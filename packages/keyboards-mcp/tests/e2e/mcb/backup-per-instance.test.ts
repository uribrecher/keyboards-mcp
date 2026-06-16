/**
 * Per-instance backup data E2E.
 *
 * Pre-seeds two distinct labeled caches under a tmp KEYBOARDS_MCP_DATA_DIR,
 * spawns two Nord mocks, connects each as a separate pool device with a
 * matching label, and asserts that list_programs returns the right
 * inventory for each device.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiDeviceHarness } from "../../helpers/multi-device-harness.js";

const _isDocker = !!process.env.MOCK_WS_URL;

const STUDIO_PROGRAMS = [
  { bank: 1, slot: 0, name: "studio-organ" },
  { bank: 1, slot: 1, name: "studio-piano" },
];
const GIG_PROGRAMS = [
  { bank: 1, slot: 0, name: "gig-rhodes" },
  { bank: 2, slot: 5, name: "gig-clav" },
];

let tmpDataDir: string;
let h: MultiDeviceHarness;
let originalDataDirEnv: string | undefined;

const NORD_A_PORT = 5800;
const NORD_B_PORT = 5801;

function seedCache(label: string, programs: Array<{ bank: number; slot: number; name: string }>): void {
  const dir = join(tmpDataDir, "backups", label);
  mkdirSync(dir, { recursive: true });
  const cache = {
    pianos: [],
    samples: [],
    programs,
    setLists: [],
    livePresets: [],
  };
  writeFileSync(join(dir, "backup_cache.json"), JSON.stringify(cache), "utf-8");
}

describe("E2E: per-instance backup data", { concurrency: 1, skip: !!process.env.MOCK_WS_URL }, () => {
  before(async () => {
    tmpDataDir = mkdtempSync(join(tmpdir(), "backup-per-instance-"));
    originalDataDirEnv = process.env.KEYBOARDS_MCP_DATA_DIR;
    process.env.KEYBOARDS_MCP_DATA_DIR = tmpDataDir;

    seedCache("studio", STUDIO_PROGRAMS);
    seedCache("gig", GIG_PROGRAMS);

    // Two Nord mocks share a virtual MIDI port name, so disambiguate via
    // distinct mock labels — connect_to_keyboard's port arg accepts a
    // mock label as an exact identity.
    h = await MultiDeviceHarness.start({
      mocks: [
        { model: "nord-electro-5d", wsPort: NORD_A_PORT, label: "studio" },
        { model: "nord-electro-5d", wsPort: NORD_B_PORT, label: "gig" },
      ],
    });
  });

  after(async () => {
    if (h) await h.stop();
    if (originalDataDirEnv === undefined) {
      delete process.env.KEYBOARDS_MCP_DATA_DIR;
    } else {
      process.env.KEYBOARDS_MCP_DATA_DIR = originalDataDirEnv;
    }
    if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it("connect with label auto-loads that label's cached inventory", async () => {
    // Connect each Nord by its distinct mock label.
    const r1 = await h.callTool("connect_to_keyboard", {
      port: "studio",
      model: "nord-electro-5d",
      label: "studio",
    });
    assert.ok(!r1.isError, `studio connect failed: ${r1.content[0].text}`);

    const r2 = await h.callTool("connect_to_keyboard", {
      port: "gig",
      model: "nord-electro-5d",
      label: "gig",
    });
    assert.ok(!r2.isError, `gig connect failed: ${r2.content[0].text}`);

    // Each device sees its own inventory
    const studio = await h.callTool("list_programs", { device: 1 });
    assert.ok(!studio.isError, `device 1 list_programs error: ${studio.content[0].text}`);
    assert.match(studio.content[0].text, /studio-organ/);
    assert.match(studio.content[0].text, /studio-piano/);
    assert.doesNotMatch(studio.content[0].text, /gig-/);

    const gig = await h.callTool("list_programs", { device: 2 });
    assert.ok(!gig.isError, `device 2 list_programs error: ${gig.content[0].text}`);
    assert.match(gig.content[0].text, /gig-rhodes/);
    assert.match(gig.content[0].text, /gig-clav/);
    assert.doesNotMatch(gig.content[0].text, /studio-/);
  });

  it("get_last_backup_location respects the label arg", async () => {
    // Pre-seed a path for label "studio" without going through extract_backup
    const studioPathFile = join(tmpDataDir, "backups", "studio", "last_backup_path.txt");
    writeFileSync(studioPathFile, "/tmp/studio.ne5b", "utf-8");

    const r = await h.callTool("get_last_backup_location", { label: "studio" });
    assert.equal(r.content[0].text, "/tmp/studio.ne5b");
  });
});
