/**
 * Discovers and loads keyboard models from keyboard_models/<mfr>/<model>/.
 */

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyboardModel, KeyboardModelInfo } from "./keyboard-model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modelsDir = join(__dirname, "..", "keyboard_models");

let activeModel: KeyboardModel | null = null;

/** Scan keyboard_models/ for all available models */
export async function discoverModels(): Promise<KeyboardModelInfo[]> {
  const models: KeyboardModelInfo[] = [];
  if (!existsSync(modelsDir)) return models;

  for (const mfr of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!mfr.isDirectory()) continue;
    const mfrDir = join(modelsDir, mfr.name);
    for (const mdl of readdirSync(mfrDir, { withFileTypes: true })) {
      if (!mdl.isDirectory()) continue;
      const indexPath = join(mfrDir, mdl.name, "index.js");
      if (existsSync(indexPath)) {
        const mod = await import(indexPath);
        const model: KeyboardModel = mod.default;
        models.push(model.info);
      }
    }
  }
  return models;
}

/** Load a specific keyboard model by ID */
export async function loadModelById(modelId: string): Promise<KeyboardModel> {
  if (!existsSync(modelsDir)) {
    throw new Error(`keyboard_models directory not found at ${modelsDir}`);
  }

  for (const mfr of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!mfr.isDirectory()) continue;
    const mfrDir = join(modelsDir, mfr.name);
    for (const mdl of readdirSync(mfrDir, { withFileTypes: true })) {
      if (!mdl.isDirectory()) continue;
      const indexPath = join(mfrDir, mdl.name, "index.js");
      if (existsSync(indexPath)) {
        const mod = await import(indexPath);
        const model: KeyboardModel = mod.default;
        if (model.info.id === modelId) return model;
      }
    }
  }

  throw new Error(
    `Keyboard model "${modelId}" not found. ` +
      `Available models: ${(await discoverModels()).map((m) => m.id).join(", ") || "none"}`,
  );
}

/** Auto-detect model from available MIDI port names */
export async function autoDetectModel(portNames: string[]): Promise<KeyboardModel | null> {
  const allInfos = await discoverModels();
  for (const info of allInfos) {
    for (const pattern of info.midiPortPatterns) {
      if (portNames.some((p) => p.toLowerCase().includes(pattern.toLowerCase()))) {
        return loadModelById(info.id);
      }
    }
  }
  return null;
}

/** Auto-detect keyboard model from a backup file or programs folder */
export async function detectModelFromBackup(filePath: string): Promise<KeyboardModel | null> {
  if (!existsSync(modelsDir)) return null;

  for (const mfr of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!mfr.isDirectory()) continue;
    const mfrDir = join(modelsDir, mfr.name);
    for (const mdl of readdirSync(mfrDir, { withFileTypes: true })) {
      if (!mdl.isDirectory()) continue;
      const indexPath = join(mfrDir, mdl.name, "index.js");
      if (existsSync(indexPath)) {
        const mod = await import(indexPath);
        const model: KeyboardModel = mod.default;
        if (model.backup?.detectBackup) {
          try {
            if (await model.backup.detectBackup(filePath)) return model;
          } catch {
            // Detection failed for this model, try next
          }
        }
      }
    }
  }
  return null;
}

/** Find the last backup path across all models (for use without a connection) */
export async function findLastBackupPath(): Promise<string | null> {
  if (!existsSync(modelsDir)) return null;

  for (const mfr of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!mfr.isDirectory()) continue;
    const mfrDir = join(modelsDir, mfr.name);
    for (const mdl of readdirSync(mfrDir, { withFileTypes: true })) {
      if (!mdl.isDirectory()) continue;
      const indexPath = join(mfrDir, mdl.name, "index.js");
      if (existsSync(indexPath)) {
        const mod = await import(indexPath);
        const model: KeyboardModel = mod.default;
        if (model.backupCache) {
          model.backupCache.load();
          const path = model.backupCache.getLastBackupPath();
          if (path) return path;
        }
      }
    }
  }
  return null;
}

export function getActiveModel(): KeyboardModel {
  if (!activeModel) throw new Error("No keyboard model loaded. Call setActiveModel() first.");
  return activeModel;
}

export function setActiveModel(model: KeyboardModel): void {
  activeModel = model;
}
