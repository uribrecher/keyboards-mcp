/**
 * JUNO-X mock handler `onUIParam` (legacy alias for set_params).
 *
 * Stage 4: handler no longer emits via the result channel. Outbound
 * MIDI emission is the engine's responsibility (it asks the codec to
 * encode the same write and emits on the device's MIDI Out itself).
 * These tests verify state updates via read_bytes; the codec round-trip
 * is covered separately in `midi-codec.test.ts`.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { addAddresses } from "../../../src/shared/roland-dt1.js";

const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
const CHORUS_LEVEL_ADDR = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x02]);

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock onUIParam (legacy alias for set_params)", () => {
  it("chorus_switch=1 stores the scaled wire byte (0x7F for max=1 discrete)", () => {
    const result = handler.onUIParam("chorus_switch", 1);
    // Stage 4: handler no longer returns sysexOut/ccOut.
    assert.equal((result as any).sysexOut, undefined);
    assert.equal((result as any).ccOut, undefined);

    const data = handler.read_bytes(CHORUS_SWITCH_ADDR, 1);
    assert.deepStrictEqual(data, [0x7F]);
  });

  it("returns a no-op log when the param name is unknown", () => {
    const result = handler.onUIParam("not_a_real_param", 1);
    assert.match(result.log ?? "", /unknown/i);
  });

  it("chorus_level=80 stores the raw byte (continuous, no scaling)", () => {
    handler.onUIParam("chorus_level", 80);
    const data = handler.read_bytes(CHORUS_LEVEL_ADDR, 1);
    assert.deepStrictEqual(data, [80]);
  });
});
