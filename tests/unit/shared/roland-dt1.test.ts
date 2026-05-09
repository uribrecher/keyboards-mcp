import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildDT1, buildRQ1, parseRQ1 } from "../../../src/shared/roland-dt1.js";

const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };

describe("parseRQ1", () => {
  it("decodes a valid RQ1 message into address + size", () => {
    const sysex = buildRQ1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x50, 0x00, 0x00], [0x00, 0x00, 0x00, 0x10]);
    const parsed = parseRQ1(sysex, JUNO_X_MODEL_ID);
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.address, [0x01, 0x50, 0x00, 0x00]);
    assert.deepStrictEqual(parsed!.size, [0x00, 0x00, 0x00, 0x10]);
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
