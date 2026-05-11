import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import { BridgeRegistry } from "../../../src/mcb/bridge-registry.js";
import { SessionManager } from "../../../src/mcb/session-manager.js";
import { reapStaleMockLeases } from "../../../src/mcb/reap-stale-mock-leases.js";
import type { MockRegistryReader, MockRegistryEntry, Lease } from "../../../src/mcb/types.js";

const reg = (entries: MockRegistryEntry[]): MockRegistryReader => ({
  findByLabel: (l) => entries.find((e) => e.label === l),
  findByMidiPort: (p) => entries.find((e) => e.midiPort === p),
  list: () => entries,
  listAllWithStale: () => entries.map((e) => ({ ...e, stale: false, modelId: "m", displayName: "M", startedAt: "0", lastTouched: "0" })),
});

function makeLease(over: Partial<Lease> = {}): Lease {
  return {
    deviceId: "dev-1",
    ownerSessionId: "sess-1",
    model: "m",
    primary: { portName: "Mock 1", wsPort: 9000 },
    channel: 1,
    connectedAt: 0,
    mockInstanceId: null,
    ...over,
  };
}

describe("reapStaleMockLeases", () => {
  it("leaves real-keyboard leases (mockInstanceId=null) alone even when no registry entry matches", () => {
    const leases = new LeaseRegistry();
    const bridges = new BridgeRegistry();
    const sessions = new SessionManager();
    leases.add(makeLease({ deviceId: "hw", primary: { portName: "Real KB", wsPort: null }, mockInstanceId: null }));
    const reaped = reapStaleMockLeases({ leases, bridges, sessions, mockRegistry: reg([]) });
    assert.equal(reaped.length, 0);
    assert.ok(leases.get("hw"));
  });

  it("reaps a mock-bound lease when the registry entry for the same port has a different instanceId", () => {
    const leases = new LeaseRegistry();
    const bridges = new BridgeRegistry();
    const sessions = new SessionManager();
    const session = sessions.create({ pid: 1 });
    leases.add(makeLease({ deviceId: "d1", ownerSessionId: session.sessionId, mockInstanceId: "A1" }));
    session.ownedDeviceIds.add("d1");
    const reaped = reapStaleMockLeases({
      leases, bridges, sessions,
      mockRegistry: reg([{ midiPort: "Mock 1", wsPort: 9000, label: "x", pid: 1, instanceId: "A2" }]),
    });
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].deviceId, "d1");
    assert.equal(leases.get("d1"), undefined);
    assert.equal(session.ownedDeviceIds.has("d1"), false);
  });

  it("reaps a mock-bound lease when the registry entry for the port is gone entirely", () => {
    const leases = new LeaseRegistry();
    const bridges = new BridgeRegistry();
    const sessions = new SessionManager();
    leases.add(makeLease({ deviceId: "d1", mockInstanceId: "A1" }));
    const reaped = reapStaleMockLeases({ leases, bridges, sessions, mockRegistry: reg([]) });
    assert.equal(reaped.length, 1);
    assert.equal(leases.get("d1"), undefined);
  });

  it("does not reap a mock-bound lease when the registry entry's instanceId still matches", () => {
    const leases = new LeaseRegistry();
    const bridges = new BridgeRegistry();
    const sessions = new SessionManager();
    leases.add(makeLease({ deviceId: "d1", mockInstanceId: "A1" }));
    const reaped = reapStaleMockLeases({
      leases, bridges, sessions,
      mockRegistry: reg([{ midiPort: "Mock 1", wsPort: 9000, label: "x", pid: 1, instanceId: "A1" }]),
    });
    assert.equal(reaped.length, 0);
    assert.ok(leases.get("d1"));
  });

  it("drops the bridge entry when reaping a lease that has a shadow", () => {
    const leases = new LeaseRegistry();
    const bridges = new BridgeRegistry();
    const sessions = new SessionManager();
    leases.add(makeLease({ deviceId: "d1", mockInstanceId: "A1" }));
    bridges.add("d1", "Mock 1", "Shadow Port");
    const reaped = reapStaleMockLeases({ leases, bridges, sessions, mockRegistry: reg([]) });
    assert.equal(reaped.length, 1);
    assert.equal(bridges.shadowOf("d1"), undefined);
  });
});
