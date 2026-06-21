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
  /**
   * Mock's dedicated outgoing-MIDI WS port (#109), when it has one. Surfaced
   * in the manifest so a WS-transport consumer can receive the RQ1→DT1
   * round-trip. `null`/absent for real hardware or mocks without an out lane.
   */
  wsOutPort?: number | null;
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
  /**
   * When the lease's primary port is a mock at claim time, this is the
   * mock's `instanceId`. `null` for real-keyboard leases. Used by the
   * passive reap-on-read safety net to detect a successor mock at the
   * same port name.
   */
  mockInstanceId: string | null;
  /**
   * Symmetric to `mockInstanceId` but for the lease's shadow port (if any
   * and if it's a mock at claim time). `null` when there is no shadow or
   * the shadow is real hardware. Reaper handles both sides identically —
   * closing either the primary's mock or the shadow's mock invalidates
   * the lease.
   */
  shadowMockInstanceId: string | null;
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
  /** Dedicated outgoing-MIDI WS port (#109), when the mock has one. */
  wsOutPort?: number;
  label: string;
  pid: number;
  /** Per-boot UUID. See `src/shared/mock-registry.ts` for semantics. */
  instanceId: string;
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
