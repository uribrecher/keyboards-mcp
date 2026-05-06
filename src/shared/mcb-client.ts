/**
 * HTTP-over-UDS client for talking to midi-connections-broker (MCB).
 *
 * Caches the MCP's session id for the lifetime of the process. The session is
 * created lazily on the first call that needs one (claimLease).
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
  label: string;
  channel: number;
  lowerChannel?: number;
  upperChannel?: number;
}

export interface ClaimRequest {
  port: string;
  model: string;
  with_shadow?: string;
  input_port?: string;
  label?: string;
  channel?: number;
  lower_channel?: number;
  upper_channel?: number;
}

export class MCBError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

function socketPath(): string {
  return process.env.MCB_SOCKET ?? join(homedir(), ".mcb", "sock");
}

let cachedSessionId: string | null = null;
let attachedThisRun = false;

/**
 * Idempotently re-attach the cached sessionId to MCB. Used after an MCB
 * restart so subsequent claims don't fail with `session-not-found`. Safe to
 * call on every claim; the second call is a no-op for the lifetime of the
 * MCB process (handler refreshes PID/clears miss state).
 */
export async function attachSession(sessionId: string): Promise<void> {
  await call("POST", `/v1/sessions/${sessionId}/attach`, { pid: process.pid, processName: "keyboards-mcp" });
}

async function ensureSession(): Promise<string> {
  if (cachedSessionId) {
    // First claim after an MCB restart: tell MCB about our session before
    // the claim. Cached locally so we don't pay the round-trip on every call.
    if (!attachedThisRun) {
      try {
        await attachSession(cachedSessionId);
        attachedThisRun = true;
      } catch (err) {
        // If MCB is unreachable, propagate; the claim will fail and the
        // caller surfaces the user-facing error.
        if (err instanceof MCBError && err.code === "mcb-unreachable") throw err;
        // Any other failure (4xx/5xx) is non-fatal for the cached path —
        // the claim itself will surface the real problem.
      }
    }
    return cachedSessionId;
  }
  const body = await call("POST", "/v1/sessions", { pid: process.pid, processName: "keyboards-mcp" });
  cachedSessionId = (body as { sessionId: string }).sessionId;
  attachedThisRun = true;
  return cachedSessionId;
}

export async function claimLease(req: ClaimRequest): Promise<Manifest> {
  const sessionId = await ensureSession();
  return await call("POST", "/v1/devices", req, { "x-session-id": sessionId }) as Manifest;
}

export async function releaseLease(deviceId: string): Promise<void> {
  if (!cachedSessionId) return;
  await call("DELETE", `/v1/devices/${deviceId}`, undefined, { "x-session-id": cachedSessionId });
}

export async function listMyDevices(): Promise<Manifest[]> {
  const sessionId = await ensureSession();
  const all = (await call("GET", "/v1/devices")) as Manifest[];
  return all.filter((m) => m.ownerSessionId === sessionId);
}

/** List ALL leases across sessions (read-open). Does not require a session. */
export async function listAllDevices(): Promise<Manifest[]> {
  return (await call("GET", "/v1/devices")) as Manifest[];
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
      label: string;
    };
  }>;
  inputs: Array<{ name: string }>;
}

export async function listMidiPorts(): Promise<MidiPortsResponse> {
  return (await call("GET", "/v1/midi/ports")) as MidiPortsResponse;
}

/** Reset the cached session — primarily for tests. */
export function resetSession(): void { cachedSessionId = null; attachedThisRun = false; }

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
