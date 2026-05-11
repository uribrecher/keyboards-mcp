import type { Lease } from "./types.js";

export type LeaseRegistryErrorCode = "port-already-owned";

export class LeaseRegistryError extends Error {
  constructor(public readonly code: LeaseRegistryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LeaseRegistryError";
  }
}

export class LeaseRegistry {
  private byDeviceId = new Map<string, Lease>();
  private primaryIndex = new Map<string, string>();

  add(lease: Lease): void {
    if (this.primaryIndex.has(lease.primary.portName)) {
      throw new LeaseRegistryError("port-already-owned", lease.primary.portName);
    }
    this.byDeviceId.set(lease.deviceId, lease);
    this.primaryIndex.set(lease.primary.portName, lease.deviceId);
  }

  remove(deviceId: string): void {
    const lease = this.byDeviceId.get(deviceId);
    if (!lease) return;
    this.primaryIndex.delete(lease.primary.portName);
    this.byDeviceId.delete(deviceId);
  }

  /**
   * Remove every lease for which `predicate` returns true. Returns the
   * removed leases so callers can clean up sibling state (bridges, owning
   * session's `ownedDeviceIds`). Iteration is over a snapshot so the
   * predicate may freely mutate other state.
   *
   * Delegates the actual deletion to `remove()` so any future indices or
   * cleanup added there are picked up here too.
   */
  reapWhere(predicate: (lease: Lease) => boolean): Lease[] {
    const removed: Lease[] = [];
    for (const lease of [...this.byDeviceId.values()]) {
      if (predicate(lease)) {
        this.remove(lease.deviceId);
        removed.push(lease);
      }
    }
    return removed;
  }

  get(deviceId: string): Lease | undefined {
    return this.byDeviceId.get(deviceId);
  }

  isPrimary(portName: string): { sessionId: string; deviceId: string } | undefined {
    const deviceId = this.primaryIndex.get(portName);
    if (!deviceId) return undefined;
    const lease = this.byDeviceId.get(deviceId)!;
    return { sessionId: lease.ownerSessionId, deviceId };
  }

  listAll(): Lease[] {
    return [...this.byDeviceId.values()];
  }
}
