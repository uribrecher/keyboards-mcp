import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import nordModel from "../../../src/keyboard_models/nord/electro_5d/index.js";

describe("Nord Electro 5D get_current_state", () => {
  it("returns 'not supported' message — Nord MIDI is one-way", () => {
    const device = nordModel.createDevice!();
    const result = device.getState();
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.match(text, /not supported/i);
    assert.match(text, /Nord MIDI is one-way/i);
  });

  it("returns the same not-supported message regardless of section filter", () => {
    const device = nordModel.createDevice!();
    const result = device.getState("organ");
    assert.match(result.content[0].text, /not supported/i);
  });
});
