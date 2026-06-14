import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBrokerState, runDoctor } from "../../../src/cli/doctor.js";
import { plistPath, launchAgentDir } from "../../../src/cli/plist.js";

const HEALTHY = { ok: true, uptimeSec: 1, sessionsActive: 0, devicesConnected: 0 };

describe("classifyBrokerState", () => {
  it("healthy when the broker answers ok (even with no plist)", () => {
    assert.equal(classifyBrokerState({ plistExists: false, health: HEALTHY }), "healthy");
  });
  it("loaded-but-unreachable when a plist exists but health is null", () => {
    assert.equal(classifyBrokerState({ plistExists: true, health: null }), "loaded-but-unreachable");
  });
  it("not-installed when there's no plist and no health", () => {
    assert.equal(classifyBrokerState({ plistExists: false, health: null }), "not-installed");
  });
  it("a reachable-but-not-ok broker is treated as not healthy", () => {
    const sick = { ok: false, uptimeSec: 1, sessionsActive: 0, devicesConnected: 0 };
    assert.equal(classifyBrokerState({ plistExists: false, health: sick }), "not-installed");
    assert.equal(classifyBrokerState({ plistExists: true, health: sick }), "loaded-but-unreachable");
  });
});

describe("runDoctor", () => {
  it("returns not-installed for a fresh home with an unreachable broker", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-doc-"));
    const state = await runDoctor({ home, fetchHealth: async () => null, log: () => {} });
    assert.equal(state, "not-installed");
  });

  it("returns loaded-but-unreachable when the plist exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-doc-"));
    mkdirSync(launchAgentDir(home), { recursive: true });
    writeFileSync(plistPath(home), "<plist/>");
    const state = await runDoctor({ home, fetchHealth: async () => null, log: () => {} });
    assert.equal(state, "loaded-but-unreachable");
  });

  it("does not crash when the health probe throws (sick-but-reachable broker)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-doc-"));
    mkdirSync(launchAgentDir(home), { recursive: true });
    writeFileSync(plistPath(home), "<plist/>");
    const state = await runDoctor({
      home,
      fetchHealth: async () => { throw new Error("HTTP 500 from broker"); },
      log: () => {},
    });
    assert.equal(state, "loaded-but-unreachable");
  });
});
