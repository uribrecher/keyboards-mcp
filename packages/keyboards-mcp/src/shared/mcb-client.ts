/**
 * HTTP-over-UDS client for talking to midi-connections-broker (MCB).
 *
 * MCB is the source of truth for sessions and leases; this module only caches
 * the MCP's session id in memory. The session is minted lazily on the first
 * call that needs one (claimLease). When MCB returns 404 session-not-found on
 * a session-bearing call, the cache is dropped and the registered
 * `onSessionLost` callback fires so the caller can tear down dependent caches
 * (the device pool). The MCP does not attempt to re-mint silently — the
 * failing call surfaces session-lost to the user, and the next call mints
 * fresh.
 *
 * To detect session loss proactively (rather than waiting for the next
 * session-bearing call), a 5s heartbeat pings GET /v1/health with the cached
 * x-session-id once a session has been minted. A 404 from that ping fires the
 * same drop-and-notify path as a session-bearing call. Any other heartbeat
 * error (mcb-unreachable, 5xx, parse) is treated as transient and ignored —
 * only confirmed session-not-found from MCB drops state. The agent observes
 * broker reachability through the existing get_health tool, so heartbeat
 * failures don't need their own log channel.
 *
 * Broker-liveness is a separate concern: a 2s ticker pings GET /v1/health
 * (no session header) whenever a subscriber is registered via
 * `setOnBrokerLivenessChange`, and pushes "up" / "down" transitions. This is
 * what consumers like the mock-runner shell wire into to drive UI affordances
 * (blinking-amber LEDs on outage). Subscribers don't poll MCB themselves —
 * they listen to the notifications this module owns.
 */

import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Manifest {
  deviceId: string;
  ownerSessionId: string;
  model: string;
  // `wsOutPort` (#109): the mock's dedicated outgoing-MIDI WS port, surfaced
  // so a WS-transport consumer can receive the RQ1→DT1 round-trip. Null/absent
  // for real hardware or mocks without an out lane.
  primary: { portName: string; wsPort: number | null; wsOutPort?: number | null };
  input?: { portName: string };
  shadow?: { portName: string; wsPort: number | null; wsOutPort?: number | null };
  channel: number;
  lowerChannel?: number;
  upperChannel?: number;
}

export interface ClaimRequest {
  port: string;
  model: string;
  with_shadow?: string;
  input_port?: string;
  channel?: number;
  lower_channel?: number;
  upper_channel?: number;
}

export class MCBError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

/**
 * Thrown when MCB returns 404 session-not-found. By the time this error
 * surfaces, the cached session id has been dropped and the onSessionLost
 * callback has been invoked. `droppedLeaseCount` is the number of leases
 * the callback reported tearing down (informational — included in the
 * user-facing message).
 */
export class MCBSessionLostError extends MCBError {
  constructor(public droppedLeaseCount: number, public lostSessionId: string) {
    super(404, "session-lost",
      `MCB returned session-not-found. Dropped ${droppedLeaseCount} local lease(s). Retry to establish a fresh session.`);
  }
}

/**
 * Thrown when MCB returns 404 device-not-found on a session-bearing call.
 * Means the lease the MCP cached locally no longer exists in MCB — either
 * because the bound mock instance closed and the broker reaped the lease,
 * or because someone else released it. By the time this surfaces, the
 * matching pool entry has been dropped via the `onDeviceLost` callback.
 *
 * Distinct from `MCBSessionLostError`: only the one device is gone, the
 * session and other devices are intact. Tools surface this to the user as
 * "this connection is dead — reconnect manually."
 */
export class MCBDeviceLostError extends MCBError {
  constructor(public lostDeviceId: string) {
    super(404, "device-lost",
      `MCB returned device-not-found for device ${lostDeviceId}. The bound mock instance is gone; the local lease has been dropped. Use connect_to_keyboard to re-establish.`);
  }
}

function socketPath(): string {
  return process.env.MCB_SOCKET ?? join(homedir(), ".mcb", "sock");
}

type ConnectTarget =
  | { kind: "uds"; socketPath: string }
  | { kind: "tcp"; host: string; port: number };

