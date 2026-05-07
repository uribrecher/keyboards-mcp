import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MultiDeviceHarness } from "../helpers/multi-device-harness.js";

let h: MultiDeviceHarness;

interface HealthBody {
  mcbReachable: boolean;
  mcbHealth: { ok: boolean; uptimeSec: number; sessionsActive: number; devicesConnected: number } | null;
  sessionId: string | null;
  deviceCount: number;
}

describe("E2E: get_health", { concurrency: 1 }, () => {
  before(async () => {
    h = await MultiDeviceHarness.start({
      mocks: [{ model: "nord-electro-5d", wsPort: 5401, label: "nordi" }],
    });
  });

  after(async () => {
    if (h) await h.stop();
  });

  it("pre-claim: mcbReachable=true, sessionId=null, deviceCount=0", async () => {
    const r = await h.callTool("get_health");
    const body = r.structuredContent as HealthBody;
    assert.equal(body.mcbReachable, true);
    assert.ok(body.mcbHealth);
    assert.equal(body.mcbHealth.ok, true);
    assert.equal(typeof body.mcbHealth.uptimeSec, "number");
    assert.equal(body.sessionId, null, "no session is minted before the first claim");
    assert.equal(body.deviceCount, 0);
  });

  it("post-claim: sessionId is a UUID, deviceCount=1", async () => {
    await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
    });
    const r = await h.callTool("get_health");
    const body = r.structuredContent as HealthBody;
    assert.match(body.sessionId ?? "", /^[a-f0-9-]{36}$/i);
    assert.equal(body.deviceCount, 1);
    assert.ok(body.mcbHealth && body.mcbHealth.devicesConnected >= 1);
    await h.callTool("disconnect_from_keyboard");
  });
});
