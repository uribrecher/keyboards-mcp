// PRECONDITION: requires an external MCB broker reachable by the MCP server.
// Default is UDS at MCB_SOCKET (~/.mcb/sock); CI/docker uses TCP via
// MCB_TCP=<host>:<port>. Start one locally with `npm run mcb`. Self-provisioning
// E2Es live under tests/e2e/mcb/ — see `npm run test:e2e:mcb`.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";

let h: TestHarness;

describe("E2E: get_current_state", { concurrency: 1 }, () => {
  before(async () => {
    h = await TestHarness.start({ model: "nord-electro-5d", wsPort: 5300 });
  });

  after(async () => {
    await h.stop();
  });

  it("returns state after setting params", async () => {
    const conn = await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock", model: "nord-electro-5d" });
    assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);
    await new Promise((r) => setTimeout(r, 500));

    const setResult = await h.callTool("set_parameters", {
      parameters: [{ name: "drawbar_1", value: 5 }],
    });
    assert.ok(!setResult.isError, `set_parameters error: ${setResult.content[0].text}`);

    const result = await h.callTool("get_current_state");
    assert.ok(!result.isError, `get_state error: ${result.content[0].text}`);
    const text = result.content[0].text;
    assert.ok(text.includes("Drawbar 1"), `expected Drawbar 1 in state: ${text.slice(0, 300)}`);
    await h.reset();
  });
});
