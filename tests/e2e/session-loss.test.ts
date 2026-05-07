import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MultiDeviceHarness } from "../helpers/multi-device-harness.js";

let h: MultiDeviceHarness;

describe("E2E: session-loss after MCB restart", { concurrency: 1 }, () => {
  before(async () => {
    h = await MultiDeviceHarness.start({
      mocks: [{ model: "nord-electro-5d", wsPort: 5301, label: "nordi" }],
    });
  });

  after(async () => {
    if (h) await h.stop();
  });

  it("after MCB restart, the next claim returns session-lost and drops the local pool", async () => {
    // Establish a session + lease.
    const connect1 = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
    });
    const text1 = connect1.content[0].text as string;
    assert.ok(text1.includes("Connected to:"), `expected initial connect to succeed: ${text1}`);

    const before = await h.callTool("get_health");
    const beforeBody = before.structuredContent as { sessionId: string | null; deviceCount: number; mcbReachable: boolean };
    assert.equal(beforeBody.mcbReachable, true);
    assert.equal(beforeBody.deviceCount, 1, "one device should be in the pool before the restart");
    assert.ok(beforeBody.sessionId, "MCP must have a cached session id after the first claim");
    const oldSessionId = beforeBody.sessionId;

    // Restart MCB — the new broker has no record of the MCP's session.
    await h.restartMcb();

    // Next claim must surface session-lost and report the dropped lease count.
    const connect2 = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
    });
    const text2 = connect2.content[0].text as string;
    assert.equal(connect2.isError, true, `expected isError, got: ${text2}`);
    assert.match(text2, /session-lost/, `expected session-lost in: ${text2}`);
    assert.match(text2, /Dropped 1 local lease/, `expected dropped count in: ${text2}`);

    // Pool was torn down by the onSessionLost callback; cached session is gone.
    const after = await h.callTool("get_health");
    const afterBody = after.structuredContent as { sessionId: string | null; deviceCount: number };
    assert.equal(afterBody.deviceCount, 0, "pool must be empty after session-lost");
    assert.equal(afterBody.sessionId, null, "cached session must be cleared after session-lost");

    // Subsequent connect mints a fresh session and succeeds.
    const connect3 = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
    });
    const text3 = connect3.content[0].text as string;
    assert.ok(text3.includes("Connected to:"), `retry should succeed: ${text3}`);
    const recovered = await h.callTool("get_health");
    const recoveredBody = recovered.structuredContent as { sessionId: string | null; deviceCount: number };
    assert.equal(recoveredBody.deviceCount, 1);
    assert.ok(recoveredBody.sessionId);
    assert.notEqual(recoveredBody.sessionId, oldSessionId, "fresh session id expected");
  });
});
