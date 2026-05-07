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

async function ensureSession(): Promise<string> {
  if (cachedSessionId) return cachedSessionId;
  const body = await call("POST", "/v1/sessions", { pid: process.pid, processName: "keyboards-mcp" });
  cachedSessionId = (body as { sessionId: string }).sessionId;
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
      const lost = cachedSessionId ?? sessionId;
      cachedSessionId = null;
      const dropped = onSessionLost ? safeInvoke(onSessionLost) : 0;
      throw new MCBSessionLostError(dropped, lost);
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
export function resetSession(): void { cachedSessionId = null; onSessionLost = null; }

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
