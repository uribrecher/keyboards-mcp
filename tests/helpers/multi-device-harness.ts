/**
 * Multi-device test harness: spawns multiple headless mocks on distinct WS ports
 * and a single MCP server. Each call to connect_to_keyboard targets one mock by
 * its port name + mock_ws_port (per-device WS). Skipped under MOCK_WS_URL (Docker CI).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MockProcess, type MockProcessOptions } from "./mock-process.js";

export interface MultiDeviceHarnessOptions {
  mocks: MockProcessOptions[];
}

export class MultiDeviceHarness {
  private mocks: MockProcess[];
  private mcpClient: Client;
  private transport: StdioClientTransport;

  private constructor(mocks: MockProcess[], client: Client, transport: StdioClientTransport) {
    this.mocks = mocks;
    this.mcpClient = client;
    this.transport = transport;
  }

  static async start(opts: MultiDeviceHarnessOptions): Promise<MultiDeviceHarness> {
    if (process.env.MOCK_WS_URL) {
      throw new Error("MultiDeviceHarness does not support external WS mode (MOCK_WS_URL).");
    }

    const mocks: MockProcess[] = [];
    for (const mockOpts of opts.mocks) {
      mocks.push(await MockProcess.start(mockOpts));
    }

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: { ...process.env as Record<string, string> },
    });

    const client = new Client({ name: "multi-device-harness", version: "1.0.0" });
    await client.connect(transport);

    return new MultiDeviceHarness(mocks, client, transport);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.mcpClient.callTool({ name, arguments: args });
  }

  getMock(index: number): MockProcess {
    return this.mocks[index];
  }

  async stop(): Promise<void> {
    const pid = this.transport.pid;
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
    await Promise.all(this.mocks.map((m) => m.stop()));
  }
}
