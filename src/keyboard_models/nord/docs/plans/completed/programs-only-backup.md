# Plan: Support Programs-Only Backup in extract_backup

## Context

Nord Sound Manager can export a "programs only" backup (much faster than full `.ne5b`). It produces a **flat folder of 211 individual `.ne5p` files** (165 bytes each) instead of a ZIP archive. We want `extract_backup` to handle this automatically by detecting whether the input is a file or directory.

## Approach: Maximize Code Reuse

### 1. Extract `parseSingleProgram()` helper — `src/nord/backup-parser.ts`

The logic for parsing a single `.ne5p` buffer already exists inside `parseBackup()` (lines 459-471). Extract it into a reusable function:

```ts
export function parseSingleProgram(buf: Buffer, fileName: string): ProgramEntry {
  const hdr = readCbinHeader(buf);
  const payload = buf.subarray(CBIN_HEADER_SIZE);
  return {
    bank: hdr.bankIndex + 1,
    slot: hdr.slotIndex,
    name: fileName,
    params: decodeProgramPayload(payload),
    payloadHex: payload.toString("hex"),
  };
}
```

Then `parseBackup()` calls `parseSingleProgram(buf, fileName)` for `.ne5p` entries (no duplication).

### 2. Add `parseProgramsFolder()` — `src/nord/backup-parser.ts`

New function that reads a directory of `.ne5p` files:

```ts
export function parseProgramsFolder(dirPath: string): ProgramEntry[] {
  // readdirSync → filter .ne5p → readFileSync each → parseSingleProgram()
  // Sort by bank/slot
}
```

Returns just `ProgramEntry[]` — not a full `BackupMetadata`. The caller decides how to assemble the final structure.

### 3. Extract `formatProgramsSection()` — `src/nord/backup-parser.ts`

Extract lines 628-688 from `formatBackupAsMarkdown()` into a standalone function:

```ts
export function formatProgramsSection(
  programs: ProgramEntry[],
  sampleBySlot: Map<number, string>
): string
```

Then `formatBackupAsMarkdown()` calls `formatProgramsSection()` internally. The programs-only path also calls `formatProgramsSection()` directly. Single implementation, two callers.

### 4. Update `extract_backup` tool — `src/tools/extract-backup.ts`

- **Auto-detect mode** from `file_path`: use `statSync` to check if it's a directory or a file
  - Directory → programs-only mode: call `parseProgramsFolder(file_path)`, merge with cached backup
  - File → full backup mode: existing `parseBackup()` behavior (no change)
- No new parameters needed — the tool stays simple
- When in programs-only mode:
  - First check `getBackupData()` — if no cached full backup exists, **fail with a clear error**: "Programs-only extraction requires a previously cached full backup for piano/sample name resolution. Please run extract_backup on a full .ne5b backup first."
  - If cache exists: merge — pianos/samples/setLists/livePresets from cache, fresh programs from folder — then update cache with merged result
- Update tool description to mention it accepts either a `.ne5b` file or a folder of `.ne5p` files

## Files to modify
- `src/nord/backup-parser.ts` — extract `parseSingleProgram()`, add `parseProgramsFolder()`, extract `formatProgramsSection()`
- `src/tools/extract-backup.ts` — auto-detect mode and routing logic

## Verification
1. `npm run build`
2. `/mcp` to reload
3. `extract_backup(file_path="/.../test_data/backup_programs_only")`
4. Verify output: correct program count (211), correct bank/slot assignments, decoded parameters
5. Confirm piano/sample names resolve from cached full backup
6. Run `extract_backup` on the full `.ne5b` to verify no regression
