import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";

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

    it("after remove, the freed master port is no longer treated as a chain hop", () => {
      registry.add("dev-A", "port-A", "port-B");
      registry.add("dev-B", "port-B", "port-C");
      registry.remove("dev-B");
      // Without masterIndex cleanup on remove, the walker would still see port-B as
      // a master and follow to its old shadow port-C, which would falsely reject A→C.
      registry.add("dev-A2", "port-A2", "port-C");
      assert.equal(registry.shadowOf("dev-A2"), "port-C");
    });
  });
});
