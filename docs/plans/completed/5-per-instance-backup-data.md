# Per-Instance Backup Data

> **Execution order: 5 of 7** — Depends on: architecture plan (KeyboardDevice with label), multi-device MCP plan (plan 4 — DevicePool with labels, multiple connected devices). Moved after multi-device because label-keyed backup storage can't be meaningfully tested with only one device connected.

## Context

Backup data (programs, piano models, samples, set lists) is currently stored as a single global cache per model type (`data/backup_cache.json` under the model directory). This assumes one instance per model — but a user can own multiple units of the same keyboard, each with different programs and samples loaded. The backup data must be associated with a specific device instance, identified by its user-assigned label.

## Current Flow

```
extract_backup(file_path) 
  → model.backup.parseBackup(file_path)
  → model.backupCache.set(data) → writes data/backup_cache.json (single global file)
  → model.backupCache.setLastBackupPath() → writes data/last_backup_path.txt
  → device.backupData = data (updates active device instance)
  → returns formatted markdown inventory

MockHandler.init(lowerChannel, upperChannel)
  → backupCache.load() (reads data/backup_cache.json)
  → buildInventoryFromCache() (piano models, sample names for UI)

MockHandler.onMIDI({ type: "program", ... })
  → applyProgramParams() from cached backup data
  → returns { state: fullState } for UI broadcast

MockHandler.onCacheReload()
  → re-reads backup cache from disk, rebuilds inventory

KeyboardDevice (MCP side)
  → device.backupData holds this instance's inventory
  → device.listPrograms() / device.listSongs() query backupData
  → device.getSystemPrompt() includes backup inventory summary
```

### Key files

- `src/tools/extract-backup.ts` — MCP tool, writes to cache and updates device.backupData
- `src/keyboard_models/nord/electro_5d/backup-cache.ts` — cache read/write, path: `data/backup_cache.json`
- `src/keyboard_models/nord/electro_5d/backup-parser.ts` — binary parsing, `BackupMetadata` type
- `src/keyboard_models/nord/electro_5d/mock-handler.ts` — MockHandler with onMIDI(), loads cache on init
- `src/keyboard_models/nord/electro_5d/device.ts` — KeyboardDevice, owns backupData for tool methods
- `src/keyboard_models/nord/electro_5d/index.ts` — model entry point, createDevice() factory

## Design

### Storage: label-keyed backup directories

Replace the single `data/backup_cache.json` with label-keyed directories:

```
data/
  backups/
    studio-nord/
      backup_cache.json       # parsed BackupMetadata
      last_backup_path.txt    # source file path
    gig-nord/
      backup_cache.json
      last_backup_path.txt
    _default/
      backup_cache.json       # fallback for unlabeled single-device usage
      last_backup_path.txt
```

The `_default` directory provides backwards compatibility — when no label is specified (single device, no label assigned), backup data goes to `_default/`.

### Tool changes

#### `extract_backup`

Add optional `label` parameter:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file_path | string | yes | Path to backup file or folder |
| label | string | no | Device instance label to associate this backup with |
| output_path | string | no | Custom markdown output path |

**Resolution:**
1. If `label` provided → store in `data/backups/<label>/`
2. If a device is connected and has a label → use that label
3. If only one device connected (no label) → store in `data/backups/_default/`
4. If no device connected and no label → store in `data/backups/_default/`

#### `connect_to_keyboard`

After connection, if a label is provided and a backup cache exists for that label, auto-load it onto the device instance (`device.backupData = cachedBackup`).

#### `get_last_backup_location`

Add optional `label` parameter. Returns the last backup path for the specified label (or `_default`).

### KeyboardDevice changes

`KeyboardDevice` already has `backupData?: BackupData`. The `BackupCacheCapability` interface (in `keyboard-model.ts`) needs to be extended with label support:

```typescript
// Current interface (single global cache):
interface BackupCacheCapability {
  load(): void;
  get(): BackupData | null;
  set(data: BackupData): void;
  reload(): boolean;
  getLastBackupPath(): string | null;
  setLastBackupPath(path: string): void;
}

// Updated interface (label-keyed):
interface BackupCacheCapability {
  load(label?: string): void;                    // reads from data/backups/<label>/
  get(label?: string): BackupData | null;
  set(data: BackupData, label?: string): void;   // writes to data/backups/<label>/
  reload(label?: string): boolean;
  getLastBackupPath(label?: string): string | null;
  setLastBackupPath(path: string, label?: string): void;
  listLabels(): string[];                         // lists known backup labels
}
```

The `label` parameter defaults to `"_default"` for backwards compatibility.

### MockHandler changes

MockHandler currently calls `backupCache.load()` globally on `init()` and reads from a single cache file. After this change:

- `MockHandler.init()` receives a label and loads that label's cache: `backupCache.load(label)`
- `MockHandler.onCacheReload()` reloads the same label's cache
- For the mock runner: the tab's label determines which cache to load
- For MCP-connected mocks (forward port): the connected device's label is used to select the right cache

### Mock runner tab labeling (plan 6)

