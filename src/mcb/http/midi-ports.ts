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
  startedAt: string;
  lastTouched: string;
  stale: boolean;
}

interface LeaseAnnotation {
  kind: "primary" | "shadow";
  sessionId: string;
  deviceId: string;
  model: string;
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
      });
      if (lease.shadow) {
        leaseByPort.set(lease.shadow.portName, {
          kind: "shadow",
          sessionId: lease.ownerSessionId,
          deviceId: lease.deviceId,
          model: lease.model,
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
