import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DMockHandler } from "../../../src/keyboard_models/nord/electro_5d/mock-handler.js";
import type { MockHandler } from "../../../src/shared/keyboard-model.js";

const LOWER_CH = 1;
const UPPER_CH = 2;

// Key CCs from Nord MIDI map
const CC_DRAWBAR_1 = 16;
const CC_ORGAN_PRESET_SELECT = 3;
const CC_VIBRATO_ENABLE = 85;
const CC_PERCUSSION = 87;
const CC_ORGAN_MODEL = 9;

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
      const expected = ["global", "lower", "preset1Drawbars", "preset2Drawbars", "presetOrganToggles", "upper"].sort();
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

    it("global contains non-per-part params", () => {
      const state = handler.getFullState(false);
      // organ_model is perPart, should be in lower/upper not global
      assert.ok(!state.global.drawbar_1, "drawbar_1 should not be in global");
    });
  });

  // ── Drawbar CC routing ──

  describe("drawbar CC routing", () => {
    it("drawbar CC on lower channel updates state", () => {
      handler.onMIDI({ type: "cc", controller: CC_DRAWBAR_1, value: 127, channel: LOWER_CH });
      const state = handler.getFullState(false);
      // Per-part on lower channel propagates to upper
      assert.strictEqual(state.upper.drawbar_1.value, 127);
      assert.strictEqual(state.upper.drawbar_1.position, 8);
    });

    it("drawbar CC updates active preset drawbar state", () => {
      // Default preset is preset1
      handler.onMIDI({ type: "cc", controller: CC_DRAWBAR_1, value: 127, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.preset1Drawbars.drawbar_1.position, 8);
    });
  });

  // ── Preset routing ──

  describe("preset routing", () => {
    it("switching to preset2 routes drawbar CCs to preset2", () => {
      // Switch to preset2 (value >= 64)
      handler.onMIDI({ type: "cc", controller: CC_ORGAN_PRESET_SELECT, value: 127, channel: LOWER_CH });
      // Send drawbar CC
      handler.onMIDI({ type: "cc", controller: CC_DRAWBAR_1, value: 127, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.preset2Drawbars.drawbar_1.position, 8);
    });

    it("preset1 drawbars remain unchanged when modifying preset2", () => {
      // Set preset1 drawbar to position 4
      handler.onMIDI({ type: "cc", controller: CC_DRAWBAR_1, value: 64, channel: LOWER_CH });
      // Switch to preset2
      handler.onMIDI({ type: "cc", controller: CC_ORGAN_PRESET_SELECT, value: 127, channel: LOWER_CH });
      // Set preset2 drawbar to position 8
      handler.onMIDI({ type: "cc", controller: CC_DRAWBAR_1, value: 127, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.preset1Drawbars.drawbar_1.position, 4);
      assert.strictEqual(state.preset2Drawbars.drawbar_1.position, 8);
    });
  });

  // ── Per-part CC routing ──

  describe("per-part CC routing", () => {
    it("CC on upper channel routes to upper part", () => {
      handler.onMIDI({ type: "cc", controller: CC_ORGAN_MODEL, value: 95, channel: UPPER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.upper.organ_model.value, 95);
    });
  });

  // ── Vibrato/percussion toggle routing ──

  describe("vibrato/percussion toggles", () => {
    it("vibrato enable routes to active preset toggles", () => {
      // Default is preset1
      handler.onMIDI({ type: "cc", controller: CC_VIBRATO_ENABLE, value: 127, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.presetOrganToggles.pst1Vib, true);
    });

    it("percussion enable routes to active preset toggles", () => {
      handler.onMIDI({ type: "cc", controller: CC_PERCUSSION, value: 127, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.presetOrganToggles.pst1Prc, true);
    });

    it("vibrato on preset2 updates pst2Vib", () => {
      // Switch to preset2
      handler.onMIDI({ type: "cc", controller: CC_ORGAN_PRESET_SELECT, value: 127, channel: LOWER_CH });
      handler.onMIDI({ type: "cc", controller: CC_VIBRATO_ENABLE, value: 127, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.presetOrganToggles.pst2Vib, true);
      assert.strictEqual(state.presetOrganToggles.pst1Vib, false);
    });
  });

  // ── Program change ──

  describe("program change", () => {
    it("program change updates state with bank/slot", () => {
      // Set bank via CC 32
      handler.onMIDI({ type: "cc", controller: 32, value: 0, channel: LOWER_CH });
      // Program change
      handler.onMIDI({ type: "program", number: 3, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.ok(state.program, "expected program in state");
      assert.strictEqual(state.program.bank, 1);
      assert.strictEqual(state.program.slot, 4); // 0-based program + 1
    });
  });

  // ── No-crash messages ──

  describe("no-crash messages", () => {
    it("unmapped CC does not throw", () => {
      const result = handler.onMIDI({ type: "cc", controller: 120, value: 0, channel: LOWER_CH });
      assert.ok(result.log);
    });

    it("sysex does not throw", () => {
      const result = handler.onMIDI({ type: "sysex", bytes: [0xF0, 0x7E, 0xF7] });
      assert.ok(result.log);
    });
  });
});
