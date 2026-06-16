import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { makeMidiPortsHandler } from "../../../src/mcb/http/midi-ports.js";
import { LeaseRegistry } from "../../../src/mcb/lease-registry.js";
import type { MockRegistryReader, MockRegistryEntryFull, PortListReader, Lease } from "../../../src/mcb/types.js";

const port = (outputs: string[], inputs: string[] = []): PortListReader =>
  ({ listOutputs: () => outputs, listInputs: () => inputs });

const reg = (full: MockRegistryEntryFull[]): MockRegistryReader => ({
  findByLabel: (l) => full.find((e) => e.label === l),
  findByMidiPort: (p) => full.find((e) => e.midiPort === p),
  list: () => full.filter((e) => !e.stale),
  listAllWithStale: () => full,
});

const fullEntry = (overrides: Partial<MockRegistryEntryFull> = {}): MockRegistryEntryFull => ({
  midiPort: "Nord Mock", wsPort: 3000,
  modelId: "nord-electro-5d", displayName: "Nord Electro 5D",
  label: "nordi", pid: 1234,
  instanceId: "00000000-0000-0000-0000-00000000aaaa",
  startedAt: "2026-05-06T00:00:00.000Z", lastTouched: "2026-05-06T00:00:30.000Z",
  stale: false,
  ...overrides,
});

const lease = (overrides: Partial<Lease> = {}): Lease => ({
  deviceId: "dev-1",
  ownerSessionId: "sess-1",
  model: "nord-electro-5d",
  primary: { portName: "Nord Mock", wsPort: 3000 },
  channel: 1,
  connectedAt: 0,
  mockInstanceId: null,
  shadowMockInstanceId: null,
  ...overrides,
});

describe("GET /v1/midi/ports handler", () => {
  it("lists OS outputs and inputs with no annotations when registry/leases empty", async () => {
    const h = makeMidiPortsHandler({
      leases: new LeaseRegistry(),
      portList: port(["Port A", "Port B"], ["In 1"]),
      mockRegistry: reg([]),
    });
    const res = await h();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      outputs: [
        { name: "Port A", mock: undefined, lease: undefined },
        { name: "Port B", mock: undefined, lease: undefined },
      ],
      inputs: [{ name: "In 1" }],
    });
  });

  it("attaches mock-registry annotation including the stale flag", async () => {
    const h = makeMidiPortsHandler({
      leases: new LeaseRegistry(),
      portList: port(["Nord Mock", "Stale Mock"]),
      mockRegistry: reg([
        fullEntry({ midiPort: "Nord Mock" }),
        fullEntry({ midiPort: "Stale Mock", wsPort: 3001, label: "ghost", stale: true }),
      ]),
    });
    const res = await h();
    const out = (res.body as { outputs: Array<{ name: string; mock?: { stale: boolean } }> }).outputs;
    assert.equal(out[0].mock?.stale, false);
    assert.equal(out[1].mock?.stale, true);
  });

  it("attaches lease annotation as primary on the master and shadow on the shadow target", async () => {
    const leases = new LeaseRegistry();
    leases.add(lease({
      primary: { portName: "Hardware Nord", wsPort: null },
      shadow: { portName: "Nord Mock", wsPort: 3000 },
    }));
    const h = makeMidiPortsHandler({
      leases,
      portList: port(["Hardware Nord", "Nord Mock"]),
      mockRegistry: reg([fullEntry({ midiPort: "Nord Mock" })]),
    });
    const res = await h();
    const out = (res.body as { outputs: Array<{ name: string; lease?: { kind: string; deviceId: string } }> }).outputs;
    assert.equal(out[0].lease?.kind, "primary");
    assert.equal(out[1].lease?.kind, "shadow");
    assert.equal(out[0].lease?.deviceId, "dev-1");
    assert.equal(out[1].lease?.deviceId, "dev-1");
  });

  it("surfaces mock.instanceId and lease.mockInstanceId so the agent can correlate a closed-mock scenario", async () => {
    const leases = new LeaseRegistry();
    leases.add(lease({
      primary: { portName: "Nord Mock", wsPort: 3000 },
      mockInstanceId: "00000000-0000-0000-0000-00000000aaaa",
    }));
    const h = makeMidiPortsHandler({
      leases,
      portList: port(["Nord Mock"]),
      mockRegistry: reg([fullEntry({ midiPort: "Nord Mock", instanceId: "00000000-0000-0000-0000-00000000aaaa" })]),
    });
    const res = await h();
    const out = (res.body as { outputs: Array<{ mock?: { instanceId: string }; lease?: { mockInstanceId: string | null } }> }).outputs;
    assert.equal(out[0].mock?.instanceId, "00000000-0000-0000-0000-00000000aaaa");
    assert.equal(out[0].lease?.mockInstanceId, "00000000-0000-0000-0000-00000000aaaa");
  });

  it("returns ports MCB sees even if no mock or lease matches", async () => {
    const h = makeMidiPortsHandler({
      leases: new LeaseRegistry(),
      portList: port(["Random HW Port"]),
      mockRegistry: reg([]),
    });
    const res = await h();
    const out = (res.body as { outputs: Array<{ name: string; mock?: unknown; lease?: unknown }> }).outputs;
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "Random HW Port");
    assert.equal(out[0].mock, undefined);
    assert.equal(out[0].lease, undefined);
  });
});
