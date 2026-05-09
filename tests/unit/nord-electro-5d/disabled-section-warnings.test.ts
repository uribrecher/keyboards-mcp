import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap } from "../../../src/keyboard_models/nord/electro_5d/midi-map.js";
import { NordElectro5DState } from "../../../src/keyboard_models/nord/electro_5d/state-manager.js";
import { preflightDisabledSections } from "../../../src/keyboard_models/nord/electro_5d/validation.js";

const parameterMap = createParameterMap();

function freshState(): NordElectro5DState {
  return new NordElectro5DState(parameterMap);
}

describe("Nord Electro 5D disabled-section blocking errors", () => {
  it("blocks a reverb parameter and emits an ERROR while reverb is disabled", () => {
    const state = freshState();
    state.set("reverb_enable", 0);

    const result = preflightDisabledSections(
      [{ key: "reverb_dry_wet", value: 64 }],
      state,
      parameterMap,
    );

    const reverbError = result.errors.find((e) => e.includes("Reverb"));
    assert.ok(reverbError, `expected a Reverb error, got: ${JSON.stringify(result.errors)}`);
    assert.match(reverbError, /^ERROR:/);
    assert.match(reverbError, /disabled/i);
    assert.ok(result.blockedKeys.has("reverb_dry_wet"), "expected reverb_dry_wet to be blocked");
  });

  it("does NOT error or block when reverb is enabled", () => {
    const state = freshState();
    state.set("reverb_enable", 1);

    const result = preflightDisabledSections(
      [{ key: "reverb_dry_wet", value: 64 }],
      state,
      parameterMap,
    );

    assert.equal(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.equal(result.blockedKeys.size, 0);
  });

  it("does NOT error when the parameter being set IS the section's enable flag", () => {
    const state = freshState();
    state.set("reverb_enable", 0); // section currently disabled

    const result = preflightDisabledSections(
      [{ key: "reverb_enable", value: 0 }],
      state,
      parameterMap,
    );

    assert.equal(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.equal(result.blockedKeys.size, 0);
  });

  it("does NOT error when the parameter being set IS an engine select", () => {
    const state = freshState();
    // No engine set yet → all engines disabled per the rule.

    const result = preflightDisabledSections(
      [{ key: "part_upper_engine_select", value: "Piano" }],
      state,
      parameterMap,
    );

    assert.ok(
      !result.errors.some((e) => /engine is currently disabled/i.test(e)),
      `expected no engine error when picking an engine, got: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.blockedKeys.size, 0);
  });

  it("does NOT error when the same batch enables the section", () => {
    const state = freshState();
    state.set("effect1_enable", 0); // currently disabled

    const result = preflightDisabledSections(
      [
        { key: "effect1_rate", value: 70 },
        { key: "effect1_enable", value: 1 },
      ],
      state,
      parameterMap,
    );

    assert.ok(
      !result.errors.some((e) => e.includes("Effect 1 is currently disabled")),
      `expected no Effect 1 error when batch enables it, got: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.blockedKeys.size, 0);
  });

  it("does NOT error when the same batch selects the engine", () => {
    const state = freshState();
    // No engine selected on either part initially.

    const result = preflightDisabledSections(
      [
        { key: "piano_model", value: 0 },
        { key: "part_upper_engine_select", value: "Piano" },
      ],
      state,
      parameterMap,
    );

    assert.ok(
      !result.errors.some((e) => e.includes("Piano engine is currently disabled")),
      `expected no Piano-engine error when batch selects it, got: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.blockedKeys.size, 0);
  });

  it("blocks and errors when setting a piano param while no part is on the Piano engine", () => {
    const state = freshState();
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const organMidi = parameterMap.resolveValue(engineParam, "Organ");
    state.set("part_lower_engine_select", organMidi); // Organ
    state.set("part_upper_engine_select", organMidi); // Organ

    const result = preflightDisabledSections(
      [{ key: "piano_model", value: 0 }],
      state,
      parameterMap,
    );

    const pianoError = result.errors.find((e) => e.includes("Piano engine is currently disabled"));
    assert.ok(pianoError, `expected a Piano-engine error, got: ${JSON.stringify(result.errors)}`);
    assert.match(pianoError, /^ERROR:/);
    assert.ok(result.blockedKeys.has("piano_model"));
  });

  it("does NOT error when at least one part is on the Piano engine and that part is enabled", () => {
    const state = freshState();
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const organMidi = parameterMap.resolveValue(engineParam, "Organ");
    const pianoMidi = parameterMap.resolveValue(engineParam, "Piano");
    state.set("part_lower_engine_select", organMidi); // Organ
    state.set("part_upper_engine_select", pianoMidi); // Piano
    state.set("part_upper_enable", 1);

    const result = preflightDisabledSections(
      [{ key: "piano_model", value: 0 }],
      state,
      parameterMap,
    );

    assert.equal(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.equal(result.blockedKeys.size, 0);
  });

  it("blocks and errors when the engine is selected on a part but that part is disabled", () => {
    const state = freshState();
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const organMidi = parameterMap.resolveValue(engineParam, "Organ");
    const pianoMidi = parameterMap.resolveValue(engineParam, "Piano");
    state.set("part_lower_engine_select", organMidi);
    state.set("part_upper_engine_select", pianoMidi);
    state.set("part_upper_enable", 0);

    const result = preflightDisabledSections(
      [{ key: "piano_model", value: 0 }],
      state,
      parameterMap,
    );

    const pianoError = result.errors.find((e) => e.includes("Piano engine is currently disabled"));
    assert.ok(pianoError, `expected Piano-engine error when the only Piano part is disabled, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.blockedKeys.has("piano_model"));
  });

  it("does NOT error when same batch enables the part holding the engine", () => {
    const state = freshState();
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const pianoMidi = parameterMap.resolveValue(engineParam, "Piano");
    state.set("part_upper_engine_select", pianoMidi);
    state.set("part_upper_enable", 0); // currently disabled

    const result = preflightDisabledSections(
      [
        { key: "piano_model", value: 0 },
        { key: "part_upper_enable", value: 1 },
      ],
      state,
      parameterMap,
    );

    assert.equal(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.equal(result.blockedKeys.size, 0);
  });

  it("emits exactly one error per disabled section but blocks every touched param", () => {
    const state = freshState();
    state.set("reverb_enable", 0);

    const result = preflightDisabledSections(
      [
        { key: "reverb_dry_wet", value: 64 },
        { key: "reverb_type", value: 1 },
      ],
      state,
      parameterMap,
    );

    const reverbErrors = result.errors.filter((e) => e.includes("Reverb is currently disabled"));
    assert.equal(reverbErrors.length, 1, `expected exactly 1 Reverb error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.blockedKeys.has("reverb_dry_wet"));
    assert.ok(result.blockedKeys.has("reverb_type"));
  });

  it("does NOT error or block global / parts parameters even when every gated section is disabled", () => {
    const state = freshState();
    state.set("effect1_enable", 0);
    state.set("effect2_enable", 0);
    state.set("reverb_enable", 0);
    state.set("delay_enable", 0);
    state.set("eq_enable", 0);
    state.set("spkr_comp_enable", 0);
    state.set("part_lower_engine_select", 0);
    state.set("part_upper_engine_select", 0);

    const result = preflightDisabledSections(
      [
        { key: "master_volume", value: 100 },        // section: global
        { key: "part_mix", value: 64 },              // section: parts
      ],
      state,
      parameterMap,
    );

    assert.equal(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.equal(result.blockedKeys.size, 0);
  });

  it("blocks and errors when setting an amp parameter while spkr_comp is disabled", () => {
    const state = freshState();
    state.set("spkr_comp_enable", 0);

    const result = preflightDisabledSections(
      [{ key: "spkr_comp_drive", value: 64 }],
      state,
      parameterMap,
    );

    const ampError = result.errors.find((e) => e.includes("Amp/Speaker is currently disabled"));
    assert.ok(ampError, `expected Amp/Speaker error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.blockedKeys.has("spkr_comp_drive"));
  });

  it("does NOT error for amp params when spkr_comp_enable is on", () => {
    const state = freshState();
    state.set("spkr_comp_enable", 1);

    const result = preflightDisabledSections(
      [{ key: "spkr_comp_drive", value: 64 }],
      state,
      parameterMap,
    );

    assert.equal(result.errors.length, 0, `expected no errors, got: ${JSON.stringify(result.errors)}`);
    assert.equal(result.blockedKeys.size, 0);
  });

  it("blocks vibrato_type and errors while vibrato_enable is off", () => {
    const state = freshState();
    // Put both parts on Organ so the organ-engine rule doesn't fire — we want
    // to isolate the per-param vibrato sub-rule.
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const organMidi = parameterMap.resolveValue(engineParam, "Organ");
    state.set("part_lower_engine_select", organMidi);
    state.set("part_upper_engine_select", organMidi);
    state.set("part_upper_enable", 1);
    state.set("vibrato_enable", 0);

    const result = preflightDisabledSections(
      [{ key: "vibrato_type", value: 1 }],
      state,
      parameterMap,
    );

    const vibError = result.errors.find((e) => /vibrato.*disabled/i.test(e));
    assert.ok(vibError, `expected vibrato-disabled error, got: ${JSON.stringify(result.errors)}`);
    assert.match(vibError, /^ERROR:/);
    assert.ok(result.blockedKeys.has("vibrato_type"));
  });

  it("does NOT error when vibrato_enable is being toggled on in the same batch as vibrato_type", () => {
    const state = freshState();
    const engineParam = parameterMap.params["part_upper_engine_select"]!;
    const organMidi = parameterMap.resolveValue(engineParam, "Organ");
    state.set("part_lower_engine_select", organMidi);
    state.set("part_upper_engine_select", organMidi);
    state.set("part_upper_enable", 1);
    state.set("vibrato_enable", 0);

    const result = preflightDisabledSections(
      [
        { key: "vibrato_type", value: 1 },
        { key: "vibrato_enable", value: 1 },
      ],
      state,
      parameterMap,
    );

    assert.ok(
      !result.errors.some((e) => /vibrato.*disabled/i.test(e)),
      `expected no vibrato-disabled error when batch enables it, got: ${JSON.stringify(result.errors)}`,
    );
    assert.equal(result.blockedKeys.size, 0);
  });
});
