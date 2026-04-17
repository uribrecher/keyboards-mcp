/**
 * Mutable container for the active keyboard model and device.
 * Starts empty — populated when connect_to_keyboard auto-detects a device.
 */

import type { KeyboardModel, KeyboardDevice, StateManager } from "./keyboard-model.js";

export class ModelHolder {
  model: KeyboardModel | null = null;
  device: KeyboardDevice | null = null;
  /** @deprecated Use device instead — kept for tools not yet migrated */
  stateManager: StateManager | null = null;

  get isLoaded(): boolean {
    return this.model !== null;
  }

  /** Get the active model or throw a user-friendly error */
  requireModel(): KeyboardModel {
    if (!this.model) {
      throw new Error("No keyboard detected. Use connect_to_keyboard first.");
    }
    return this.model;
  }

  /** Get the active device or throw a user-friendly error */
  requireDevice(): KeyboardDevice {
    if (!this.device) {
      throw new Error("No keyboard detected. Use connect_to_keyboard first.");
    }
    return this.device;
  }

  /** @deprecated Use requireDevice() — kept for tools not yet migrated */
  requireState(): StateManager {
    if (!this.stateManager) {
      throw new Error("No keyboard detected. Use connect_to_keyboard first.");
    }
    return this.stateManager;
  }

  /** Load a model: create device (if supported) and state manager */
  load(model: KeyboardModel): void {
    this.model = model;
    this.stateManager = model.createStateManager();
    model.backupCache?.load();

    // New architecture: create a device instance
    if (model.createDevice) {
      this.device = model.createDevice();
      // Load backup data onto device if available
      const backupData = model.backupCache?.get();
      if (backupData) {
        this.device.backupData = backupData;
      }
    }
  }

  /** Unload the current model (on disconnect) */
  unload(): void {
    if (this.device) {
      this.device.detach();
    }
    this.model = null;
    this.device = null;
    this.stateManager = null;
  }
}
