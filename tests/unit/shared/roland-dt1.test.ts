import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildDT1, buildRQ1, decodeRolandSize, parseRQ1 } from "../../../src/shared/roland-dt1.js";

const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };

describe("parseRQ1", () => {
  it("decodes a valid RQ1 message into deviceId + address + size", () => {
    const sysex = buildRQ1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x50, 0x00, 0x00], [0x00, 0x00, 0x00, 0x10]);
    const parsed = parseRQ1(sysex, JUNO_X_MODEL_ID);
    assert.ok(parsed);
    assert.equal(parsed!.deviceId, 0x10);
    assert.deepStrictEqual(parsed!.address, [0x01, 0x50, 0x00, 0x00]);
    assert.deepStrictEqual(parsed!.size, [0x00, 0x00, 0x00, 0x10]);
  });

  it("preserves a non-default device ID", () => {
    const sysex = buildRQ1(JUNO_X_MODEL_ID, 0x42, [0x01, 0x50, 0x00, 0x00], [0x00, 0x00, 0x00, 0x01]);
    const parsed = parseRQ1(sysex, JUNO_X_MODEL_ID);
    assert.ok(parsed);
    assert.equal(parsed!.deviceId, 0x42);
  });

  it("returns null for a DT1 message (wrong command byte)", () => {
    const sysex = buildDT1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x00, 0x00, 0x00], [0x42]);
    assert.strictEqual(parseRQ1(sysex, JUNO_X_MODEL_ID), null);
  });

  it("returns null when checksum is wrong", () => {
    const sysex = buildRQ1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x50, 0x00, 0x00], [0x00, 0x00, 0x00, 0x10]);
    sysex[sysex.length - 2] = (sysex[sysex.length - 2] + 1) & 0x7f;
    assert.strictEqual(parseRQ1(sysex, JUNO_X_MODEL_ID), null);
  });
});

describe("decodeRolandSize", () => {
  it("decodes 1 byte", () => {
    assert.equal(decodeRolandSize([0x00, 0x00, 0x00, 0x01]), 1);
  });

  it("decodes 16 bytes (a value > 15, where nibble decoding would fail)", () => {
    assert.equal(decodeRolandSize([0x00, 0x00, 0x00, 0x10]), 16);
  });

  it("decodes 127 bytes", () => {
    assert.equal(decodeRolandSize([0x00, 0x00, 0x00, 0x7F]), 127);
  });

  it("decodes 128 bytes (boundary — uses second-LSB byte)", () => {
    assert.equal(decodeRolandSize([0x00, 0x00, 0x01, 0x00]), 128);
  });

  it("decodes a multi-byte size", () => {
    // 0x01:0x02:0x03:0x04 in 7-bit-MSB-first = (1<<21) | (2<<14) | (3<<7) | 4
    const expected = (1 << 21) | (2 << 14) | (3 << 7) | 4;
    assert.equal(decodeRolandSize([0x01, 0x02, 0x03, 0x04]), expected);
  });
});
