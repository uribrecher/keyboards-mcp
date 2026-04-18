import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap } from "../../../src/keyboard_models/roland/juno_x/midi-map.js";
import { JunoXEngine } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";

const map = createParameterMap();
const params = map.params;

describe("JUNO-X parameter map", () => {
  it("has params from multiple engines", () => {
    // Should have params from Analog Synth, ZCore, JUNO-X Model, RD Piano, and Scene
    const asSynth = map.getParamsForEngine(JunoXEngine.AnalogSynth);
    const zcore = map.getParamsForEngine(JunoXEngine.ZCore);
    const rdPiano = map.getParamsForEngine(JunoXEngine.RDPiano);
    assert.ok(Object.keys(asSynth).length > 0, "no Analog Synth params");
    assert.ok(Object.keys(zcore).length > 0, "no ZCore params");
    assert.ok(Object.keys(rdPiano).length > 0, "no RD Piano params");
  });

  it("all discrete params have labels covering their index range", () => {
    for (const [key, param] of Object.entries(params)) {
      if (param.type !== "discrete") continue;
      assert.ok(param.labels, `${key}: discrete param missing labels`);
      const labelKeys = Object.keys(param.labels).map(Number);
      assert.ok(labelKeys.length >= 2, `${key}: discrete param needs at least 2 labels`);
      for (const lk of labelKeys) {
        assert.ok(lk >= param.min && lk <= param.max, `${key}: label key ${lk} outside range [${param.min}, ${param.max}]`);
      }
    }
  });

  it("all toggle params have labels for 0 and 1", () => {
    for (const [key, param] of Object.entries(params)) {
      if (param.type !== "toggle") continue;
      assert.ok(param.labels, `${key}: toggle param missing labels`);
      assert.ok(param.labels[0] !== undefined, `${key}: missing label for 0`);
      assert.ok(param.labels[1] !== undefined, `${key}: missing label for 1`);
    }
  });

  it("findParam returns correct param for every key", () => {
    for (const key of Object.keys(params)) {
      const found = map.findParam(key);
      assert.ok(found, `findParam("${key}") returned undefined`);
      assert.strictEqual(found.key, key);
    }
  });

  it("getSections returns non-empty array", () => {
    const sections = map.getSections();
    assert.ok(sections.length > 0);
  });

  it("getParamsBySection returns at least one param per section", () => {
    for (const section of map.getSections()) {
      const sectionParams = map.getParamsBySection(section);
      assert.ok(Object.keys(sectionParams).length > 0, `section "${section}" has no params`);
    }
  });

  it("all params have required fields", () => {
    for (const [key, param] of Object.entries(params)) {
      assert.ok(param.name, `${key}: missing name`);
      assert.ok(param.section, `${key}: missing section`);
      assert.ok(param.type, `${key}: missing type`);
      assert.ok(param.encoding, `${key}: missing encoding`);
      assert.ok(param.description, `${key}: missing description`);
      // CC or sysexAddress must be present
      assert.ok(
        param.cc !== undefined || param.sysexAddress !== undefined,
        `${key}: must have cc or sysexAddress`,
      );
    }
  });

  it("getEngineForParam returns engine for engine-specific params", () => {
    // as_cutoff is an Analog Synth param
    const engine = map.getEngineForParam("as_cutoff");
    assert.strictEqual(engine, JunoXEngine.AnalogSynth);
  });

  it("getEngineForParam returns undefined for scene params", () => {
    // Scene params don't belong to any engine
    const engine = map.getEngineForParam("chorus_type");
    assert.strictEqual(engine, undefined);
  });
});
