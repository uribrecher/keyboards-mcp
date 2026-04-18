/**
 * Full test harness: spawns headless mock + MCP server,
 * provides callTool() and mock state probing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MockProcess, type MockProcessOptions } from "./mock-process.js";

export interface HarnessOptions extends MockProcessOptions {}

export class TestHarness {
  private mock: MockProcess;
  private mcpClient: Client;
  private transport: StdioClientTransport;

  private constructor(mock: MockProcess, client: Client, transport: StdioClientTransport) {
    this.mock = mock;
    this.mcpClient = client;
    this.transport = transport;
  }

  static async start(opts: HarnessOptions): Promise<TestHarness> {
    // 1. Start headless mock
    const mock = await MockProcess.start(opts);

    // 2. Start MCP server as child process via stdio transport
    // Set MOCK_WS_PORT so MidiManager connects to the right mock WS
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: { ...process.env, MOCK_WS_PORT: String(mock.wsPort) },
    });

    const client = new Client({ name: "test-harness", version: "1.0.0" });
    await client.connect(transport);

    return new TestHarness(mock, client, transport);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.mcpClient.callTool({ name, arguments: args });
  }

  getMockState(): Record<string, any> | null {
    return this.mock.getLastState();
  }

  async waitForMockState(timeoutMs?: number): Promise<Record<string, any>> {
    return this.mock.waitForState(timeoutMs);
  }

  /**
   * Wait for the next mock state broadcast (ignores cached state).
   * Useful after calling set_parameters to wait for the CC to arrive.
   */
  async waitForNextState(timeoutMs = 3000): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Next state timeout")), timeoutMs);
      // Access the mock's internal resolver mechanism
      (this.mock as any).stateResolvers.push((state: Record<string, any>) => {
        clearTimeout(timer);
        resolve(state);
      });
    });
  }

  async stop(): Promise<void> {
    try { await this.transport.close(); } catch { /* ignore */ }
    await this.mock.stop();
  }
}
