import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createJunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { buildDT1 } from "../../../src/shared/roland-dt1.js";
import { JUNO_X_MODEL_ID } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import type { MockHandler } from "../../../src/shared/keyboard-model.js";

const LOWER_CH = 0;
const UPPER_CH = 1;

let handler: MockHandler;

describe("JUNO-X mock handler", () => {
  beforeEach(() => {
    handler = createJunoXMockHandler();
    handler.init(LOWER_CH, UPPER_CH);
  });

  // ── State shape ──

  describe("state shape", () => {
    it("getFullState has expected top-level keys", () => {
      const state = handler.getFullState(false);
      const keys = Object.keys(state).sort();
      const expected = ["model", "part1", "part2", "part3", "part4", "part5", "scene", "sceneGlobal"].sort();
      assert.deepStrictEqual(keys, expected);
    });

    it("model field is Roland JUNO-X", () => {
      const state = handler.getFullState(false);
      assert.strictEqual(state.model, "Roland JUNO-X");
    });

    it("each part has engine, engineName, params, sceneParams", () => {
      const state = handler.getFullState(false);
      for (let i = 1; i <= 5; i++) {
        const part = state[`part${i}`];
        assert.ok("engine" in part, `part${i} missing engine`);
        assert.ok("engineName" in part, `part${i} missing engineName`);
        assert.ok("params" in part, `part${i} missing params`);
        assert.ok("sceneParams" in part, `part${i} missing sceneParams`);
      }
    });

    it("scene has bank and program fields", () => {
      const state = handler.getFullState(false);
      assert.ok("bank" in state.scene, "scene missing bank");
      assert.ok("program" in state.scene, "scene missing program");
    });
  });

  // ── CC routing ──

  describe("CC routing", () => {
    it("CC on lower channel routes to part1", () => {
      handler.onMIDI({ type: "cc", controller: 16, value: 100, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.part1.params.cc16, 100);
    });

    it("CC on upper channel routes to part2", () => {
      handler.onMIDI({ type: "cc", controller: 17, value: 80, channel: UPPER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.part2.params.cc17, 80);
    });

    it("CC on unmapped channel does not crash", () => {
      const result = handler.onMIDI({ type: "cc", controller: 16, value: 50, channel: 15 });
      assert.ok(result.log);
    });

    it("Bank Select MSB (CC 0) does not route to part params", () => {
      handler.onMIDI({ type: "cc", controller: 0, value: 5, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.part1.params.cc0, undefined);
    });

    it("Bank Select LSB (CC 32) does not route to part params", () => {
      handler.onMIDI({ type: "cc", controller: 32, value: 3, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.part1.params.cc32, undefined);
    });

    it("onMIDI returns state and log for mapped CC", () => {
      const result = handler.onMIDI({ type: "cc", controller: 16, value: 64, channel: LOWER_CH });
      assert.ok(result.state, "expected state");
      assert.ok(result.log, "expected log");
    });
  });

  // ── Program change ──

  describe("program change", () => {
    it("program change updates scene bank and program", () => {
      // Set bank MSB + LSB
      handler.onMIDI({ type: "cc", controller: 0, value: 1, channel: LOWER_CH });
      handler.onMIDI({ type: "cc", controller: 32, value: 2, channel: LOWER_CH });
      // Program change
      handler.onMIDI({ type: "program", number: 5, channel: LOWER_CH });
      const state = handler.getFullState(false);
      assert.strictEqual(state.scene.program, 5);
      // Bank = (MSB << 7) | LSB = (1 << 7) | 2 = 130
      assert.strictEqual(state.scene.bank, 130);
    });
  });

  // ── SysEx DT1 ──

  describe("SysEx DT1", () => {
    it("DT1 to scene global address updates sceneGlobal", () => {
      // Address 0x01, 0x00, 0x00, 0x00 = Temporary Scene, global area
      const sysex = buildDT1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x00, 0x00, 0x00], [42]);
      const result = handler.onMIDI({ type: "sysex", bytes: sysex });
      assert.ok(result.state, "expected state broadcast");
      const state = handler.getFullState(false);
      // sceneGlobal should have an entry
      assert.ok(Object.keys(state.sceneGlobal).length > 0, "sceneGlobal should have entries");
    });

    it("DT1 to part address updates part sceneParams", () => {
      // Address 0x01, 0x10, 0x00, 0x00 = Temporary Scene, Part 1
      const sysex = buildDT1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x10, 0x00, 0x00], [99]);
      handler.onMIDI({ type: "sysex", bytes: sysex });
      const state = handler.getFullState(false);
      assert.ok(Object.keys(state.part1.sceneParams).length > 0, "part1 sceneParams should have entries");
    });

    it("invalid SysEx does not crash", () => {
      const result = handler.onMIDI({ type: "sysex", bytes: [0xF0, 0x7E, 0xF7] });
      assert.ok(result.log);
    });

    it("DT1 with wrong model ID is ignored", () => {
      const wrongModel = { bytes: [0x00, 0x00, 0x00, 0x00, 0xFF] };
      const sysex = buildDT1(wrongModel, 0x10, [0x01, 0x00, 0x00, 0x00], [42]);
      const result = handler.onMIDI({ type: "sysex", bytes: sysex });
      assert.ok(result.log!.includes("ignored"), `expected 'ignored' in log: "${result.log}"`);
    });
  });
});
