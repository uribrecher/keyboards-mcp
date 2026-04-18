import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let nextPort = 5300;

describe("E2E: get_current_state", { concurrency: 1 }, () => {
  it("returns state after setting params", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "nord-electro-5d", wsPort: port });
    try {
      const conn = await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock" });
      assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);
      await new Promise((r) => setTimeout(r, 1000)); // WS stabilization

      const setResult = await h.callTool("set_parameters", {
        parameters: [{ name: "drawbar_1", value: 5 }],
      });
      assert.ok(!setResult.isError, `set_parameters error: ${setResult.content[0].text}`);

      const result = await h.callTool("get_current_state");
      assert.ok(!result.isError, `get_state error: ${result.content[0].text}`);
      const text = result.content[0].text;
      assert.ok(text.includes("Drawbar 1"), `expected Drawbar 1 in state: ${text.slice(0, 300)}`);
    } finally {
      await h.stop();
    }
  });

  it("returns state for Prophet-6 after setting params", async () => {
    const port = nextPort++;
    const h = await TestHarness.start({ model: "sequential-prophet-6", wsPort: port });
    try {
      const conn = await h.callTool("connect_to_keyboard", { port: "Prophet-6 Mock" });
      assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);
      await new Promise((r) => setTimeout(r, 1000)); // WS stabilization

      await h.callTool("set_parameters", {
        parameters: [{ name: "osc1_freq", value: 100 }],
      });

      const result = await h.callTool("get_current_state");
      assert.ok(!result.isError, `get_state error: ${result.content[0].text}`);
      const text = result.content[0].text;
      assert.ok(text.includes("Osc 1 Freq"), `expected Osc 1 Freq in state: ${text.slice(0, 300)}`);
    } finally {
      await h.stop();
    }
  });
});
