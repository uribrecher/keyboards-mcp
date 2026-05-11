import type { LeaseRegistry } from "../lease-registry.js";
import type { BridgeRegistry } from "../bridge-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { RouteContext } from "./server.js";

interface Deps {
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  sessions: SessionManager;
}

/**
 * `DELETE /v1/mocks/:instanceId` — active path for "this mock just went away,
 * release every lease bound to it."
 *
 * Called by the mock-runner's `MockTransport.stop()` when a tab closes (or
 * the app quits). No session auth. Authentication for this route follows
 * the same model as the rest of the MCB API: the broker trusts its
 * listener boundary. In UDS mode the socket is chmod 0600 (local user
 * only). In TCP mode the broker assumes operators bind on a private
 * network (per `src/mcb/index.ts:22`, the API as a whole is unauthenticated
 * — adding per-route auth here would be inconsistent and wouldn't address
 * the equivalent gap on every other state-changing endpoint).
 *
 * `instanceId` is NOT a confidentiality capability: any caller of
 * `GET /v1/midi/ports` can read every running mock's `instanceId`. What it
 * provides is uniqueness — a successor mock at the same wsPort/label has a
 * different instanceId, so this endpoint can't accidentally release a
 * successor's leases when the predecessor's `stop()` fires late.
 *
 * Idempotent: unknown instanceId → 204 no-op. We don't 404, so the
 * best-effort caller (which swallows errors anyway) doesn't have to
 * distinguish "released" from "nothing to release."
 *
 * The passive safety net in `reapStaleMockLeases` covers the case where
 * this endpoint never fires (mock-runner crash, network blip, MCB restart
 * during shutdown).
 */
export function makeMocksHandlers(deps: Deps) {
  return {
    delete: async (ctx: RouteContext) => {
      const instanceId = ctx.params.instanceId;
      const reaped = deps.leases.reapWhere((lease) =>
        lease.mockInstanceId === instanceId || lease.shadowMockInstanceId === instanceId
      );
      for (const lease of reaped) {
        if (deps.bridges.shadowOf(lease.deviceId)) deps.bridges.remove(lease.deviceId);
        deps.sessions.get(lease.ownerSessionId)?.ownedDeviceIds.delete(lease.deviceId);
        const side = lease.mockInstanceId === instanceId ? "primary" : "shadow";
        console.log(
          `[mcb] mock closed instance=${short(instanceId)} — released lease ` +
          `device=${short(lease.deviceId)} session=${short(lease.ownerSessionId)} ` +
          `(${side} side: "${side === "primary" ? lease.primary.portName : lease.shadow!.portName}")`
        );
      }
      if (reaped.length === 0) {
        console.log(`[mcb] mock closed instance=${short(instanceId)} — no leases bound to it`);
      }
      return { statusCode: 204 };
    },
  };
}

function short(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}
