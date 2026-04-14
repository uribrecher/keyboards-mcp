/**
 * Mutable container for the active keyboard model and its state.
 * Starts empty — populated when connect_to_keyboard auto-detects a device.
 */

import type { KeyboardModel, StateManager } from "./keyboard-model.js";

export class ModelHolder {
  model: KeyboardModel | null = null;
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

  /** Get the active state manager or throw a user-friendly error */
  requireState(): StateManager {
    if (!this.stateManager) {
      throw new Error("No keyboard detected. Use connect_to_keyboard first.");
    }
    return this.stateManager;
  }

  /** Load a model: create state manager and initialize backup cache */
  load(model: KeyboardModel): void {
    this.model = model;
    this.stateManager = model.createStateManager();
    model.backupCache?.load();
  }

  /** Unload the current model (on disconnect) */
  unload(): void {
    this.model = null;
    this.stateManager = null;
  }
}
