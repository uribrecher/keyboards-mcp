/**
 * Prophet-6 MidiCodec — wire ↔ user-domain round-trips.
 *
 * Prophet-6 uses the shared CC-only codec, so this exercises:
 * - encodeParams: user value → CC bytes (raw 0-127 for continuous; index
 *   scaled to 0-127 for discrete/toggle).
 * - decode for CC: CC bytes → user-domain {kind:"param", name, value}
 *   events (continuous unchanged; discrete/toggle quantized to index).
 * - decode for program-change: emits {kind:"loadProgram", bank:0, slot}.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createProphet6Codec } from "../../../src/keyboard_models/sequential_circuits/prophet_6/midi-codec.js";

describe("Prophet-6 codec — encode", () => {
  const codec = createProphet6Codec();

  it("encodes a continuous CC param verbatim", () => {
    const msgs = codec.encodeParams([{ name: "osc1_freq", value: 100 }]);
    assert.strictEqual(msgs.length, 1);
    const msg = msgs[0];
    assert.strictEqual(msg.type, "cc");
    if (msg.type !== "cc") return;
    assert.strictEqual(msg.controller, 67);
    assert.strictEqual(msg.value, 100);
  });

  it("encodes a toggle param's user-domain index as a wire byte", () => {
    // arp_on_off: max=1, encoding=raw → user 1 → wire 127, user 0 → wire 0
    const on = codec.encodeParams([{ name: "arp_on_off", value: 1 }])[0];
    const off = codec.encodeParams([{ name: "arp_on_off", value: 0 }])[0];
    assert.strictEqual(on.type, "cc");
    assert.strictEqual(off.type, "cc");
    if (on.type !== "cc" || off.type !== "cc") return;
    assert.strictEqual(on.value, 127);
    assert.strictEqual(off.value, 0);
  });

  it("encodes a discrete param string label as the labeled index's wire byte", () => {
    // arp_mode: labels {0:"Up",1:"Down",2:"Up/Down",...}, max=4
    // user index 2 → wire round(2/4 * 127) = 64
    const msg = codec.encodeParams([{ name: "arp_mode", value: "Up/Down" }])[0];
    assert.strictEqual(msg.type, "cc");
    if (msg.type !== "cc") return;
    assert.strictEqual(msg.value, 64);
  });

  it("throws for unknown param name", () => {
    assert.throws(() => codec.encodeParams([{ name: "definitely_not_a_param", value: 0 }]));
  });
});

describe("Prophet-6 codec — decode", () => {
  const codec = createProphet6Codec();

  it("decodes a continuous CC verbatim into a param event", () => {
    const events = codec.decode({ type: "cc", controller: 67, value: 100, channel: 0 });
    assert.strictEqual(events.length, 1);
    const e = events[0];
    assert.strictEqual(e.kind, "param");
    if (e.kind === "param") {
      assert.strictEqual(e.name, "osc1_freq");
      assert.strictEqual(e.value, 100);
    }
  });

  it("quantizes a toggle CC to its user-domain index", () => {
    // arp_on_off: max=1 → wire 127 → user 1; wire 0 → user 0
    const onEv = codec.decode({ type: "cc", controller: 58, value: 127, channel: 0 })[0];
    const offEv = codec.decode({ type: "cc", controller: 58, value: 0, channel: 0 })[0];
    assert.strictEqual(onEv.kind, "param");
    assert.strictEqual(offEv.kind, "param");
    if (onEv.kind !== "param" || offEv.kind !== "param") return;
    assert.strictEqual(onEv.value, 1);
    assert.strictEqual(offEv.value, 0);
  });

  it("quantizes a discrete CC to its user-domain index", () => {
    // arp_mode: max=4 → wire 64 → user 2 ("Up/Down")
    const ev = codec.decode({ type: "cc", controller: 59, value: 64, channel: 0 })[0];
    assert.strictEqual(ev.kind, "param");
    if (ev.kind !== "param") return;
    assert.strictEqual(ev.value, 2);
  });

  it("returns no events for an unmapped CC", () => {
    const events = codec.decode({ type: "cc", controller: 120, value: 42, channel: 0 });
    assert.deepStrictEqual(events, []);
  });

  it("decodes a program change into a loadProgram event with bank=0", () => {
    const events = codec.decode({ type: "program", number: 7, channel: 0 });
    assert.strictEqual(events.length, 1);
    const e = events[0];
    assert.strictEqual(e.kind, "loadProgram");
    if (e.kind === "loadProgram") {
      assert.strictEqual(e.bank, 0);
      assert.strictEqual(e.slot, 7);
    }
  });
});

describe("Prophet-6 codec — round-trip user→wire→user", () => {
  const codec = createProphet6Codec();

  it("continuous param round-trips verbatim", () => {
    const cc = codec.encodeParams([{ name: "osc1_freq", value: 77 }])[0];
    if (cc.type !== "cc") throw new Error("expected cc message");
    const ev = codec.decode({ type: "cc", controller: cc.controller, value: cc.value, channel: 0 })[0];
    assert.strictEqual(ev.kind, "param");
    if (ev.kind !== "param") return;
    assert.strictEqual(ev.value, 77);
  });

  it("toggle param round-trips", () => {
    for (const userValue of [0, 1]) {
      const cc = codec.encodeParams([{ name: "arp_on_off", value: userValue }])[0];
      if (cc.type !== "cc") throw new Error("expected cc message");
      const ev = codec.decode({ type: "cc", controller: cc.controller, value: cc.value, channel: 0 })[0];
      assert.strictEqual(ev.kind, "param");
      if (ev.kind !== "param") continue;
      assert.strictEqual(ev.value, userValue);
    }
  });

  it("discrete param round-trips for every label", () => {
    // arp_mode max=4 → 5 labels
    for (let userValue = 0; userValue <= 4; userValue++) {
      const cc = codec.encodeParams([{ name: "arp_mode", value: userValue }])[0];
      if (cc.type !== "cc") throw new Error("expected cc message");
      const ev = codec.decode({ type: "cc", controller: cc.controller, value: cc.value, channel: 0 })[0];
      assert.strictEqual(ev.kind, "param");
      if (ev.kind !== "param") continue;
      assert.strictEqual(ev.value, userValue);
    }
  });
});
