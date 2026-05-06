import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap } from "../../../src/keyboard_models/sequential_circuits/prophet_6/midi-map.js";
import { GenericParameterState } from "../../../src/shared/parameter-state.js";
import { validateParameterBatch } from "../../../src/keyboard_models/sequential_circuits/prophet_6/validation.js";

const parameterMap = createParameterMap();

function freshState(): GenericParameterState {
  return new GenericParameterState([], parameterMap);
}

describe("Prophet-6 disabled-section warnings", () => {
  it("warns when setting an arpeggiator parameter while arp_on_off is off", () => {
    const state = freshState();
    state.set("arp_on_off", 0);

    const warnings = validateParameterBatch(
      [{ key: "arp_mode", value: 1 }],
      state,
      "1",
      parameterMap,
    );

    assert.ok(warnings.some((w) => /Arpeggiator is currently disabled/.test(w)),
      `expected Arpeggiator warning, got: ${JSON.stringify(warnings)}`);
  });

  it("does NOT warn when arp_on_off is on", () => {
    const state = freshState();
    state.set("arp_on_off", 1);

    const warnings = validateParameterBatch(
      [{ key: "arp_mode", value: 1 }],
      state,
      "1",
      parameterMap,
    );

    assert.deepEqual(warnings, []);
  });

  it("does NOT warn when same batch enables the arpeggiator", () => {
    const state = freshState();
    state.set("arp_on_off", 0);

    const warnings = validateParameterBatch(
      [
        { key: "arp_mode", value: 1 },
        { key: "arp_on_off", value: 1 },
      ],
      state,
      "1",
      parameterMap,
    );

    assert.deepEqual(warnings, []);
  });

  it("warns when setting glide_mode while glide_on_off is off", () => {
    const state = freshState();
    state.set("glide_on_off", 0);

    const warnings = validateParameterBatch(
      [{ key: "glide_mode", value: 1 }],
      state,
      "1",
      parameterMap,
    );

    assert.ok(warnings.some((w) => /Glide is currently disabled/.test(w)),
      `expected Glide warning, got: ${JSON.stringify(warnings)}`);
  });

  it("does NOT warn when same batch enables glide", () => {
    const state = freshState();
    state.set("glide_on_off", 0);

    const warnings = validateParameterBatch(
      [
        { key: "glide_mode", value: 1 },
        { key: "glide_on_off", value: 1 },
      ],
      state,
      "1",
      parameterMap,
    );

    assert.deepEqual(warnings, []);
  });
});
