/**
 * Mutable container for the active keyboard model and device.
 * Starts empty — populated when connect_to_keyboard auto-detects a device.
 */

import type { KeyboardModel, KeyboardDevice } from "./keyboard-model.js";

export class ModelHolder {
  model: KeyboardModel | null = null;
  device: KeyboardDevice | null = null;

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

  /** Load a model: create device instance and load backup data */
  load(model: KeyboardModel): void {
    this.model = model;

    // Load backup cache so backup data is available
    model.backupCache?.load();

    // Create device instance
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
  }
}