import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProcess } from "../helpers/mock-process.js";
import { readActive } from "../../src/shared/mock-registry.js";

const externalWsUrl = process.env.MOCK_WS_URL;
let nextPort = 4000;

describe("headless mock runner", { concurrency: 1 }, () => {
  if (externalWsUrl) {
    // Docker/CI: single external mock (nord-electro-5d)
    it("connects to external mock and receives state", async () => {
      const mock = await MockProcess.connectExternal(externalWsUrl);
      try {
        const state = await mock.waitForState();
        assert.ok(state, "no state received");
        assert.ok(state.global, "missing global");
      } finally {
        await mock.stop();
      }
    });
  } else {
    // Local: spawn per-model mocks with real MIDI
    for (const { model, check } of [
      {
        model: "nord-electro-5d",
        check: (s: any) => {
          assert.ok(s.lower); assert.ok(s.upper); assert.ok(s.global); assert.ok(s.preset1Drawbars);
          // organ_model is discrete (perPart) — labels should be broadcast
          assert.ok(s.upper.organ_model?.labels, "expected labels on upper.organ_model");
          assert.strictEqual(s.upper.organ_model.labels[0], "B3");
        },
      },
      { model: "roland-juno-x", check: (s: any) => { assert.ok(s.model); assert.ok(s.part1); assert.ok(s.part5); } },
      {
        model: "sequential-prophet-6",
        check: (s: any) => {
          assert.ok(s.global); assert.ok(!s.lower);
          // arp_mode is discrete — labels should be broadcast
          assert.ok(s.global.arp_mode?.labels, "expected labels on global.arp_mode");
          assert.strictEqual(s.global.arp_mode.labels[0], "Up");
        },
      },
    ]) {
      it(`starts ${model} and receives correct state`, async () => {
        const mock = await MockProcess.start({ model, wsPort: nextPort++ });
        try { check(await mock.waitForState()); } finally { await mock.stop(); }
      });
    }

    it("exits with non-zero code for invalid model", async () => {
      const code = await MockProcess.startExpectingFailure({ model: "nonexistent-model", wsPort: nextPort++ });
      assert.ok(code !== 0, `expected non-zero exit code, got ${code}`);
    });

    it("two mocks run simultaneously and stay independent", async () => {
      const mockA = await MockProcess.start({ model: "nord-electro-5d", wsPort: nextPort++ });
      const mockB = await MockProcess.start({ model: "sequential-prophet-6", wsPort: nextPort++ });
      try {
        const stateA = await mockA.waitForState();
        const stateB = await mockB.waitForState();
        // Each mock produces its own model-specific state shape
        assert.ok(stateA.preset1Drawbars, "Nord state missing preset1Drawbars");
        assert.ok(stateB.global?.arp_mode, "Prophet-6 state missing arp_mode");
        // Stop A — B keeps running
        await mockA.stop();
        const stateBAfter = await mockB.waitForState();
        assert.ok(stateBAfter.global, "Prophet-6 stopped responding after Nord stopped");
      } finally {
        try { await mockA.stop(); } catch { /* ignore */ }
        try { await mockB.stop(); } catch { /* ignore */ }
      }
    });

    it("three concurrent mocks on different ports stay independent", async () => {
      const mocks = [
        await MockProcess.start({ model: "nord-electro-5d", wsPort: nextPort++ }),
        await MockProcess.start({ model: "roland-juno-x", wsPort: nextPort++ }),
        await MockProcess.start({ model: "sequential-prophet-6", wsPort: nextPort++ }),
      ];
      try {
        const states = await Promise.all(mocks.map((m) => m.waitForState()));
        assert.ok(states[0].preset1Drawbars, "Nord state missing");
        assert.ok(states[1].part1, "JUNO-X state missing");
        assert.ok(states[2].global?.arp_mode, "Prophet-6 state missing");
      } finally {
        await Promise.all(mocks.map(async (m) => {
          try { await m.stop(); } catch { /* ignore */ }
        }));
      }
    });

    it("each running mock publishes itself in the runtime registry", async () => {
      const tmpData = mkdtempSync(join(tmpdir(), "mock-registry-int-"));
      const prevEnv = process.env.KEYBOARDS_MCP_DATA_DIR;
      process.env.KEYBOARDS_MCP_DATA_DIR = tmpData;
      let mock: MockProcess | null = null;
      try {
        mock = await MockProcess.start({ model: "nord-electro-5d", wsPort: nextPort++ });
        await mock.waitForState();
        // Brief settle to let the engine flush its registry write
        await new Promise((r) => setTimeout(r, 100));

        const entries = readActive();
        const ours = entries.find((e) => e.modelId === "nord-electro-5d");
        assert.ok(ours, `expected a registry entry for nord-electro-5d, got: ${JSON.stringify(entries)}`);
        assert.equal(ours.midiPort, "Nord Electro 5D Mock");
        assert.equal(typeof ours.wsPort, "number");
      } finally {
        if (mock) await mock.stop();
        // The engine.stop() unregisters; verify
        await new Promise((r) => setTimeout(r, 100));
        const after = readActive();
        const stillThere = after.find((e) => e.modelId === "nord-electro-5d");
        assert.equal(stillThere, undefined, "expected the entry to be removed on stop");
        if (prevEnv === undefined) delete process.env.KEYBOARDS_MCP_DATA_DIR;
        else process.env.KEYBOARDS_MCP_DATA_DIR = prevEnv;
        rmSync(tmpData, { recursive: true, force: true });
      }
    });

    it("port reuse — restarting on the same port works after the previous mock stops", async () => {
      const port = nextPort++;
      const first = await MockProcess.start({ model: "nord-electro-5d", wsPort: port });
      await first.waitForState();
      await first.stop();

      // Brief settle so the OS releases the port
      await new Promise((resolve) => setTimeout(resolve, 200));

      const second = await MockProcess.start({ model: "sequential-prophet-6", wsPort: port });
      try {
        const state = await second.waitForState();
        assert.ok(state.global?.arp_mode, "Prophet-6 state missing after port reuse");
      } finally {
        await second.stop();
      }
    });
  }
});
