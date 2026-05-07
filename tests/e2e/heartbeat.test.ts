/**
 * Proactive session-loss detection via the mcb-client heartbeat.
 *
 * Distinct from session-loss.test.ts: that test surfaces session-not-found
 * via a session-bearing tool call. This test makes no session-bearing call
 * after the broker restart — only a read-only get_health — and asserts that
 * the heartbeat tick alone dropped the cache and tore down the pool.
 *
 * Uses MCB_HEARTBEAT_MS=200 so the test doesn't pay the 5s default tick.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MultiDeviceHarness } from "../helpers/multi-device-harness.js";

let h: MultiDeviceHarness;
let prevHeartbeat: string | undefined;

const TICK_MS = 200;

interface HealthBody {
  mcbReachable: boolean;
  sessionId: string | null;
  deviceCount: number;
}

describe("E2E: heartbeat proactively detects MCB restart", { concurrency: 1, skip: !!process.env.MOCK_WS_URL }, () => {
  before(async () => {
    prevHeartbeat = process.env.MCB_HEARTBEAT_MS;
    process.env.MCB_HEARTBEAT_MS = String(TICK_MS);
    h = await MultiDeviceHarness.start({
      mocks: [{ model: "nord-electro-5d", wsPort: 5501, label: "nordi" }],
    });
  });

  after(async () => {
    if (h) await h.stop();
    if (prevHeartbeat === undefined) delete process.env.MCB_HEARTBEAT_MS;
    else process.env.MCB_HEARTBEAT_MS = prevHeartbeat;
  });

  it("heartbeat tick drops the cache after MCB restart without any session-bearing call", async () => {
    // Establish a session + lease.
    await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
    });
    const before = await h.callTool("get_health");
    const beforeBody = before.structuredContent as HealthBody;
    assert.ok(beforeBody.sessionId, "session should be minted after the first claim");
    assert.equal(beforeBody.deviceCount, 1);

    // Restart broker. NOTE: we intentionally do NOT call any session-bearing
    // tool after this — the heartbeat alone must surface the divergence.
    await h.restartMcb();

    // Wait long enough for at least 2-3 heartbeat ticks to land. The first
    // tick after restart must produce a 404 session-not-found and trigger
    // the drop+teardown.
    await new Promise((r) => setTimeout(r, TICK_MS * 5));

    const after = await h.callTool("get_health");
    const afterBody = after.structuredContent as HealthBody;
    assert.equal(afterBody.sessionId, null, "heartbeat should have cleared the cached sessionId");
    assert.equal(afterBody.deviceCount, 0, "heartbeat-driven session loss should tear down the pool");
    assert.equal(afterBody.mcbReachable, true, "broker is back up");
  });
});
