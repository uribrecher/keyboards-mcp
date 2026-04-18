import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let nextPort = 5200;

describe("E2E: set_parameters", { concurrency: 1 }, () => {
  it("sets Nord drawbar via MCP and gets valid response", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "nord-electro-5d", wsPort: port });
    try {
      const conn = await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock" });
      // (connect result logged for debugging)
      assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);

      // Allow mock WS connection to stabilize
      await new Promise((r) => setTimeout(r, 1000));

      const result = await h.callTool("set_parameters", {
        parameters: [{ name: "drawbar_1", value: 8 }],
      });
      assert.ok(!result.isError, `set_parameters error: ${result.content[0].text}`);
      const text = result.content[0].text;
      assert.ok(text.includes("Drawbar 1"), `expected Drawbar 1 in: ${text}`);
    } finally {
      await h.stop();
    }
  });

  it("sets Prophet-6 osc freq via MCP and gets valid response", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "sequential-prophet-6", wsPort: port });
    try {
      const conn = await h.callTool("connect_to_keyboard", { port: "Prophet-6 Mock" });
      // Allow mock WS connection to stabilize
      assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);

      await new Promise((r) => setTimeout(r, 1000));

      const result = await h.callTool("set_parameters", {
        parameters: [{ name: "osc1_freq", value: 100 }],
      });
      assert.ok(!result.isError, `set_parameters error: ${result.content[0].text}`);
      const text = result.content[0].text;
      assert.ok(text.includes("Osc 1 Freq"), `expected Osc 1 Freq in: ${text}`);
    } finally {
      await h.stop();
    }
  });
});
