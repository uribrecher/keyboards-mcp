import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DMockHandler } from "../../../src/keyboard_models/nord/electro_5d/mock-handler.js";
import type { MockHandler } from "../../../src/shared/keyboard-model.js";

const LOWER_CH = 1;
const UPPER_CH = 2;

let handler: MockHandler;

describe("Nord Electro 5D mock handler", () => {
  beforeEach(() => {
    handler = createNordElectro5DMockHandler();
    handler.init(LOWER_CH, UPPER_CH);
  });

  // ── State shape ──

  describe("state shape", () => {
    it("getFullState has expected top-level keys", () => {
      const state = handler.getFullState(false);
      const keys = Object.keys(state).sort();
      const expected = [
        "global", "lower", "upper",
        "preset1Drawbars", "preset2Drawbars",
        "presetOrganToggles",
        "currentBank", "currentProgram", "programLoaded",
        "setListMode", "currentSetList", "currentSong", "currentPart",
      ].sort();
      assert.deepStrictEqual(keys, expected);
    });

    it("getFullState with inventory has pianoModels and sampleNames", () => {
      const state = handler.getFullState(true);
      assert.ok("pianoModels" in state, "missing pianoModels");
      assert.ok("sampleNames" in state, "missing sampleNames");
    });

    it("lower and upper contain per-part params", () => {
      const state = handler.getFullState(false);
      assert.ok(state.lower.drawbar_1, "lower missing drawbar_1");
      assert.ok(state.upper.drawbar_1, "upper missing drawbar_1");
    });

    it("global does not contain per-part params", () => {
      const state = handler.getFullState(false);
      assert.ok(!state.global.drawbar_1, "drawbar_1 should not be in global");
    });
  });

  // ── set_params: drawbar routing ──

  describe("drawbar routing", () => {
    it("drawbar set with part 1 propagates to upper (auto-propagate)", () => {
      handler.set_params!([{ name: "drawbar_1", value: 8, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.upper.drawbar_1.value, 8);
      assert.strictEqual(state.upper.drawbar_1.position, 8);
      assert.strictEqual(state.lower.drawbar_1.position, 8);
    });

    it("drawbar set updates active preset drawbar state", () => {
      // Default preset is preset1
      handler.set_params!([{ name: "drawbar_1", value: 8, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.preset1Drawbars.drawbar_1.position, 8);
    });
  });

  // ── set_params: preset routing ──

  describe("preset routing", () => {
    it("switching active preset routes drawbar writes to preset2", () => {
      // Switch to Preset 2 (user value 1)
      handler.set_params!([{ name: "organ_preset_select", value: 1 }]);
      handler.set_params!([{ name: "drawbar_1", value: 8, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.preset2Drawbars.drawbar_1.position, 8);
    });

    it("preset1 drawbars remain unchanged when modifying preset2", () => {
      handler.set_params!([{ name: "drawbar_1", value: 4, part: 1 }]);
      handler.set_params!([{ name: "organ_preset_select", value: 1 }]);
      handler.set_params!([{ name: "drawbar_1", value: 8, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.preset1Drawbars.drawbar_1.position, 4);
      assert.strictEqual(state.preset2Drawbars.drawbar_1.position, 8);
    });
  });

  // ── set_params: per-part routing ──

  describe("per-part routing", () => {
    it("set with part 2 routes to upper only", () => {
      handler.set_params!([{ name: "organ_model", value: 3, part: 2 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.upper.organ_model.value, 3);
    });

    it("set without part defaults to lower and propagates to upper", () => {
      handler.set_params!([{ name: "organ_model", value: 3 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.lower.organ_model.value, 3);
      assert.strictEqual(state.upper.organ_model.value, 3);
    });
  });

  // ── Vibrato/percussion toggle routing ──

  describe("vibrato/percussion toggles", () => {
    it("vibrato_enable on default preset (1) updates pst1Vib", () => {
      handler.set_params!([{ name: "vibrato_enable", value: 1, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.presetOrganToggles.pst1Vib, true);
    });

    it("percussion on default preset (1) updates pst1Prc", () => {
      handler.set_params!([{ name: "percussion", value: 1, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.presetOrganToggles.pst1Prc, true);
    });

    it("vibrato on preset2 updates pst2Vib", () => {
      handler.set_params!([{ name: "organ_preset_select", value: 1 }]);
      handler.set_params!([{ name: "vibrato_enable", value: 1, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.presetOrganToggles.pst2Vib, true);
      assert.strictEqual(state.presetOrganToggles.pst1Vib, false);
    });
  });

  // ── load_program ──

  describe("load_program", () => {
    it("updates state with bank/slot", () => {
      handler.load_program!(0, 3);
      const state = handler.getFullState(false);
      assert.ok(state.program, "expected program in state");
      assert.strictEqual(state.program.bank, 1);
      assert.strictEqual(state.program.slot, 4);
    });
  });

  // ── Active engine getters/setters ──

  describe("active engine", () => {
    it("get_active_engine returns 'organ' by default", () => {
      assert.strictEqual(handler.get_active_engine!(1), "organ");
      assert.strictEqual(handler.get_active_engine!(2), "organ");
    });

    it("set_active_engine routes to the right per-part engine selector", () => {
      handler.set_active_engine!(2, "piano");
      assert.strictEqual(handler.get_active_engine!(2), "piano");
      // Lower part unchanged.
      assert.strictEqual(handler.get_active_engine!(1), "organ");
    });
  });

  // ── Dynamic UI labels ──

  describe("dynamic UI labels in state", () => {
    it("discrete param entry includes labels object from MIDI map", () => {
      handler.set_params!([{ name: "organ_model", value: 0, part: 2 }]);
      const state = handler.getFullState(false);
      const entry = state.upper.organ_model;
      assert.ok(entry.labels, "expected labels on discrete entry");
      assert.strictEqual(entry.labels[0], "B3");
    });

    it("continuous param entry has no labels field", () => {
      handler.set_params!([{ name: "drawbar_1", value: 4, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.lower.drawbar_1.labels, undefined);
    });

    it("toggle param entry has no labels field", () => {
      handler.set_params!([{ name: "vibrato_enable", value: 1, part: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.lower.vibrato_enable.labels, undefined);
    });

    it("labels survive across getFullState calls", () => {
      const a = handler.getFullState(false);
      const b = handler.getFullState(false);
      assert.ok(a.upper.organ_model.labels);
      assert.ok(b.upper.organ_model.labels);
    });

    it("displayName flows from midi-map to state entry when set", () => {
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.effect1_rate.displayName, "RATE");
    });

    it("displayName is absent from state entry when not set", () => {
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.master_volume.displayName, undefined);
    });
  });

  // ── Unknown param ──

  describe("set_params unknown", () => {
    it("logs unknown name without throwing", () => {
      const result = handler.set_params!([{ name: "totally_made_up", value: 1 }]);
      assert.ok(result.log!.includes("unknown"), `expected 'unknown' in log: "${result.log}"`);
    });
  });
});
