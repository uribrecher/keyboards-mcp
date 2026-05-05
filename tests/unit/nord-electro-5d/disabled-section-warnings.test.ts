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

  it("does NOT warn when the same batch enables the section", () => {
    const state = freshState();
    state.set("effect1_enable", 0); // currently disabled

    const warnings = validateParameterBatch(
      [
        { key: "effect1_rate", value: 70 },
        { key: "effect1_enable", value: 1 },
      ],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Effect 1 is currently disabled")),
      `expected no Effect 1 warning when batch enables it, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("does NOT warn when the same batch selects the engine", () => {
    const state = freshState();
    // No engine selected on either part initially.

    const warnings = validateParameterBatch(
      [
        { key: "piano_model", value: 0 },
        { key: "part_upper_engine_select", value: "Piano" },
      ],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Piano engine is currently disabled")),
      `expected no Piano-engine warning when batch selects it, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("warns when setting a piano param while no part is on the Piano engine", () => {
    const state = freshState();
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const organMidi = parameterMap.resolveValue(engineParam, "Organ");
    state.set("part_lower_engine_select", organMidi); // Organ
    state.set("part_upper_engine_select", organMidi); // Organ

    const warnings = validateParameterBatch(
      [{ key: "piano_model", value: 0 }],
      state,
      "upper",
      parameterMap,
    );

    const pianoWarning = warnings.find((w) => w.includes("Piano engine is currently disabled"));
    assert.ok(pianoWarning, `expected a Piano-engine warning, got: ${JSON.stringify(warnings)}`);
  });

  it("does NOT warn when at least one part is on the Piano engine", () => {
    const state = freshState();
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const organMidi = parameterMap.resolveValue(engineParam, "Organ");
    const pianoMidi = parameterMap.resolveValue(engineParam, "Piano");
    state.set("part_lower_engine_select", organMidi); // Organ
    state.set("part_upper_engine_select", pianoMidi); // Piano

    const warnings = validateParameterBatch(
      [{ key: "piano_model", value: 0 }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Piano engine is currently disabled")),
      `expected no Piano-engine warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("emits exactly one warning per disabled section, regardless of param count", () => {
    const state = freshState();
    state.set("reverb_enable", 0);

    const warnings = validateParameterBatch(
      [
        { key: "reverb_dry_wet", value: 64 },
        { key: "reverb_type", value: 1 },
      ],
      state,
      "upper",
      parameterMap,
    );

    const reverbWarnings = warnings.filter((w) => w.includes("Reverb is currently disabled"));
    assert.equal(reverbWarnings.length, 1, `expected exactly 1 Reverb warning, got: ${JSON.stringify(warnings)}`);
  });
});
