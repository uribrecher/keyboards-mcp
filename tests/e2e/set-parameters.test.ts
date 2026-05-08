// PRECONDITION: requires an external MCB broker running at MCB_SOCKET (default
// ~/.mcb/sock). Start it in another terminal with `npm run mcb`. Self-provisioning
// E2Es live under tests/e2e/mcb/ — see `npm run test:e2e:mcb`.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let h: TestHarness;

describe("E2E: set_parameters", { concurrency: 1 }, () => {
  before(async () => {
    h = await TestHarness.start({ model: "nord-electro-5d", wsPort: 5200 });
  });

  after(async () => {
    await h.stop();
  });

  it("sets Nord drawbar via MCP and gets valid response", async () => {
    const conn = await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock", model: "nord-electro-5d" });
    assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);
    await new Promise((r) => setTimeout(r, 500));

    const result = await h.callTool("set_parameters", {
      parameters: [{ name: "drawbar_1", value: 8 }],
    });
    assert.ok(!result.isError, `set_parameters error: ${result.content[0].text}`);
    const text = result.content[0].text;
    assert.ok(text.includes("Drawbar 1"), `expected Drawbar 1 in: ${text}`);
    await h.reset();
  });

  it("sets Prophet-6 osc freq via MCP and gets valid response", async () => {
    // In Docker mode, only Nord model is running — skip Prophet-6 specific test
    if (process.env.MOCK_WS_URL) return;

    const h2 = await TestHarness.start({ model: "sequential-prophet-6", wsPort: 5201 });
    try {
      const conn = await h2.callTool("connect_to_keyboard", { port: "Prophet-6 Mock", model: "sequential-prophet-6" });
      assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);
      await new Promise((r) => setTimeout(r, 500));

      const result = await h2.callTool("set_parameters", {
        parameters: [{ name: "osc1_freq", value: 100 }],
      });
      assert.ok(!result.isError, `set_parameters error: ${result.content[0].text}`);
      const text = result.content[0].text;
      assert.ok(text.includes("Osc 1 Freq"), `expected Osc 1 Freq in: ${text}`);
    } finally {
      await h2.stop();
    }
  });
});
