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

/**
 * Rich form of a registry entry used by the `GET /v1/midi/ports` endpoint.
 * Carries every field the at-rest `mocks.json` writes (modelId, displayName,
 * timestamps) plus a `stale` flag. Sourced from the shared mock-registry
 * module; re-exported here so MCB internals don't need to reach into shared/.
 */
export type MockRegistryEntryFull = import("../shared/mock-registry.js").MockRegistryEntry & { stale: boolean };

export interface MockRegistryReader {
  findByLabel(label: string): MockRegistryEntry | undefined;
  findByMidiPort(midiPort: string): MockRegistryEntry | undefined;
  list(): MockRegistryEntry[];
  /**
   * Full enumeration including stale entries. Stale = process gone or
   * `lastTouched` older than `STALE_AFTER_MS`. The `GET /v1/midi/ports`
   * endpoint surfaces stale entries with the flag so operators can see
   * ghost mocks instead of having them silently filtered.
   */
  listAllWithStale(): MockRegistryEntryFull[];
}
