/**
 * JUNO-X mock-handler: set_params / get_params API (#30 stage 5).
 *
 * Verifies user-domain param storage and retrieval. The handler stores
 * canonical user-domain numerics (1 for ON, 80 for chorus_level=80, etc.)
 * — never wire bytes. Wire-byte translation lives entirely in the codec.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock set_params + get_params (stage 5: user-domain)", () => {
  it("chorus_switch=1 round-trips as user-domain 1, NOT wire byte 127", () => {
    handler.set_params([{ name: "chorus_switch", value: 1 }]);
    const values = handler.get_params(["chorus_switch"]);
    assert.equal(values.chorus_switch, 1);
  });

  it("set_params returns no emission channels (stage 4+)", () => {
    const result = handler.set_params([{ name: "chorus_switch", value: 1 }]);
    assert.equal((result as any).sysexOut, undefined);
    assert.equal((result as any).ccOut, undefined);
    assert.equal((result as any).programOut, undefined);
  });

  it("string label inputs are normalized to numeric user-domain on write", () => {
    handler.set_params([{ name: "chorus_switch", value: "ON" }]);
    assert.equal(handler.get_params(["chorus_switch"]).chorus_switch, 1);
  });

  it("get_params returns the param's defaultValue when unset", () => {
    const values = handler.get_params(["chorus_switch", "chorus_level"]);
    assert.equal(values.chorus_switch, 0);    // defaultValue 0
    assert.equal(values.chorus_level, 64);    // defaultValue 64
  });

  it("broadcast state.params surfaces scene-global params by name (user-domain)", () => {
    handler.set_params([
      { name: "chorus_switch", value: 1 },
      { name: "delay_switch", value: 1 },
      { name: "chorus_level", value: 90 },
    ]);
    const state = handler.getFullState(false);
    assert.equal(state.params.chorus_switch, 1);
    assert.equal(state.params.delay_switch, 1);
    assert.equal(state.params.chorus_level, 90);
  });

  it("per-part set_params writes to the right part; cross-part isolation", () => {
    handler.set_params([{ name: "lfo_rate", value: 50, part: 1 }]);
    handler.set_params([{ name: "lfo_rate", value: 100, part: 2 }]);
    assert.equal(handler.get_params(["lfo_rate"], 1).lfo_rate, 50);
    assert.equal(handler.get_params(["lfo_rate"], 2).lfo_rate, 100);
  });

  it("set_params with unknown param logs but doesn't throw", () => {
    const result = handler.set_params([{ name: "definitely_not_a_param", value: 1 }]);
    assert.match(result.log ?? "", /unknown/i);
  });

  it("load_program updates scene state", () => {
    handler.load_program(130, 5);
    const state = handler.getFullState(false);
    assert.equal(state.scene.bank, 130);
    assert.equal(state.scene.program, 5);
  });
});
