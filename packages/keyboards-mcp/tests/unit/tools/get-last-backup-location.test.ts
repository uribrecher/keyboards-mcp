import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGetLastBackupLocation } from "../../../src/tools/get-last-backup-location.js";
import { _resetForTests } from "../../../src/keyboard_models/nord/electro_5d/backup-cache.js";
import nordModel from "../../../src/keyboard_models/nord/electro_5d/index.js";
import { makeHarness, connectNord, type FakeMcpServer } from "../../helpers/tool-harness.js";
import type { DevicePool } from "../../../src/shared/device-pool.js";

let server: FakeMcpServer;
let pool: DevicePool;

/** Store a last-backup path on disk for `label` via the shared Nord cache. */
function storePath(path: string, label?: string): void {
  nordModel.backupCache!.setLastBackupPath(path, label);
}

describe("get_last_backup_location tool", () => {
  beforeEach(() => {
    _resetForTests();
    process.env.KEYBOARDS_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "kbd-data-"));
    ({ server, pool } = makeHarness());
    registerGetLastBackupLocation(server.asMcpServer, pool);
  });

  it("errors for an out-of-range device index", async () => {
    const res = await server.call("get_last_backup_location", { device: 7 });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /No device at index 7/);
  });

  it("returns the path scoped to an explicit device's model and label", async () => {
    const { index } = connectNord(pool, { label: "studio" });
    storePath("/backups/studio.ne5b", "studio");
    const res = await server.call("get_last_backup_location", { device: index });
    assert.strictEqual(res.content[0].text, "/backups/studio.ne5b");
  });

  it("resolves an explicit label from disk even with no matching device connected", async () => {
    storePath("/backups/loft.ne5b", "loft");
    const res = await server.call("get_last_backup_location", { label: "loft" });
    assert.strictEqual(res.content[0].text, "/backups/loft.ne5b");
  });

  it("reports when an explicit label has no stored path", async () => {
    const res = await server.call("get_last_backup_location", { label: "empty-label" });
    assert.match(res.content[0].text, /No previous backup path stored under label "empty-label"/);
  });

  it("uses the lone connected device's label when no args are given", async () => {
    connectNord(pool, { label: "main" });
    storePath("/backups/main.ne5b", "main");
    const res = await server.call("get_last_backup_location", {});
    assert.strictEqual(res.content[0].text, "/backups/main.ne5b");
  });

  it("lists cached paths per device when multiple are connected", async () => {
    connectNord(pool, { label: "one" });
    connectNord(pool, { label: "two" });
    storePath("/backups/one.ne5b", "one");
    storePath("/backups/two.ne5b", "two");
    const res = await server.call("get_last_backup_location", {});
    assert.match(res.content[0].text, /Multiple devices connected/);
    assert.match(res.content[0].text, /one\.ne5b/);
    assert.match(res.content[0].text, /two\.ne5b/);
  });

  it("falls back to a disk-label scan when nothing is connected", async () => {
    // A cached full backup under a label puts a backup_cache.json on disk,
    // which the registry scan / disk-label enumeration can find.
    nordModel.backupCache!.set({ programs: [], pianos: [], samples: [], setLists: [], livePresets: [] } as never, "archived");
    storePath("/backups/archived.ne5b", "archived");
    const res = await server.call("get_last_backup_location", {});
    assert.match(res.content[0].text, /archived\.ne5b/);
  });

  it("reports nothing stored when there is no device and no cache", async () => {
    const res = await server.call("get_last_backup_location", {});
    assert.match(res.content[0].text, /No previous backup path stored/);
  });
});
