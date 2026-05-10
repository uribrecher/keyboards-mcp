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

describe("JUNO-X MidiCodec — encodeParams / decode", () => {
  it("scene-chorus toggle: ON encodes to a DT1 with byte 0x7F", () => {
    const codec = createJunoXCodec();
    const [msg] = codec.encodeParams([{ name: "chorus_switch", value: 1 }]);
    assert.equal(msg.type, "sysex");
    if (msg.type !== "sysex") return;
    const events = codec.decode(msg);
    const param = events.find(e => e.kind === "param" && e.name === "chorus_switch");
    assert.ok(param && param.kind === "param");
    assert.equal(param.value, 0x7F);
  });

  it("scene-chorus continuous: chorus_level=80 encodes raw byte and round-trips", () => {
    const codec = createJunoXCodec();
    const [msg] = codec.encodeParams([{ name: "chorus_level", value: 80 }]);
    assert.equal(msg.type, "sysex");
    const events = codec.decode(msg);
    const param = events.find(e => e.kind === "param" && e.name === "chorus_level");
    assert.ok(param && param.kind === "param");
    assert.equal(param.value, 80);
  });

  it("per-part sysex param: part_mono_poly encodes with the part offset, decodes with part info", () => {
    const codec = createJunoXCodec();
    // part_mono_poly is a discrete param with max=2, so user value 1 scales
    // to wire byte 64 (1/2 * 127, rounded). The codec speaks wire bytes —
    // user-value translation is callers' responsibility (formatValue/resolveValue).
    const [msg] = codec.encodeParams([{ name: "part_mono_poly", value: 1, part: 2 }]);
    assert.equal(msg.type, "sysex");
    if (msg.type !== "sysex") return;
    // Verify the address bakes in SCENE_PART_OFFSETS[1] for part 2.
    const dt1 = parseDT1(msg.bytes, JUNO_X_MODEL_ID);
    assert.ok(dt1);
    const expected = addAddresses(addAddresses(SCENE_BASE, SCENE_PART_OFFSETS[1]), [0x00, 0x00, 0x00, 0x09]);
    assert.deepStrictEqual(dt1!.address, expected);
    // Decode reports the wire byte and the part it came from.
    const events = codec.decode(msg);
    const param = events.find(e => e.kind === "param" && e.name === "part_mono_poly");
    assert.ok(param && param.kind === "param");
    assert.equal(param.part, 2);
    assert.equal(param.value, 64);
  });
});

describe("JUNO-X MidiCodec — RQ1 round-trip via parseRequest + buildResponse", () => {
  it("recognizes an RQ1 sysex as a request descriptor and decodes its reply via decode()", () => {
    const codec = createJunoXCodec();
    const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
    const reqBytes = buildRQ1(JUNO_X_MODEL_ID, 0x10, CHORUS_SWITCH_ADDR, [0x00, 0x00, 0x00, 0x01]);

    // codec.decode treats RQ1 as kind: "request"
    const events = codec.decode({ type: "sysex", bytes: reqBytes });
    const req = events.find(e => e.kind === "request");
    assert.ok(req && req.kind === "request");
    assert.equal(req.descriptor.protocol, "roland-rq1");
    assert.equal(req.descriptor.size, 1);
    assert.deepStrictEqual(req.descriptor.address, CHORUS_SWITCH_ADDR);

    // parseRequest is the convenience access for the same.
    const parsed = codec.parseRequest({ type: "sysex", bytes: reqBytes });
    assert.ok(parsed);
    assert.equal(parsed!.deviceId, 0x10);

    // Build a DT1 reply carrying chorus_switch=ON. Decoding it back gives us
    // a param event that round-trips to 0x7F (the encoded ON byte).
    const reply = codec.buildResponse(parsed!, [0x7F]);
    const replyEvents = codec.decode(reply);
    const param = replyEvents.find(e => e.kind === "param" && e.name === "chorus_switch");
    assert.ok(param && param.kind === "param");
    assert.equal(param.value, 0x7F);
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
