import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DMockHandler } from "../../../src/keyboard_models/nord/electro_5d/mock-handler.js";
import type { MockHandler } from "../../../src/shared/keyboard-model.js";

let handler: MockHandler;

describe("Nord Electro 5D mock handler — state queries & restore", () => {
  beforeEach(() => {
    handler = createNordElectro5DMockHandler();
    handler.init(1, 2);
  });

  describe("get_params", () => {
    it("returns stored user-domain values for the requested part", () => {
      handler.set_params!([{ name: "organ_model", value: 3, part: 2 }]);
      const upper = handler.get_params!(["organ_model"], 2);
      assert.strictEqual(upper.organ_model, 3);
    });

    it("returns defaults for params that were never set, and skips unknown names", () => {
      const out = handler.get_params!(["master_volume", "totally_unknown"], 1);
      assert.ok("master_volume" in out);
      assert.ok(!("totally_unknown" in out));
    });
  });

  describe("set_active_engine", () => {
    it("logs an error for an unknown engine name", () => {
      const result = handler.set_active_engine!(1, "theremin");
      assert.match(result.log!, /unknown engine/i);
    });
  });

  describe("set_params error handling", () => {
    it("logs a normalize error without throwing for an unresolvable value", () => {
      const result = handler.set_params!([{ name: "organ_model", value: "Bogus" }]);
      assert.match(result.log!, /Bogus/);
      // The handler still returns a valid state object.
      assert.ok(result.state);
    });
  });

  describe("amp rotary 'Both' override", () => {
    it("forces spkr_comp_part_select to Both when both engines are organ and amp is rotary", () => {
      handler.set_params!([{ name: "part_lower_engine_select", value: 0, part: 1 }]);
      handler.set_params!([{ name: "part_upper_engine_select", value: 0, part: 2 }]);
      handler.set_params!([{ name: "spkr_comp_type", value: 4 }]); // Rotary
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.spkr_comp_part_select.label, "Both");
      assert.strictEqual(state.global.spkr_comp_part_select.index, 2);
    });
  });

  describe("set-list mode", () => {
    it("enabling set-list mode then selecting a part populates the setList state", () => {
      handler.set_params!([{ name: "program_setlist_mode", value: 1 }]);
      const result = handler.set_params!([{ name: "setlist_part_select", value: 2 }]);
      assert.strictEqual(result.state!.setListMode, true);
      assert.ok(result.state!.setList, "expected setList block in state");
      assert.strictEqual(result.state!.setList.part, "C"); // part index 2
    });

    it("load_program in set-list mode loads a song rather than a program", () => {
      handler.set_params!([{ name: "program_setlist_mode", value: 1 }]);
      const result = handler.load_program!(0, 3);
      // No backup cache on disk → resolves to "no program found", but stays in set-list mode.
      assert.match(result.log!, /Set List/);
      assert.strictEqual(result.state!.setListMode, true);
    });
  });

  describe("setFullState (tolerant restore)", () => {
    it("round-trips a snapshot produced by getFullState", () => {
      handler.set_params!([{ name: "organ_model", value: 2, part: 2 }]);
      handler.set_params!([{ name: "master_volume", value: 99 }]);
      handler.set_params!([{ name: "drawbar_1", value: 7, part: 1 }]);
      handler.set_params!([{ name: "vibrato_enable", value: 1, part: 1 }]);
      const snapshot = handler.getFullState(false);

      const fresh = createNordElectro5DMockHandler();
      fresh.init(1, 2);
      fresh.setFullState!(snapshot);
      const restored = fresh.getFullState(false);

      assert.strictEqual(restored.upper.organ_model.value, 2);
      assert.strictEqual(restored.global.master_volume.value, 99);
      assert.strictEqual(restored.preset1Drawbars.drawbar_1.value, 7);
      assert.strictEqual(restored.presetOrganToggles.pst1Vib, true);
    });

    it("restores program / set-list scalar fields", () => {
      handler.setFullState!({
        setListMode: true,
        currentSetList: 1,
        currentSong: 2,
        currentPart: 3,
        currentBank: 4,
        currentProgram: 5,
        programLoaded: true,
      });
      const state = handler.getFullState(false);
      assert.strictEqual(state.setListMode, true);
      assert.strictEqual(state.currentSong, 2);
      assert.strictEqual(state.currentBank, 4);
      assert.strictEqual(state.programLoaded, true);
    });

    it("tolerates malformed snapshot input without throwing", () => {
      assert.doesNotThrow(() =>
        handler.setFullState!({
          lower: null,
          upper: "not an object",
          global: { organ_model: { value: "not a number" }, unknown_key: { value: 1 } },
          preset1Drawbars: 42,
          presetOrganToggles: "nope",
          currentBank: "five",
        }),
      );
    });
  });

  describe("onCacheReload", () => {
    it("does not throw when no backup cache file exists on disk", () => {
      assert.doesNotThrow(() => handler.onCacheReload!());
    });
  });
});
