/**
 * Plan 9: save → restore round-trip via the data layer (no Electron).
 *
 * Spawns two MockProcess instances, captures their getFullState(false)
 * via the WS broadcast each mock sends to its first client, builds a
 * synthetic .mockrack payload, writes it atomically, parses it back, and
 * asserts the snapshots round-trip cleanly.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProcess } from "../helpers/mock-process.js";
import {
  parseMockrack,
  writeMockrackAtomic,
  MOCKRACK_VERSION,
  type MockrackV1,
} from "../../src/mockrack-format.js";

let nextPort = 4400;
const isDocker = !!process.env.MOCK_WS_URL;

describe("plan #9 save/load round-trip", { concurrency: 1, skip: isDocker }, () => {
  it("two mocks → snapshot → write → re-read → identity preserved", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "save-load-"));
    const a = await MockProcess.start({ model: "nord-electro-5d", wsPort: nextPort++ });
    const b = await MockProcess.start({ model: "sequential-prophet-6", wsPort: nextPort++ });
    try {
      const stateA = await a.waitForState();
      const stateB = await b.waitForState();
      assert.ok(stateA);
      assert.ok(stateB);

      const file: MockrackV1 = {
        $schema: "mockrack/v1",
        version: MOCKRACK_VERSION,
        savedAt: new Date().toISOString(),
        appVersion: "test",
        activeTabIndex: 0,
        tabs: [
          { modelId: "nord-electro-5d", label: "studio", state: stateA },
          { modelId: "sequential-prophet-6", label: "stage",  state: stateB },
        ],
      };

      const path = join(tmp, "rig.mockrack");
      writeMockrackAtomic(path, file);
      const text = readFileSync(path, "utf-8");
      const round = parseMockrack(text);
      assert.equal(round.version, MOCKRACK_VERSION);
      assert.equal(round.tabs.length, 2);
      assert.equal(round.tabs[0].label, "studio");
      assert.equal(round.tabs[1].label, "stage");
      assert.deepEqual(round.tabs[0].state, stateA);
      assert.deepEqual(round.tabs[1].state, stateB);
    } finally {
      try { await a.stop(); } catch { /* ignore */ }
      try { await b.stop(); } catch { /* ignore */ }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a malformed file at .mockrack path surfaces a useful error", () => {
    const tmp = mkdtempSync(join(tmpdir(), "save-load-bad-"));
    try {
      const path = join(tmp, "bad.mockrack");
      writeFileSync(path, "this is not json", "utf-8");
      assert.throws(() => parseMockrack(readFileSync(path, "utf-8")),
        /Failed to parse \.mockrack/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
