import type { ShadowEndpoint } from "./types.js";

export class BridgeRegistry {
  private bridges = new Map<string, ShadowEndpoint>();
  private shadowIndex = new Map<string, string>();

  add(masterDeviceId: string, masterPortName: string, shadowPortName: string): void {
    if (masterPortName === shadowPortName) {
      throw new Error("self-shadow: master and shadow ports must differ");
    }
    if (this.bridges.has(masterDeviceId)) {
      throw new Error(`bridge-already-exists for master ${masterDeviceId}`);
    }
    if (this.shadowIndex.has(shadowPortName)) {
      throw new Error(`shadow-conflict: ${shadowPortName} is already a shadow target`);
    }
    this.bridges.set(masterDeviceId, { portName: shadowPortName });
    this.shadowIndex.set(shadowPortName, masterDeviceId);
  }

  remove(masterDeviceId: string): void {
    const bridge = this.bridges.get(masterDeviceId);
    if (!bridge) return;
    this.shadowIndex.delete(bridge.portName);
    this.bridges.delete(masterDeviceId);
  }

  shadowOf(masterDeviceId: string): string | undefined {
    return this.bridges.get(masterDeviceId)?.portName;
  }

  isShadowTarget(portName: string): { masterDeviceId: string } | undefined {
    const masterDeviceId = this.shadowIndex.get(portName);
    return masterDeviceId ? { masterDeviceId } : undefined;
  }
}
