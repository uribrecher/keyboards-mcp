import type { LeaseRegistry } from "../lease-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

/**
 * GET /v1/health doubles as the session heartbeat endpoint. When called
 * without `x-session-id` it reports broker liveness only. When called with
 * `x-session-id`, it ALSO validates that the broker still knows that
 * session — returning 404 session-not-found if the session table no longer
 * has it (typical cause: broker restarted while the client kept running).
 * The MCP's mcb-client uses this on a 5s interval to detect divergence
 * proactively rather than waiting for the next session-bearing call.
 */
export function makeHealthHandler(deps: { leases: LeaseRegistry; sessions: SessionManager; startedAtMs: number }) {
  return async (ctx: RouteContext) => {
    const sessionId = ctx.headers["x-session-id"];
    if (sessionId !== undefined) {
      if (!deps.sessions.get(sessionId)) {
        throw new HttpError(404, "session-not-found", `Session ${sessionId} not found`);
      }
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        uptimeSec: Math.floor((Date.now() - deps.startedAtMs) / 1000),
        sessionsActive: deps.sessions.listAll().length,
        devicesConnected: deps.leases.listAll().length,
      },
    };
  };
}
