/**
 * Full test harness: spawns headless mock + MCP server,
 * provides callTool() and mock state probing.
 *
 * Two modes:
 * - Local (default): spawns mock with real MIDI, MidiManager connects normally
 * - Docker/WS (MOCK_WS_URL set): connects to external mock service via WS
 *
 * Use startShared()/stopShared() to reuse one MCP server across tests.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MockProcess, type MockProcessOptions } from "./mock-process.js";

export type HarnessOptions = MockProcessOptions;

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

    let mock: MockProcess;
    let mcpEnv: Record<string, string>;

    if (externalWsUrl) {
      mock = await MockProcess.connectExternal(externalWsUrl);
      mcpEnv = {
        ...process.env as Record<string, string>,
        MOCK_WS_URL: externalWsUrl,
        MOCK_MODEL_ID: opts.model,
        MIDI_TRANSPORT: "ws",
      };
    } else {
      mock = await MockProcess.start(opts);
      mcpEnv = {
        ...process.env as Record<string, string>,
        MOCK_WS_PORT: String(mock.wsPort),
      };
    }

    // Use compiled JS in Docker (npx tsx is slow in containers)
    const useCompiled = !!externalWsUrl;
    const transport = new StdioClientTransport({
      command: useCompiled ? "node" : "npx",
      args: useCompiled ? ["dist/index.js"] : ["tsx", "src/index.ts"],
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

  /** Reset device state between tests (without killing the MCP process) */
  async reset(): Promise<void> {
    try { await this.callTool("disconnect_from_keyboard"); } catch { /* ignore */ }
  }

  async stop(): Promise<void> {
    // Best-effort: release any MCB lease before killing the MCP, so subsequent
    // tests can claim the same port. MCB doesn't yet auto-GC sessions on
    // PID death (deferred from MCB MVP), so explicit release matters.
    try { await this.callTool("disconnect_from_keyboard"); } catch { /* no device or MCB unreachable */ }
    // Kill MCP child immediately — transport.close() hangs waiting for graceful exit
    const pid = this.transport.pid;
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
    await this.mock.stop();
  }
}
