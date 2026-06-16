import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MultiDeviceHarness } from "../../helpers/multi-device-harness.js";

let h: MultiDeviceHarness;

const WS = 5340;

describe("E2E: mock close releases its MCB lease (active path)", { concurrency: 1, skip: !!process.env.MOCK_WS_URL }, () => {
  before(async () => {
    h = await MultiDeviceHarness.start({
      mocks: [{ model: "nord-electro-5d", wsPort: WS, label: "nordi" }],
    });
  });

  after(async () => {
    if (h) await h.stop();
  });

  it("closing the mock-runner fires DELETE /v1/mocks/:instanceId and MCB drops the lease", async () => {
    // Establish a lease on the mock.
    const connect = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
    });
    assert.ok(!connect.isError, `connect failed: ${connect.content[0].text}`);

    const before = await h.listMcbDevices();
    assert.equal(before.length, 1, "MCB should have one lease after the claim");
    assert.ok(before[0].mockInstanceId, "lease must carry a mockInstanceId for a mock-backed claim");
    const originalInstanceId = before[0].mockInstanceId;

    // Close the mock. MockTransport.stop() runs in the SIGTERM handler and
    // fires the active DELETE /v1/mocks/:instanceId before the process exits.
    await h.stopMock(0);

    // Give the active release a beat to land on the broker.
    await new Promise((r) => setTimeout(r, 200));

    const after = await h.listMcbDevices();
    assert.equal(after.length, 0, `MCB lease should be gone after mock close, got: ${JSON.stringify(after)}`);

    // Bring up a fresh mock at the same port/label. It must mint a new
    // instanceId — no aliasing to the closed one.
    await h.startMock({ model: "nord-electro-5d", wsPort: WS, label: "nordi" });
    await new Promise((r) => setTimeout(r, 200));

    // A fresh connect succeeds with a new lease, distinct from the original.
    const reconnect = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
    });
    assert.ok(!reconnect.isError, `reconnect failed: ${reconnect.content[0].text}`);

    const final = await h.listMcbDevices();
    assert.equal(final.length, 1, "after reconnect, MCB should have one fresh lease");
    assert.ok(final[0].mockInstanceId, "fresh lease must carry the new mock's mockInstanceId");
    assert.notEqual(final[0].mockInstanceId, originalInstanceId,
      "new lease's mockInstanceId must differ from the closed mock's — no aliasing");
  });
});

describe("E2E: shadow mock close also releases the lease", { concurrency: 1, skip: !!process.env.MOCK_WS_URL }, () => {
  // Two mocks: one acts as the "primary" (we treat its port as the master),
  // the other as the "shadow" target. Closing the shadow tab should reap
  // the lease just like closing the primary's tab does.
  let h2: MultiDeviceHarness;
  const PRIMARY_WS = 5341;
  const SHADOW_WS = 5342;

  before(async () => {
    h2 = await MultiDeviceHarness.start({
      mocks: [
        { model: "nord-electro-5d", wsPort: PRIMARY_WS, label: "primary-nord" },
        { model: "nord-electro-5d", wsPort: SHADOW_WS, label: "shadow-nord" },
      ],
    });
  });

  after(async () => {
    if (h2) await h2.stop();
  });

  it("closing the shadow mock reaps the lease (active path covers shadow side)", async () => {
    // Find each mock's OS port name via list_midi_devices (Core MIDI suffixes
    // duplicates, so the second instance becomes "Nord Electro 5D Mock1").
    const ports = await h2.callTool("list_midi_devices");
    const outputs = ports.structuredContent.outputs as Array<{ name: string; mock?: { wsPort: number; label: string } }>;
    const primary = outputs.find((o) => o.mock?.wsPort === PRIMARY_WS);
    const shadow = outputs.find((o) => o.mock?.wsPort === SHADOW_WS);
    assert.ok(primary && shadow, `expected both mocks visible, got: ${JSON.stringify(outputs.filter((o) => o.mock))}`);

    const connect = await h2.callTool("connect_to_keyboard", {
      port: primary!.name,
      model: "nord-electro-5d",
      with_shadow: shadow!.name,
    });
    assert.ok(!connect.isError, `connect failed: ${connect.content[0].text}`);

    const before = await h2.listMcbDevices();
    assert.equal(before.length, 1, "MCB should have one lease after the claim");
    assert.ok(before[0].mockInstanceId, "primary mockInstanceId should be set");
    assert.ok(before[0].shadowMockInstanceId,
      "shadowMockInstanceId should be set when the shadow is a mock");

    // Close the SHADOW mock (index 1 in h2.mocks).
    await h2.stopMock(1);
    await new Promise((r) => setTimeout(r, 200));

    const after = await h2.listMcbDevices();
    assert.equal(after.length, 0,
      `closing the shadow mock should reap the lease, got: ${JSON.stringify(after)}`);
  });
});
