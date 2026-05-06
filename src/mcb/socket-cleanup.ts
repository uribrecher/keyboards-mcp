import { existsSync, unlinkSync } from "node:fs";
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
      res.resume(); // discard body
      resolve("alive");
      // Hint to res to release the socket.
      res.on("end", () => { /* noop */ });
    });
    req.setTimeout(PROBE_TIMEOUT_MS, () => { req.destroy(); resolve("stale"); });
    req.on("error", () => resolve("stale"));
    req.end();
  });
}

/**
 * Make `socketPath` ready for `server.listen()`. Resolves on success, rejects
 * with `another-instance-alive` if a live MCB already owns the path.
 *   absent → no-op.
 *   stale  → unlink, then proceed.
 *   alive  → throw.
 */
export async function prepareSocketPath(socketPath: string): Promise<void> {
  const result = await probeExistingSocket(socketPath);
  if (result === "absent") return;
  if (result === "alive") {
    throw new Error(`another-instance-alive: another MCB is already listening at ${socketPath}`);
  }
  unlinkSync(socketPath);
}
