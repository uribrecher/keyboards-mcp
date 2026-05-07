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
 */

import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Manifest {
  deviceId: string;
  ownerSessionId: string;
  model: string;
  primary: { portName: string; wsPort: number | null };
  input?: { portName: string };
  shadow?: { portName: string; wsPort: number | null };
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

function socketPath(): string {
  return process.env.MCB_SOCKET ?? join(homedir(), ".mcb", "sock");
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
  await callWithSessionGuard("DELETE", `/v1/devices/${deviceId}`, undefined, cachedSessionId);
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
      startedAt: string;
      lastTouched: string;
      stale: boolean;
    };
    lease?: {
      kind: "primary" | "shadow";
      sessionId: string;
      deviceId: string;
      model: string;
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
  stopHeartbeat();
}

/**
 * Test-only entry points. Production code uses the 5s setInterval; tests
 * trigger ticks synchronously to avoid sleeping.
 */
export const __testing = {
  triggerHeartbeat: heartbeatTick,
  isHeartbeatRunning: (): boolean => heartbeatTimer !== null,
};

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const sock = socketPath();
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: sock, method, path, headers: { "content-type": "application/json", ...headers } },
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
    req.on("error", (err) => reject(new MCBError(0, "mcb-unreachable", `MCB unreachable at ${sock}: ${err.message}. Is MCB running? (npm run mcb)`)));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
