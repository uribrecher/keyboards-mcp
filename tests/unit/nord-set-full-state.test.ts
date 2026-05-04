import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DMockHandler } from "../../src/keyboard_models/nord/electro_5d/mock-handler.js";

const LOWER_CH = 1;
const UPPER_CH = 2;

describe("Nord setFullState round-trip", () => {
  it("setFullState(getFullState(false)) restores the same state", () => {
    const a = createNordElectro5DMockHandler();
    a.init(LOWER_CH, UPPER_CH);
    // upper drawbar_1 (CC 16) → upper channel
    a.onMIDI({ type: "cc", controller: 16, value: 100, channel: UPPER_CH });
    // lower drawbar_1 (CC 16) → lower channel
    a.onMIDI({ type: "cc", controller: 16, value: 50, channel: LOWER_CH });
    // global reverb_type (CC 96) — global params read from lowerChannel in
    // the existing buildFullState() implementation, so set it on lowerCh.
    a.onMIDI({ type: "cc", controller: 96, value: 4, channel: LOWER_CH });
    const before = a.getFullState(false);

    const b = createNordElectro5DMockHandler();
    b.init(LOWER_CH, UPPER_CH);
    assert.ok(b.setFullState, "Nord handler should implement setFullState");
    b.setFullState!(JSON.parse(JSON.stringify(before)));
    const after = b.getFullState(false);

    // Compare the fields setFullState is responsible for round-tripping.
    assert.deepEqual(after.lower, before.lower);
    assert.deepEqual(after.upper, before.upper);
    assert.deepEqual(after.global, before.global);
    assert.deepEqual(after.preset1Drawbars, before.preset1Drawbars);
    assert.deepEqual(after.preset2Drawbars, before.preset2Drawbars);
  });

  it("does not throw on a minimal snapshot", () => {
    const a = createNordElectro5DMockHandler();
    a.init(LOWER_CH, UPPER_CH);
    assert.doesNotThrow(() => a.setFullState!({}));
  });

  it("ignores unknown extra fields and does not throw", () => {
    const a = createNordElectro5DMockHandler();
    a.init(LOWER_CH, UPPER_CH);
    assert.doesNotThrow(() => a.setFullState!({ rubbish: 123, mystery: "x" }));
  });
});
