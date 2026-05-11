import type { LeaseRegistry } from "../lease-registry.js";
import type { PortListReader, MockRegistryReader } from "../types.js";

interface Deps {
  leases: LeaseRegistry;
  portList: PortListReader;
  mockRegistry: MockRegistryReader;
}

interface MockAnnotation {
  midiPort: string;
  wsPort: number;
  modelId: string;
  displayName: string;
  label: string;
  pid: number;
  /** Per-boot UUID for this mock instance. Never recycled across tab closes. */
  instanceId: string;
  startedAt: string;
  lastTouched: string;
  stale: boolean;
}

interface LeaseAnnotation {
  kind: "primary" | "shadow";
  sessionId: string;
  deviceId: string;
  model: string;
  /**
   * For mock-backed leases, the `instanceId` of the mock that was active
   * at claim time. `null` for real-keyboard leases. A mismatch against the
   * current mock annotation on the same port means the lease is bound to a
   * different (closed) mock — the broker's passive reaper will catch it on
   * the next read.
   */
  mockInstanceId: string | null;
}

interface OutputPort {
  name: string;
  mock?: MockAnnotation;
  lease?: LeaseAnnotation;
}

interface InputPort {
  name: string;
}

export interface MidiPortsResponse {
  outputs: OutputPort[];
  inputs: InputPort[];
}

export function makeMidiPortsHandler(deps: Deps) {
  return async () => {
    const outputNames = deps.portList.listOutputs();
    const inputNames = deps.portList.listInputs();

    const mockByPort = new Map<string, MockAnnotation>();
    for (const e of deps.mockRegistry.listAllWithStale()) {
      mockByPort.set(e.midiPort, {
        midiPort: e.midiPort, wsPort: e.wsPort,
        modelId: e.modelId, displayName: e.displayName,
        label: e.label, pid: e.pid,
        instanceId: e.instanceId,
        startedAt: e.startedAt, lastTouched: e.lastTouched,
        stale: e.stale,
      });
    }

    const leaseByPort = new Map<string, LeaseAnnotation>();
    for (const lease of deps.leases.listAll()) {
      leaseByPort.set(lease.primary.portName, {
        kind: "primary",
        sessionId: lease.ownerSessionId,
        deviceId: lease.deviceId,
        model: lease.model,
        mockInstanceId: lease.mockInstanceId,
      });
      if (lease.shadow) {
        leaseByPort.set(lease.shadow.portName, {
          kind: "shadow",
          sessionId: lease.ownerSessionId,
          deviceId: lease.deviceId,
          model: lease.model,
          mockInstanceId: lease.mockInstanceId,
        });
      }
    }

    const body: MidiPortsResponse = {
      outputs: outputNames.map((name) => ({
        name,
        mock: mockByPort.get(name),
        lease: leaseByPort.get(name),
      })),
      inputs: inputNames.map((name) => ({ name })),
    };
    return { statusCode: 200, body };
  };
}
