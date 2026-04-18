import { describe, it, after } from "node:test";
import { strict as assert } from "node:assert";
import { MockProcess } from "../helpers/mock-process.js";

// Use unique ports per test to avoid EADDRINUSE
let nextPort = 4000;

describe("headless mock runner", { concurrency: 1 }, () => {
  // ── Nord Electro 5D ──

  it("starts Nord and receives initial state with correct shape", async () => {
    const port = nextPort++;
    const mock = await MockProcess.start({ model: "nord-electro-5d", wsPort: port });
    try {
      const state = await mock.waitForState();
      assert.ok(state.lower, "missing lower");
      assert.ok(state.upper, "missing upper");
      assert.ok(state.global, "missing global");
      assert.ok(state.preset1Drawbars, "missing preset1Drawbars");
      assert.ok(state.preset2Drawbars, "missing preset2Drawbars");
    } finally {
      await mock.stop();
    }
  });

  // ── JUNO-X ──

  it("starts JUNO-X and receives initial state with correct shape", async () => {
    const port = nextPort++;
    const mock = await MockProcess.start({ model: "roland-juno-x", wsPort: port });
    try {
      const state = await mock.waitForState();
      assert.ok(state.model, "missing model");
      assert.ok(state.part1, "missing part1");
      assert.ok(state.part5, "missing part5");
      assert.ok(state.scene, "missing scene");
      assert.ok(state.sceneGlobal !== undefined, "missing sceneGlobal");
    } finally {
      await mock.stop();
    }
  });

  // ── Prophet-6 ──

  it("starts Prophet-6 and receives initial state with correct shape", async () => {
    const port = nextPort++;
    const mock = await MockProcess.start({ model: "sequential-prophet-6", wsPort: port });
    try {
      const state = await mock.waitForState();
      assert.ok(state.global, "missing global");
      // Prophet-6 is mono-timbral — should only have global
      assert.ok(!state.lower, "should not have lower");
      assert.ok(!state.upper, "should not have upper");
    } finally {
      await mock.stop();
    }
  });

  // ── Invalid model ──

  it("exits with non-zero code for invalid model", async () => {
    const code = await MockProcess.startExpectingFailure({
      model: "nonexistent-model",
      wsPort: nextPort++,
    });
    assert.ok(code !== 0, `expected non-zero exit code, got ${code}`);
  });
});
