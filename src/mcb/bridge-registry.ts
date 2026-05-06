interface BridgeRecord {
  masterPortName: string;
  shadowPortName: string;
}

export type BridgeRegistryErrorCode =
  | "self-shadow"
  | "bridge-already-exists"
  | "shadow-conflict"
  | "master-port-conflict"
  | "cycle-would-form";

export class BridgeRegistryError extends Error {
  constructor(public readonly code: BridgeRegistryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BridgeRegistryError";
  }
}

export class BridgeRegistry {
  private bridges = new Map<string, BridgeRecord>();
  private shadowIndex = new Map<string, string>();
  private masterIndex = new Map<string, string>();

  add(masterDeviceId: string, masterPortName: string, shadowPortName: string): void {
    if (masterPortName === shadowPortName) {
      throw new BridgeRegistryError("self-shadow", "master and shadow ports must differ");
    }
    if (this.bridges.has(masterDeviceId)) {
      throw new BridgeRegistryError("bridge-already-exists", `master ${masterDeviceId} already has a bridge`);
    }
    if (this.shadowIndex.has(shadowPortName)) {
      throw new BridgeRegistryError("shadow-conflict", `${shadowPortName} is already a shadow target`);
    }
    if (this.masterIndex.has(masterPortName)) {
      throw new BridgeRegistryError("master-port-conflict", `${masterPortName} is already a master port`);
    }
    if (this.wouldFormCycle(masterPortName, shadowPortName)) {
      throw new BridgeRegistryError("cycle-would-form", `bridge ${masterPortName}→${shadowPortName} would close a chain`);
    }
    this.bridges.set(masterDeviceId, { masterPortName, shadowPortName });
    this.shadowIndex.set(shadowPortName, masterDeviceId);
    this.masterIndex.set(masterPortName, masterDeviceId);
  }

  remove(masterDeviceId: string): void {
    const bridge = this.bridges.get(masterDeviceId);
    if (!bridge) return;
    this.shadowIndex.delete(bridge.shadowPortName);
    this.masterIndex.delete(bridge.masterPortName);
    this.bridges.delete(masterDeviceId);
  }

  shadowOf(masterDeviceId: string): string | undefined {
    return this.bridges.get(masterDeviceId)?.shadowPortName;
  }

  isShadowTarget(portName: string): { masterDeviceId: string } | undefined {
    const masterDeviceId = this.shadowIndex.get(portName);
    return masterDeviceId ? { masterDeviceId } : undefined;
  }

  /**
   * Walk the existing bridge graph from `shadowPortName` along the chain of
   * (master-port → shadow-port) edges. If the walk reaches `masterPortName`,
   * adding the proposed edge would close a cycle. The seen-set guards against
   * a degenerate pre-existing cycle in the graph (shouldn't happen, but the
   * walker must always terminate).
   */
  private wouldFormCycle(masterPortName: string, shadowPortName: string): boolean {
    let current: string | undefined = shadowPortName;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (current === masterPortName) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      const nextMasterId = this.masterIndex.get(current);
      if (nextMasterId === undefined) return false;
      current = this.bridges.get(nextMasterId)?.shadowPortName;
    }
    return false;
  }
}
