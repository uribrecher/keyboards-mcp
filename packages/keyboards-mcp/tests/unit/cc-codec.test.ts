/**
 * CC-only codec smoke tests for Nord and Prophet-6.
 *
 * The generic createCcCodec helper backs both models. These tests verify
 * the round-trip on a couple of representative params.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DCodec } from "../../src/keyboard_models/nord/electro_5d/midi-codec.js";
import { createProphet6Codec } from "../../src/keyboard_models/sequential_circuits/prophet_6/midi-codec.js";

describe("Nord Electro 5D codec — CC-only", () => {
  it("encodes and decodes a representative CC param", () => {
    const codec = createNordElectro5DCodec();
    // Pick the first param with a defined CC.
    const sampleEntry = Object.entries(codec.map.params).find(([_, p]) => p.cc !== undefined);
    assert.ok(sampleEntry, "expected at least one CC-mapped param on Nord");
    const [name, param] = sampleEntry;

    const [msg] = codec.encodeParams([{ name, value: 64 }]);
    assert.equal(msg.type, "cc");
    if (msg.type !== "cc") return;
    assert.equal(msg.controller, param.cc);

    const events = codec.decode(msg);
    const decoded = events.find(e => e.kind === "param" && e.name === name);
    assert.ok(decoded && decoded.kind === "param");
  });

  it("loadProgram action emits bank-select + program-change", () => {
    const codec = createNordElectro5DCodec();
    const messages = codec.encodeAction({ kind: "loadProgram", bank: 5, slot: 0, channel: 0 });
    assert.equal(messages.length, 3);
    assert.equal(messages[0].type, "cc");
    assert.equal(messages[2].type, "program");
  });
});

describe("Prophet-6 codec — CC-only", () => {
  it("encodes and decodes a representative CC param", () => {
    const codec = createProphet6Codec();
    const sampleEntry = Object.entries(codec.map.params).find(([_, p]) => p.cc !== undefined);
    assert.ok(sampleEntry, "expected at least one CC-mapped param on Prophet-6");
    const [name] = sampleEntry;

    const [msg] = codec.encodeParams([{ name, value: 64 }]);
    assert.equal(msg.type, "cc");

    const events = codec.decode(msg);
    const decoded = events.find(e => e.kind === "param" && e.name === name);
    assert.ok(decoded && decoded.kind === "param");
  });

  it("parseRequest returns undefined (no protocol requests)", () => {
    const codec = createProphet6Codec();
    const result = codec.parseRequest({ type: "sysex", bytes: [0xF0, 0xF7] });
    assert.equal(result, undefined);
  });
});
