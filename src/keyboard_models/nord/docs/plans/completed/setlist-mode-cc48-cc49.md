# Add Set List Mode (CC48 + CC49) to Mock Device

## Context

The Nord Electro 5D has two operating modes: Program mode and Set List mode. CC48 toggles between them, and CC49 selects the song part (A/B/C/D) when in set list mode. These are currently unmapped in the mock device. Adding support enables the mock to emulate the hardware's set list navigation — important for live performance workflows.

## How Set List Mode Works on Hardware

- **CC48**: Mode toggle — 0 = Program mode, 127 = Set List mode
- **Bank Select (CC0+CC32)**: In set list mode, selects which set list (0-9 maps to set lists 1-10)
- **Program Change**: In set list mode, selects a song within that set list (0-49), automatically resets to part A
- **CC49**: Selects the part of the current song (0=A, 43=B, 85=C, 127=D)
- Each song part (A/B/C/D) references a stored program (bank+slot). Loading a part = loading that program's params.

## Data Available

From `backup_cache.json` (`BackupMetadata.setLists[]`):
```ts
interface SetListEntry {
  name: string;
  slot: number;       // 0-based
  programs: [SetListProgramRef, SetListProgramRef, SetListProgramRef, SetListProgramRef]; // A, B, C, D
}
interface SetListProgramRef {
  bank: number;  // 1-based
  slot: number;  // 0-based
}
```

## Implementation

### 1. Add CC48 and CC49 to MIDI map (`src/nord/nord-electro-5d-map.ts`)

Add two new parameter entries:
- `program_setlist_mode`: CC48, toggle, labels ["Program", "Set List"], section "global"
- `setlist_part_select`: CC49, discrete, max=3, labels ["A", "B", "C", "D"], section "global"

### 2. Add set list state to mock device (`src/mock-device.ts`)

New state variables:
- `setListMode: boolean` — toggled by CC48
- `currentSetList: number` — 0-indexed, set by Bank Select (CC32) when in set list mode
- `currentSong: number` — 0-indexed, set by Program Change when in set list mode
- `currentPart: number` — 0-3 (A/B/C/D), set by CC49, reset to 0 on song change

### 3. Update CC handler for CC48 (`src/mock-device.ts`)

When CC48 arrives:
- Value 0 → `setListMode = false` (Program mode)
- Value 127 → `setListMode = true` (Set List mode)
- Log the mode change

### 4. Update CC handler for CC49 (`src/mock-device.ts`)

When CC49 arrives (only meaningful in set list mode):
- Map discrete value to part index: 0→A(0), 43→B(1), 85→C(2), 127→D(3)
- Store `currentPart`
- Look up the song's program ref for that part: `setList.programs[partIndex]`
- Resolve the referenced program from `_backup.programs`
- Call `applyProgramParams()` with that program's params
- Broadcast updated state with set list info

### 5. Update Bank Select handler (`src/mock-device.ts`)

CC32 (Bank Select LSB) handler:
- If in set list mode: store as `currentSetList` (0-indexed), don't update `currentBank`
- If in program mode: existing behavior (store as `currentBank`)

### 6. Update Program Change handler (`src/mock-device.ts`)

When in set list mode:
- Store as `currentSong` (0-indexed from PC)
- Reset `currentPart = 0` (part A)
- Look up set list → song → part A's program ref
- Resolve program and call `applyProgramParams()`
- Broadcast with set list display info

When in program mode:
- Existing behavior (unchanged)

### 7. Update StateMessage and UI display

Add to StateMessage:
```ts
setList?: {
  mode: boolean;           // true = set list mode
  listNumber: number;      // 1-indexed for display
  listName?: string;       // from backup
  songNumber: number;      // 1-indexed for display
  part: string;            // "A" | "B" | "C" | "D"
  programBank: number;     // resolved program bank (1-indexed)
  programSlot: number;     // resolved program slot (1-indexed)
  programName?: string;    // resolved program name
};
```

Update `src/web/app.js` and `src/web/index.html`:
- Add a new **set list indicator** element (fixed width/height, two lines of text):
  - Line 1: `SET LIST #1` (set list bank number)
  - Line 2: `#1 song-name` (song number + name within that set list)
- Show this indicator when in set list mode, hide when in program mode
- The existing program display continues to show the resolved program (bank:slot — name)
- Part indicator (A/B/C/D) shown separately or as part of the set list display

### 8. Mirror all changes in Electron (`src/electron/main.ts`)

All state variables, CC handlers, PC handler changes, and StateMessage updates must be duplicated in the Electron main process.

## Helper: Resolve Set List Song to Program

Set list songs are organized like programs: 5 banks × 50 songs. Each song has 4 parts (A/B/C/D), each referencing a stored program. The backup stores these as `SetListEntry` objects (only non-empty entries are stored).

```ts
function resolveSetListSong(bank: number, song: number, partIdx: number): { prog, entry } {
  // bank is 1-indexed, song is 0-indexed (same convention as programs)
  const entry = _backup?.setLists.find(s => s.bank === bank && s.slot === song);
  if (!entry) return { prog: undefined, entry: undefined };
  const ref = entry.programs[partIdx];  // [A, B, C, D]
  if (!ref) return { prog: undefined, entry };
  const prog = _backup?.programs.find(p => p.bank === ref.bank && p.slot === ref.slot);
  return { prog, entry };
}
```

Note: The backup parser currently doesn't store a `bank` field on SetListEntry. The CBIN header has `bankIndex` (used by programs) but it's ignored for set lists. **Fix**: add `bank: hdr.bankIndex + 1` to `SetListEntry` in `backup-parser.ts` (line 517), and add `bank: number` to the interface (line 102).

## Files to Modify

- `src/nord/backup-parser.ts` — Add `bank` field to `SetListEntry` interface + parsing (from CBIN header `bankIndex`)
- `src/nord/nord-electro-5d-map.ts` — Add CC48, CC49 parameter definitions
- `src/mock-device.ts` — Set list state, CC48/CC49 handlers, updated Bank Select + PC handlers, updated StateMessage
- `src/electron/main.ts` — Mirror all mock-device changes
- `src/web/app.js` — Update program display for set list mode

## Files NOT Modified

- `src/agent.ts` — untouched
- `src/nord/backup-cache.ts` — set list data already available via getBackupData()

## Verification

1. Start mock device (Electron or plain)
2. Connect MCP server
3. Send CC48=127 → mock enters set list mode (logged + displayed)
4. Send Bank Select CC32=0, then Program Change 0 → loads set list song 1, part A
5. Send CC49=43 → switches to part B, loads that part's referenced program
6. Send CC49=85 → switches to part C
7. Send Program Change 1 → loads song 2, auto-resets to part A
8. Send CC48=0 → back to program mode, Bank Select + PC work as before
9. Verify UI shows correct set list/song/part info in program display
