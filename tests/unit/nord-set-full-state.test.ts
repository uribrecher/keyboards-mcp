import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createNordElectro5DMockHandler } from "../../src/keyboard_models/nord/electro_5d/mock-handler.js";

const LOWER_CH = 1;
const UPPER_CH = 2;

describe("Nord setFullState round-trip", () => {
  it("setFullState(getFullState(false)) restores the same state", () => {
    const a = createNordElectro5DMockHandler();
    a.init(LOWER_CH, UPPER_CH);
    // Drawbar writes (perPart). part 1 auto-propagates to both parts;
    // sending part 2 afterwards leaves only the upper part with the upper
    // value, exercising the lower != upper case for round-trip.
    a.set_params!([{ name: "drawbar_1", value: 3, part: 1 }]);
    a.set_params!([{ name: "drawbar_1", value: 6, part: 2 }]);
    // Global reverb_type — non-perPart, lands in globalParams.
    a.set_params!([{ name: "reverb_type", value: 4 }]);
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
