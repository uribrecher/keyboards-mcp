/**
 * JUNO-X mock-handler stage-5: RQ1 fulfillment is now entirely engine-driven.
 *
 * The engine uses:
 *   codec.parseRequest(msg)  →  codec.paramsAtAddress(addr, size)  →
 *   handler.get_params(names) →  codec.encodeBytes(name, value, part)  →
 *   codec.buildResponse(req, data)  →  emit on MIDI Out
 *
 * These tests verify the public API the engine relies on:
 *   - handler.get_params returns user-domain values for params written
 *     via handler.set_params.
 *   - codec.paramsAtAddress + codec.encodeBytes round-trip through
 *     codec.buildResponse + codec.decode.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { addAddresses } from "../../../src/shared/roland-dt1.js";

const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock RQ1 — engine fulfillment via public API", () => {
  it("get_params returns the value written via set_params (round-trip)", () => {
    handler.set_params([{ name: "chorus_switch", value: 1 }]);
    const values = handler.get_params(["chorus_switch"]);
    assert.equal(values.chorus_switch, 1);  // user-domain
  });

  it("get_params returns defaultValue for an unset param", () => {
    const values = handler.get_params(["chorus_switch", "chorus_level"]);
    assert.equal(values.chorus_switch, 0);
    assert.equal(values.chorus_level, 64);   // chorus_level defaultValue
  });

  it("the codec can encode the user-domain value back to wire bytes for an RQ1 reply", () => {
    handler.set_params([{ name: "chorus_switch", value: 1 }]);
    const codec = handler.codec!;
    const refs = codec.paramsAtAddress(CHORUS_SWITCH_ADDR, 1);
    assert.equal(refs.length, 1);
    const values = handler.get_params([refs[0].name]);
    const bytes = codec.encodeBytes(refs[0].name, values[refs[0].name]);
    assert.deepEqual(bytes, [0x7F]);
  });

  it("paramsAtAddress + encodeBytes produces a DT1 whose decode returns the original user value", () => {
    handler.set_params([{ name: "chorus_switch", value: 1 }]);
    const codec = handler.codec!;
    const refs = codec.paramsAtAddress(CHORUS_SWITCH_ADDR, 1);
    const values = handler.get_params([refs[0].name]);
    const data = codec.encodeBytes(refs[0].name, values[refs[0].name]);
    const reply = codec.buildResponse({
      protocol: "roland-rq1", address: CHORUS_SWITCH_ADDR, size: 1, deviceId: 0x10,
    }, data);
    const events = codec.decode(reply);
    const ev = events.find(e => e.kind === "param" && e.name === "chorus_switch");
    assert.ok(ev && ev.kind === "param");
    assert.equal(ev.value, 1);
  });

  it("onMIDI is a no-op in stage 5 (handler doesn't speak MIDI)", () => {
    const result = handler.onMIDI({ type: "sysex", bytes: [0xF0, 0xF7] });
    assert.deepEqual(result, {});
  });
});
