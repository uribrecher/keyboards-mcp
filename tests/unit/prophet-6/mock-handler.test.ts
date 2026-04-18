import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { createProphet6MockHandler } from "../../../src/keyboard_models/sequential_circuits/prophet_6/mock-handler.js";
import type { MockHandler } from "../../../src/shared/keyboard-model.js";

let handler: MockHandler;

describe("Prophet-6 mock handler", () => {
  beforeEach(() => {
    handler = createProphet6MockHandler();
    handler.init(0, 1);
  });

  // ── State shape ──

  describe("state shape", () => {
    it("getFullState returns object with only 'global' at top level", () => {
      const state = handler.getFullState(false);
      const keys = Object.keys(state);
      assert.deepStrictEqual(keys, ["global"]);
    });

    it("global contains all expected parameter keys", () => {
      const state = handler.getFullState(false);
      const global = state.global;
      assert.ok(global.osc1_freq, "missing osc1_freq");
      assert.ok(global.osc1_level, "missing osc1_level");
      assert.ok(global.lp_freq, "missing lp_freq");
      assert.ok(global.vca_env_attack, "missing vca_env_attack");
      assert.ok(global.arp_on_off, "missing arp_on_off");
      assert.ok(global.distortion_amount, "missing distortion_amount");
    });

    it("each param entry has required fields", () => {
      const state = handler.getFullState(false);
      const entry = state.global.osc1_freq;
      assert.ok("value" in entry, "missing value");
      assert.ok("label" in entry, "missing label");
      assert.ok("name" in entry, "missing name");
      assert.ok("section" in entry, "missing section");
      assert.ok("type" in entry, "missing type");
    });
  });

  // ── CC routing ──

  describe("CC routing", () => {
    it("CC 67 (osc1_freq) with value 100 updates state", () => {
      handler.onMIDI({ type: "cc", controller: 67, value: 100, channel: 0 });
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.osc1_freq.value, 100);
    });

    it("CC 102 (lp_freq) with value 64 updates state", () => {
      handler.onMIDI({ type: "cc", controller: 102, value: 64, channel: 0 });
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.lp_freq.value, 64);
    });

    it("onMIDI returns state and log for mapped CC", () => {
      const result = handler.onMIDI({ type: "cc", controller: 67, value: 50, channel: 0 });
      assert.ok(result.state, "expected state in result");
      assert.ok(result.log, "expected log in result");
      assert.ok(result.log!.includes("Osc 1 Freq"), `expected param name in log: "${result.log}"`);
    });

    it("onMIDI returns lastChange for the changed param", () => {
      const result = handler.onMIDI({ type: "cc", controller: 67, value: 80, channel: 0 });
      assert.ok(result.state!.lastChange, "expected lastChange");
      assert.strictEqual(result.state!.lastChange.key, "osc1_freq");
      assert.strictEqual(result.state!.lastChange.value, 80);
    });
  });

  // ── Toggle params ──

  describe("toggle params", () => {
    it("arp_on_off CC 58 with value 127 shows On label", () => {
      handler.onMIDI({ type: "cc", controller: 58, value: 127, channel: 0 });
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.arp_on_off.label, "On");
    });

    it("arp_on_off CC 58 with value 0 shows Off label", () => {
      handler.onMIDI({ type: "cc", controller: 58, value: 0, channel: 0 });
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.arp_on_off.label, "Off");
    });
  });

  // ── Bank select ignored ──

  describe("bank select", () => {
    it("CC 0 (Bank Select MSB) does not update param state", () => {
      const stateBefore = JSON.stringify(handler.getFullState(false));
      handler.onMIDI({ type: "cc", controller: 0, value: 5, channel: 0 });
      const stateAfter = JSON.stringify(handler.getFullState(false));
      assert.strictEqual(stateBefore, stateAfter);
    });

    it("CC 32 (Bank Select LSB) does not update param state", () => {
      const stateBefore = JSON.stringify(handler.getFullState(false));
      handler.onMIDI({ type: "cc", controller: 32, value: 3, channel: 0 });
      const stateAfter = JSON.stringify(handler.getFullState(false));
      assert.strictEqual(stateBefore, stateAfter);
    });
  });

  // ── No-crash on program change and sysex ──

  describe("no-crash messages", () => {
    it("program change does not throw", () => {
      const result = handler.onMIDI({ type: "program", number: 5, channel: 0 });
      assert.ok(result.log, "expected a log message");
    });

    it("sysex does not throw", () => {
      const result = handler.onMIDI({ type: "sysex", bytes: [0xF0, 0x7E, 0xF7] });
      assert.ok(result.log, "expected a log message");
    });

    it("unmapped CC does not throw", () => {
      const result = handler.onMIDI({ type: "cc", controller: 120, value: 0, channel: 0 });
      assert.ok(result.log, "expected a log message");
      assert.ok(result.log!.includes("unmapped"), `expected 'unmapped' in log: "${result.log}"`);
    });
  });
});
