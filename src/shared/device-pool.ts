/**
 * Pool of connected keyboard devices.
 *
 * Replaces the singleton ModelHolder. Each entry wraps a KeyboardDevice
 * (which owns its own MidiConnection, state, and backup data) plus a
 * stable 1-based index that survives disconnects.
 */

import type { KeyboardDevice } from "./keyboard-model.js";

export interface PoolPorts {
  output?: string;
  input?: string;
  forward?: string;
  /** Lease id from MCB. Used by disconnect to release the lease. */
  mcbDeviceId?: string;
}

export interface PoolEntry {
  index: number;
  device: KeyboardDevice;
  /** Optional cleanup hook run after device.detach() when the entry is removed. */
  onDispose?: () => void;
  /** Optional port info for diagnostic tools (list_midi_devices). */
  ports?: PoolPorts;
}

export class DevicePool {
  private devices = new Map<number, PoolEntry>();
  private nextIndex = 1;

  /** Add a device. Returns its assigned index (1-based, stable for session). */
  connect(device: KeyboardDevice, onDispose?: () => void, ports?: PoolPorts): number {
    const index = this.nextIndex++;
    this.devices.set(index, { index, device, onDispose, ports });
    return index;
  }

  /** Remove a device. Calls device.detach() then onDispose. Throws if no such index. */
  disconnect(index: number): void {
    const entry = this.devices.get(index);
    if (!entry) {
      throw new Error(`No device at index ${index}.`);
    }
    entry.device.detach();
    this.devices.delete(index);
    try { entry.onDispose?.(); } catch { /* swallow disposer errors */ }
  }

  /** Look up a pool entry by index, or undefined if not present. */
  get(index: number): PoolEntry | undefined {
    return this.devices.get(index);
  }

  /** Look up a pool entry by index, or throw a user-friendly error. */
  require(index: number): PoolEntry {
    const entry = this.devices.get(index);
    if (!entry) {
      const available = this.list()
        .map((e) => `  device ${e.index}: ${e.device.model.info.displayName}${e.device.label ? ` (${e.device.label})` : ""}`)
        .join("\n");
      const summary = available || "  (no devices connected)";
      throw new Error(`No device at index ${index}.\nConnected devices:\n${summary}`);
    }
    return entry;
  }

  /**
   * Return the only connected device.
   * Throws if zero or multiple devices are connected — used by tools that
   * accept an optional `device` index for backwards compatibility with
   * single-device usage.
   */
  requireSingle(): PoolEntry {
    const entries = this.list();
    if (entries.length === 0) {
      throw new Error("No keyboard connected. Use connect_to_keyboard first.");
    }
    if (entries.length > 1) {
      const lines = entries
        .map((e) => `  device ${e.index}: ${e.device.model.info.displayName}${e.device.label ? ` (${e.device.label})` : ""}`)
        .join("\n");
      throw new Error(
        `Multiple devices connected — specify the 'device' parameter (1-based index).\nConnected devices:\n${lines}`,
      );
    }
    return entries[0];
  }

  /** Resolve a tool call: explicit index if provided, else the lone device. */
  resolve(index?: number): PoolEntry {
    return index !== undefined ? this.require(index) : this.requireSingle();
  }

  /** All connected entries in insertion order. */
  list(): PoolEntry[] {
    return Array.from(this.devices.values());
  }

  /** Count of connected devices. */
  size(): number {
    return this.devices.size;
  }

  /**
   * Disconnect every device in the pool. Used on MCB session-loss: the
   * broker has already discarded our leases, so the local OS-level handles
   * (MIDI output/input/forward + mock-status WS) must be torn down to keep
   * the cache consistent with broker truth. Returns the count torn down.
   */
  disconnectAll(): number {
    const indices = [...this.devices.keys()];
    for (const i of indices) {
      try { this.disconnect(i); } catch { /* already gone */ }
    }
    return indices.length;
  }
}
