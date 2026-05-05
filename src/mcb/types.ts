export interface Session {
  sessionId: string;
  pid: number;
  processName?: string;
  ownedDeviceIds: Set<string>;
  createdAt: number;
  /** Epoch ms when the liveness watcher first declared the PID dead, else null. */
  markedDeadAt: number | null;
}

export interface ShadowEndpoint {
  portName: string;
}

export interface PortInfo {
  portName: string;
  wsPort: number | null;
}

export interface Lease {
  deviceId: string;
  ownerSessionId: string;
  model: string;
  primary: PortInfo;
  input?: { portName: string };
  shadow?: PortInfo;
  label: string;
  channel: number;
  lowerChannel?: number;
  upperChannel?: number;
  connectedAt: number;
}

export type Manifest = Omit<Lease, "connectedAt">;

export type Direction = "output" | "input";

export interface PortListReader {
  listOutputs(): string[];
  listInputs(): string[];
}

export interface MockRegistryEntry {
  midiPort: string;
  wsPort: number;
  label: string;
  pid: number;
}

export interface MockRegistryReader {
  findByLabel(label: string): MockRegistryEntry | undefined;
  findByMidiPort(midiPort: string): MockRegistryEntry | undefined;
  list(): MockRegistryEntry[];
}
