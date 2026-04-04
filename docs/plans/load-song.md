# Plan: Add `load_song` MCP Tool

## Context
Loading a set list song currently requires manual MIDI sequencing. This tool wraps it into a single call.

## Implementation

### 1. Create `src/tools/load-song.ts`

Follow `load-program.ts` pattern.

**Input schema:**
- `bank` (number, 1-5) — set list number
- `slot` (number, 1-50) — song number within the set list
- `part` (string, optional) — "A", "B", "C", or "D". Defaults to "A".

**MIDI sequence:**
1. CC48 = 1 (enter set list mode)
2. CC0 = 0, CC32 = bank - 1
3. Program Change = slot - 1
4. CC49 = part index (A=0, B=1, C=2, D=3)

**Response:** Include song name + program names from backup cache if available.

### 2. Register in `src/index.ts`

Import + call `registerLoadSong(server, midiManager)`.

## Files
- **New:** `src/tools/load-song.ts`
- **Edit:** `src/index.ts`

## Verification
1. `npm run build`
2. `/mcp` reload
3. Test with bank 4, slot 4 (geshem), part A and part C
