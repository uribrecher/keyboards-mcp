import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let h: TestHarness;

describe("E2E: connect", { concurrency: 1 }, () => {
  before(async () => {
    h = await TestHarness.start({ model: "nord-electro-5d", wsPort: 5100 });
  });

  after(async () => {
    await h.stop();
  });

  it("connects to Nord mock via MCP", async () => {
    const result = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
    });
    const text = result.content[0].text;
    assert.ok(text.includes("Detected model: Nord Electro 5D"), `unexpected: ${text}`);
    assert.ok(text.includes("Connected"), `unexpected: ${text}`);
    await h.reset();
  });

  it("is_connected reports status", async () => {
    await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock" });
    const result = await h.callTool("is_connected");
    const text = result.content[0].text;
    assert.ok(text.includes("Connected") || text.includes("connected"), `unexpected: ${text}`);
    await h.reset();
  });
});