> **Note:** The tab UI for label management is implemented in plan 6 (Tabbed Mock Runner). This plan provides the data layer (label-keyed storage). The tab ↔ backup directory mapping described below is exercised when plan 6 lands.

Each mock tab gets an **auto-generated label** based on the selected model type with an incrementing counter:

```
nord-el-5d-#1, nord-el-5d-#2, prophet-5-#1, prophet-5-#2, ...
```

- The label is auto-populated after model selection (tab starts empty, label appears once model is chosen)
- The user can **manually edit** the label after it's assigned (e.g., rename `nord-el-5d-#1` to `studio-nord`)
- The label doubles as the tab's display name and its backup storage key
- Tabs start with no backup data. If the user extracts a backup while a tab is active, it's stored under that tab's label
- If a tab is created and its auto-generated label matches an existing backup directory (e.g., `nord-el-5d-#1` was used before), the cached backup is auto-loaded
- Renaming the label moves/re-keys the backup directory

### `is_connected` / device listing

When listing devices, include the label and whether backup data is loaded:

```
Device 1: Nord Electro 5D "studio Nord" (backup: 201 programs, 27 pianos)
Device 2: Nord Electro 5D "gig Nord" (backup: not loaded)
Device 3: Prophet-6 (no backup)
```

## Migration

Existing `data/backup_cache.json` and `data/last_backup_path.txt` are migrated to `data/backups/_default/` on first run. Old paths are removed after successful migration.

## What doesn't change

- **Backup parsing logic** — `backup-parser.ts` is unchanged (model-level concern, knows the binary format)
- **BackupMetadata type** — unchanged
- **Program Change handling** — `applyProgramParams()` logic unchanged, just reads from instance data instead of global cache
- **UI state broadcasting** — `getExtraState()` unchanged, just reads from instance data

## Verification

### MCP-level (testable with multi-device from plan 4)

1. Extract a backup with no label → stored in `data/backups/_default/`, mock loads it (backwards compat)
2. Extract a backup with `label="studio"` → stored in `data/backups/studio/`
3. Connect with `label="studio"` → auto-loads studio backup data
4. Connect a second device with `label="gig"` and different backup → each device has independent inventory
5. `get_last_backup_location(label="studio")` → returns correct path
6. Migration: start with existing `data/backup_cache.json` → auto-migrated to `_default/`

### Mock runner tab integration (testable after plan 6)

7. Mock runner: select Nord model → tab auto-labeled `nord-el-5d-#1`, starts empty
8. Mock runner: extract backup on that tab → stored under `nord-el-5d-#1`
9. Mock runner: close and re-create Nord tab → auto-labeled `nord-el-5d-#1` again → cached backup auto-loaded
10. Mock runner: rename tab to `studio-nord` → backup directory re-keyed

## Test Coverage

### Unit tests

**`tests/unit/backup-cache.test.ts`** (new) — test the updated `BackupCacheCapability` in isolation:
- **Default label:** `set(data)` with no label writes to `data/backups/_default/backup_cache.json`. `get()` reads it back identically.
- **Named label:** `set(data, "studio")` writes to `data/backups/studio/backup_cache.json`. `get("studio")` reads it back.
- **Label isolation:** Set data under `"studio"` and `"gig"`. Assert `get("studio")` and `get("gig")` return different data. `get("unknown")` returns null.
- **listLabels:** After writing to `"studio"` and `"gig"`, `listLabels()` returns both (plus `_default` if present).
- **Last backup path:** `setLastBackupPath("/path", "studio")` → `getLastBackupPath("studio")` returns `"/path"`. `getLastBackupPath("gig")` returns null.
- **reload:** Modify the JSON file on disk, call `reload("studio")`, verify updated data returned by `get("studio")`.

**`tests/unit/backup-migration.test.ts`** (new) — test the migration from old single-file layout:
- **Migration runs:** Place a `data/backup_cache.json` and `data/last_backup_path.txt` at old paths. Trigger migration. Assert files moved to `data/backups/_default/`. Assert old paths no longer exist.
- **Migration is idempotent:** Run migration twice. No error, `_default/` still intact.
- **No migration needed:** Start with no old files. Migration is a no-op.

### E2E tests

**`tests/e2e/backup-per-instance.test.ts`** (new) — requires two mock processes (from plan 4):
- **Extract with label:** Connect device 1 (Nord) with `label: "studio"`. Call `extract_backup(file_path, label: "studio")`. Assert response includes program/piano counts. Call `list_programs(device: 1)` and verify inventory is populated.
- **Extract with different label:** Connect device 2 (Nord) with `label: "gig"`. Extract a different backup under `"gig"`. Assert `list_programs(device: 2)` returns different data than device 1.
- **Auto-load on connect:** Disconnect device 1. Reconnect with `label: "studio"`. Assert `list_programs(device: 1)` returns the previously cached inventory without re-extracting.
- **Default label backwards compat:** Connect a single device with no label. Extract backup. Assert stored under `_default`. `list_programs` works.
- **get_last_backup_location:** After extracting under `"studio"`, call `get_last_backup_location(label: "studio")`. Assert it returns the original file path.
