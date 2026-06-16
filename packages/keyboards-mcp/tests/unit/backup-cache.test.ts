import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackupCache,
  sanitizeLabel,
  _resetForTests,
} from "../../src/keyboard_models/nord/electro_5d/backup-cache.js";
import type { BackupMetadata } from "../../src/keyboard_models/nord/electro_5d/backup-parser.js";

function makeData(tag: string): BackupMetadata {
  return {
    pianos: [{ category: "Grand", location: 1, name: `Piano-${tag}` } as any],
    samples: [{ slot: 1, name: `Sample-${tag}` } as any],
    programs: [],
    setLists: [],
    livePresets: [],
  } as unknown as BackupMetadata;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "backup-cache-test-"));
  process.env.KEYBOARDS_MCP_DATA_DIR = dataDir;
  _resetForTests();
});

afterEach(() => {
  delete process.env.KEYBOARDS_MCP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("sanitizeLabel", () => {
  it("returns _default for empty/null/undefined", () => {
    assert.equal(sanitizeLabel(undefined), "_default");
    assert.equal(sanitizeLabel(null), "_default");
    assert.equal(sanitizeLabel(""), "_default");
    assert.equal(sanitizeLabel("   "), "_default");
  });

  it("lowercases and hyphenates whitespace", () => {
    assert.equal(sanitizeLabel("Studio Nord"), "studio-nord");
    assert.equal(sanitizeLabel("Gig  Nord"), "gig-nord");
  });

  it("strips disallowed characters", () => {
    assert.equal(sanitizeLabel("studio/nord"), "studionord");
    assert.equal(sanitizeLabel("studio:nord!"), "studionord");
  });

  it("rejects path traversal sentinels", () => {
    assert.equal(sanitizeLabel(".."), "_default");
    assert.equal(sanitizeLabel("../etc"), "_default");
    assert.equal(sanitizeLabel("foo/../bar"), "_default");
  });

  it("preserves underscore-prefixed defaults", () => {
    assert.equal(sanitizeLabel("_default"), "_default");
  });
});

describe("BackupCache (label-keyed)", () => {
  it("default label round-trips", () => {
    const cache = createBackupCache();
    const data = makeData("a");
    cache.set(data);
    cache.load();
    assert.deepEqual(cache.get(), data);
    assert.ok(existsSync(join(dataDir, "backups", "_default", "backup_cache.json")));
  });

  it("named label writes under that directory", () => {
    const cache = createBackupCache();
    cache.set(makeData("studio"), "studio");
    assert.ok(existsSync(join(dataDir, "backups", "studio", "backup_cache.json")));
  });

  it("isolates labels — set under studio does not leak into gig", () => {
    const cache = createBackupCache();
    cache.set(makeData("studio"), "studio");
    cache.set(makeData("gig"), "gig");
    cache.load("studio");
    cache.load("gig");
    assert.equal((cache.get("studio") as any).pianos[0].name, "Piano-studio");
    assert.equal((cache.get("gig") as any).pianos[0].name, "Piano-gig");
    assert.equal(cache.get("unknown"), null);
  });

  it("listLabels returns persisted labels", () => {
    const cache = createBackupCache();
    cache.set(makeData("studio"), "studio");
    cache.set(makeData("gig"), "gig");
    const labels = cache.listLabels();
    assert.ok(labels.includes("studio"));
    assert.ok(labels.includes("gig"));
  });

  it("setLastBackupPath / getLastBackupPath are label-keyed", () => {
    const cache = createBackupCache();
    cache.setLastBackupPath("/tmp/studio.bin", "studio");
    assert.equal(cache.getLastBackupPath("studio"), "/tmp/studio.bin");
    assert.equal(cache.getLastBackupPath("gig"), null);
  });

  it("reload picks up an out-of-process file change", () => {
    const cache = createBackupCache();
    cache.set(makeData("v1"), "studio");
    // Simulate an external process rewriting the cache file
    const file = join(dataDir, "backups", "studio", "backup_cache.json");
    writeFileSync(file, JSON.stringify(makeData("v2")), "utf-8");
    assert.equal(cache.reload("studio"), true);
    assert.equal((cache.get("studio") as any).pianos[0].name, "Piano-v2");
  });

  it("load is idempotent — second call doesn't throw or re-read", () => {
    const cache = createBackupCache();
    cache.set(makeData("a"), "studio");
    cache.load("studio");
    cache.load("studio"); // no-op
    assert.deepEqual(cache.get("studio"), makeData("a"));
  });

  it("sanitizes the label when writing — 'Studio Nord' and 'studio-nord' share storage", () => {
    const cache = createBackupCache();
    cache.set(makeData("a"), "Studio Nord");
    assert.deepEqual(cache.get("studio-nord"), makeData("a"));
    assert.ok(existsSync(join(dataDir, "backups", "studio-nord", "backup_cache.json")));
  });

  it("path traversal is neutralized — '../escape' is treated as _default", () => {
    const cache = createBackupCache();
    cache.set(makeData("a"), "../escape");
    // The data must end up under _default, never outside the sandbox
    assert.ok(existsSync(join(dataDir, "backups", "_default", "backup_cache.json")));
    assert.deepEqual(cache.get(), makeData("a"));
  });
});

describe("Migration from legacy single-file cache", () => {
  it("moves legacy backup_cache.json + last_backup_path.txt into _default/", () => {
    // Place legacy files
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "backup_cache.json"), JSON.stringify(makeData("legacy")), "utf-8");
    writeFileSync(join(dataDir, "last_backup_path.txt"), "/old/path.bin", "utf-8");

    // Trigger migration
    const cache = createBackupCache();
    cache.load();

    // Old paths gone
    assert.equal(existsSync(join(dataDir, "backup_cache.json")), false);
    assert.equal(existsSync(join(dataDir, "last_backup_path.txt")), false);

    // Migrated to _default
    const newCache = join(dataDir, "backups", "_default", "backup_cache.json");
    const newPath = join(dataDir, "backups", "_default", "last_backup_path.txt");
    assert.ok(existsSync(newCache));
    assert.ok(existsSync(newPath));
    assert.equal(readFileSync(newPath, "utf-8"), "/old/path.bin");
    assert.equal((cache.get() as any).pianos[0].name, "Piano-legacy");
  });

  it("no-op when nothing to migrate", () => {
    // Just call createBackupCache; should not throw
    const cache = createBackupCache();
    cache.load();
    assert.equal(cache.get(), null);
    assert.equal(cache.listLabels().length, 0);
  });

  it("idempotent — running twice does not destroy migrated data", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "backup_cache.json"), JSON.stringify(makeData("legacy")), "utf-8");

    createBackupCache();        // first migration
    _resetForTests();           // simulate a fresh module load
    const cache = createBackupCache(); // second migration (no legacy file now)
    cache.load();

    assert.equal((cache.get() as any).pianos[0].name, "Piano-legacy");
  });

  it("does not overwrite an existing _default cache", () => {
    // Existing migrated cache
    mkdirSync(join(dataDir, "backups", "_default"), { recursive: true });
    writeFileSync(
      join(dataDir, "backups", "_default", "backup_cache.json"),
      JSON.stringify(makeData("existing")),
      "utf-8",
    );
    // Legacy file ALSO present
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "backup_cache.json"), JSON.stringify(makeData("legacy")), "utf-8");

    const cache = createBackupCache();
    cache.load();

    // The existing migrated cache wins — the legacy file is left in place
    assert.equal((cache.get() as any).pianos[0].name, "Piano-existing");
    assert.ok(existsSync(join(dataDir, "backup_cache.json")));
  });
});
