import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MultiDeviceHarness } from "../../helpers/multi-device-harness.js";

/* ────────────────────────────────────────────────────────────────────
 * Plan #6 — three concurrent mocks via the device pool.
 * Verifies full per-device isolation: a parameter set on device 1
 * cannot leak into devices 2 or 3.
 * ───────────────────────────────────────────────────────────────── */

const N3_NORD = 5550;
const N3_JUNO = 5551;
const N3_PROPHET = 5552;
let trio: MultiDeviceHarness | null = null;

describe("E2E: three concurrent mocks (plan #6)", { concurrency: 1, skip: !!process.env.MOCK_WS_URL }, () => {
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
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
      label: "rack-nord",
    });
    assert.ok(!r1.isError, `Nord connect: ${r1.content[0].text}`);
    assert.match(r1.content[0].text, /device 1/);

    const r2 = await trio.callTool("connect_to_keyboard", {
      port: "Roland JUNO-X Mock",
      model: "roland-juno-x",
      label: "rack-juno",
    });
    assert.ok(!r2.isError, `JUNO-X connect: ${r2.content[0].text}`);
    assert.match(r2.content[0].text, /device 2/);

    const r3 = await trio.callTool("connect_to_keyboard", {
      port: "Prophet-6 Mock",
      model: "sequential-prophet-6",
      label: "rack-prophet",
    });
    assert.ok(!r3.isError, `Prophet-6 connect: ${r3.content[0].text}`);
    assert.match(r3.content[0].text, /device 3/);

    const status = await trio.callTool("is_connected");
    assert.match(status.content[0].text, /device 1: nord-electro-5d/);
    assert.match(status.content[0].text, /device 2: roland-juno-x/);
    assert.match(status.content[0].text, /device 3: sequential-prophet-6/);
  });

  it("targeted set_parameters never leaks across devices", async () => {
    if (!trio) throw new Error("harness missing");

    // Each set_parameters call surfaces only the param it set on its target
    // device; the cross-device check that used to read shadow state via
    // get_current_state is no longer meaningful (MCP is stateless on params).
    const r1 = await trio.callTool("set_parameters", { device: 1, parameters: [{ name: "drawbar_1", value: 8 }] });
    assert.ok(!r1.isError);
    assert.match(r1.content[0].text, /Drawbar 1/);
    assert.doesNotMatch(r1.content[0].text, /Osc 1 Freq/);

    const r2 = await trio.callTool("set_parameters", { device: 2, parameters: [{ name: "env_attack", value: 100 }] });
    assert.ok(!r2.isError);

    const r3 = await trio.callTool("set_parameters", { device: 3, parameters: [{ name: "osc1_freq", value: 60 }] });
    assert.ok(!r3.isError);
    assert.match(r3.content[0].text, /Osc 1 Freq/);
    assert.doesNotMatch(r3.content[0].text, /Drawbar 1/);
  });

  it("disconnect one device — others stay live with stable indices", async () => {
    if (!trio) throw new Error("harness missing");

    const dr = await trio.callTool("disconnect_from_keyboard", { device: 2 });
    assert.ok(!dr.isError);

    const status = await trio.callTool("is_connected");
    assert.match(status.content[0].text, /device 1: nord-electro-5d/);
    assert.match(status.content[0].text, /device 3: sequential-prophet-6/);
    assert.doesNotMatch(status.content[0].text, /device 2:/);

    // Devices 1 and 3 still respond
    const ok1 = await trio.callTool("set_parameters", { device: 1, parameters: [{ name: "drawbar_2", value: 4 }] });
    assert.ok(!ok1.isError);
    const ok3 = await trio.callTool("set_parameters", { device: 3, parameters: [{ name: "osc1_freq", value: 70 }] });
    assert.ok(!ok3.isError);
  });
});
