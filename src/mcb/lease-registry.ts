import type { Lease } from "./types.js";

export class LeaseRegistry {
  private byDeviceId = new Map<string, Lease>();
  private primaryIndex = new Map<string, string>();

  add(lease: Lease): void {
    if (this.primaryIndex.has(lease.primary.portName)) {
      throw new Error(`port-already-owned: ${lease.primary.portName}`);
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
