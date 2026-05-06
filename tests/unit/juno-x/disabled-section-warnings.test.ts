import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap } from "../../../src/keyboard_models/roland/juno_x/midi-map.js";
import { JunoXState } from "../../../src/keyboard_models/roland/juno_x/state-manager.js";
import { validateParameterBatch } from "../../../src/keyboard_models/roland/juno_x/validation.js";

const parameterMap = createParameterMap();

function freshState(): JunoXState {
  return new JunoXState(parameterMap);
}

describe("JUNO-X disabled-section warnings", () => {
  it("warns when setting a chorus parameter while chorus_switch is off", () => {
    const state = freshState();
    state.set("chorus_switch", 0);

    const warnings = validateParameterBatch(
      [{ key: "chorus_level", value: 64 }],
      state,
      "1",
      parameterMap,
    );

    assert.ok(warnings.some((w) => /Scene Chorus is currently disabled/.test(w)),
      `expected Scene Chorus warning, got: ${JSON.stringify(warnings)}`);
  });

  it("does NOT warn when chorus_switch is on", () => {
    const state = freshState();
    state.set("chorus_switch", 1);

    const warnings = validateParameterBatch(
      [{ key: "chorus_level", value: 64 }],
      state,
      "1",
      parameterMap,
    );

    assert.deepEqual(warnings, []);
  });

  it("does NOT warn when toggling chorus_switch itself", () => {
    const state = freshState();
    state.set("chorus_switch", 0);

    const warnings = validateParameterBatch(
      [{ key: "chorus_switch", value: 0 }],
      state,
      "1",
      parameterMap,
    );

    assert.deepEqual(warnings, []);
  });

  it("does NOT warn when same batch enables the section", () => {
    const state = freshState();
    state.set("delay_switch", 0);

    const warnings = validateParameterBatch(
      [
        { key: "delay_level", value: 70 },
        { key: "delay_switch", value: 1 },
      ],
      state,
      "1",
      parameterMap,
    );

    assert.deepEqual(warnings, []);
  });

  it("emits one warning per disabled section across multiple gates", () => {
    const state = freshState();
    state.set("reverb_switch", 0);
    state.set("delay_switch", 0);

    const warnings = validateParameterBatch(
      [
        { key: "reverb_level", value: 64 },
        { key: "delay_level", value: 64 },
      ],
      state,
      "1",
      parameterMap,
    );

    assert.equal(warnings.length, 2,
      `expected 2 warnings (reverb + delay), got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings.some((w) => /Scene Reverb/.test(w)));
    assert.ok(warnings.some((w) => /Scene Delay/.test(w)));
  });
});
