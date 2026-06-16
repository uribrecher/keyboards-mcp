/**
 * Nord Electro 5D backup data cache.
 *
 * Per-instance storage: each device has a `label` and its cache lives in
 * `data/backups/<sanitized-label>/`. A `_default` label preserves
 * backwards compatibility for single-device, no-label callers.
 *
 * On first load, legacy `data/backup_cache.json` and `data/last_backup_path.txt`
 * are migrated into `data/backups/_default/`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackupCacheCapability, BackupData } from "../../../shared/keyboard-model.js";
import type { BackupMetadata, PianoEntry } from "./backup-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the data directory at every call so tests can override the
 * destination via KEYBOARDS_MCP_DATA_DIR. In production this is the
 * repo's `data/` folder.
 */
function getDataDir(): string {
  return process.env.KEYBOARDS_MCP_DATA_DIR
    ?? join(__dirname, "..", "..", "..", "..", "data");
}

function getBackupsRoot(): string {
  return join(getDataDir(), "backups");
}

const DEFAULT_LABEL = "_default";

/** Legacy single-file paths (pre-plan-5). */
function legacyCachePath(): string {
  return join(getDataDir(), "backup_cache.json");
}
function legacyLastBackupPath(): string {
  return join(getDataDir(), "last_backup_path.txt");
}

/** In-memory cache keyed by sanitized label. */
const cacheByLabel = new Map<string, BackupMetadata>();

/** Set of labels we've attempted to load from disk this process. */
const loadedLabels = new Set<string>();

let migrationRan = false;

/**
 * Sanitize a user label for filesystem use.
 *  - lowercase
 *  - strip leading/trailing whitespace
 *  - collapse internal whitespace into "-"
 *  - remove characters other than [a-z0-9._-]
 *  - reject "..", "/", ""; fall back to DEFAULT_LABEL
 */
export function sanitizeLabel(label: string | undefined | null): string {
  if (!label) return DEFAULT_LABEL;
  let slug = label.trim().toLowerCase();
  slug = slug.replace(/\s+/g, "-");
  slug = slug.replace(/[^a-z0-9._-]/g, "");
  // Disallow path traversal sentinels and pure-dot names
  if (slug === "" || slug === "." || slug === ".." || slug.includes("..")) {
    return DEFAULT_LABEL;
  }
  return slug;
}

function labelDir(label: string): string {
  return join(getBackupsRoot(), sanitizeLabel(label));
}

function cacheFile(label: string): string {
  return join(labelDir(label), "backup_cache.json");
}

function lastBackupFile(label: string): string {
  return join(labelDir(label), "last_backup_path.txt");
}

/**
 * Migrate legacy `data/backup_cache.json` and `data/last_backup_path.txt`
 * into `data/backups/_default/`. Idempotent; runs at most once per process.
 */
export function runMigration(): void {
  if (migrationRan) return;
  migrationRan = true;

  const defaultDir = labelDir(DEFAULT_LABEL);
  const cacheSrc = legacyCachePath();
  const pathSrc = legacyLastBackupPath();
  try {
    const legacyCacheExists = existsSync(cacheSrc);
    const legacyPathExists = existsSync(pathSrc);
    if (!legacyCacheExists && !legacyPathExists) return;

    mkdirSync(defaultDir, { recursive: true });

    if (legacyCacheExists) {
      const target = cacheFile(DEFAULT_LABEL);
      if (!existsSync(target)) {
        renameSync(cacheSrc, target);
        console.error(`Migrated legacy backup cache → ${target}`);
      }
    }
    if (legacyPathExists) {
      const target = lastBackupFile(DEFAULT_LABEL);
      if (!existsSync(target)) {
        renameSync(pathSrc, target);
        console.error(`Migrated legacy last_backup_path.txt → ${target}`);
      }
    }
  } catch (err) {
    console.error("Backup cache migration failed (non-fatal):", err);
  }
}

