/**
 * JUNO-X mock-handler: set_params / get_params API (#30 stage 3).
 *
 * Verifies the new param-domain API on the handler:
 *   - set_params writes are equivalent to UI param messages and update
 *     internal state by way of the existing handleSysEx / handleCC paths
 *     (so RQ1 readback continues to work).
 *   - get_params returns wire-byte values keyed by canonical param name.
 *   - The broadcast `params` view exposes scene-global params by name.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { JUNO_X_MODEL_ID, SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { buildRQ1, parseDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

const DEVICE_ID = 0x10;

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock set_params + get_params", () => {
  it("set_params chorus_switch=1 → readable via get_params and via RQ1", () => {
    const result = handler.set_params([{ name: "chorus_switch", value: 1 }]);
    // Result has the encoded sysexOut packet for the engine to emit.
    assert.ok(result.sysexOut && result.sysexOut.length === 1);

    // get_params returns the wire byte (127 = scaled "ON" for max=1 discrete).
    const values = handler.get_params(["chorus_switch"]);
    assert.equal(values.chorus_switch, 0x7F);

    // RQ1 round-trip on the same address returns the same byte.
    const addr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
    const rq = buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, addr, [0, 0, 0, 1]);
    const reply = handler.onMIDI({ type: "sysex", bytes: rq });
    const dt1 = parseDT1(reply.sysexOut![0], JUNO_X_MODEL_ID);
    assert.deepStrictEqual(dt1!.data, [0x7F]);
  });

  it("get_params returns 0 for unset params", () => {
    const values = handler.get_params(["chorus_switch", "delay_switch"]);
    assert.equal(values.chorus_switch, 0);
    assert.equal(values.delay_switch, 0);
  });

  it("broadcast state.params surfaces scene-global params by name", () => {
    handler.set_params([
      { name: "chorus_switch", value: 1 },
      { name: "delay_switch", value: 1 },
      { name: "chorus_level", value: 90 },
    ]);
    const state = handler.getFullState(false);
    assert.ok(state.params, "expected `params` key on broadcast state");
    assert.equal(state.params.chorus_switch, 0x7F);
    assert.equal(state.params.delay_switch, 0x7F);
    assert.equal(state.params.chorus_level, 90);
  });

  it("set_params with unknown param logs but doesn't throw", () => {
    const result = handler.set_params([{ name: "definitely_not_a_param", value: 1 }]);
    assert.match(result.log ?? "", /unknown/i);
  });
});
