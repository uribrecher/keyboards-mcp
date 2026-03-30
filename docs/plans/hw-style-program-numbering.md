# Plan: Use hardware-style 1-indexed program numbering

## Context

The Nord hardware displays programs as `bank:number` where number is 1-50. The codebase uses 0-indexed slots (0-49) in both the `load_program` tool API and the backup inventory markdown. This causes confusion — the agent says "Bank 2, Slot 9" but the hardware shows "2:10". We need all user-facing representations to match the hardware.

Internal data structures stay 0-indexed; only external-facing parts change.

## Changes

### 1. `src/tools/load-program.ts`

- **Schema**: slot `min(0).max(49)` → `min(1).max(50)`, description → `"Program number within bank (1-50)"`
- **Tool description**: `"Bank 1-5, slot 0-49."` → `"Bank 1-5, program 1-50 (matching hardware display)."`
- **MIDI send** (line 32): `midi.sendProgramChange(slot)` → `midi.sendProgramChange(slot - 1)` (convert back to 0-indexed for MIDI)
- **Response** (line 38): `Loaded program: Bank ${bank}, Slot ${slot}` → `Loaded program ${bank}:${slot}`

### 2. `src/nord/backup-parser.ts`

- **Program table slot column** (line 608): `${p.slot}` → `${p.slot + 1}` so slots display 1-50
- **Set list fallback** (line 620): `B${ref.bank}:${ref.slot}` → `B${ref.bank}:${ref.slot + 1}` (the map key and lookup stay 0-indexed internally — only the fallback display string changes)
- **Table header** (line 569): "Slot" → "Prog" (optional, to align with "program number" terminology)

### 3. Regenerate inventory

After the parser change, re-run backup extraction to regenerate `data/nord_backup_inventory.md` with 1-indexed slots.

## Verification

1. `npm run build` — no errors
2. Connect to Nord and test `load_program` with bank 1, slot 10 → hardware should show 1:10
3. Run `extract_backup` on the existing backup → verify markdown shows slots 1-50
4. Check set list references in the generated markdown are 1-indexed
