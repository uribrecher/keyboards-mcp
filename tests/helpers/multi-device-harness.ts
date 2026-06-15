/**
 * Multi-device test harness: spawns multiple headless mocks on distinct WS ports,
 * a dedicated MCB instance with a unique UDS path, and a single MCP server. Each
 * call to connect_to_keyboard targets one mock by its port name (and optional
 * label). Skipped under MOCK_WS_URL (Docker CI uses a different transport path).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProcess, type MockProcessOptions } from "./mock-process.js";

export interface MultiDeviceHarnessOptions {
  mocks: MockProcessOptions[];
}

export class MultiDeviceHarness {
  private mocks: MockProcess[];
  private mcpClient: Client;
  private transport: StdioClientTransport;
  private mcbProc: ChildProcess;
  private mcbDir: string;
  private mcbSocketPath: string;

  private constructor(args: {
    mocks: MockProcess[];
    client: Client;
    transport: StdioClientTransport;
    mcbProc: ChildProcess;
    mcbDir: string;
    mcbSocketPath: string;
  }) {
    this.mocks = args.mocks;
    this.mcpClient = args.client;
    this.transport = args.transport;
    this.mcbProc = args.mcbProc;
    this.mcbDir = args.mcbDir;
    this.mcbSocketPath = args.mcbSocketPath;
  }

  static async start(opts: MultiDeviceHarnessOptions): Promise<MultiDeviceHarness> {
    if (process.env.MOCK_WS_URL) {
      throw new Error("MultiDeviceHarness does not support external WS mode (MOCK_WS_URL).");
    }

    // Per-harness MCB instance on a unique UDS — keeps tests isolated and
    // lets multiple test files run in parallel without lease collisions.
    const mcbDir = mkdtempSync(join(tmpdir(), "mcb-harness-"));
    const mcbSocketPath = join(mcbDir, "sock");
    const mcbProc = await startMcb(mcbSocketPath);

    const mocks: MockProcess[] = [];
    try {
      for (const mockOpts of opts.mocks) {
        // Push MCB_SOCKET into the mock-runner env so its tab-close active
        // release (DELETE /v1/mocks/:instanceId in MockTransport.stop) lands
        // on the harness's MCB, not whatever the developer has in $MCB_SOCKET.
        mocks.push(await MockProcess.start({
          ...mockOpts,
          env: { ...(mockOpts.env ?? {}), MCB_SOCKET: mcbSocketPath },
        }));
      }
    } catch (err) {
      await Promise.all(mocks.map((m) => m.stop()));
      mcbProc.kill("SIGTERM");
      rmSync(mcbDir, { recursive: true, force: true });
      throw err;
    }

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env as Record<string, string>,
        MCB_SOCKET: mcbSocketPath,
      },
    });

    const client = new Client({ name: "multi-device-harness", version: "1.0.0" });
    await client.connect(transport);

    // Drain MCP stderr so a full pipe buffer can't block the child during
    // shutdown. The pipe stays open for the lifetime of the child; without
    // a consumer, errors written after the buffer fills (~64KB) deadlock.
    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer) => {
        if (process.env.MCP_TEST_STDERR) process.stderr.write(`[mcp ${transport.pid}] ${chunk}`);
      });
      stderr.on("error", () => { /* child went away */ });
    }

    return new MultiDeviceHarness({ mocks, client, transport, mcbProc, mcbDir, mcbSocketPath });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.mcpClient.callTool({ name, arguments: args });
  }

  getMock(index: number): MockProcess {
    return this.mocks[index];
  }

  /**
   * Stop a single mock-runner mid-test. The mock's own `MockTransport.stop()`
   * runs SIGTERM-driven (see `src/sounds-and-recreation-app/cli.ts`), which fires the
   * active `DELETE /v1/mocks/:instanceId` to the harness's MCB before exit.
   */
  async stopMock(index: number): Promise<void> {
    const mock = this.mocks[index];
    if (!mock) throw new Error(`No mock at index ${index}`);
    await mock.stop();
    this.mocks.splice(index, 1);
  }

  /**
   * Start an additional mock-runner against the harness's MCB. Returns the
   * new mock's index in the harness's `mocks` array.
   */
  async startMock(opts: MockProcessOptions): Promise<number> {
    const mock = await MockProcess.start({
      ...opts,
      env: { ...(opts.env ?? {}), MCB_SOCKET: this.mcbSocketPath },
    });
    this.mocks.push(mock);
    return this.mocks.length - 1;
  }

  /** Read MCB's lease list directly — bypasses MCP. */
  async listMcbDevices(): Promise<Array<{ deviceId: string; mockInstanceId: string | null; shadowMockInstanceId: string | null; primary: { portName: string }; shadow?: { portName: string } }>> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.mcbSocketPath, method: "GET", path: "/v1/devices" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (err) { reject(err); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Stop the MCB process and spawn a fresh one on the same socket. Used by
   * the session-loss e2e to simulate "user restarted MCB" — the new broker has
   * an empty session table, so any session-bearing call from the still-running
   * MCP triggers session-not-found. SIGTERM lets the broker unlink the
   * socket cleanly; SIGKILL on the tsx wrapper PID does not propagate to the
   * broker child, leaving the listener bound.
   */
  async restartMcb(): Promise<void> {
    const proc = this.mcbProc;
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 2000);
      proc.once("exit", () => { clearTimeout(t); resolve(); });
    });
    this.mcbProc = await startMcb(this.mcbSocketPath);
  }

  async stop(): Promise<void> {
    // Close transport pipes first so the MCP child sees stdin EOF and exits.
    // Without this, an MCP child whose transport.pid is the npx wrapper can
    // outlive the SIGKILL (the wrapper dies, the underlying node child does
    // not) — leaving open FDs that keep the test runner's event loop alive.
    try { await this.mcpClient.close(); } catch { /* best-effort */ }
    const mcpPid = this.transport.pid;
    if (mcpPid) {
      try { process.kill(mcpPid, "SIGKILL"); } catch { /* already dead */ }
    }
    await Promise.all(this.mocks.map((m) => m.stop()));
    // Best-effort MCB shutdown — graceful first, then SIGKILL.
    this.mcbProc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.mcbProc.kill("SIGKILL"); resolve(); }, 2000);
      this.mcbProc.once("exit", () => { clearTimeout(t); resolve(); });
    });
    rmSync(this.mcbDir, { recursive: true, force: true });
  }
}

async function startMcb(socketPath: string): Promise<ChildProcess> {
  const tsxCli = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const proc = spawn(process.execPath, [tsxCli, "src/mcb/index.ts"], {
    env: { ...process.env, MCB_SOCKET: socketPath },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const ok = await new Promise<boolean>((resolve) => {
        const req = request({ socketPath, method: "GET", path: "/v1/health" }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.end();
      });
      if (ok) return proc;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error(`MCB fixture failed to come up at ${socketPath} within 10s`);
}
