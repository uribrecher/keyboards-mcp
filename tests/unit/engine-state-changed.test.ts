import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MockEngine } from "../../src/mock-runner/engine.js";
import type { MockHandler } from "../../src/shared/keyboard-model.js";

function makeStubHandler(): MockHandler {
  let label: string | undefined;
  let lower = 0, upper = 1;
  const state: Record<string, any> = { foo: 0 };
  return {
    init(l, u, lab) { lower = l; upper = u; label = lab; },
    onMIDI: () => ({}),
    getFullState: () => ({ ...state, _meta: { lower, upper, label } }),
    setFullState(snap) { Object.assign(state, snap); },
  };
}

describe("MockEngine snapshot + state-changed", () => {
  it("getFullState(false) delegates to the handler with includeInventory=false", () => {
    const handler = makeStubHandler();
    let captured: boolean | undefined;
    handler.getFullState = (includeInventory) => {
      captured = includeInventory;
      return { ok: true };
    };
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    const snap = engine.getFullState(false);
    assert.equal(captured, false);
    assert.deepEqual(snap, { ok: true });
  });

  it("restoreSnapshot returns false when handler lacks setFullState", () => {
    const handler = makeStubHandler();
    delete (handler as any).setFullState;
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    assert.equal(engine.restoreSnapshot({ any: "thing" }), false);
  });

  it("restoreSnapshot returns true and calls setFullState when supported", () => {
    const handler = makeStubHandler();
    let received: any = null;
    handler.setFullState = (snap) => { received = snap; };
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    assert.equal(engine.restoreSnapshot({ a: 1 }), true);
    assert.deepEqual(received, { a: 1 });
  });

  it("restoreSnapshot returns false (and does not throw) when snapshot is null", () => {
    const handler = makeStubHandler();
    const engine = new MockEngine(handler, {
      lowerChannel: 0, upperChannel: 1, wsPort: 0,
      portName: "x", noMidi: true, noRegistry: true,
    });
    assert.equal(engine.restoreSnapshot(null), false);
  });
});
