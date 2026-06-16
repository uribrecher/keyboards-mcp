import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap, PARAMS } from "../../../src/keyboard_models/nord/electro_5d/midi-map.js";

const map = createParameterMap();

describe("Nord Electro 5D parameter map", () => {
  it("has no duplicate CC numbers", () => {
    const seen = new Map<number, string>();
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.cc === undefined) continue;
      assert.ok(!seen.has(param.cc), `CC ${param.cc} used by both "${seen.get(param.cc)}" and "${key}"`);
      seen.set(param.cc, key);
    }
  });

  it("all discrete params have labels and at least min/max entries", () => {
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.type !== "discrete") continue;
      assert.ok(param.labels, `${key}: discrete param missing labels`);
      const labelKeys = Object.keys(param.labels).map(Number);
      assert.ok(labelKeys.length >= 2, `${key}: discrete param needs at least 2 labels`);
      // All label keys should be within [min, max]
      for (const lk of labelKeys) {
        assert.ok(lk >= param.min && lk <= param.max, `${key}: label key ${lk} outside range [${param.min}, ${param.max}]`);
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
    assert.ok(sections.length > 0);
  });

  it("getParamsBySection returns at least one param per section", () => {
    for (const section of map.getSections()) {
      const params = map.getParamsBySection(section);
      assert.ok(Object.keys(params).length > 0, `section "${section}" has no params`);
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
    }
  });

  it("drawbar params use drawbar encoding", () => {
    for (const [key, param] of Object.entries(PARAMS)) {
      if (key.startsWith("drawbar_")) {
        assert.strictEqual(param.encoding.kind, "drawbar", `${key} should use drawbar encoding`);
      }
    }
  });
});
