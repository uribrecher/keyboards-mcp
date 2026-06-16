/**
 * JUNO-X MidiCodec round-trip tests (#30 stage 1).
 *
 * The codec is the single source of truth for param ↔ MIDI translation.
 * We assert the wire shape we send is what we'd parse back, and that the
 * RQ1/DT1 protocol pieces interoperate via parseRequest/buildResponse.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createJunoXCodec } from "../../../src/keyboard_models/roland/juno_x/midi-codec.js";
import { JUNO_X_MODEL_ID, SCENE_BASE, SCENE_PART_OFFSETS } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { buildRQ1, parseDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

describe("JUNO-X MidiCodec — encodeParams / decode (stage 5: user-domain decode)", () => {
  it("scene-chorus toggle: ON encodes to a DT1 with byte 0x7F; decode reports user-domain 1", () => {
    const codec = createJunoXCodec();
    const [msg] = codec.encodeParams([{ name: "chorus_switch", value: 1 }]);
    assert.equal(msg.type, "sysex");
    if (msg.type !== "sysex") return;
    // Verify the wire byte that goes out.
    const dt1 = parseDT1(msg.bytes, JUNO_X_MODEL_ID);
    assert.deepStrictEqual(dt1!.data, [0x7F]);
    // decode returns user-domain (1), not the wire byte (127).
    const events = codec.decode(msg);
    const param = events.find(e => e.kind === "param" && e.name === "chorus_switch");
    assert.ok(param && param.kind === "param");
    assert.equal(param.value, 1);
  });

  it("scene-chorus continuous: chorus_level=80 encodes byte 80 and decodes to 80 (raw)", () => {
    const codec = createJunoXCodec();
    const [msg] = codec.encodeParams([{ name: "chorus_level", value: 80 }]);
    assert.equal(msg.type, "sysex");
    const events = codec.decode(msg);
    const param = events.find(e => e.kind === "param" && e.name === "chorus_level");
    assert.ok(param && param.kind === "param");
    assert.equal(param.value, 80);
  });

  it("per-part sysex param: part_mono_poly encodes with the part offset, decodes user-domain", () => {
    const codec = createJunoXCodec();
    const [msg] = codec.encodeParams([{ name: "part_mono_poly", value: 1, part: 2 }]);
    assert.equal(msg.type, "sysex");
    if (msg.type !== "sysex") return;
    const dt1 = parseDT1(msg.bytes, JUNO_X_MODEL_ID);
    const expected = addAddresses(addAddresses(SCENE_BASE, SCENE_PART_OFFSETS[1]), [0x00, 0x00, 0x00, 0x09]);
    assert.deepStrictEqual(dt1!.address, expected);
    // Wire byte for "part_mono_poly value=1" with max=2 is 64; decode
    // inverts that back to user-domain 1.
    assert.deepStrictEqual(dt1!.data, [64]);
    const events = codec.decode(msg);
    const param = events.find(e => e.kind === "param" && e.name === "part_mono_poly");
    assert.ok(param && param.kind === "param");
    assert.equal(param.part, 2);
    assert.equal(param.value, 1);
  });
});

describe("JUNO-X MidiCodec — RQ1 round-trip via parseRequest + buildResponse", () => {
  it("recognizes an RQ1 sysex and decodes its reply via decode() back to user-domain", () => {
    const codec = createJunoXCodec();
    const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
    const reqBytes = buildRQ1(JUNO_X_MODEL_ID, 0x10, CHORUS_SWITCH_ADDR, [0x00, 0x00, 0x00, 0x01]);

    const events = codec.decode({ type: "sysex", bytes: reqBytes });
    const req = events.find(e => e.kind === "request");
    assert.ok(req && req.kind === "request");
    assert.equal(req.descriptor.protocol, "roland-rq1");
    assert.equal(req.descriptor.size, 1);
    assert.deepStrictEqual(req.descriptor.address, CHORUS_SWITCH_ADDR);

    const parsed = codec.parseRequest({ type: "sysex", bytes: reqBytes });
    assert.ok(parsed);
    assert.equal(parsed!.deviceId, 0x10);

    // Build a DT1 reply with the wire byte for ON; decode returns user 1.
    const reply = codec.buildResponse(parsed!, [0x7F]);
    const replyEvents = codec.decode(reply);
    const param = replyEvents.find(e => e.kind === "param" && e.name === "chorus_switch");
    assert.ok(param && param.kind === "param");
    assert.equal(param.value, 1);
  });
});

describe("JUNO-X MidiCodec — paramsAtAddress + encodeBytes (engine RQ1 fulfillment)", () => {
  it("paramsAtAddress finds chorus_switch at its 1-byte address", () => {
    const codec = createJunoXCodec();
    const addr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
    const refs = codec.paramsAtAddress(addr, 1);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, "chorus_switch");
    assert.equal(refs[0].byteOffset, 0);
    assert.equal(refs[0].byteCount, 1);
  });

  it("encodeBytes packs a user-domain value to wire bytes", () => {
    const codec = createJunoXCodec();
    // chorus_switch user 1 → wire 0x7F (max=1 scaled discrete).
    assert.deepEqual(codec.encodeBytes("chorus_switch", 1), [0x7F]);
    // chorus_level user 80 → wire 80 (raw continuous).
    assert.deepEqual(codec.encodeBytes("chorus_level", 80), [80]);
  });

  it("normalizeUserValue: string label → numeric index", () => {
    const codec = createJunoXCodec();
    assert.equal(codec.normalizeUserValue("chorus_switch", "ON"), 1);
    assert.equal(codec.normalizeUserValue("chorus_switch", "OFF"), 0);
  });

  it("wireToUserValue: wire byte → user-domain numeric (round-trips)", () => {
    const codec = createJunoXCodec();
    assert.equal(codec.wireToUserValue("chorus_switch", 0x7F), 1);
    assert.equal(codec.wireToUserValue("chorus_switch", 0), 0);
    assert.equal(codec.wireToUserValue("chorus_level", 80), 80);
  });
});

describe("JUNO-X MidiCodec — encodeAction loadProgram", () => {
  it("emits bank-select MSB + LSB followed by program-change", () => {
    const codec = createJunoXCodec();
    const messages = codec.encodeAction({ kind: "loadProgram", bank: (3 << 7) | 5, slot: 12, channel: 0 });
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0], { type: "cc", controller: 0,  value: 3, channel: 0 });
    assert.deepEqual(messages[1], { type: "cc", controller: 32, value: 5, channel: 0 });
    assert.deepEqual(messages[2], { type: "program", number: 12, channel: 0 });
  });
});
