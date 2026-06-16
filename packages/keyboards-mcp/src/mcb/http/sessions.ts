import type { SessionManager } from "../session-manager.js";
import type { RouteContext } from "./server.js";
import { HttpError } from "./errors.js";

export function makeSessionsHandlers(deps: { sessions: SessionManager }) {
  return {
    create: async (ctx: RouteContext) => {
      const { pid, processName } = (ctx.body ?? {}) as { pid?: number; processName?: string };
      if (typeof pid !== "number" || pid <= 0) {
        throw new HttpError(400, "invalid-input", "Body must include numeric pid > 0");
      }
      const session = deps.sessions.create({ pid, processName });
      const sid = session.sessionId.replace(/-/g, "").slice(0, 8);
      console.log(`[mcb] session minted session=${sid} pid=${pid}${processName ? ` (${processName})` : ""}`);
      return { statusCode: 200, body: { sessionId: session.sessionId, ownerPid: pid } };
    },
  };
}
