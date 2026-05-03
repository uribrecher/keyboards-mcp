import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  register,
  touch,
  relabel,
  unregister,
  readAll,
  readActive,
  readAllWithStaleFlag,
  findByMidiPort,
  findByWsPort,
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

    it("upserts by wsPort — second register with same wsPort replaces the first", () => {
      register(makeEntry({ wsPort: 4001, label: "v1" }));
      register(makeEntry({ wsPort: 4001, label: "v2" }));
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].label, "v2");
    });

    it("two same-model mocks (same midiPort, different wsPort) coexist", () => {
      // Mirrors the real-world case where Core MIDI hands out
      // "Foo" and "Foo1" but our higher layers may track the requested
      // name. Even if midiPort happens to collide, wsPort keeps them
      // distinct and BOTH stay in the registry.
      register(makeEntry({ midiPort: "Same Mock", wsPort: 5000, label: "studio" }));
      register(makeEntry({ midiPort: "Same Mock", wsPort: 5001, label: "gig" }));
      const all = readAll();
      assert.equal(all.length, 2);
      assert.deepEqual(
        all.map((e) => e.label).sort(),
        ["gig", "studio"],
      );
    });
  });

  describe("findByMidiPort / findByWsPort", () => {
    it("findByMidiPort returns the matching active entry", () => {
      register(makeEntry({ midiPort: "Nord Electro 5D Mock", label: "studio" }));
      const found = findByMidiPort("Nord Electro 5D Mock");
      assert.equal(found?.label, "studio");
    });

    it("findByMidiPort returns the most-recently-touched entry on duplicates", async () => {
      register(makeEntry({ midiPort: "Dup", wsPort: 5000, label: "old", lastTouched: new Date(Date.now() - 1000).toISOString() }));
      register(makeEntry({ midiPort: "Dup", wsPort: 5001, label: "newest" }));
      const found = findByMidiPort("Dup");
      assert.equal(found?.label, "newest");
    });

    it("findByMidiPort returns undefined for unknown ports", () => {
      assert.equal(findByMidiPort("Nope"), undefined);
    });

    it("findByWsPort is unambiguous", () => {
      register(makeEntry({ midiPort: "Dup", wsPort: 5000, label: "left" }));
      register(makeEntry({ midiPort: "Dup", wsPort: 5001, label: "right" }));
      assert.equal(findByWsPort(5000)?.label, "left");
      assert.equal(findByWsPort(5001)?.label, "right");
      assert.equal(findByWsPort(5999), undefined);
    });
  });

  describe("touch / relabel", () => {
    it("touch refreshes lastTouched only for entries owned by this PID", async () => {
      const old = new Date(Date.now() - 60_000).toISOString();
      register(makeEntry({ wsPort: 5000, lastTouched: old }));
      await new Promise((r) => setTimeout(r, 10));
      touch(5000);
      assert.notEqual(readAll()[0].lastTouched, old);
    });

    it("touch is a no-op for entries owned by another PID", () => {
      const old = new Date(Date.now() - 60_000).toISOString();
      register(makeEntry({ wsPort: 5000, lastTouched: old, pid: process.pid + 9999 }));
      touch(5000);
      assert.equal(readAll()[0].lastTouched, old);
    });

    it("relabel updates the label and bumps lastTouched", async () => {
      register(makeEntry({ wsPort: 5000, label: "old" }));
      await new Promise((r) => setTimeout(r, 10));
      relabel(5000, "new");
      assert.equal(readAll()[0].label, "new");
    });
  });

  describe("unregister / dropOwnedByThisProcess", () => {
    it("unregister removes the entry by wsPort + own pid", () => {
      register(makeEntry({ wsPort: 5000 }));
      unregister(5000);
      assert.equal(readAll().length, 0);
    });

    it("unregister leaves entries owned by other PIDs alone", () => {
      register(makeEntry({ wsPort: 5000, pid: process.pid + 9999 }));
      unregister(5000);
      assert.equal(readAll().length, 1);
    });

    it("dropOwnedByThisProcess wipes only this PID's entries", () => {
      register(makeEntry({ wsPort: 5000 }));
      register(makeEntry({ wsPort: 5001, pid: process.pid + 9999 }));
      dropOwnedByThisProcess();
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].wsPort, 5001);
    });
  });

  describe("readActive / readAllWithStaleFlag (staleness)", () => {
    it("readActive hides entries whose owning PID is dead", () => {
      register(makeEntry({ wsPort: 5000, pid: 999_999 }));
      assert.equal(readAll().length, 1);
      assert.equal(readActive().length, 0);
    });

    it("readActive hides entries whose lastTouched is older than STALE_AFTER_MS", () => {
      const tooOld = new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();
      register(makeEntry({ wsPort: 5000, lastTouched: tooOld }));
      assert.equal(readActive().length, 0);
    });

    it("readActive includes entries with recent heartbeats and live PIDs", () => {
      register(makeEntry({ wsPort: 5000 }));
      assert.equal(readActive().length, 1);
    });

    it("readAllWithStaleFlag keeps stale entries with stale: true", () => {
      register(makeEntry({ wsPort: 5000, label: "live" }));
      register(makeEntry({ wsPort: 5001, label: "ghost", pid: 999_999 }));
      const flagged = readAllWithStaleFlag();
      assert.equal(flagged.length, 2);
      const ghost = flagged.find((e) => e.label === "ghost")!;
      const live = flagged.find((e) => e.label === "live")!;
      assert.equal(ghost.stale, true);
      assert.equal(live.stale, false);
    });
  });

  describe("purgeStale", () => {
    it("rewrites the file dropping dead-PID entries", () => {
      register(makeEntry({ wsPort: 5000 }));
      register(makeEntry({ wsPort: 5001, pid: 999_999 }));
      purgeStale();
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].wsPort, 5000);
    });
  });

  describe("atomic write", () => {
    it("recovers from a corrupt file on register", () => {
      mkdirSync(join(dataDir, "runtime"), { recursive: true });
      writeFileSync(join(dataDir, "runtime", "mocks.json"), "this is not json", "utf-8");
      register(makeEntry({ wsPort: 5000 }));
      const parsed = JSON.parse(readFileSync(join(dataDir, "runtime", "mocks.json"), "utf-8"));
      assert.equal(parsed.length, 1);
    });

    it("uses per-process tmp files — concurrent writers do not collide on the same .tmp", () => {
      // Fire many writes back-to-back; the per-process+timestamp+random
      // tmp-name policy guarantees each picks its own scratch path even
      // if their renames interleave.
      for (let i = 0; i < 50; i++) {
        register(makeEntry({ wsPort: 5000 + i, label: `n${i}` }));
      }
      // No leftover .tmp files should remain after a successful write
      const runtimeDir = join(dataDir, "runtime");
      const leftover = readdirSync(runtimeDir).filter((f) => f.endsWith(".tmp"));
      assert.equal(leftover.length, 0, `unexpected leftover tmps: ${leftover.join(", ")}`);
    });
  });

  describe("malformed entries", () => {
    it("readAll filters non-conforming entries instead of throwing", () => {
      mkdirSync(join(dataDir, "runtime"), { recursive: true });
      writeFileSync(
        join(dataDir, "runtime", "mocks.json"),
        JSON.stringify([
          makeEntry({ wsPort: 5000 }),
          { midiPort: 123, wsPort: "nope" }, // malformed
          null,
          "still bad",
        ]),
        "utf-8",
      );
      const all = readAll();
      assert.equal(all.length, 1);
      assert.equal(all[0].wsPort, 5000);
    });
  });
});
