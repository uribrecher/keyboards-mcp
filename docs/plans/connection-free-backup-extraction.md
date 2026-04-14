# Connection-Free Backup Extraction

## Context

`extract_backup` and `get_last_backup_location` currently require a MIDI connection (`holder.requireModel()`), but backup extraction is pure file parsing — no MIDI I/O needed. This broke when we made the codebase generic/multi-model. We need these tools to auto-detect the keyboard model from the backup file itself.

## Approach

Add a `detectBackup` method to `BackupCapability` so each model can claim a file. Add a registry function that tries all models. Fall back to detection when no connection exists.

## Changes

### 1. `src/shared/keyboard-model.ts` — Add detection method to interface

Add `detectBackup?` to `BackupCapability`:

```typescript
export interface BackupCapability {
  detectBackup?(filePath: string): Promise<boolean>;  // NEW
  parseBackup(filePath: string): Promise<BackupData>;
  parseProgramsFolder?(folderPath: string): Promise<BackupData>;
  formatAsMarkdown(data: BackupData, date?: string): string;
}
```

### 2. `src/keyboard_models/nord/electro_5d/backup-parser.ts` — Implement detection

Export a `detectBackup(filePath: string): boolean` function:
- **Directory**: check for `.ne5p` files
- **File**: fast-path on `.ne5b` extension; fallback: open ZIP, check for `ne5*`/`.npno`/`.nsmp` entries

### 3. `src/keyboard_models/nord/electro_5d/index.ts` — Wire detection

Import and add `detectBackup` to the `backup` capability object.

### 4. `src/shared/model-registry.ts` — Add two new functions

**`detectModelFromBackup(filePath)`**: Iterates all discovered models, calls `model.backup.detectBackup(filePath)`, returns first match.

**`findLastBackupPath()`**: Iterates all models, loads their `backupCache`, returns first non-null `getLastBackupPath()`.

Both follow the existing `discoverModels()` directory-scanning pattern.

### 5. `src/tools/extract-backup.ts` — Remove connection requirement

Replace the `requireModel()` block with:
1. If `holder.isLoaded` → use connected model (unchanged behavior)
2. Else → call `detectModelFromBackup(file_path)`
3. If detected → call `backupCache?.load()` on it, use transiently (don't store in holder)
4. If not detected → return error

Also: make `defaultOutputPath()` dynamic based on model name instead of hardcoded "nord".

### 6. `src/tools/get-last-backup-location.ts` — Remove connection requirement

1. If `holder.isLoaded` → use connected model (unchanged)
2. Else → call `findLastBackupPath()` from model-registry
3. If found → return path
4. If not → return "no path stored" message

## Verification

1. `npm run build` — compiles clean
2. Without connecting, run `extract_backup` with the real `.ne5b` backup path — should detect Nord and parse successfully
3. Without connecting, run `get_last_backup_location` — should return the cached path from the previous extraction
4. Connect to device, run `extract_backup` — should still work via the connected model path (no regression)