/**
 * Spawns the headless mock as a child process, waits for MOCK_READY,
 * provides a WebSocket client for state probing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";

// The headless mock lives in the sibling app workspace. From this helper
// (packages/keyboards-mcp/tests/helpers/), `../../../sounds-and-recreation-app`
// resolves to packages/sounds-and-recreation-app. We spawn its `src/cli.ts`
// with cwd set there so the app's own tsx/deps resolve.
const APP_DIR = new URL("../../../sounds-and-recreation-app", import.meta.url).pathname;

export interface MockProcessOptions {
  model: string;
  wsPort?: number;
  /** Second WS port for the outgoing-from-mock MIDI lane (#109). */
  wsOutPort?: number;
  /** Skip the virtual MIDI port — WS-only mode (CI/Docker, no ALSA). */
  noMidi?: boolean;
  lowerChannel?: number;
  upperChannel?: number;
  label?: string;
  /**
   * Extra env vars merged onto `process.env` for the spawned mock-runner.
   * The harness uses this to push `MCB_SOCKET` so the mock-runner's
   * `releaseMockInstance` call lands on the same broker the test owns.
   */
  env?: Record<string, string>;
}

export class MockProcess {
  private proc: ChildProcess | null;
  private ws: WebSocket | null = null;
  private lastState: Record<string, any> | null = null;
  private stateResolvers: Array<(state: Record<string, any>) => void> = [];
  readonly wsPort: number;
  private external: boolean;

  private constructor(proc: ChildProcess | null, wsPort: number, external = false) {
    this.proc = proc;
    this.wsPort = wsPort;
    this.external = external;
  }

  /**
   * Connect to an external mock service (docker/CI mode).
   * No child process is spawned — just connects WS for state probing.
   */
  static async connectExternal(wsUrl: string): Promise<MockProcess> {
    const url = new URL(wsUrl);
    const port = parseInt(url.port) || 3000;
    const mp = new MockProcess(null, port, true);
    await mp.connectWsToUrl(wsUrl);
    return mp;
  }

  static async start(opts: MockProcessOptions): Promise<MockProcess> {
    const wsPort = opts.wsPort ?? 3456;
    const args = [
      "tsx",
      "src/cli.ts",
      "--model", opts.model,
      "--ws-port", String(wsPort),
      "--lower-channel", String(opts.lowerChannel ?? 0),
      "--upper-channel", String(opts.upperChannel ?? 1),
    ];
    if (opts.wsOutPort !== undefined) { args.push("--ws-out-port", String(opts.wsOutPort)); }
    if (opts.noMidi) { args.push("--no-midi"); }
    if (opts.label) { args.push("--label", opts.label); }
    const proc = spawn("npx", args, {
      cwd: APP_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env as Record<string, string>, ...(opts.env ?? {}) },
    });

    // Wait for MOCK_READY
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MOCK_READY timeout (10s)")), 10_000);
      proc.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("MOCK_READY")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Mock exited with code ${code}`));
      });
    });

    const mp = new MockProcess(proc, wsPort);
    await mp.connectWs();
    return mp;
  }

  /**
   * Start a mock process expecting it to fail (e.g. invalid model).
   * Returns the exit code.
   */
  static async startExpectingFailure(opts: MockProcessOptions): Promise<number> {
    const wsPort = opts.wsPort ?? 3456;
    const proc = spawn("npx", [
      "tsx",
      "src/cli.ts",
      "--model", opts.model,
      "--ws-port", String(wsPort),
    ], {
      cwd: APP_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error("Process did not exit within 10s"));
      }, 10_000);
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code ?? 1);
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async connectWs(): Promise<void> {
    return this.connectWsToUrl(`ws://localhost:${this.wsPort}`);
  }

  private async connectWsToUrl(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WS connect timeout")), 5_000);
      const ws = new WebSocket(url);
      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        resolve();
      });
      ws.on("message", (data: Buffer) => {
        const parsed = JSON.parse(data.toString());
        this.lastState = parsed;
        for (const r of this.stateResolvers) r(parsed);
        this.stateResolvers = [];
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  getLastState(): Record<string, any> | null {
    return this.lastState;
  }

  waitForState(timeoutMs = 3000): Promise<Record<string, any>> {
    if (this.lastState) return Promise.resolve(this.lastState);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("State timeout")), timeoutMs);
      this.stateResolvers.push((state) => {
        clearTimeout(timer);
        resolve(state);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.external || !this.proc) return; // External mock — don't kill
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc!.kill("SIGKILL");
        resolve();
      }, 3000);
      this.proc!.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
