import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import prophetModel from "../../../src/keyboard_models/sequential_circuits/prophet_6/index.js";

describe("Prophet-6 get_current_state", () => {
  it("returns 'not supported' message — no implemented query path", () => {
    const device = prophetModel.createDevice!();
    const result = device.getState();
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /not supported/i);
    assert.match(text, /Prophet-6/i);
  });
});
