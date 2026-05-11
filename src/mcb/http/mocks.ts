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
 * the app quits). No session auth: the `instanceId` UUID itself is the
 * capability — only the transport that minted it knows it, and it's never
 * recycled, so a successor mock at the same wsPort/label can't accidentally
 * release a predecessor's leases.
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
      const reaped = deps.leases.reapWhere((lease) => lease.mockInstanceId === instanceId);
      for (const lease of reaped) {
        if (deps.bridges.shadowOf(lease.deviceId)) deps.bridges.remove(lease.deviceId);
        deps.sessions.get(lease.ownerSessionId)?.ownedDeviceIds.delete(lease.deviceId);
      }
      return { statusCode: 204 };
    },
  };
}
