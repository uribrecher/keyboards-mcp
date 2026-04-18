import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MockProcess } from "../helpers/mock-process.js";

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
      { model: "nord-electro-5d", check: (s: any) => { assert.ok(s.lower); assert.ok(s.upper); assert.ok(s.global); assert.ok(s.preset1Drawbars); } },
      { model: "roland-juno-x", check: (s: any) => { assert.ok(s.model); assert.ok(s.part1); assert.ok(s.part5); } },
      { model: "sequential-prophet-6", check: (s: any) => { assert.ok(s.global); assert.ok(!s.lower); } },
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
  }
});
