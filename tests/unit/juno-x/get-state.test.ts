import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import junoModel from "../../../src/keyboard_models/roland/juno_x/index.js";

describe("JUNO-X get_current_state", () => {
  it("returns 'not yet implemented' message pointing to the RQ1 follow-up", () => {
    const device = junoModel.createDevice!();
    const result = device.getState();
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /not yet implemented/i);
    assert.match(text, /RQ1|todo #21/);
  });
});
