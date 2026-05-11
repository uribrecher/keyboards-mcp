import type { LeaseRegistry } from "./lease-registry.js";
import type { BridgeRegistry } from "./bridge-registry.js";
import type { SessionManager } from "./session-manager.js";
import type { MockRegistryReader, Lease } from "./types.js";

interface Deps {
  leases: LeaseRegistry;
  bridges: BridgeRegistry;
  sessions: SessionManager;
  mockRegistry: MockRegistryReader;
}

/**
 * Passive safety net for the mock-close → lease-release path.
 *
 * Every lease with a non-null `mockInstanceId` was bound to a specific mock
 * instance at claim time. If the registry's current entry for that port name
 * has a different `instanceId` (or the entry is gone entirely), the bound
 * mock is dead and this lease points at a phantom — the active
 * `DELETE /v1/mocks/:instanceId` path must have been lost. We reap it here.
 *
 * Real-keyboard leases (`mockInstanceId === null`) are untouched: their
 * liveness is governed by `resolvePort`'s OS-visibility check plus the
 * existing PID sweep.
 *
 * Runs at the top of any read-or-claim path that should see fresh state
 * (`GET /v1/devices`, `POST /v1/devices`). Cheap — O(leases) and only walks
 * mock-bound entries.
 *
 * Returns the reaped leases so callers can log or surface them; the
 * registries/sessions are already cleaned up before return.
 */
export function reapStaleMockLeases(deps: Deps): Lease[] {
  const reaped = deps.leases.reapWhere((lease) => {
    if (lease.mockInstanceId === null) return false;
    const current = deps.mockRegistry.findByMidiPort(lease.primary.portName);
    return current?.instanceId !== lease.mockInstanceId;
  });
  for (const lease of reaped) {
    if (deps.bridges.shadowOf(lease.deviceId)) deps.bridges.remove(lease.deviceId);
    deps.sessions.get(lease.ownerSessionId)?.ownedDeviceIds.delete(lease.deviceId);
  }
  return reaped;
}
