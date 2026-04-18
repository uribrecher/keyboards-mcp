import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap, PARAMS } from "../../../src/keyboard_models/sequential_circuits/prophet_6/midi-map.js";

const map = createParameterMap();

describe("Prophet-6 parameter map", () => {
  it("has no duplicate CC numbers", () => {
    const seen = new Map<number, string>();
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.cc === undefined) continue;
      assert.ok(!seen.has(param.cc), `CC ${param.cc} used by both "${seen.get(param.cc)}" and "${key}"`);
      seen.set(param.cc, key);
    }
  });

  it("all discrete params have labels covering their index range", () => {
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.type !== "discrete") continue;
      assert.ok(param.labels, `${key}: discrete param missing labels`);
      for (let i = param.min; i <= param.max; i++) {
        assert.ok(
          param.labels[i] !== undefined,
          `${key}: missing label for index ${i} (range ${param.min}-${param.max})`,
        );
      }
    }
  });

  it("all toggle params have labels for 0 and 1", () => {
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.type !== "toggle") continue;
      assert.ok(param.labels, `${key}: toggle param missing labels`);
      assert.ok(param.labels[0] !== undefined, `${key}: missing label for 0`);
      assert.ok(param.labels[1] !== undefined, `${key}: missing label for 1`);
    }
  });

  it("findParam returns correct param for every key", () => {
    for (const key of Object.keys(PARAMS)) {
      const found = map.findParam(key);
      assert.ok(found, `findParam("${key}") returned undefined`);
      assert.strictEqual(found.key, key);
    }
  });

  it("getSections returns non-empty array", () => {
    const sections = map.getSections();
    assert.ok(sections.length > 0, "getSections returned empty array");
  });

  it("getParamsBySection returns at least one param per section", () => {
    for (const section of map.getSections()) {
      const params = map.getParamsBySection(section);
      assert.ok(
        Object.keys(params).length > 0,
        `section "${section}" has no params`,
      );
    }
  });

  it("all params have required fields", () => {
    for (const [key, param] of Object.entries(PARAMS)) {
      assert.ok(param.name, `${key}: missing name`);
      assert.ok(param.section, `${key}: missing section`);
      assert.ok(param.cc !== undefined, `${key}: missing cc`);
      assert.ok(param.type, `${key}: missing type`);
      assert.ok(param.encoding, `${key}: missing encoding`);
      assert.ok(param.description, `${key}: missing description`);
      assert.ok(param.min !== undefined, `${key}: missing min`);
      assert.ok(param.max !== undefined, `${key}: missing max`);
    }
  });
});