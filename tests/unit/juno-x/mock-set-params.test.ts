/**
 * JUNO-X mock-handler: set_params / get_params API (#30 stages 3–4).
 *
 * Verifies the param-domain API on the handler:
 *   - set_params updates internal state by way of the byte-level
 *     handleSysEx / handleCC paths (so read_bytes continues to work).
 *   - get_params returns wire-byte values keyed by canonical param name.
 *   - The broadcast `params` view exposes scene-global params by name.
 *
 * Stage 4: set_params no longer returns ccOut/sysexOut/programOut —
 * MIDI emission is the engine's responsibility now.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { addAddresses } from "../../../src/shared/roland-dt1.js";

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock set_params + get_params", () => {
  it("set_params chorus_switch=1 → readable via get_params and via read_bytes", () => {
    const result = handler.set_params([{ name: "chorus_switch", value: 1 }]);
    // Stage 4: handler no longer emits via the result channel.
    assert.equal((result as any).sysexOut, undefined);
    assert.equal((result as any).ccOut, undefined);

    // get_params returns the wire byte (127 = scaled "ON" for max=1 discrete).
    const values = handler.get_params(["chorus_switch"]);
    assert.equal(values.chorus_switch, 0x7F);

    // The same byte is visible to read_bytes — engine uses this for RQ1.
    const addr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
    const data = handler.read_bytes(addr, 1);
    assert.deepStrictEqual(data, [0x7F]);
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
