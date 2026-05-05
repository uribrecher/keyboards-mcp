import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { TestHarness } from "../helpers/test-harness.js";
import { MultiDeviceHarness } from "../helpers/multi-device-harness.js";

const isDocker = !!process.env.MOCK_WS_URL;

// In Docker mode, only Nord mock is running. Locally, test all models.
const MODELS = isDocker
  ? [{ id: "nord-electro-5d", portPattern: "Nord Electro 5D Mock", port: 5500 }]
  : [
      { id: "nord-electro-5d", portPattern: "Nord Electro 5D Mock", port: 5500 },
      { id: "roland-juno-x", portPattern: "Roland JUNO-X Mock", port: 5501 },
      { id: "sequential-prophet-6", portPattern: "Prophet-6 Mock", port: 5502 },
    ];

describe("E2E: multi-model regression", { concurrency: 1 }, () => {
  for (const { id, portPattern, port } of MODELS) {
    it(`${id}: connect + list_parameters + get_state`, async () => {
      const h = await TestHarness.start({ model: id, wsPort: port });
      try {
        const connectResult = await h.callTool("connect_to_keyboard", { port: portPattern, model: id });
        assert.ok(!connectResult.isError, `connect failed: ${connectResult.content[0].text}`);

        const listResult = await h.callTool("list_parameters");
        assert.ok(!listResult.isError, `list_parameters failed: ${listResult.content[0].text}`);
        assert.ok(listResult.content[0].text.length > 100, "suspiciously short response");

        const stateResult = await h.callTool("get_current_state");
        assert.ok(!stateResult.isError, `get_current_state failed: ${stateResult.content[0].text}`);
      } finally {
        await h.stop();
      }
    });
  }
});

/* ────────────────────────────────────────────────────────────────────
 * Plan #6 — three concurrent mocks via the device pool.
 * Verifies full per-device isolation: a parameter set on device 1
 * cannot leak into devices 2 or 3.
 * ───────────────────────────────────────────────────────────────── */

const N3_NORD = 5550;
const N3_JUNO = 5551;
const N3_PROPHET = 5552;
let trio: MultiDeviceHarness | null = null;

describe("E2E: three concurrent mocks (plan #6)", { concurrency: 1, skip: isDocker }, () => {
  before(async () => {
    trio = await MultiDeviceHarness.start({
      mocks: [
        { model: "nord-electro-5d", wsPort: N3_NORD },
        { model: "roland-juno-x", wsPort: N3_JUNO },
        { model: "sequential-prophet-6", wsPort: N3_PROPHET },
      ],
    });
  });

  after(async () => { if (trio) await trio.stop(); });

  it("connect three devices and address each independently", async () => {
    if (!trio) throw new Error("harness missing");

    const r1 = await trio.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock", mock_ws_port: N3_NORD,
      auto_input: false, auto_forward: false, label: "rack-nord",
    });
    assert.ok(!r1.isError, `Nord connect: ${r1.content[0].text}`);
    assert.match(r1.content[0].text, /device 1/);

    const r2 = await trio.callTool("connect_to_keyboard", {
      port: "Roland JUNO-X Mock", mock_ws_port: N3_JUNO,
      auto_input: false, auto_forward: false, label: "rack-juno",
    });
    assert.ok(!r2.isError, `JUNO-X connect: ${r2.content[0].text}`);
    assert.match(r2.content[0].text, /device 2/);

    const r3 = await trio.callTool("connect_to_keyboard", {
      port: "Prophet-6 Mock", mock_ws_port: N3_PROPHET,
      auto_input: false, auto_forward: false, label: "rack-prophet",
    });
    assert.ok(!r3.isError, `Prophet-6 connect: ${r3.content[0].text}`);
    assert.match(r3.content[0].text, /device 3/);

    const status = await trio.callTool("is_connected");
    assert.match(status.content[0].text, /device 1: Nord Electro 5D/);
    assert.match(status.content[0].text, /device 2: Roland JUNO-X/);
    assert.match(status.content[0].text, /device 3: Prophet-6/);
  });

  it("targeted set_parameters never leaks across devices", async () => {
    if (!trio) throw new Error("harness missing");

    await trio.callTool("set_parameters", { device: 1, parameters: [{ name: "drawbar_1", value: 8 }] });
    await trio.callTool("set_parameters", { device: 2, parameters: [{ name: "as_env_attack", value: 100 }] });
    await trio.callTool("set_parameters", { device: 3, parameters: [{ name: "osc1_freq", value: 60 }] });

    const s1 = await trio.callTool("get_current_state", { device: 1 });
    assert.match(s1.content[0].text, /Drawbar 1/);
    assert.doesNotMatch(s1.content[0].text, /Osc 1 Freq/);

    const s3 = await trio.callTool("get_current_state", { device: 3 });
    assert.match(s3.content[0].text, /Osc 1 Freq/);
    assert.doesNotMatch(s3.content[0].text, /Drawbar 1/);
  });

  it("disconnect one device — others stay live with stable indices", async () => {
    if (!trio) throw new Error("harness missing");

    const dr = await trio.callTool("disconnect_from_keyboard", { device: 2 });
    assert.ok(!dr.isError);

    const status = await trio.callTool("is_connected");
    assert.match(status.content[0].text, /device 1: Nord Electro 5D/);
    assert.match(status.content[0].text, /device 3: Prophet-6/);
    assert.doesNotMatch(status.content[0].text, /device 2:/);

    // Devices 1 and 3 still respond
    const ok1 = await trio.callTool("set_parameters", { device: 1, parameters: [{ name: "drawbar_2", value: 4 }] });
    assert.ok(!ok1.isError);
    const ok3 = await trio.callTool("set_parameters", { device: 3, parameters: [{ name: "osc1_freq", value: 70 }] });
    assert.ok(!ok3.isError);
  });
});
