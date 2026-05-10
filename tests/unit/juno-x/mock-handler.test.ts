/**
 * JUNO-X mock handler — stage 5 (pure param-domain handler).
 *
 * The handler no longer speaks MIDI. Tests verify the public API:
 * `set_params`, `get_params`, `load_program`, `getFullState` shape.
 * `onMIDI` is a no-op stub kept only for interface compatibility.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createJunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import type { MockHandler } from "../../../src/shared/keyboard-model.js";

const LOWER_CH = 0;
const UPPER_CH = 1;

let handler: MockHandler;

describe("JUNO-X mock handler (stage 5 — pure param domain)", () => {
  beforeEach(() => {
    handler = createJunoXMockHandler();
    handler.init(LOWER_CH, UPPER_CH);
  });

  describe("state shape", () => {
    it("getFullState has expected top-level keys", () => {
      const state = handler.getFullState(false);
      const keys = Object.keys(state).sort();
      const expected = ["model", "params", "part1", "part2", "part3", "part4", "part5", "scene"].sort();
      assert.deepStrictEqual(keys, expected);
    });

    it("model field is Roland JUNO-X", () => {
      const state = handler.getFullState(false);
      assert.strictEqual(state.model, "Roland JUNO-X");
    });

    it("each part has engine, engineName, and a name-keyed params record", () => {
      const state = handler.getFullState(false);
      for (let i = 1; i <= 5; i++) {
        const part = state[`part${i}`];
        assert.ok("engine" in part, `part${i} missing engine`);
        assert.ok("engineName" in part, `part${i} missing engineName`);
        assert.ok(typeof part.params === "object" && part.params !== null, `part${i}.params missing`);
      }
    });

    it("scene has bank and program fields", () => {
      const state = handler.getFullState(false);
      assert.ok("bank" in state.scene, "scene missing bank");
      assert.ok("program" in state.scene, "scene missing program");
    });

    it("params is name-keyed and starts empty", () => {
      const state = handler.getFullState(false);
      assert.deepEqual(state.params, {});
    });
  });

  describe("set_params + get_params (param-domain API)", () => {
    it("set_params writes a scene-global param; get_params reads it back as user-domain", () => {
      handler.set_params!([{ name: "chorus_switch", value: 1 }, { name: "chorus_level", value: 80 }]);
      const values = handler.get_params!(["chorus_switch", "chorus_level"]);
      assert.equal(values.chorus_switch, 1);  // user-domain — NOT 127
      assert.equal(values.chorus_level, 80);
    });

    it("string label is normalized to user-domain index", () => {
      handler.set_params!([{ name: "chorus_switch", value: "ON" }]);
      const values = handler.get_params!(["chorus_switch"]);
      assert.equal(values.chorus_switch, 1);
    });

    it("set_params writes a per-part CC param to the named part", () => {
      handler.set_params!([{ name: "as_lfo_rate", value: 64, part: 1 }]);
      handler.set_params!([{ name: "as_lfo_rate", value: 100, part: 3 }]);
      assert.equal(handler.get_params!(["as_lfo_rate"], 1).as_lfo_rate, 64);
      assert.equal(handler.get_params!(["as_lfo_rate"], 3).as_lfo_rate, 100);
    });

    it("set_params returns state for broadcast and a log line", () => {
      const result = handler.set_params!([{ name: "chorus_switch", value: 1 }]);
      assert.ok(result.state);
      assert.match(result.log ?? "", /Chorus Switch/);
    });

    it("unknown param name is logged but doesn't throw", () => {
      const result = handler.set_params!([{ name: "definitely_not_a_param", value: 1 }]);
      assert.match(result.log ?? "", /unknown/i);
    });

    it("get_params returns the param's defaultValue when unset", () => {
      const values = handler.get_params!(["chorus_level"]);
      // chorus_level defaultValue is 64.
      assert.equal(values.chorus_level, 64);
    });
  });

  describe("load_program", () => {
    it("updates scene bank and program", () => {
      handler.load_program!(130, 5);
      const state = handler.getFullState(false);
      assert.equal(state.scene.bank, 130);
      assert.equal(state.scene.program, 5);
    });
  });

  describe("onMIDI is a no-op in stage 5", () => {
    it("returns an empty result and does not affect state", () => {
      const before = handler.getFullState(false);
      const result = handler.onMIDI({ type: "cc", controller: 16, value: 100, channel: 0 });
      assert.deepEqual(result, {});
      const after = handler.getFullState(false);
      assert.deepEqual(after, before);
    });
  });

  describe("broadcast `params` view", () => {
    it("surfaces written scene-global params by name", () => {
      handler.set_params!([
        { name: "chorus_switch", value: 1 },
        { name: "delay_switch", value: 1 },
        { name: "chorus_level", value: 90 },
      ]);
      const state = handler.getFullState(false);
      assert.equal(state.params.chorus_switch, 1);
      assert.equal(state.params.delay_switch, 1);
      assert.equal(state.params.chorus_level, 90);
    });
  });
});
