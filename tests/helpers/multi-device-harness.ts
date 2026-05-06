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
        mocks.push(await MockProcess.start(mockOpts));
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

    return new MultiDeviceHarness({ mocks, client, transport, mcbProc, mcbDir, mcbSocketPath });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.mcpClient.callTool({ name, arguments: args });
  }

  getMock(index: number): MockProcess {
    return this.mocks[index];
  }

  async stop(): Promise<void> {
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
