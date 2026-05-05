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
});
