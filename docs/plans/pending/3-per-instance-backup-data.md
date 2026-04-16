# Per-Instance Backup Data

> **Execution order: 3 of 7** — Depends on: architecture plan (KeyboardDevice with label). Multi-device plan builds on top of this naturally. Can be implemented right after architecture, before or alongside test automation.

## Context

Backup data (programs, piano models, samples, set lists) is currently stored as a single global cache per model type (`data/backup_cache.json` under the model directory). This assumes one instance per model — but a user can own multiple units of the same keyboard, each with different programs and samples loaded. The backup data must be associated with a specific device instance, identified by its user-assigned label.

## Current Flow

```
extract_backup(file_path) 
  → model.backupParser.parseBackup(file_path)
  → writes data/backup_cache.json (single global file)
  → writes data/last_backup_path.txt
  → returns formatted markdown inventory

MockHandler.init()
  → backupCache.load()  (reads data/backup_cache.json)
  → buildInventoryFromCache()
  → applyProgramParams() on Program Change
  → getExtraState() includes piano/sample names for UI
```

### Key files

- `src/tools/extract-backup.ts` — MCP tool registration
- `src/keyboard_models/nord/electro_5d/backup-cache.ts` — cache read/write, path: `data/backup_cache.json`
- `src/keyboard_models/nord/electro_5d/backup-parser.ts` — binary parsing, `BackupMetadata` type
- `src/keyboard_models/nord/electro_5d/mock-handler.ts` — loads cache on init, applies program params
- `src/keyboard_models/nord/electro_5d/index.ts` — model entry point

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

Per the architecture plan, `KeyboardDevice` already has `backupData?: BackupData`. The backup cache module needs to support reading/writing by label:

```typescript
// In backup-cache.ts (conceptual)
interface BackupCache {
  save(data: BackupMetadata, label?: string): void;    // writes to data/backups/<label>/
  load(label?: string): BackupMetadata | null;         // reads from data/backups/<label>/
  listLabels(): string[];                               // lists known backup labels
  getLastBackupPath(label?: string): string | null;
}
```

### MockHandler changes

MockHandler currently calls `backupCache.load()` globally on init. After this change:

- MockHandler receives its backup data via constructor or init parameter (injected by whoever creates it)
- For MCP-connected mocks (forward port): the connected device's `backupData` is forwarded to the mock handler via the existing cache reload mechanism

### Mock runner tab labeling

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

1. Extract a backup with no label → stored in `data/backups/_default/`, mock loads it (backwards compat)
2. Extract a backup with `label="studio"` → stored in `data/backups/studio/`
3. Connect with `label="studio"` → auto-loads studio backup data
4. Connect a second device with `label="gig"` and different backup → each device has independent inventory
5. Mock runner: select Nord model → tab auto-labeled `nord-el-5d-#1`, starts empty
6. Mock runner: extract backup on that tab → stored under `nord-el-5d-#1`
7. Mock runner: close and re-create Nord tab → auto-labeled `nord-el-5d-#1` again → cached backup auto-loaded
8. Mock runner: rename tab to `studio-nord` → backup directory re-keyed
9. `get_last_backup_location(label="studio-nord")` → returns correct path
10. Migration: start with existing `data/backup_cache.json` → auto-migrated to `_default/`
