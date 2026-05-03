import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  register,
  touch,
  relabel,
  unregister,
  readAll,
  readActive,
  findByMidiPort,
  purgeStale,
  dropOwnedByThisProcess,
  _clearForTests,
  STALE_AFTER_MS,
  type MockRegistryEntry,
} from "../../src/shared/mock-registry.js";

let dataDir: string;

function makeEntry(over: Partial<MockRegistryEntry> = {}): MockRegistryEntry {
  const now = new Date().toISOString();
  return {
    midiPort:    "Test Mock",
    wsPort:      4001,
    modelId:     "test-model",
    displayName: "Test Model",
    label:       "test-label",
    pid:         process.pid,
    startedAt:   now,
    lastTouched: now,
    ...over,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mock-registry-test-"));
  process.env.KEYBOARDS_MCP_DATA_DIR = dataDir;
  _clearForTests();
});

afterEach(() => {
  delete process.env.KEYBOARDS_MCP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mock-registry", () => {
  describe("register / readAll", () => {
    it("round-trips a single entry", () => {
      const entry = makeEntry();
      register(entry);
      const all = readAll();
      assert.equal(all.length, 1);
      assert.deepEqual(all[0], entry);
      assert.ok(existsSync(join(dataDir, "runtime", "mocks.json")));
    });

    it("upserts by midiPort — second register replaces the first", () => {
      register(makeEntry({ midiPort: "Mock A", label: "v1" }));
      register(makeEntry({ midiPort: "Mock A", label: "v2" }));
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].label, "v2");
    });

    it("keeps distinct midiPorts as separate entries", () => {
      register(makeEntry({ midiPort: "Mock A" }));
      register(makeEntry({ midiPort: "Mock B" }));
      assert.equal(readAll().length, 2);
    });
  });

  describe("findByMidiPort", () => {
    it("returns the matching active entry", () => {
      register(makeEntry({ midiPort: "Nord Electro 5D Mock", label: "studio" }));
      const found = findByMidiPort("Nord Electro 5D Mock");
      assert.equal(found?.label, "studio");
    });

    it("returns undefined for unknown ports", () => {
      assert.equal(findByMidiPort("Nope"), undefined);
    });
  });

  describe("touch / relabel", () => {
    it("touch refreshes lastTouched only for entries owned by this PID", async () => {
      const old = new Date(Date.now() - 60_000).toISOString();
      register(makeEntry({ midiPort: "M", lastTouched: old }));
      // Brief delay to make the timestamp comparison meaningful
      await new Promise((r) => setTimeout(r, 10));
      touch("M");
      const after = readAll()[0];
      assert.notEqual(after.lastTouched, old);
    });

    it("touch is a no-op for entries owned by another PID", () => {
      const old = new Date(Date.now() - 60_000).toISOString();
      register(makeEntry({ midiPort: "M", lastTouched: old, pid: process.pid + 9999 }));
      touch("M");
      assert.equal(readAll()[0].lastTouched, old);
    });

    it("relabel updates the label and bumps lastTouched", async () => {
      register(makeEntry({ midiPort: "M", label: "old" }));
      await new Promise((r) => setTimeout(r, 10));
      relabel("M", "new");
      const after = readAll()[0];
      assert.equal(after.label, "new");
    });
  });

  describe("unregister / dropOwnedByThisProcess", () => {
    it("unregister removes the entry by midiPort + own pid", () => {
      register(makeEntry({ midiPort: "M" }));
      unregister("M");
      assert.equal(readAll().length, 0);
    });

    it("unregister leaves entries owned by other PIDs alone", () => {
      register(makeEntry({ midiPort: "M", pid: process.pid + 9999 }));
      unregister("M");
      assert.equal(readAll().length, 1);
    });

    it("dropOwnedByThisProcess wipes only this PID's entries", () => {
      register(makeEntry({ midiPort: "Mine" }));
      register(makeEntry({ midiPort: "Theirs", pid: process.pid + 9999 }));
      dropOwnedByThisProcess();
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].midiPort, "Theirs");
    });
  });

  describe("readActive (staleness)", () => {
    it("hides entries whose owning PID is dead", () => {
      // pick a high random PID that's almost certainly not in use
      const deadPid = 999_999;
      register(makeEntry({ midiPort: "Ghost", pid: deadPid }));
      assert.equal(readAll().length, 1);
      assert.equal(readActive().length, 0);
    });

    it("hides entries whose lastTouched is older than STALE_AFTER_MS", () => {
      const tooOld = new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();
      register(makeEntry({ midiPort: "Old", lastTouched: tooOld }));
      assert.equal(readActive().length, 0);
    });

    it("includes entries with recent heartbeats and live PIDs", () => {
      register(makeEntry({ midiPort: "Live" }));
      assert.equal(readActive().length, 1);
    });
  });

  describe("purgeStale", () => {
    it("rewrites the file dropping dead-PID entries", () => {
      const deadPid = 999_999;
      register(makeEntry({ midiPort: "Live" }));
      register(makeEntry({ midiPort: "Ghost", pid: deadPid }));
      purgeStale();
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].midiPort, "Live");
    });
  });

  describe("atomic write", () => {
    it("never leaves a half-written file behind", () => {
      // Pre-create a corrupted file to ensure register() recovers
      mkdirSync(join(dataDir, "runtime"), { recursive: true });
      writeFileSync(join(dataDir, "runtime", "mocks.json"), "this is not json", "utf-8");
      register(makeEntry({ midiPort: "M" }));
      const raw = readFileSync(join(dataDir, "runtime", "mocks.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.equal(Array.isArray(parsed), true);
      assert.equal(parsed.length, 1);
    });
  });

  describe("malformed entries", () => {
    it("readAll filters non-conforming entries instead of throwing", () => {
      mkdirSync(join(dataDir, "runtime"), { recursive: true });
      writeFileSync(
        join(dataDir, "runtime", "mocks.json"),
        JSON.stringify([
          makeEntry({ midiPort: "Good" }),
          { midiPort: 123, wsPort: "nope" }, // malformed
          null,
          "still bad",
        ]),
        "utf-8",
      );
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].midiPort, "Good");
    });
  });
});
