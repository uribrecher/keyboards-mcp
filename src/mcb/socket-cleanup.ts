import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { request } from "node:http";

export type ProbeResult = "absent" | "stale" | "alive";

const PROBE_TIMEOUT_MS = 1000;

/**
 * Decide whether a UDS path is owned by a live MCB, holds a stale file from a
 * prior crash, or doesn't exist. Probes the live case by issuing GET /v1/health
 * over the socket — any successful HTTP response counts as "alive" (we're not
 * trying to authenticate the peer, just establish that something is serving).
 */
export function probeExistingSocket(socketPath: string): Promise<ProbeResult> {
  if (!existsSync(socketPath)) return Promise.resolve("absent");
  return new Promise<ProbeResult>((resolve) => {
    const req = request({ socketPath, method: "GET", path: "/v1/health" }, (res) => {
      res.resume();
      resolve("alive");
    });
    req.setTimeout(PROBE_TIMEOUT_MS, () => { req.destroy(); resolve("stale"); });
    req.on("error", () => resolve("stale"));
    req.end();
  });
}

/**
 * Make `socketPath` ready for `server.listen()`. Resolves on success, rejects
 * on `another-instance-alive` (a live MCB owns the path) or `not-a-socket-file`
 * (the path exists but isn't a socket — refusing to unlink user data when
 * MCB_SOCKET is misconfigured).
 *   absent → no-op.
 *   stale  → unlink, then proceed. ENOENT during unlink is tolerated (TOCTOU
 *            with another janitor).
 *   alive  → throw.
 */
export async function prepareSocketPath(socketPath: string): Promise<void> {
  const result = await probeExistingSocket(socketPath);
  if (result === "absent") return;
  if (result === "alive") {
    throw new Error(`another-instance-alive: another MCB is already listening at ${socketPath}`);
  }
  // result === "stale": verify the path really is a socket file before unlinking.
  let isSocket: boolean;
  try {
    isSocket = lstatSync(socketPath).isSocket();
  } catch (err) {
    // File vanished between probe and stat — TOCTOU with another janitor; safe to proceed.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!isSocket) {
    throw new Error(`not-a-socket-file: refusing to unlink ${socketPath} (not a socket)`);
  }
  try {
    unlinkSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
