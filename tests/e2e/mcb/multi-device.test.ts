import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { MultiDeviceHarness } from "../../helpers/multi-device-harness.js";

const _isDocker = !!process.env.MOCK_WS_URL;

let h: MultiDeviceHarness;

const NORD_WS = 5700;
const PROPHET_WS = 5701;

describe("E2E: multi-device", { concurrency: 1, skip: !!process.env.MOCK_WS_URL }, () => {
  before(async () => {
    h = await MultiDeviceHarness.start({
      mocks: [
        { model: "nord-electro-5d", wsPort: NORD_WS },
        { model: "sequential-prophet-6", wsPort: PROPHET_WS },
      ],
    });
  });

  after(async () => {
    if (h) await h.stop();
  });

  it("connect both devices and is_connected reports both with correct indices", async () => {
    const r1 = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      model: "nord-electro-5d",
      label: "studio nord",
    });
    assert.ok(!r1.isError, `nord connect failed: ${r1.content[0].text}`);
    assert.match(r1.content[0].text, /device 1/, `expected 'device 1' in: ${r1.content[0].text}`);
    assert.match(r1.content[0].text, /studio nord/, `expected label in: ${r1.content[0].text}`);

    const r2 = await h.callTool("connect_to_keyboard", {
      port: "Prophet-6 Mock",
      model: "sequential-prophet-6",
    });
    assert.ok(!r2.isError, `prophet connect failed: ${r2.content[0].text}`);
    assert.match(r2.content[0].text, /device 2/, `expected 'device 2' in: ${r2.content[0].text}`);

    const status = await h.callTool("is_connected");
    const text = status.content[0].text;
    assert.match(text, /device 1: nord-electro-5d/, `unexpected: ${text}`);
    assert.match(text, /device 2: sequential-prophet-6/, `unexpected: ${text}`);
    assert.match(text, /studio nord/);
  });

  it("ambiguous set_parameters without device returns error listing devices", async () => {
    const r = await h.callTool("set_parameters", {
      parameters: [{ name: "drawbar_1", value: 8 }],
    });
    assert.ok(r.isError, `expected error, got: ${r.content[0].text}`);
    assert.match(r.content[0].text, /Multiple devices connected/);
    assert.match(r.content[0].text, /Nord Electro 5D/);
    assert.match(r.content[0].text, /Prophet-6/);
  });

  it("targeted set_parameters routes to the chosen device", async () => {
    const r1 = await h.callTool("set_parameters", {
      device: 1,
      parameters: [{ name: "drawbar_1", value: 8 }],
    });
    assert.ok(!r1.isError, `device 1 set failed: ${r1.content[0].text}`);
    assert.match(r1.content[0].text, /Drawbar 1/);

    const r2 = await h.callTool("set_parameters", {
      device: 2,
      parameters: [{ name: "osc1_freq", value: 100 }],
    });
    assert.ok(!r2.isError, `device 2 set failed: ${r2.content[0].text}`);
    assert.match(r2.content[0].text, /Osc 1 Freq/);
  });

  it("targeted list_parameters returns the right model's params", async () => {
    const r1 = await h.callTool("list_parameters", { device: 1 });
    assert.ok(!r1.isError);
    assert.match(r1.content[0].text, /drawbar_1/);

    const r2 = await h.callTool("list_parameters", { device: 2 });
    assert.ok(!r2.isError);
    assert.match(r2.content[0].text, /osc1_freq/);
  });

  it("targeted get_current_state returns each model's not-supported message", async () => {
    const r1 = await h.callTool("get_current_state", { device: 1 });
    assert.ok(!r1.isError);
    assert.match(r1.content[0].text, /Nord MIDI is one-way/i);

    const r2 = await h.callTool("get_current_state", { device: 2 });
    assert.ok(!r2.isError);
    assert.match(r2.content[0].text, /Prophet-6.*not supported/i);
  });

  it("disconnect device 1 leaves device 2 with its original index", async () => {
    const dr = await h.callTool("disconnect_from_keyboard", { device: 1 });
    assert.ok(!dr.isError);
    assert.match(dr.content[0].text, /Disconnected device 1/);

    const status = await h.callTool("is_connected");
    const text = status.content[0].text;
    assert.match(text, /device 2: sequential-prophet-6/);
    assert.doesNotMatch(text, /device 1:/);

    // Tools targeting the gone device error out
    const gone = await h.callTool("set_parameters", {
      device: 1,
      parameters: [{ name: "drawbar_1", value: 4 }],
    });
    assert.ok(gone.isError);
    assert.match(gone.content[0].text, /No device at index 1/);

    // Single-device fallback now works without device param
    const single = await h.callTool("set_parameters", {
      parameters: [{ name: "osc1_freq", value: 60 }],
    });
    assert.ok(!single.isError, `single-device fallback failed: ${single.content[0].text}`);
  });
});
