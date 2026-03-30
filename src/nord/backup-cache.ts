import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackupMetadata, PianoEntry } from "./backup-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, "..", "..", "data");
const cachePath = join(dataDir, "backup_cache.json");

let cachedBackup: BackupMetadata | null = null;

/** Save parsed backup data to in-memory cache and persist as JSON. */
export function setBackupData(data: BackupMetadata): void {
  cachedBackup = data;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(data), "utf-8");
  } catch {
    // Non-fatal — cache still works in-memory
  }
}

export function getBackupData(): BackupMetadata | null {
  return cachedBackup;
}

/** Load cached backup data from JSON on disk (call at startup). */
export function loadBackupCache(): void {
  if (cachedBackup) return;
  try {
    if (existsSync(cachePath)) {
      cachedBackup = JSON.parse(readFileSync(cachePath, "utf-8")) as BackupMetadata;
      console.error(`Loaded backup cache from ${cachePath}`);
    }
  } catch {
    // Non-fatal — will work without cache until extract_backup is called
  }
}

/**
 * Resolve a piano model index to its name from the cached inventory.
 * @param pianoType - Piano type label (e.g., "Grand", "Upright", "EP1")
 * @param modelIndex - 1-based per-category model index
 * @returns Model name if inventory is loaded, null otherwise
 */
export function resolvePianoModelName(pianoType: string, modelIndex: number): string | null {
  if (!cachedBackup) return null;
  const typeToCategory: Record<string, string> = {
    Grand: "Grand", EP1: "EPiano1", EP2: "EPiano2",
    Harpsichord: "Harps", Upright: "Upright", Clav: "Clavinet",
  };
  const category = typeToCategory[pianoType];
  if (!category) return null;
  const piano = cachedBackup.pianos.find(
    (p) => p.category === category && p.location === modelIndex
  );
  return piano?.name ?? null;
}

/**
 * Resolve a sample slot to its name from the cached inventory.
 * @param slot - 0-based internal sample slot
 * @returns Sample name if inventory is loaded, null otherwise
 */
export function resolveSampleName(slot: number): string | null {
  if (!cachedBackup) return null;
  const sample = cachedBackup.samples.find((s) => s.slot === slot);
  return sample?.name ?? null;
}

/**
 * Get available piano models for a given type from the cached inventory.
 * @returns Array of {location, name} or null if no inventory
 */
export function getPianoModelsForType(pianoType: string): { location: number; name: string }[] | null {
  if (!cachedBackup) return null;
  const typeToCategory: Record<string, string> = {
    Grand: "Grand", EP1: "EPiano1", EP2: "EPiano2",
    Harpsichord: "Harps", Upright: "Upright", Clav: "Clavinet",
  };
  const category = typeToCategory[pianoType];
  if (!category) return null;
  return cachedBackup.pianos
    .filter((p) => p.category === category)
    .map((p) => ({ location: p.location, name: p.name }))
    .sort((a, b) => a.location - b.location);
}
