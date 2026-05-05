import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap } from "../../../src/keyboard_models/nord/electro_5d/midi-map.js";
import { NordElectro5DState } from "../../../src/keyboard_models/nord/electro_5d/state-manager.js";
import { validateParameterBatch } from "../../../src/keyboard_models/nord/electro_5d/validation.js";

const parameterMap = createParameterMap();

function freshState(): NordElectro5DState {
  return new NordElectro5DState(parameterMap);
}

describe("Nord Electro 5D disabled-section warnings", () => {
  it("warns when setting a reverb parameter while reverb is disabled", () => {
    const state = freshState();
    state.set("reverb_enable", 0);

    const warnings = validateParameterBatch(
      [{ key: "reverb_dry_wet", value: 64 }],
      state,
      "upper",
      parameterMap,
    );

    const reverbWarning = warnings.find((w) => w.includes("Reverb"));
    assert.ok(reverbWarning, `expected a Reverb warning, got: ${JSON.stringify(warnings)}`);
    assert.match(reverbWarning, /disabled/i);
  });

  it("does NOT warn when reverb is enabled", () => {
    const state = freshState();
    state.set("reverb_enable", 1);

    const warnings = validateParameterBatch(
      [{ key: "reverb_dry_wet", value: 64 }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Reverb is currently disabled")),
      `expected no Reverb-disabled warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("does NOT warn when the parameter being set IS the section's enable flag", () => {
    const state = freshState();
    state.set("reverb_enable", 0); // section currently disabled

    const warnings = validateParameterBatch(
      [{ key: "reverb_enable", value: 0 }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Reverb is currently disabled")),
      `expected no self-warning when toggling reverb_enable, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("does NOT warn when the parameter being set IS an engine select", () => {
    const state = freshState();
    // No engine set yet → all engines disabled per the rule.

    const warnings = validateParameterBatch(
      [{ key: "part_upper_engine_select", value: "Piano" }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => /engine is currently disabled/i.test(w)),
      `expected no self-warning when picking an engine, got: ${JSON.stringify(warnings)}`,
    );
  });
});
