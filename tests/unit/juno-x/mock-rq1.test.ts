import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { JUNO_X_MODEL_ID, SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { buildDT1, buildRQ1, parseDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

const DEVICE_ID = 0x10;
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00]; // see scene-params.ts
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock RQ1 → DT1 round-trip", () => {
  it("responds to RQ1 of chorus_switch with a DT1 carrying the stored byte", () => {
    // Set chorus_switch via DT1 first.
    const setMsg = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x01]);
    handler.onMIDI({ type: "sysex", bytes: setMsg });

    // Now issue RQ1 for the same address, size = 1 byte.
    const reqMsg = buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x00, 0x00, 0x00, 0x01]);
    const result = handler.onMIDI({ type: "sysex", bytes: reqMsg });

    assert.ok(result.sysexOut, "expected sysexOut on the result");
    assert.equal(result.sysexOut!.length, 1, "expected exactly one DT1 response");

    const parsed = parseDT1(result.sysexOut![0], JUNO_X_MODEL_ID);
    assert.ok(parsed, "response must parse as a DT1");
    assert.deepStrictEqual(parsed!.address, CHORUS_SWITCH_ADDR);
    assert.deepStrictEqual(parsed!.data, [0x01]);
  });

  it("responds with zero bytes when the address is unset", () => {
    const reqMsg = buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x00, 0x00, 0x00, 0x01]);
    const result = handler.onMIDI({ type: "sysex", bytes: reqMsg });

    assert.ok(result.sysexOut);
    const parsed = parseDT1(result.sysexOut![0], JUNO_X_MODEL_ID);
    assert.deepStrictEqual(parsed!.data, [0x00], "default byte for unset address is 0");
  });

  it("does not emit sysexOut for a DT1 (which only updates state)", () => {
    const setMsg = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x01]);
    const result = handler.onMIDI({ type: "sysex", bytes: setMsg });
    assert.equal(result.sysexOut, undefined);
  });
});
