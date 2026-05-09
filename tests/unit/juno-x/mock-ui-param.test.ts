/**
 * JUNO-X mock handler `onUIParam` (#24).
 *
 * The UI sends `{type:"param", name, value}` for SysEx-addressed params.
 * The handler must:
 *   - encode the named param to a DT1 sysex packet,
 *   - apply the change to its internal state (sceneGlobal[addr] = value),
 *   - return the encoded packet in `sysexOut` so the engine can fan it out
 *     on the device's MIDI Out.
 *
 * Verified by calling `onUIParam`, asserting `sysexOut`, then issuing an
 * RQ1 read against the same address and confirming the stored byte.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { JUNO_X_MODEL_ID, SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { buildRQ1, parseDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

const DEVICE_ID = 0x10;
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00];
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock onUIParam", () => {
  it("encodes chorus_switch=1 as DT1 sysex and stores the value", () => {
    // JUNO-X discrete params are encoded via `discreteToMidi(idx, max)` —
    // a SCALED encoding that maps idx 0..max → bytes 0..127. So "ON"
    // (idx 1, max 1) on the wire is byte 127. This mirrors what
    // `device.setParameters` writes on the same address.
    const result = handler.onUIParam("chorus_switch", 1);

    assert.ok(result.sysexOut, "expected sysexOut on the result");
    assert.equal(result.sysexOut!.length, 1);

    const parsed = parseDT1(result.sysexOut![0], JUNO_X_MODEL_ID);
    assert.ok(parsed, "result.sysexOut[0] must parse as DT1");
    assert.deepStrictEqual(parsed!.address, CHORUS_SWITCH_ADDR);
    assert.deepStrictEqual(parsed!.data, [0x7F]);

    // Verify state was applied: RQ1 the same address, expect the same wire byte.
    const reqMsg = buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x00, 0x00, 0x00, 0x01]);
    const rq1Result = handler.onMIDI({ type: "sysex", bytes: reqMsg });
    const rq1Parsed = parseDT1(rq1Result.sysexOut![0], JUNO_X_MODEL_ID);
    assert.deepStrictEqual(rq1Parsed!.data, [0x7F], "sceneGlobal must reflect the UI-param write");
  });

  it("returns a no-op log when the param name is unknown", () => {
    const result = handler.onUIParam("not_a_real_param", 1);
    assert.equal(result.sysexOut, undefined);
    assert.equal(result.ccOut, undefined);
    assert.match(result.log ?? "", /unknown param/i);
  });

  it("encodes chorus_level (continuous, 0..127) directly as a one-byte DT1", () => {
    const result = handler.onUIParam("chorus_level", 80);
    assert.ok(result.sysexOut);
    const parsed = parseDT1(result.sysexOut![0], JUNO_X_MODEL_ID);
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.data, [80]);
  });
});
