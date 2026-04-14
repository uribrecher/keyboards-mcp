/**
 * Nord Electro 5D backup data cache.
 * Wraps the original backup-cache module but conforms to BackupCacheCapability.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackupCacheCapability, BackupData } from "../../../shared/keyboard-model.js";
import type { BackupMetadata, PianoEntry } from "./backup-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, "..", "..", "..", "..", "data");
const cachePath = join(dataDir, "backup_cache.json");
const lastBackupFile = join(dataDir, "last_backup_path.txt");

let cachedBackup: BackupMetadata | null = null;

export function createBackupCache(): BackupCacheCapability {
  return {
    load(): void {
      if (cachedBackup) return;
      try {
        if (existsSync(cachePath)) {
          cachedBackup = JSON.parse(readFileSync(cachePath, "utf-8")) as BackupMetadata;
          console.error(`Loaded backup cache from ${cachePath}`);
        }
      } catch {
        // Non-fatal
      }
    },

    get(): BackupData | null {
      return cachedBackup;
    },

    set(data: BackupData): void {
      cachedBackup = data as BackupMetadata;
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(cachePath, JSON.stringify(data), "utf-8");
      } catch {
        // Non-fatal — cache still works in-memory
      }
    },

    reload(): boolean {
      try {
        if (existsSync(cachePath)) {
          cachedBackup = JSON.parse(readFileSync(cachePath, "utf-8")) as BackupMetadata;
          console.error(`Reloaded backup cache from ${cachePath}`);
          return true;
        }
      } catch {
        // Non-fatal
      }
      return false;
    },

    getLastBackupPath(): string | null {
      try {
        if (existsSync(lastBackupFile)) {
          return readFileSync(lastBackupFile, "utf-8").trim();
        }
      } catch {
        // Non-fatal
      }
      return null;
    },

    setLastBackupPath(path: string): void {
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(lastBackupFile, path, "utf-8");
      } catch {
        // Non-fatal
      }
    },
  };
}

// ── Convenience helpers for internal use ──

export function getBackupData(): BackupMetadata | null {
  return cachedBackup;
}

export function resolvePianoModelName(pianoType: string, modelIndex: number): string | null {
  if (!cachedBackup) return null;
  const typeToCategory: Record<string, string> = {
    Grand: "Grand", EP1: "EPiano1", EP2: "EPiano2",
    Harpsichord: "Harps", Upright: "Upright", Clav: "Clavinet",
  };
  const category = typeToCategory[pianoType];
  if (!category) return null;
  const piano = cachedBackup.pianos.find(
    (p: PianoEntry) => p.category === category && p.location === modelIndex,
  );
  return piano?.name ?? null;
}

export function resolveSampleName(slot: number): string | null {
  if (!cachedBackup) return null;
  const sample = cachedBackup.samples.find((s) => s.slot === slot);
  return sample?.name ?? null;
}

export function getPianoModelsForType(pianoType: string): { location: number; name: string }[] | null {
  if (!cachedBackup) return null;
  const typeToCategory: Record<string, string> = {
    Grand: "Grand", EP1: "EPiano1", EP2: "EPiano2",
    Harpsichord: "Harps", Upright: "Upright", Clav: "Clavinet",
  };
  const category = typeToCategory[pianoType];
  if (!category) return null;
  return cachedBackup.pianos
    .filter((p: PianoEntry) => p.category === category)
    .map((p: PianoEntry) => ({ location: p.location, name: p.name }))
    .sort((a, b) => a.location - b.location);
}
