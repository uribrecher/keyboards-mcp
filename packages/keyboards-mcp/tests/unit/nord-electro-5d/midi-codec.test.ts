/**
 * Nord Electro 5D codec — wire ↔ user-domain round-trips.
 *
 * Nord uses the shared CC-only codec but with non-trivial encodings
 * (drawbar 0-8, per-part channel routing, model-index, one-based) so
 * these round-trips matter more than the bare smoke test.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DCodec } from "../../../src/keyboard_models/nord/electro_5d/midi-codec.js";

describe("Nord codec — encode", () => {
  const codec = createNordElectro5DCodec();

  it("encodes a drawbar param with user position 0-8", () => {
    // drawbar_1 cc=16, encoding=drawbar (positions=9 → user 0..8 maps to wire ~0,16,32,48,64,80,96,112,127)
    const enc = codec.encodeParams([{ name: "drawbar_1", value: 8, part: 1 }])[0];
    assert.strictEqual(enc.type, "cc");
    if (enc.type !== "cc") return;
    assert.strictEqual(enc.controller, 16);
    assert.strictEqual(enc.value, 127);
    assert.strictEqual(enc.channel, 0);
  });

  it("encodes a perPart param with explicit channel from part", () => {
    // organ_model cc=9, perPart=true, max=4. user 3 → wire 95.
    const enc = codec.encodeParams([{ name: "organ_model", value: 3, part: 2 }])[0];
    assert.strictEqual(enc.type, "cc");
    if (enc.type !== "cc") return;
    assert.strictEqual(enc.controller, 9);
    assert.strictEqual(enc.value, 95);
    assert.strictEqual(enc.channel, 1);  // part 2 → channel 1 (0-based)
  });

  it("perPart param without part field leaves channel undefined", () => {
    const enc = codec.encodeParams([{ name: "organ_model", value: 0 }])[0];
    assert.strictEqual(enc.type, "cc");
    if (enc.type !== "cc") return;
    assert.strictEqual(enc.channel, undefined);
  });
});

describe("Nord codec — decode", () => {
  const codec = createNordElectro5DCodec();

  it("decodes a drawbar CC into a user-domain position", () => {
    // wire 127 → user 8
    const ev = codec.decode({ type: "cc", controller: 16, value: 127, channel: 0 })[0];
    assert.strictEqual(ev.kind, "param");
    if (ev.kind !== "param") return;
    assert.strictEqual(ev.name, "drawbar_1");
    assert.strictEqual(ev.value, 8);
    assert.strictEqual(ev.part, 1);  // channel 0 → part 1
  });

  it("decodes a perPart CC and tags the part by channel", () => {
    // wire 95 on channel 1 (upper) → user 3, part 2
    const ev = codec.decode({ type: "cc", controller: 9, value: 95, channel: 1 })[0];
    assert.strictEqual(ev.kind, "param");
    if (ev.kind !== "param") return;
    assert.strictEqual(ev.name, "organ_model");
    assert.strictEqual(ev.value, 3);
    assert.strictEqual(ev.part, 2);
  });

  it("returns no events for an unmapped CC", () => {
    const events = codec.decode({ type: "cc", controller: 120, value: 42, channel: 0 });
    assert.deepStrictEqual(events, []);
  });

  it("decodes a program change into a loadProgram event", () => {
    const ev = codec.decode({ type: "program", number: 7, channel: 0 })[0];
    assert.strictEqual(ev.kind, "loadProgram");
    if (ev.kind !== "loadProgram") return;
    assert.strictEqual(ev.bank, 0);
    assert.strictEqual(ev.slot, 7);
  });
});

describe("Nord codec — round-trip user→wire→user", () => {
  const codec = createNordElectro5DCodec();

  it("drawbar param round-trips for every position 0-8", () => {
    for (let pos = 0; pos <= 8; pos++) {
      const cc = codec.encodeParams([{ name: "drawbar_1", value: pos, part: 1 }])[0];
      if (cc.type !== "cc") throw new Error("expected cc");
      const ev = codec.decode({ type: "cc", controller: cc.controller, value: cc.value, channel: cc.channel ?? 0 })[0];
      assert.strictEqual(ev.kind, "param");
      if (ev.kind !== "param") continue;
      assert.strictEqual(ev.value, pos);
    }
  });

  it("organ_model round-trips for every label index 0-4", () => {
    for (let userValue = 0; userValue <= 4; userValue++) {
      const cc = codec.encodeParams([{ name: "organ_model", value: userValue, part: 2 }])[0];
      if (cc.type !== "cc") throw new Error("expected cc");
      const ev = codec.decode({ type: "cc", controller: cc.controller, value: cc.value, channel: cc.channel ?? 0 })[0];
      assert.strictEqual(ev.kind, "param");
      if (ev.kind !== "param") continue;
      assert.strictEqual(ev.value, userValue);
    }
  });
});
