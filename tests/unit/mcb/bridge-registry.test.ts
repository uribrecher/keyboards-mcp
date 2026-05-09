import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { BridgeRegistry, BridgeRegistryError } from "../../../src/mcb/bridge-registry.js";

let registry: BridgeRegistry;

describe("BridgeRegistry", () => {
  beforeEach(() => { registry = new BridgeRegistry(); });

  it("adds and reads back a bridge", () => {
    registry.add("dev-A", "Master Port", "Shadow Port");
    assert.equal(registry.shadowOf("dev-A"), "Shadow Port");
    assert.deepEqual(registry.isShadowTarget("Shadow Port"), { masterDeviceId: "dev-A" });
  });

  it("rejects self-shadow", () => {
    assert.throws(
      () => registry.add("dev-A", "Same Port", "Same Port"),
      { message: /self-shadow/i },
    );
  });

  it("rejects when master already has a bridge", () => {
    registry.add("dev-A", "Master Port", "Shadow Port");
    assert.throws(
      () => registry.add("dev-A", "Master Port", "Other Shadow"),
      { message: /bridge-already-exists/i },
    );
  });

  it("rejects when shadow port is already a target", () => {
    registry.add("dev-A", "Master A", "Shared Shadow");
    assert.throws(
      () => registry.add("dev-B", "Master B", "Shared Shadow"),
      { message: /shadow-conflict/i },
    );
  });

  it("remove drops the bridge", () => {
    registry.add("dev-A", "Master Port", "Shadow Port");
    registry.remove("dev-A");
    assert.equal(registry.shadowOf("dev-A"), undefined);
    assert.equal(registry.isShadowTarget("Shadow Port"), undefined);
  });

  it("errors are typed instances with stable code fields", () => {
    try {
      registry.add("dev-A", "Same Port", "Same Port");
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof BridgeRegistryError, `expected BridgeRegistryError, got ${err}`);
      assert.equal(err.code, "self-shadow");
    }
    registry.add("dev-A", "Master Port", "Shadow Port");
    try {
      registry.add("dev-B", "Master Port 2", "Shadow Port");
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof BridgeRegistryError);
      assert.equal(err.code, "shadow-conflict");
    }
  });

  describe("cycle detection", () => {
    it("rejects a 2-hop cycle (A→B then B→A)", () => {
      registry.add("dev-A", "port-A", "port-B");
      assert.throws(
        () => registry.add("dev-B", "port-B", "port-A"),
        { message: /cycle-would-form/i },
      );
    });

    it("rejects a 3-hop cycle (A→B, B→C, then C→A)", () => {
      registry.add("dev-A", "port-A", "port-B");
      registry.add("dev-B", "port-B", "port-C");
      assert.throws(
        () => registry.add("dev-C", "port-C", "port-A"),
        { message: /cycle-would-form/i },
      );
    });

    it("rejects an N-hop cycle (4 hops)", () => {
      registry.add("dev-A", "port-A", "port-B");
      registry.add("dev-B", "port-B", "port-C");
      registry.add("dev-C", "port-C", "port-D");
      assert.throws(
        () => registry.add("dev-D", "port-D", "port-A"),
        { message: /cycle-would-form/i },
      );
    });

    it("allows a multi-hop chain that does not close (A→B then B→C)", () => {
      registry.add("dev-A", "port-A", "port-B");
      registry.add("dev-B", "port-B", "port-C");
      assert.equal(registry.shadowOf("dev-A"), "port-B");
      assert.equal(registry.shadowOf("dev-B"), "port-C");
    });

    it("allows independent bridges that share no ports", () => {
      registry.add("dev-X", "port-X", "port-Y");
      registry.add("dev-A", "port-A", "port-B");
      assert.equal(registry.shadowOf("dev-X"), "port-Y");
      assert.equal(registry.shadowOf("dev-A"), "port-B");
    });

    it("allows extending a chain after a remove that broke the cycle path", () => {
      registry.add("dev-A", "port-A", "port-B");
      registry.add("dev-B", "port-B", "port-C");
      registry.remove("dev-A");
      // C→A is now legal — no chain from A back to C.
      registry.add("dev-C", "port-C", "port-A");
      assert.equal(registry.shadowOf("dev-C"), "port-A");
    });

    it("rejects a second bridge that reuses an existing master port", () => {
      registry.add("dev-A", "port-A", "port-B");
      assert.throws(
        () => registry.add("dev-A2", "port-A", "port-C"),
        { message: /master-port-conflict/i },
      );
    });

    it("after remove, the freed master port is reusable for a new bridge", () => {
      registry.add("dev-A", "port-A", "port-B");
      registry.remove("dev-A");
      // Without masterIndex cleanup on remove, this would falsely reject as
      // master-port-conflict because masterIndex would still hold port-A → dev-A.
      registry.add("dev-A2", "port-A", "port-C");
      assert.equal(registry.shadowOf("dev-A2"), "port-C");
    });
  });

  // #21 enabled mock-as-primary (bidirectional virtual MIDI ports).
  // These regression tests exercise the existing walker against the new
  // configurations to ensure none of them slip through cycle detection.
  describe("regression: cycles in #21-enabled configurations", () => {
    it("rejects a 2-hop cycle between two mock primaries (mocks share OS port name across directions)", () => {
      // For mocks, both MIDI directions share the same OS port name (#21).
      // So a bridge `mockA → mockB` plus a bridge `mockB → mockA` is a
      // straight 2-hop cycle, indistinguishable from any other 2-hop case.
      const r = new BridgeRegistry();
      r.add("dev-A", "Roland JUNO-X Mock", "Roland JUNO-X Mock1");
      assert.throws(
        () => r.add("dev-B", "Roland JUNO-X Mock1", "Roland JUNO-X Mock"),
        /cycle-would-form/,
      );
    });

    it("rejects a 3-hop cycle across three mocks", () => {
      const r = new BridgeRegistry();
      r.add("dev-A", "mockA", "mockB");
      r.add("dev-B", "mockB", "mockC");
      assert.throws(
        () => r.add("dev-C", "mockC", "mockA"),
        /cycle-would-form/,
      );
    });

    it("allows mock-as-primary chained linearly without closing", () => {
      const r = new BridgeRegistry();
      r.add("dev-A", "mockA", "mockB");
      r.add("dev-B", "mockB", "mockC");
      // Linear chain — no cycle.
    });

    it("rejects a self-bridge on a mock primary", () => {
      // For mocks, primary.portName === input.portName (same OS port name).
      // A bridge from a mock to itself is just a self-shadow.
      const r = new BridgeRegistry();
      assert.throws(
        () => r.add("dev-A", "mockA", "mockA"),
        /self-shadow/,
      );
    });

    it("rejects reusing a mock as the master of a second bridge (master-port-conflict)", () => {
      // A port can only be the master of ONE bridge (data flows from
      // master to shadow — duplicating wouldn't make physical sense).
      // First bridge claims mockB as master OK; second bridge using
      // mockB as master fails. Note: a port CAN be both a shadow target
      // (bridge1.shadow=mockB) AND the master of a different bridge
      // (bridge2.master=mockB), as the chain test below exercises.
      const r = new BridgeRegistry();
      r.add("dev-A", "mockA", "mockB");
      r.add("dev-B", "mockB", "mockC"); // mockB is shadow of A, master of B — OK.
      assert.throws(
        () => r.add("dev-C", "mockB", "mockD"),
        /master-port-conflict/,
      );
    });
  });
});
