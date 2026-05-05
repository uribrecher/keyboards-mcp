import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let h: TestHarness;

describe("E2E: list_parameters", { concurrency: 1 }, () => {
  before(async () => {
    h = await TestHarness.start({ model: "nord-electro-5d", wsPort: 5400 });
  });

  after(async () => {
    await h.stop();
  });

  it("lists all parameters for Nord", async () => {
    await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock", model: "nord-electro-5d" });

    const result = await h.callTool("list_parameters");
    const text = result.content[0].text;
    assert.ok(text.includes("organ_model"), `expected organ_model: ${text.slice(0, 200)}`);
    assert.ok(text.includes("drawbar_1"), `expected drawbar_1: ${text.slice(0, 200)}`);
    assert.ok(text.includes("reverb"), `expected reverb: ${text.slice(0, 200)}`);
    await h.reset();
  });

  it("lists parameters filtered by section", async () => {
    await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock", model: "nord-electro-5d" });

    const result = await h.callTool("list_parameters", { section: "organ" });
    const text = result.content[0].text;
    assert.ok(text.includes("Drawbar"), `expected drawbar in organ section: ${text.slice(0, 200)}`);
    await h.reset();
  });
});
