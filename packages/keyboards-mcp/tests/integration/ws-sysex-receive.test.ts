/**
 * Integration test for the WS-mode SysEx receive path (#109) — the WS-mode
 * counterpart to `mcp-sysex-receive.test.ts` (real MIDI).
 *
 * Spawns a JUNO-X mock with BOTH WS lanes (`--no-midi`, so no ALSA needed),
 * then drives the RQ1→DT1 round-trip through the real `WsMidiConnection`
 * (the same class the MCP uses) + `requestRolandValue` (the same read helper
 * `get_current_state` uses). The mock receives the RQ1 on the in lane and
 * replies with a DT1 on the out lane, which `WsMidiConnection.onSysEx`
 * surfaces — the round-trip that had no WS path before.
 *
 * Every step is timeout-bounded (mock spawn, WS connect, the request), so a
 * failure surfaces fast rather than hanging CI. Runs in every environment
 * including Docker WS mode (no real MIDI required).
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MockProcess } from "../helpers/mock-process.js";
import { WsMidiConnection } from "../../src/midi/ws-midi-connection.js";
import { requestRolandValue, buildDT1, addAddresses } from "../../src/shared/roland-dt1.js";

const WS_PORT = 5730;
const WS_OUT_PORT = 5731;
const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };
const DEVICE_ID = 0x10;
const SCENE_BASE = [0x01, 0x00, 0x00, 0x00];
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00];
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

describe("WS-mode SysEx receive: RQ1 round-trip over the second WS lane", { concurrency: 1 }, () => {
  it("receives the stored value via a DT1 on the out lane after an RQ1 on the in lane", async () => {
    const mock = await MockProcess.start({
      model: "roland-juno-x",
      wsPort: WS_PORT,
      wsOutPort: WS_OUT_PORT,
      noMidi: true,
    });
    let conn: WsMidiConnection | undefined;
    try {
      conn = await WsMidiConnection.connect(`ws://localhost:${WS_PORT}`, DEVICE_ID, `ws://localhost:${WS_OUT_PORT}`);

      // Pre-set chorus_switch=ON with a DT1 on the in lane (0x7F is the
      // canonical ON wire byte for this max=1 discrete).
      conn.sendSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x7F]));

      // RQ1 on the in lane → DT1 on the out lane → onSysEx → resolved value.
      const data = await requestRolandValue(conn, JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, 1, 2000);
      assert.deepEqual(data, [0x7F], "expected chorus_switch=ON (wire 0x7F) from the WS-lane RQ1 round-trip");
    } finally {
      conn?.close();
      await mock.stop();
    }
  });
});
