import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let nextPort = 5400;

describe("E2E: list_parameters", { concurrency: 1 }, () => {
  it("lists all parameters for Nord", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "nord-electro-5d", wsPort: port });
    try {
      await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock" });

      const result = await h.callTool("list_parameters");
      const text = result.content[0].text;
      assert.ok(text.includes("organ_model"), `expected organ_model: ${text.slice(0, 200)}`);
      assert.ok(text.includes("drawbar_1"), `expected drawbar_1: ${text.slice(0, 200)}`);
      assert.ok(text.includes("reverb"), `expected reverb: ${text.slice(0, 200)}`);
    } finally {
      await h.stop();
    }
  });

  it("lists parameters filtered by section", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "nord-electro-5d", wsPort: port });
    try {
      await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock" });

      const result = await h.callTool("list_parameters", { section: "organ" });
      const text = result.content[0].text;
      assert.ok(text.includes("Drawbar"), `expected drawbar in organ section: ${text.slice(0, 200)}`);
    } finally {
      await h.stop();
    }
  });
});
