/**
 * Full test harness: spawns headless mock + MCP server,
 * provides callTool() and mock state probing.
 *
 * Two modes:
 * - Local (default): spawns mock with real MIDI, MidiManager connects normally
 * - Docker/WS (MOCK_WS_URL set): connects to external mock service via WS
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
    const externalWsUrl = process.env.MOCK_WS_URL;

    // 1. Start or connect to mock
    let mock: MockProcess;
    let mcpEnv: Record<string, string>;

    if (externalWsUrl) {
      // Docker/CI mode: mock is an external service, connect via WS
      mock = await MockProcess.connectExternal(externalWsUrl);
      mcpEnv = {
        ...process.env as Record<string, string>,
        MOCK_WS_URL: externalWsUrl,
        MOCK_MODEL_ID: opts.model,
      };
    } else {
      // Local mode: spawn mock with real MIDI
      mock = await MockProcess.start(opts);
      mcpEnv = {
        ...process.env as Record<string, string>,
        MOCK_WS_PORT: String(mock.wsPort),
      };
    }

    // 2. Start MCP server as child process via stdio transport
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: mcpEnv,
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

  async stop(): Promise<void> {
    try { await this.transport.close(); } catch { /* ignore */ }
    await this.mock.stop();
  }
}
