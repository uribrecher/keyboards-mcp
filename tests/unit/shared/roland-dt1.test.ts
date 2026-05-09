import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildDT1, buildRQ1, decodeRolandSize, parseRQ1, requestRolandValue } from "../../../src/shared/roland-dt1.js";
import type { MidiConnection } from "../../../src/shared/midi-connection.js";

const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };

interface FakeConn extends MidiConnection {
  _fireSysEx(bytes: number[]): void;
  readonly _lastSent: number[] | null;
}

function makeFakeConn(): FakeConn {
  const listeners: Array<(bytes: number[]) => void> = [];
  let lastSent: number[] | null = null;
  return {
    sendCC() {}, sendProgramChange() {}, sendNRPN() {},
    async sendCCBatch() {}, onCC() {},
    sendSysEx(bytes: number[]) { lastSent = bytes; },
    onSysEx(cb) { listeners.push(cb); },
    _fireSysEx(bytes: number[]) { for (const cb of listeners) cb([...bytes]); },
    get _lastSent() { return lastSent; },
  } as FakeConn;
}

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

describe("requestRolandValue", () => {
  const ADDR = [0x01, 0x50, 0x00, 0x00];
  const DEVICE_ID = 0x10;

  it("resolves with the data bytes when a matching DT1 arrives", async () => {
    const conn = makeFakeConn();
    const promise = requestRolandValue(conn, JUNO_X_MODEL_ID, DEVICE_ID, ADDR, 1, 100);

    // Sanity: an RQ1 was sent.
    assert.ok(conn._lastSent, "expected requestRolandValue to send a sysex");
    const parsedReq = parseRQ1(conn._lastSent!, JUNO_X_MODEL_ID);
    assert.ok(parsedReq, "sent sysex must parse as RQ1");
    assert.deepStrictEqual(parsedReq!.address, ADDR);
    assert.equal(decodeRolandSize(parsedReq!.size), 1);

    // Fire a matching DT1.
    const dt1 = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, ADDR, [0x42]);
    conn._fireSysEx(dt1);

    const data = await promise;
    assert.deepStrictEqual(data, [0x42]);
  });

  it("ignores DT1 messages with a different address", async () => {
    const conn = makeFakeConn();
    const promise = requestRolandValue(conn, JUNO_X_MODEL_ID, DEVICE_ID, ADDR, 1, 100);

    // Wrong address — should be ignored.
    const wrong = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, [0x01, 0x60, 0x00, 0x00], [0x99]);
    conn._fireSysEx(wrong);

    // Right address — should resolve.
    const right = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, ADDR, [0x42]);
    conn._fireSysEx(right);

    const data = await promise;
    assert.deepStrictEqual(data, [0x42]);
  });

  it("rejects on timeout when no matching DT1 arrives", async () => {
    const conn = makeFakeConn();
    await assert.rejects(
      requestRolandValue(conn, JUNO_X_MODEL_ID, DEVICE_ID, ADDR, 1, 30),
      /timeout/i,
    );
  });

  it("ignores non-DT1 sysex while waiting", async () => {
    const conn = makeFakeConn();
    const promise = requestRolandValue(conn, JUNO_X_MODEL_ID, DEVICE_ID, ADDR, 1, 100);
    conn._fireSysEx([0xF0, 0x42, 0x99, 0xF7]); // not Roland; should be ignored
    const dt1 = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, ADDR, [0x42]);
    conn._fireSysEx(dt1);
    const data = await promise;
    assert.deepStrictEqual(data, [0x42]);
  });
});