// MCB_TCP=<host>:<port> opts the client into TCP mode (docker-compose CI
// topology). Anything else falls through to the UDS default at MCB_SOCKET.
function connectTarget(): ConnectTarget {
  const tcp = process.env.MCB_TCP;
  if (tcp) {
    const lastColon = tcp.lastIndexOf(":");
    if (lastColon <= 0) throw new Error(`MCB_TCP must be host:port, got: ${tcp}`);
    const host = tcp.slice(0, lastColon);
    const port = Number(tcp.slice(lastColon + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`MCB_TCP port must be 1-65535, got: ${tcp}`);
    }
    return { kind: "tcp", host, port };
  }
  return { kind: "uds", socketPath: socketPath() };
}

function describeTarget(t: ConnectTarget): string {
  return t.kind === "uds" ? t.socketPath : `tcp://${t.host}:${t.port}`;
}

let cachedSessionId: string | null = null;

/**
 * Returns the number of local leases torn down. Registered by `index.ts` so
 * a session-loss can clear the device pool synchronously with the cache drop.
 */
type SessionLostCallback = () => number;
let onSessionLost: SessionLostCallback | null = null;

export function setOnSessionLost(cb: SessionLostCallback | null): void {
  onSessionLost = cb;
}

/**
 * Fired when a session-bearing call returns 404 device-not-found. Receives
 * the deviceId so the caller can drop the matching pool entry (only that
 * one — not the whole session).
 */
type DeviceLostCallback = (deviceId: string) => void;
let onDeviceLost: DeviceLostCallback | null = null;

export function setOnDeviceLost(cb: DeviceLostCallback | null): void {
  onDeviceLost = cb;
}

/** Read the cached session id without minting one. Used by get_health. */
export function getCachedSessionId(): string | null {
  return cachedSessionId;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

function heartbeatIntervalMs(): number {
  const raw = process.env.MCB_HEARTBEAT_MS;
  if (raw === undefined) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

function startHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => { void heartbeatTick(); }, heartbeatIntervalMs());
  // Don't keep the event loop alive just for the heartbeat — when the process
  // would otherwise exit (e.g. test teardown), let it.
  heartbeatTimer.unref();
}

