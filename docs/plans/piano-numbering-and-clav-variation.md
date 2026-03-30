# Plan: Fix piano model numbering and decode Clavinet variation

## Context

Two related issues with piano representation in the backup inventory and tools:

1. **Piano models use global sequential numbering (1-27) but hardware uses per-category location (resets per type).** The HTML from Nord Sound Manager shows pianos numbered per-category: Grand 1-5, Upright 1-7, EP1 1-9, etc. Our inventory uses a flat global `#` which doesn't match.

2. **Clavinet variations (A/B/C/D) are not shown anywhere.** The Clavinet D6 has 4 pickup variations. These are NOT in the piano partition (confirmed via hex dump — only one Clavinet entry exists). They're per-program settings via MIDI CC 45 (`piano_variation`). Need to find the corresponding bits in the program payload.

### Key discovery from hex analysis

CBIN header bytes `0x0c` and `0x0e` in `.npno` files contain:
- `hdr[0x0c]` = piano type index (0=Grand, 1=Upright, 2=EP1, 3=EP2, 4=Clav, 5=Harps)
- `hdr[0x0e]` = per-category location (0-indexed)

These match the HTML's Bank/Location columns exactly.

## Changes

### 1. Parse per-category location from piano CBIN header

**File:** `src/nord/backup-parser.ts`

- In the `.npno` parsing section (line ~438-451), read the CBIN header via `readCbinHeader()`
- Extract `hdr.bankIndex` (= type index) and `hdr.slotIndex` (= per-category location, 0-indexed)
- Add `location` field to `PianoEntry` interface (1-indexed, = slotIndex + 1)

### 2. Update piano inventory table to show per-category location

**File:** `src/nord/backup-parser.ts` (`formatBackupAsMarkdown`)

- Change piano table `#` column to show per-category location instead of global sequential number
- Group or sort pianos by category, show location within each category
- Format: category-relative number matching the hardware (e.g., Grand: 1-5, Upright: 1-7)

### 3. Decode Clavinet variation from program payload

**File:** `src/nord/backup-parser.ts` (`decodeProgramPayload`)

- Find the bits in the 137-byte program payload that store Clavinet variation (A/B/C/D)
- This is likely a 2-bit field near the piano type/model bits (around bit 240-250)
- Method: compare program payloads of Clav programs (e.g., "Snappy D6", "Bass And Clav", "Breathy Clav") to find differing bits
- Add to `ProgramParams` interface and include in markdown output (e.g., "Clav M1:A" or "Clav M1 (D6-A)")

### 4. Update program table piano column format

- Currently shows `Grand M4` (global model index within type)
- Verify this already matches per-category location from step 1
- For Clavinet programs, append variation: `Clav M1:A`

## Files to modify

- `src/nord/backup-parser.ts` — PianoEntry interface, piano parsing, program decoding, markdown formatting
- `data/nord_backup_inventory.md` — regenerate after changes

## Verification

1. `npm run build` — no errors
2. Run `extract_backup` — verify piano table shows per-category locations matching the HTML
3. Verify Clavinet programs show variation (A/B/C/D) in the program table
4. Cross-reference inventory with Nord Sound Manager HTML export
