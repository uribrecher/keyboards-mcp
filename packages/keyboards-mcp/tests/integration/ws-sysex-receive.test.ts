/**
 * Integration test for the WS-mode SysEx receive path (#109) — the WS-mode
 * counterpart to `mcp-sysex-receive.test.ts` (real MIDI).
 *
 * Spawns a JUNO-X mock with BOTH WS lanes (`--no-midi`, so no ALSA needed),
 * then spawns the MCP server in WS transport mode wired to both lanes via
 * `MOCK_WS_URL` + `MOCK_WS_OUT_URL`. It sets scene-chorus values with
 * `set_parameters` (inbound DT1 over lane 1) and reads them back with
 * `get_current_state`, which issues an RQ1 and receives the DT1 response on
 * the out lane (lane 2) — the round-trip that had no WS path before.
 *
 * Runs in every environment (no real MIDI required), including Docker WS mode.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MockProcess } from "../helpers/mock-process.js";

const WS_PORT = 5730;
const WS_OUT_PORT = 5731;

let mock: MockProcess;
let client: Client;
let transport: StdioClientTransport;

describe("WS-mode SysEx receive: RQ1 round-trip over the second WS lane", { concurrency: 1 }, () => {
  before(async () => {
    mock = await MockProcess.start({
      model: "roland-juno-x",
      wsPort: WS_PORT,
      wsOutPort: WS_OUT_PORT,
      noMidi: true,
    });

    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env as Record<string, string>,
        MOCK_WS_URL: `ws://localhost:${WS_PORT}`,
        MOCK_WS_OUT_URL: `ws://localhost:${WS_OUT_PORT}`,
        MOCK_MODEL_ID: "roland-juno-x",
        MIDI_TRANSPORT: "ws",
      },
    });
    client = new Client({ name: "ws-sysex-receive-test", version: "1.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    try { await client.callTool({ name: "disconnect_from_keyboard", arguments: {} }); } catch { /* ignore */ }
    const pid = transport?.pid;
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
    if (mock) await mock.stop();
  });

  it("reads live JUNO-X scene-chorus values back via the out lane", async () => {
    const conn = await client.callTool({ name: "connect_to_keyboard", arguments: { port: "Roland JUNO-X Mock", model: "roland-juno-x" } });
    assert.ok(!(conn as any).isError, `connect failed: ${(conn as any).content?.[0]?.text}`);

    const set = await client.callTool({
      name: "set_parameters",
      arguments: { parameters: [
        { name: "chorus_switch", value: 1 },
        { name: "chorus_type", value: 9 },
        { name: "chorus_level", value: 80 },
      ] },
    });
    assert.ok(!(set as any).isError, `set_parameters failed: ${(set as any).content?.[0]?.text}`);

    const state = await client.callTool({ name: "get_current_state", arguments: { section: "scene-chorus" } });
    assert.ok(!(state as any).isError, `get_current_state failed: ${(state as any).content?.[0]?.text}`);
    const text = (state as any).content[0].text as string;
    assert.match(text, /Chorus Switch.*ON/i, `expected Chorus Switch ON via the out-lane RQ1 read, got: ${text}`);
    assert.match(text, /Chorus Type.*JUNO Chorus/, `expected Chorus Type JUNO Chorus, got: ${text}`);
    assert.match(text, /Chorus Level.*80/, `expected Chorus Level 80, got: ${text}`);
  });
});