function stopHeartbeat(): void {
  if (heartbeatTimer === null) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function heartbeatTick(): Promise<void> {
  const sid = cachedSessionId;
  if (sid === null) { stopHeartbeat(); return; }
  try {
    await call("GET", "/v1/health", undefined, { "x-session-id": sid });
  } catch (err) {
    if (err instanceof MCBError && err.statusCode === 404 && err.code === "session-not-found") {
      // Confirmed: broker no longer knows our session. Drop everything.
      dropSessionAndFire();
    }
    // Any other error (mcb-unreachable, 5xx, parse) is treated as transient —
    // we don't have evidence the session is gone, so we leave state alone and
    // try again next tick.
  }
}

/**
 * Idempotent: clears the cached session, stops the heartbeat, and fires the
 * onSessionLost callback exactly once per cache lifecycle. Returns the count
 * of local leases the callback reported tearing down (0 if the cache was
 * already cleared by a concurrent path).
 */
function dropSessionAndFire(): number {
  if (cachedSessionId === null) return 0;
  cachedSessionId = null;
  stopHeartbeat();
  return onSessionLost ? safeInvoke(onSessionLost) : 0;
}

async function ensureSession(): Promise<string> {
  if (cachedSessionId) return cachedSessionId;
  const body = await call("POST", "/v1/sessions", { pid: process.pid, processName: "keyboards-mcp" });
  cachedSessionId = (body as { sessionId: string }).sessionId;
  startHeartbeat();
  return cachedSessionId;
}

/**
 * Wrap a session-bearing call so that 404 session-not-found drops the cached
 * session, fires the onSessionLost callback, and rethrows as
 * MCBSessionLostError. All other errors propagate as-is.
 */
async function callWithSessionGuard(method: string, path: string, body: unknown, sessionId: string): Promise<unknown> {
  try {
    return await call(method, path, body, { "x-session-id": sessionId });
  } catch (err) {
    if (err instanceof MCBError && err.statusCode === 404 && err.code === "session-not-found") {
      const dropped = dropSessionAndFire();
      throw new MCBSessionLostError(dropped, sessionId);
    }
    throw err;
  }
}

function safeInvoke(cb: SessionLostCallback): number {
  try { return cb(); } catch { return 0; }
}

export async function claimLease(req: ClaimRequest): Promise<Manifest> {
  const sessionId = await ensureSession();
  return await callWithSessionGuard("POST", "/v1/devices", req, sessionId) as Manifest;
}

export async function releaseLease(deviceId: string): Promise<void> {
  if (!cachedSessionId) return;
  try {
    await callWithSessionGuard("DELETE", `/v1/devices/${deviceId}`, undefined, cachedSessionId);
  } catch (err) {
    // MCB has already reaped this lease (active DELETE /v1/mocks/:instanceId
    // path, or the passive safety net on read). Drop the local pool entry
    // through the same channel a future tool call would, then surface as
    // device-lost so the caller sees a coherent error rather than a stray
    // "device-not-found." Idempotent: if no callback is registered or the
    // entry is already gone, this is a no-op.
    if (err instanceof MCBError && err.statusCode === 404 && err.code === "device-not-found") {
      if (onDeviceLost) safeInvokeDeviceLost(onDeviceLost, deviceId);
      throw new MCBDeviceLostError(deviceId);
    }
    throw err;
  }
}

function safeInvokeDeviceLost(cb: DeviceLostCallback, deviceId: string): void {
  try { cb(deviceId); } catch { /* swallow subscriber errors */ }
}

/**
 * Returns leases owned by this MCP's cached session, or [] if no session has
 * been minted yet. Reads must not mint a session as a side effect.
 */
export async function listMyDevices(): Promise<Manifest[]> {
  if (cachedSessionId === null) return [];
  const sessionId = cachedSessionId;
  const all = (await call("GET", "/v1/devices")) as Manifest[];
  return all.filter((m) => m.ownerSessionId === sessionId);
}

/** List ALL leases across sessions (read-open). Does not require a session. */
export async function listAllDevices(): Promise<Manifest[]> {
  return (await call("GET", "/v1/devices")) as Manifest[];
}

/**
 * Tell MCB that a mock instance has gone away. Releases every lease bound
 * to that mockInstanceId — used by `MockTransport.stop()` when a tab closes.
 *
 * Capability-style: no session header. Best-effort: any failure is the
 * caller's to swallow, the broker may be down at shutdown time.
 */
export async function releaseMockInstance(instanceId: string): Promise<void> {
  await call("DELETE", `/v1/mocks/${instanceId}`);
}

export interface McbHealth {
  ok: boolean;
  uptimeSec: number;
  sessionsActive: number;
  devicesConnected: number;
}

/** GET /v1/health. Returns null if MCB is unreachable. */
export async function getMcbHealth(): Promise<McbHealth | null> {
  try {
    return (await call("GET", "/v1/health")) as McbHealth;
  } catch (err) {
    if (err instanceof MCBError && err.code === "mcb-unreachable") return null;
    throw err;
  }
}

/**
 * Unified MIDI-port listing from MCB. Aggregates OS port enumeration,
 * mock-registry annotations (incl. stale flag), and lease info into a
 * single response — so MCP-side tools don't have to duplicate MCB's
 * data sources.
 */
export interface MidiPortsResponse {
  outputs: Array<{
    name: string;
    mock?: {
      midiPort: string;
      wsPort: number;
      modelId: string;
      displayName: string;
      label: string;
      pid: number;
      instanceId: string;
      startedAt: string;
      lastTouched: string;
      stale: boolean;
    };
    lease?: {
      kind: "primary" | "shadow";
      sessionId: string;
      deviceId: string;
      model: string;
      mockInstanceId: string | null;
    };
  }>;
  inputs: Array<{ name: string }>;
}

export async function listMidiPorts(): Promise<MidiPortsResponse> {
  return (await call("GET", "/v1/midi/ports")) as MidiPortsResponse;
}

/** Reset the cached session — primarily for tests. */
export function resetSession(): void {
  cachedSessionId = null;
  onSessionLost = null;
  onDeviceLost = null;
  stopHeartbeat();
  setOnBrokerLivenessChange(null);
}

// === Broker liveness ===
//
// "unknown" is the initial state — we haven't probed yet, so subscribers
// shouldn't render either up or down. After the first tick, the state is
// always "up" or "down". Public API is one callback, not a multi-subscriber
// bus, matching `setOnSessionLost`. Wiring multiple consumers — if that ever
// happens — is the consumer's problem (e.g. main.ts can fan out to many
// renderers).

export type BrokerLiveness = "up" | "down" | "unknown";
type BrokerLivenessCallback = (state: "up" | "down") => void;

const DEFAULT_LIVENESS_INTERVAL_MS = 2_000;
let brokerLiveness: BrokerLiveness = "unknown";
let onBrokerLivenessChange: BrokerLivenessCallback | null = null;
let livenessTimer: NodeJS.Timeout | null = null;

function livenessIntervalMs(): number {
  const raw = process.env.MCB_LIVENESS_MS;
  if (raw === undefined) return DEFAULT_LIVENESS_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIVENESS_INTERVAL_MS;
}

export function setOnBrokerLivenessChange(cb: BrokerLivenessCallback | null): void {
  onBrokerLivenessChange = cb;
  if (cb === null) {
    stopLivenessTicker();
    brokerLiveness = "unknown";
    return;
  }
  startLivenessTicker();
  // Help fresh subscribers render correctly without waiting for the next
  // transition: if we already have a known state, fire it now.
  if (brokerLiveness !== "unknown") safeNotifyLiveness(cb, brokerLiveness);
}

export function getBrokerLiveness(): BrokerLiveness {
  return brokerLiveness;
}

function startLivenessTicker(): void {
  if (livenessTimer !== null) return;
  livenessTimer = setInterval(() => { void livenessTick(); }, livenessIntervalMs());
  livenessTimer.unref();
  // Fire once immediately so the first state transition out of "unknown"
  // doesn't have to wait a full interval.
  void livenessTick();
}

function stopLivenessTicker(): void {
  if (livenessTimer === null) return;
  clearInterval(livenessTimer);
  livenessTimer = null;
}

async function livenessTick(): Promise<void> {
  let next: "up" | "down";
  try {
    await call("GET", "/v1/health");
    next = "up";
  } catch {
    next = "down";
  }
  if (next === brokerLiveness) return;
  brokerLiveness = next;
  if (onBrokerLivenessChange) safeNotifyLiveness(onBrokerLivenessChange, next);
}

function safeNotifyLiveness(cb: BrokerLivenessCallback, state: "up" | "down"): void {
  try { cb(state); } catch { /* swallow subscriber errors */ }
}

/**
 * Test-only entry points. Production code uses the setInterval timers; tests
 * trigger ticks synchronously to avoid sleeping.
 */
export const __testing = {
  triggerHeartbeat: heartbeatTick,
  isHeartbeatRunning: (): boolean => heartbeatTimer !== null,
  triggerLiveness: livenessTick,
  isLivenessRunning: (): boolean => livenessTimer !== null,
};

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const target = connectTarget();
  const reqOpts = target.kind === "uds"
    ? { socketPath: target.socketPath, method, path, headers: { "content-type": "application/json", ...headers } }
    : { host: target.host, port: target.port, method, path, headers: { "content-type": "application/json", ...headers } };
  return new Promise((resolve, reject) => {
    const req = request(
      reqOpts,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 204) { resolve(undefined); return; }
          const text = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
          if (res.statusCode! >= 400) {
            const err = parsed as { error?: string; message?: string; details?: unknown };
            reject(new MCBError(res.statusCode!, err?.error ?? "unknown", err?.message ?? `MCB ${method} ${path} failed: ${res.statusCode}`, err?.details));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", (err) => reject(new MCBError(0, "mcb-unreachable", `MCB unreachable at ${describeTarget(target)}: ${err.message}. Is the keyboards-mcp broker daemon running? Run 'keyboards-mcp doctor'.`)));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
