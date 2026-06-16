import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOCKRACK_VERSION,
  parseMockrack,
  serializeMockrack,
  writeMockrackAtomic,
  type MockrackV1,
  type MockrackTab,
} from "../../src/mockrack-format.js";

function makeTab(over: Partial<MockrackTab> = {}): MockrackTab {
  return { modelId: "nord-electro-5d", label: "studio-nord", state: null, ...over };
}

function makeFile(over: Partial<MockrackV1> = {}): MockrackV1 {
  return {
    $schema: "mockrack/v1",
    version: MOCKRACK_VERSION,
    savedAt: "2026-05-04T18:00:00Z",
    appVersion: "2.0.0",
    activeTabIndex: 0,
    tabs: [makeTab()],
    ...over,
  };
}

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "mockrack-test-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe("parseMockrack", () => {
  it("accepts a minimal valid file", () => {
    const file = makeFile();
    const parsed = parseMockrack(JSON.stringify(file));
    assert.deepEqual(parsed, file);
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => parseMockrack("not json"), /Failed to parse/);
  });

  it("rejects a higher schema version", () => {
    const file = makeFile({ version: 99 as any });
    assert.throws(() => parseMockrack(JSON.stringify(file)),
      /requires Mock Runner v99; you're on v1/);
  });

  it("rejects when tabs is not an array", () => {
    const bad = { ...makeFile(), tabs: "nope" } as any;
    assert.throws(() => parseMockrack(JSON.stringify(bad)), /tabs/);
  });

  it("rejects a tab missing modelId", () => {
    const bad = makeFile({ tabs: [{ label: "x", state: null } as any] });
    assert.throws(() => parseMockrack(JSON.stringify(bad)), /modelId/);
  });

  it("rejects a tab missing label", () => {
    const bad = makeFile({ tabs: [{ modelId: "x", state: null } as any] });
    assert.throws(() => parseMockrack(JSON.stringify(bad)), /label/);
  });

  it("accepts state: null and state: object", () => {
    const file = makeFile({ tabs: [
      makeTab({ state: null }),
      makeTab({ label: "two", state: { foo: 1 } }),
    ]});
    const parsed = parseMockrack(JSON.stringify(file));
    assert.equal(parsed.tabs.length, 2);
    assert.equal(parsed.tabs[0].state, null);
    assert.deepEqual(parsed.tabs[1].state, { foo: 1 });
  });

  it("treats a missing state field as null (forward/backward compat)", () => {
    const file = { ...makeFile(), tabs: [{ modelId: "x", label: "y" }] };
    const parsed = parseMockrack(JSON.stringify(file));
    assert.equal(parsed.tabs[0].state, null);
  });

  it("rejects an array state value", () => {
    const file = makeFile({ tabs: [makeTab({ state: [1, 2, 3] as any })] });
    assert.throws(() => parseMockrack(JSON.stringify(file)), /state must be an object or null/);
  });

  it("clamps activeTabIndex into [0, tabs.length-1]", () => {
    const tooBig = parseMockrack(JSON.stringify(makeFile({ activeTabIndex: 99 })));
    assert.equal(tooBig.activeTabIndex, 0);
    const negative = parseMockrack(JSON.stringify(makeFile({ activeTabIndex: -3 })));
    assert.equal(negative.activeTabIndex, 0);
    const empty = parseMockrack(JSON.stringify(makeFile({ activeTabIndex: 5, tabs: [] })));
    assert.equal(empty.activeTabIndex, 0);
  });
});

describe("serializeMockrack", () => {
  it("produces a parseable JSON string with stable shape", () => {
    const file = makeFile();
    const json = serializeMockrack(file);
    const round = parseMockrack(json);
    assert.deepEqual(round, file);
  });
});

describe("writeMockrackAtomic", () => {
  it("writes via per-process tmp file then renames", () => {
    const path = join(dataDir, "rig.mockrack");
    writeMockrackAtomic(path, makeFile());
    assert.ok(existsSync(path));
    const leftover = readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));
    assert.equal(leftover.length, 0);
    const parsed = parseMockrack(readFileSync(path, "utf-8"));
    assert.equal(parsed.tabs[0].label, "studio-nord");
  });

  it("creates the parent directory if missing", () => {
    const path = join(dataDir, "nested", "deeper", "rig.mockrack");
    writeMockrackAtomic(path, makeFile());
    assert.ok(existsSync(path));
  });
});
