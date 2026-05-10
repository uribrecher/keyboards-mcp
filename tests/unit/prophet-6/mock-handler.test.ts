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

  // ── set_params routing ──

  describe("set_params routing", () => {
    it("continuous param value is stored verbatim in user domain", () => {
      handler.set_params!([{ name: "osc1_freq", value: 100 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.osc1_freq.value, 100);
    });

    it("second continuous param updates independently", () => {
      handler.set_params!([{ name: "lp_freq", value: 64 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.lp_freq.value, 64);
    });

    it("set_params returns state and log", () => {
      const result = handler.set_params!([{ name: "osc1_freq", value: 50 }]);
      assert.ok(result.state, "expected state in result");
      assert.ok(result.log, "expected log in result");
      assert.ok(result.log!.includes("Osc 1 Freq"), `expected param name in log: "${result.log}"`);
    });

    it("returns lastChange for the changed param", () => {
      const result = handler.set_params!([{ name: "osc1_freq", value: 80 }]);
      assert.ok(result.state!.lastChange, "expected lastChange");
      assert.strictEqual(result.state!.lastChange.key, "osc1_freq");
      assert.strictEqual(result.state!.lastChange.value, 80);
    });

    it("unknown param is logged but doesn't throw", () => {
      const result = handler.set_params!([{ name: "totally_made_up", value: 10 }]);
      assert.ok(result.log!.includes("unknown"), `expected 'unknown' in log: "${result.log}"`);
    });

    it("string label resolves to user-domain index", () => {
      // arp_mode has labels { 0: "Up", 1: "Down", 2: "Up/Down", ... }
      handler.set_params!([{ name: "arp_mode", value: "Down" }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.arp_mode.value, 1);
      assert.strictEqual(state.global.arp_mode.label, "Down");
    });
  });

  // ── get_params ──

  describe("get_params", () => {
    it("returns user-domain values for requested names", () => {
      handler.set_params!([{ name: "osc1_freq", value: 77 }]);
      const out = handler.get_params!(["osc1_freq", "lp_freq"]);
      assert.strictEqual(out.osc1_freq, 77);
      // lp_freq unchanged → defaultValue
      assert.ok(typeof out.lp_freq === "number");
    });

    it("skips unknown param names", () => {
      const out = handler.get_params!(["osc1_freq", "totally_made_up"]);
      assert.ok("osc1_freq" in out);
      assert.ok(!("totally_made_up" in out));
    });
  });

  // ── Toggle params ──

  describe("toggle params", () => {
    it("arp_on_off user value 1 shows On label", () => {
      handler.set_params!([{ name: "arp_on_off", value: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.arp_on_off.label, "On");
    });

    it("arp_on_off user value 0 shows Off label", () => {
      handler.set_params!([{ name: "arp_on_off", value: 0 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.arp_on_off.label, "Off");
    });
  });

  // ── Dynamic UI labels ──

  describe("dynamic UI labels in state", () => {
    it("discrete param entry includes labels object from MIDI map", () => {
      handler.set_params!([{ name: "arp_mode", value: 0 }]);
      const state = handler.getFullState(false);
      const entry = state.global.arp_mode;
      assert.ok(entry.labels, "expected labels on discrete entry");
      assert.strictEqual(entry.labels[0], "Up");
      assert.strictEqual(entry.labels[2], "Up/Down");
    });

    it("continuous param entry has no labels field", () => {
      handler.set_params!([{ name: "osc1_freq", value: 100 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.osc1_freq.labels, undefined);
    });

    it("toggle param entry has no labels field", () => {
      handler.set_params!([{ name: "arp_on_off", value: 1 }]);
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.arp_on_off.labels, undefined);
    });

    it("labels survive across getFullState calls", () => {
      const a = handler.getFullState(false);
      const b = handler.getFullState(false);
      assert.ok(a.global.arp_mode.labels);
      assert.ok(b.global.arp_mode.labels);
    });

    it("displayName is absent from state entry when not set in midi-map", () => {
      const state = handler.getFullState(false);
      assert.strictEqual(state.global.osc1_freq.displayName, undefined);
    });
  });

  // ── onMIDI is a no-op (codec path bypasses it) ──

  describe("onMIDI no-op", () => {
    it("returns empty result for cc message", () => {
      const result = handler.onMIDI({ type: "cc", controller: 67, value: 100, channel: 0 });
      assert.deepStrictEqual(result, {});
    });

    it("returns empty result for program change", () => {
      const result = handler.onMIDI({ type: "program", number: 5, channel: 0 });
      assert.deepStrictEqual(result, {});
    });

    it("returns empty result for sysex", () => {
      const result = handler.onMIDI({ type: "sysex", bytes: [0xF0, 0x7E, 0xF7] });
      assert.deepStrictEqual(result, {});
    });
  });
});
