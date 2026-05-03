/**
 * Label discovery E2E (plan #7).
 *
 * Two flavors:
 *  1. Auto-adoption: a running mock writes its entry into the registry;
 *     `connect_to_keyboard` (no `label` arg) picks up that label.
 *  2. The mock's broadcast state stamps `label` so list_midi_devices
 *     can render it even without a connected pool device.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiDeviceHarness } from "../helpers/multi-device-harness.js";

const isDocker = !!process.env.MOCK_WS_URL;

const NORD_WS = 5900;
const PROPHET_WS = 5901;

let h: MultiDeviceHarness;
let tmpDataDir: string;
let prevEnv: string | undefined;

describe("E2E: label discovery", { concurrency: 1, skip: isDocker }, () => {
  before(async () => {
    tmpDataDir = mkdtempSync(join(tmpdir(), "label-discovery-"));
    prevEnv = process.env.KEYBOARDS_MCP_DATA_DIR;
    process.env.KEYBOARDS_MCP_DATA_DIR = tmpDataDir;

    h = await MultiDeviceHarness.start({
      mocks: [
        { model: "nord-electro-5d", wsPort: NORD_WS },
        { model: "sequential-prophet-6", wsPort: PROPHET_WS },
      ],
    });
  });

  after(async () => {
    if (h) await h.stop();
    if (prevEnv === undefined) delete process.env.KEYBOARDS_MCP_DATA_DIR;
    else process.env.KEYBOARDS_MCP_DATA_DIR = prevEnv;
    if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it("list_midi_devices shows each running mock's label and ws port", async () => {
    // Wait briefly for the mocks' registry writes + heartbeats to settle
    await new Promise((r) => setTimeout(r, 200));

    const result = await h.callTool("list_midi_devices");
    const text = result.content[0].text;

    // Headless CLI publishes label "_default" by default; that's enough to
    // assert the registry channel works end-to-end.
    assert.match(text, /Nord Electro 5D Mock\s+\[_default\]/, `expected Nord registry tag in: ${text}`);
    assert.match(text, /Prophet-6 Mock\s+\[_default\]/, `expected Prophet registry tag in: ${text}`);
    assert.match(text, new RegExp(`ws:${NORD_WS}`), `expected ws:${NORD_WS}`);
    assert.match(text, new RegExp(`ws:${PROPHET_WS}`), `expected ws:${PROPHET_WS}`);
  });

  it("connect_to_keyboard without label auto-adopts the running mock's label", async () => {
    const r = await h.callTool("connect_to_keyboard", {
      port: "Nord Electro 5D Mock",
      auto_input: false,
      auto_forward: false,
      // NB: no label, no mock_ws_port — both should be discovered from the registry
    });
    assert.ok(!r.isError, `connect failed: ${r.content[0].text}`);
    assert.match(r.content[0].text, /Label: auto-adopted from running mock/);
    assert.match(r.content[0].text, /"_default"/);

    const status = await h.callTool("is_connected");
    assert.match(status.content[0].text, /device 1: Nord Electro 5D "_default"/);
  });
});
