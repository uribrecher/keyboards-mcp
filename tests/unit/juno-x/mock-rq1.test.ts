/**
 * JUNO-X mock-handler bytes-level read API used by the stage-4 engine
 * to fulfill Roland RQ1 requests.
 *
 * Stage 4 moved RQ1 handling out of the mock and into the engine —
 * the handler no longer sees RQ1 sysex. The engine now does:
 *
 *   codec.parseRequest(msg)  →  handler.read_bytes(addr, size)  →
 *   codec.buildResponse(req, data)  →  emit on MIDI Out
 *
 * These tests verify `handler.read_bytes` for the same scenarios the
 * old handler-driven RQ1 path used to cover. The codec round-trip is
 * tested separately in `midi-codec.test.ts`.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { JUNO_X_MODEL_ID, SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { buildDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

const DEVICE_ID = 0x10;
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00];
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock read_bytes (stage-4 engine RQ1 fulfillment)", () => {
  it("returns the byte stored by a prior DT1 write", () => {
    const setMsg = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x01]);
    handler.onMIDI({ type: "sysex", bytes: setMsg });

    const data = handler.read_bytes(CHORUS_SWITCH_ADDR, 1);
    assert.deepStrictEqual(data, [0x01]);
  });

  it("returns 0 for an unset address", () => {
    const data = handler.read_bytes(CHORUS_SWITCH_ADDR, 1);
    assert.deepStrictEqual(data, [0x00]);
  });

  it("returns the requested number of contiguous bytes (size > 15)", () => {
    // Size 16 used to expose a nibble-vs-7bit decoder bug in the codec.
    const data = handler.read_bytes(CHORUS_SWITCH_ADDR, 16);
    assert.equal(data.length, 16);
    assert.ok(data.every((b) => b === 0));
  });

  it("DT1 only updates state — it does not emit sysexOut from the handler", () => {
    const setMsg = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x01]);
    const result = handler.onMIDI({ type: "sysex", bytes: setMsg });
    // MockHandlerResult no longer has a sysexOut field at all (stage 4).
    assert.equal((result as any).sysexOut, undefined);
  });

  it("read_bytes routes Scene Part addresses (0x10..0x14) to per-part scene state", () => {
    // Scene Part 1 address: SCENE_BASE + SCENE_PART_OFFSETS[0] + param offset.
    // For this test we just need any address whose byte[1] is 0x10..0x14 —
    // [0x01, 0x10, 0x00, 0x09] targets Scene Part 1 at param offset 9.
    const partAddr = [0x01, 0x10, 0x00, 0x09];
    const setMsg = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, partAddr, [0x42]);
    handler.onMIDI({ type: "sysex", bytes: setMsg });

    const data = handler.read_bytes(partAddr, 1);
    assert.deepStrictEqual(data, [0x42]);
  });
});
