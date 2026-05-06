import type { SessionManager } from "../session-manager.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeSessionsHandlers(deps: { sessions: SessionManager }) {
  return {
    create: async (ctx: RouteContext) => {
      const { pid, processName } = (ctx.body ?? {}) as { pid?: number; processName?: string };
      if (typeof pid !== "number" || pid <= 0) {
        throw new HttpError(400, "invalid-input", "Body must include numeric pid > 0");
      }
      const session = deps.sessions.create({ pid, processName });
      return { statusCode: 200, body: { sessionId: session.sessionId, ownerPid: pid } };
    },

    /**
     * Idempotent attach for MCB-crash recovery: client passes its previously-
     * issued sessionId; MCB either refreshes PID on a known session or
     * re-creates the record with the given id (handles "MCB restarted while
     * the client kept running"). Re-claiming individual leases is the
     * client's responsibility — this just re-establishes the session record.
     */
    attach: async (ctx: RouteContext) => {
      const sessionId = ctx.params.id;
      if (!UUID_RE.test(sessionId)) {
        throw new HttpError(400, "invalid-input", "Path :id must be a UUID");
      }
      const { pid, processName } = (ctx.body ?? {}) as { pid?: number; processName?: string };
      if (typeof pid !== "number" || pid <= 0) {
        throw new HttpError(400, "invalid-input", "Body must include numeric pid > 0");
      }
      const session = deps.sessions.attach(sessionId, { pid, processName });
      return { statusCode: 200, body: { sessionId: session.sessionId, ownerPid: pid } };
    },
  };
}