export function createBackupCache(): BackupCacheCapability {
  runMigration();

  return {
    load(label?: string): void {
      const key = sanitizeLabel(label);
      if (loadedLabels.has(key) && cacheByLabel.has(key)) return;
      loadedLabels.add(key);
      try {
        const path = cacheFile(key);
        if (existsSync(path)) {
          const data = JSON.parse(readFileSync(path, "utf-8")) as BackupMetadata;
          cacheByLabel.set(key, data);
          console.error(`Loaded backup cache "${key}" from ${path}`);
        }
      } catch {
        // Non-fatal
      }
    },

    get(label?: string): BackupData | null {
      return cacheByLabel.get(sanitizeLabel(label)) ?? null;
    },

    set(data: BackupData, label?: string): void {
      const key = sanitizeLabel(label);
      cacheByLabel.set(key, data as BackupMetadata);
      try {
        mkdirSync(labelDir(key), { recursive: true });
        writeFileSync(cacheFile(key), JSON.stringify(data), "utf-8");
      } catch {
        // Non-fatal — cache still works in-memory
      }
    },

    reload(label?: string): boolean {
      const key = sanitizeLabel(label);
      try {
        const path = cacheFile(key);
        if (existsSync(path)) {
          const data = JSON.parse(readFileSync(path, "utf-8")) as BackupMetadata;
          cacheByLabel.set(key, data);
          console.error(`Reloaded backup cache "${key}" from ${path}`);
          return true;
        }
      } catch {
        // Non-fatal
      }
      return false;
    },

    getLastBackupPath(label?: string): string | null {
      const key = sanitizeLabel(label);
      try {
        const path = lastBackupFile(key);
        if (existsSync(path)) {
          return readFileSync(path, "utf-8").trim();
        }
      } catch {
        // Non-fatal
      }
      return null;
    },

    setLastBackupPath(path: string, label?: string): void {
      const key = sanitizeLabel(label);
      try {
        mkdirSync(labelDir(key), { recursive: true });
        writeFileSync(lastBackupFile(key), path, "utf-8");
      } catch {
        // Non-fatal
      }
    },

    listLabels(): string[] {
      try {
        const root = getBackupsRoot();
        if (!existsSync(root)) return [];
        return readdirSync(root)
          .filter((entry) => {
            const full = join(root, entry);
            try { return statSync(full).isDirectory(); } catch { return false; }
          })
          .filter((entry) => existsSync(join(root, entry, "backup_cache.json")));
      } catch {
        return [];
      }
    },
  };
}

// ── Convenience helpers for internal use ──

export function getBackupData(label?: string): BackupMetadata | null {
  return cacheByLabel.get(sanitizeLabel(label)) ?? null;
}

const PIANO_TYPE_TO_CATEGORY: Record<string, string> = {
  Grand: "Grand", EP1: "EPiano1", EP2: "EPiano2",
  Harpsichord: "Harps", Upright: "Upright", Clav: "Clavinet",
};

export function resolvePianoModelName(pianoType: string, modelIndex: number, label?: string): string | null {
  const data = getBackupData(label);
  if (!data) return null;
  const category = PIANO_TYPE_TO_CATEGORY[pianoType];
  if (!category) return null;
  const piano = data.pianos.find(
    (p: PianoEntry) => p.category === category && p.location === modelIndex,
  );
  return piano?.name ?? null;
}

export function resolveSampleName(slot: number, label?: string): string | null {
  const data = getBackupData(label);
  if (!data) return null;
  const sample = data.samples.find((s) => s.slot === slot);
  return sample?.name ?? null;
}

export function getPianoModelsForType(pianoType: string, label?: string): { location: number; name: string }[] | null {
  const data = getBackupData(label);
  if (!data) return null;
  const category = PIANO_TYPE_TO_CATEGORY[pianoType];
  if (!category) return null;
  return data.pianos
    .filter((p: PianoEntry) => p.category === category)
    .map((p: PianoEntry) => ({ location: p.location, name: p.name }))
    .sort((a, b) => a.location - b.location);
}

/** Test-only: reset all module-level state. */
export function _resetForTests(): void {
  cacheByLabel.clear();
  loadedLabels.clear();
  migrationRan = false;
}
