import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import type { Lease } from "../../../src/mcb/types.js";

let r: LeaseRegistry;

function fixture(o: Partial<Lease> = {}): Lease {
  return {
    deviceId: "dev-1", ownerSessionId: "sess-1", model: "m",
    primary: { portName: "Port A", wsPort: null },
    label: "default", channel: 1, connectedAt: Date.now(), ...o,
  };
}

describe("LeaseRegistry", () => {
  beforeEach(() => { r = new LeaseRegistry(); });

  it("adds and reads back a lease", () => {
    const lease = fixture();
    r.add(lease);
    assert.deepEqual(r.get("dev-1"), lease);
  });

  it("rejects adding a lease whose primary is already owned", () => {
    r.add(fixture({ deviceId: "dev-1", primary: { portName: "Same", wsPort: null } }));
    assert.throws(
      () => r.add(fixture({ deviceId: "dev-2", primary: { portName: "Same", wsPort: null } })),
      { message: /port-already-owned/i },
    );
  });

  it("isPrimary returns owner info", () => {
    r.add(fixture({ deviceId: "dev-1", ownerSessionId: "s-1", primary: { portName: "X", wsPort: null } }));
    assert.deepEqual(r.isPrimary("X"), { sessionId: "s-1", deviceId: "dev-1" });
    assert.equal(r.isPrimary("Other"), undefined);
  });

  it("listAll + remove", () => {
    r.add(fixture({ deviceId: "dev-1", primary: { portName: "A", wsPort: null } }));
    r.add(fixture({ deviceId: "dev-2", primary: { portName: "B", wsPort: null } }));
    assert.equal(r.listAll().length, 2);
    r.remove("dev-1");
    assert.equal(r.listAll().length, 1);
    assert.equal(r.get("dev-1"), undefined);
  });
});
