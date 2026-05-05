import type { LeaseRegistry } from "../lease-registry.js";
import type { SessionManager } from "../session-manager.js";

export function makeHealthHandler(deps: { leases: LeaseRegistry; sessions: SessionManager; startedAtMs: number }) {
  return async () => ({
    statusCode: 200,
    body: {
      ok: true,
      uptimeSec: Math.floor((Date.now() - deps.startedAtMs) / 1000),
      sessionsActive: deps.sessions.listAll().length,
      devicesConnected: deps.leases.listAll().length,
    },
  });
}
