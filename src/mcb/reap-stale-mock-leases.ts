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
 * Every lease with a non-null `mockInstanceId` (primary side) or
 * `shadowMockInstanceId` (shadow side) was bound to a specific mock
 * instance at claim time. If the registry's current entry for that port
 * name has a different `instanceId` (or the entry is gone entirely), the
 * bound mock is dead and this lease points at a phantom — the active
 * `DELETE /v1/mocks/:instanceId` path must have been lost. We reap it here.
 *
 * Both sides are checked symmetrically: closing either the primary's mock
 * OR the shadow's mock invalidates the lease, because the local MIDI
 * forward bridge has nothing live to talk to on one side.
 *
 * Real-keyboard leases (both instance fields `null`) are untouched: their
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
  // Snapshot the registry ONCE per call. The real wiring reads
  // `data/runtime/mocks.json` from disk on every `findByMidiPort`, so
  // calling it inside the predicate + reason-builder would mean up to 4
  // file reads per lease per `GET`/`POST /v1/devices`. With this map the
  // whole reap is a single read.
  const byPort = new Map<string, string>();
  for (const e of deps.mockRegistry.list()) byPort.set(e.midiPort, e.instanceId);

  const reaped = deps.leases.reapWhere((lease) => {
    if (lease.mockInstanceId !== null) {
      if (byPort.get(lease.primary.portName) !== lease.mockInstanceId) return true;
    }
    if (lease.shadowMockInstanceId !== null && lease.shadow) {
      if (byPort.get(lease.shadow.portName) !== lease.shadowMockInstanceId) return true;
    }
    return false;
  });
  for (const lease of reaped) {
    if (deps.bridges.shadowOf(lease.deviceId)) deps.bridges.remove(lease.deviceId);
    deps.sessions.get(lease.ownerSessionId)?.ownedDeviceIds.delete(lease.deviceId);
    const reason = describeReapReason(lease, byPort);
    console.log(
      `[mcb] reaped stale mock lease device=${short(lease.deviceId)} ` +
      `session=${short(lease.ownerSessionId)} primary="${lease.primary.portName}"` +
      `${lease.shadow ? ` shadow="${lease.shadow.portName}"` : ""} (${reason})`
    );
  }
  return reaped;
}

function describeReapReason(lease: Lease, byPort: Map<string, string>): string {
  const reasons: string[] = [];
  if (lease.mockInstanceId !== null) {
    const current = byPort.get(lease.primary.portName);
    if (current === undefined) reasons.push(`primary mock instance gone (was ${short(lease.mockInstanceId)})`);
    else if (current !== lease.mockInstanceId) {
      reasons.push(`primary mock replaced (was ${short(lease.mockInstanceId)}, now ${short(current)})`);
    }
  }
  if (lease.shadowMockInstanceId !== null && lease.shadow) {
    const current = byPort.get(lease.shadow.portName);
    if (current === undefined) reasons.push(`shadow mock instance gone (was ${short(lease.shadowMockInstanceId)})`);
    else if (current !== lease.shadowMockInstanceId) {
      reasons.push(`shadow mock replaced (was ${short(lease.shadowMockInstanceId)}, now ${short(current)})`);
    }
  }
  return reasons.join("; ") || "unknown";
}

function short(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}
