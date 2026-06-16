import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtractBackup } from "../../../src/tools/extract-backup.js";
import { _resetForTests } from "../../../src/keyboard_models/nord/electro_5d/backup-cache.js";
import { makeHarness, connectNord, type FakeMcpServer } from "../../helpers/tool-harness.js";
import type { DevicePool } from "../../../src/shared/device-pool.js";
import { makeProgramFile, buildNe5bZip } from "../../helpers/nord-backup-fixture.js";

/** A small but complete .ne5b archive. */
function fixtureBackup(name = "2026-06-16_backup.ne5b"): string {
  return buildNe5bZip(
    [
      { name: "meta.xml", data: '<root product_version="1.0" product_build="1" manager_version="1"/>' },
      { name: "programs/B1/One.ne5p", data: makeProgramFile({ bankIndex: 0, slotIndex: 0 }, []) },
      { name: "programs/B1/Two.ne5p", data: makeProgramFile({ bankIndex: 0, slotIndex: 1 }, []) },
    ],
    name,
  );
}

let server: FakeMcpServer;
let pool: DevicePool;

describe("extract_backup tool", () => {
  beforeEach(() => {
    _resetForTests();
    process.env.KEYBOARDS_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "kbd-data-"));
    ({ server, pool } = makeHarness());
    registerExtractBackup(server.asMcpServer, pool);
  });

  it("detects the model from the backup when no device is connected", async () => {
    const res = await server.call("extract_backup", { file_path: fixtureBackup() });
    assert.ok(!res.isError, res.content[0].text);
    assert.match(res.content[0].text, /Extracted full backup inventory/);
    assert.match(res.content[0].text, /2 programs/);
    assert.match(res.content[0].text, /Cached under label "_default"/);
    // markdown file written under the data dir
    const root = join(process.env.KEYBOARDS_MCP_DATA_DIR!, "backups", "_default");
    assert.ok(existsSync(root) && readdirSync(root).some((f) => f.endsWith(".md")));
  });

  it("applies the inventory to an explicit device and sets its backupData", async () => {
    const { index, device } = connectNord(pool, { label: "studio" });
    const res = await server.call("extract_backup", { file_path: fixtureBackup(), device: index });
    assert.match(res.content[0].text, new RegExp(`Inventory applied to device ${index}`));
    assert.ok(device.backupData, "device.backupData should be set");
    assert.match(res.content[0].text, /label "studio"/);
  });

  it("returns an error for an out-of-range device index", async () => {
    const res = await server.call("extract_backup", { file_path: fixtureBackup(), device: 99 });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /No device at index 99/);
  });

  it("honors an explicit label argument", async () => {
    const res = await server.call("extract_backup", { file_path: fixtureBackup(), label: "My Rig" });
    assert.match(res.content[0].text, /label "my-rig"/); // sanitized
  });

  it("writes to an explicit output_path when given", async () => {
    const outPath = join(process.env.KEYBOARDS_MCP_DATA_DIR!, "custom", "inv.md");
    const res = await server.call("extract_backup", { file_path: fixtureBackup(), output_path: outPath });
    assert.match(res.content[0].text, new RegExp(`Written to: ${outPath.replace(/[/\\]/g, "[/\\\\]")}`));
    assert.ok(existsSync(outPath));
  });

  it("rejects programs-only extraction with no cached full backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "progs-only-"));
    writeFileSync(join(dir, "A.ne5p"), makeProgramFile({ bankIndex: 0, slotIndex: 0 }, []));
    const res = await server.call("extract_backup", { file_path: dir });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /Programs-only extraction requires a previously cached full backup/);
  });

  it("merges programs-only extraction onto a cached full backup", async () => {
    // First a full extract to populate the _default cache.
    await server.call("extract_backup", { file_path: fixtureBackup() });
    const dir = mkdtempSync(join(tmpdir(), "progs-merge-"));
    writeFileSync(join(dir, "Solo.ne5p"), makeProgramFile({ bankIndex: 0, slotIndex: 3 }, []));
    const res = await server.call("extract_backup", { file_path: dir });
    assert.ok(!res.isError, res.content[0].text);
    assert.match(res.content[0].text, /programs-only backup inventory/);
  });

  it("reports a failure for a nonexistent file path", async () => {
    const res = await server.call("extract_backup", { file_path: "/no/such/file.ne5b" });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /Failed to extract backup|Could not detect/);
  });

  it("cannot detect a model from a non-backup file with no device connected", async () => {
    const bogus = join(process.env.KEYBOARDS_MCP_DATA_DIR!, "notes.txt");
    writeFileSync(bogus, "just some text");
    const res = await server.call("extract_backup", { file_path: bogus });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /Could not detect keyboard model/);
  });
});
