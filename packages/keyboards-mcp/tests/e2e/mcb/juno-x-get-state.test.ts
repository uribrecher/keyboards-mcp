/**
 * E2E test for JUNO-X get_current_state via Roland RQ1 (#23).
 *
 * Spawns a JUNO-X mock + MCB + MCP via MultiDeviceHarness, sets known
 * scene-effect values via set_parameters (DT1 to mock), then calls
 * get_current_state and asserts the rendered text contains the live
 * values that the mock returned via DT1.
 *
 * Skipped in WS-only Docker mode — real-MIDI receive is what's tested.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MultiDeviceHarness } from "../../helpers/multi-device-harness.js";

const IS_DOCKER_WS_MODE = !!process.env.MOCK_WS_URL;
const JUNO_WS = 5710;

let h: MultiDeviceHarness;

describe("E2E: JUNO-X get_current_state — live RQ1 read", { concurrency: 1, skip: IS_DOCKER_WS_MODE }, () => {
  before(async () => {
    h = await MultiDeviceHarness.start({
      mocks: [{ model: "roland-juno-x", wsPort: JUNO_WS }],
    });
  });

  after(async () => {
    if (h) await h.stop();
  });

  it("returns live values for scene-chorus after set_parameters", async () => {
    const conn = await h.callTool("connect_to_keyboard", {
      port: "Roland JUNO-X Mock",
      model: "roland-juno-x",
    });
    assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);

    const set = await h.callTool("set_parameters", {
      parameters: [
        { name: "chorus_switch", value: 1 },
        { name: "chorus_type", value: 9 },
        { name: "chorus_level", value: 80 },
      ],
    });
    assert.ok(!set.isError, `set_parameters failed: ${set.content[0].text}`);

    const state = await h.callTool("get_current_state", { section: "scene-chorus" });
    assert.ok(!state.isError, `get_current_state failed: ${state.content[0].text}`);
    const text = state.content[0].text;
    assert.match(text, /Chorus Switch.*ON/i, `expected Chorus Switch ON in: ${text}`);
    assert.match(text, /Chorus Type.*JUNO Chorus/, `expected Chorus Type JUNO Chorus in: ${text}`);
    assert.match(text, /Chorus Level.*80/, `expected Chorus Level 80 in: ${text}`);

    await h.callTool("disconnect_from_keyboard");
  });

  it("returns 'not yet supported' for an unsupported section", async () => {
    const conn = await h.callTool("connect_to_keyboard", {
      port: "Roland JUNO-X Mock",
      model: "roland-juno-x",
    });
    assert.ok(!conn.isError);

    const state = await h.callTool("get_current_state", { section: "scene-modify" });
    assert.match(state.content[0].text, /not yet supported.*scene-modify/i);

    await h.callTool("disconnect_from_keyboard");
  });
});
