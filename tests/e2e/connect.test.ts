import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let nextPort = 5100;

describe("E2E: connect", { concurrency: 1 }, () => {
  it("connects to Nord mock via MCP", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "nord-electro-5d", wsPort: port });
    try {
      const result = await h.callTool("connect_to_keyboard", {
        port: "Nord Electro 5D Mock",
      });
      const text = result.content[0].text;
      assert.ok(text.includes("Detected model: Nord Electro 5D"), `unexpected: ${text}`);
      assert.ok(text.includes("Connected to"), `unexpected: ${text}`);
    } finally {
      await h.stop();
    }
  });

  it("is_connected returns true after connect", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "nord-electro-5d", wsPort: port });
    try {
      await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock" });
      const result = await h.callTool("is_connected");
      const text = result.content[0].text;
      assert.ok(text.includes("Connected") || text.includes("connected"), `unexpected: ${text}`);
    } finally {
      await h.stop();
    }
  });
});
