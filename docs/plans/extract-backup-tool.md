# Nord Electro 5D Backup Extraction Tool

## Context

The user owns a Nord Electro 5D and has a backup file (`.ne5b`) created by Nord Sound Manager. The format is proprietary. We reverse-engineered its structure and built an MCP tool (`extract_backup`) that reads the backup and generates a markdown inventory of everything stored on the keyboard — programs with decoded parameter settings, piano models, samples, set lists, and live presets.

## Backup File Structure

The `.ne5b` file is a **standard ZIP archive** (`PK` header). ~396 files, ~1.2GB:

```
meta.xml                              — XML: product version, build, manager version
Settings/Settings/Settings.ne5s       — 78 bytes, CBIN: device settings
Program/Bank {1-5}/*.ne5p             — 201 files, 165 bytes each, CBIN: program presets
Piano/{category}/*.npno               — 27 files (5-190MB), CBIN+CNSP: piano models
Samp Lib/Samp Lib/*.nsmp             — 153 files (40KB-5MB), CBIN+NWS: samples
Live/Live/Live {1-3}.ne5l             — 3 files, 165 bytes each, CBIN: live presets
Set List/Set List 1/*.ne5t            — 10 files, 62 bytes each, CBIN: set list entries
```

### CBIN Header (28 bytes, common to all binary files)

| Offset | Size | Field |
|--------|------|-------|
| 0x00 | 4 | Magic: `CBIN` |
| 0x04 | 4 | Version (LE uint32, always 1) |
| 0x08 | 4 | Type tag: `ne5p`/`ne5l`/`ne5s`/`ne5t`/`npno`/`nsmp` |
| 0x0C | 1 | Bank index (0-4 for programs/live) |
| 0x0E | 1 | Slot index within bank (0-49) |
| 0x14 | 4 | Type discriminator: 4=program/live, 0=settings/setlist, 0x200=sample, 0x500=piano |
| 0x18 | 4 | CRC/hash |

### Piano files (.npno) — CNSP sub-structure

- `CNSP` marker at offset 0x2C from file start
- Name at CNSP+0x18: `"Model Name#Variant    Size"` format (padded, `#` separator)
- Control characters (0x01-0x1F) must be stripped from the name field
- Category encoded at CNSP+0x14 (4 bytes)

### Sample files (.nsmp) — NWS container

- `NWS` marker at offset 0x2C with `hdr`/`cat`/`map` chunks
- Name: 64-byte null-terminated string at absolute offset 0x4A
- Variant/source info: null-terminated string at offset 0x8C (e.g. "BR ste", "Korg01 mono")
- Category byte at `cat` chunk offset +9

## Program Payload Bit Map (NE5P)

The 137-byte payload after the CBIN header contains **bit-packed** parameter data. Parameters are NOT byte-aligned — they sit at arbitrary bit boundaries. Bit numbering is MSB-first (bit 0 of each byte = bit 7 in hardware terms).

The payload has 1096 total bits: 568 always-zero, 5 always-one, 523 variable across the 201 programs.

### Confirmed Fields (hardware-verified)

Ground truth programs used for verification:
- **Grand Strings** (Bank 1 Slot 0): Piano Grand M4, EQ on, Rev Stage, no other fx
- **Whiter Shade** (Bank 1 Slot 1): Organ B3, split C4, Amp Rotary, Rev Stage Soft
- **Jazzy Click B** (Bank 1 Slot 6): Organ B3+Bass, split F3, Amp Rotary, Rev Stage Soft
- **aWoovyJump FS** (Bank 1 Slot 20): EP1 M9 + Sample Synth, all effects on
- Engine select fields verified against 15 programs
- Part enable fields verified against 13 programs
- Pipe drawbar positions verified against 5 programs

| Parameter | Abs Bit | Byte.Bit | Width | Encoding | Status |
|-----------|---------|----------|-------|----------|--------|
| **lower_engine** | 145 | 18.1 | 2 | 0=Organ, 1=Piano, 2=Sample | Confirmed (15 programs) |
| *(gap)* | 147 | 18.7 | 1 | Unknown | |
| **upper_engine** | 148 | 18.4 | 2 | 0=Organ, 1=Piano, 2=Sample | Confirmed (15 programs) |
| **split_mode** | 163 | 20.3 | 1 | 0=off, 1=on | Confirmed |
| **split_point** | 164 | 20.4 | 3 | 0=C3, 1=F3, 2=C4, 3=F4, 4=C5, 5=F5 | Confirmed |
| **master_gain** | 179 | 22.3 | 7 | 0-127 (display scale /12.7) | Confirmed (before/after diff) |
| **organ_model** | 186 | 23.2 | 3 | 0=B3, 1=B3+Bass, 2=Pipe, 3=Vox, 4=Farfisa | Confirmed |
| **lower_enable** | 189 | 23.5 | 1 | 0=off, 1=on | Confirmed (13 programs) |
| **upper_enable** | 190 | 23.6 | 1 | 0=off, 1=on | Confirmed (13 programs) |
| **piano_type** | 240 | 30.0 | 3 | 0=Grand, 1=Upright, 2=EP1, 3=EP2, 4=Clav, 5=Harpsi | Confirmed |
| **piano_model** | 246 | 30.6 | 4 | 0-indexed model number (display = value+1) | Confirmed |
| **sample_attack** | 336 | 42.0 | 7 | 0-127 (display scale /12.7) | Confirmed (before/after diff) |
| **sample_dec_rel** | 343 | 42.7 | 7 | 0-127 (display scale /12.7) | Confirmed (before/after diff) |
| **sample_slot** | 350 | 43.6 | 8 | CBIN sample slot (0-152) | Confirmed (10 test programs) |
| **B3 pst1** | 456 | 57.0 | 36 | 9 × 4-bit values (0-8) | Confirmed for B3 |
| **B3 organ_preset_sel** | 492 | 61.4 | 1 | 0=Preset 1, 1=Preset 2 | Confirmed (B3) |
| **B3 drawbar_live** | 493 | 61.5 | 1 | 0=off, 1=on | Confirmed (B3) |
| **B3 vibrato_type** | 494 | 61.6 | 3 | 0=V1, 1=C1, 2=V2, 3=C2, 4=V3, 5=C3 | Confirmed (B3) |
| **B3 vibrato_enable** | 497 | 62.1 | 1 | 0=off, 1=on | Confirmed (B3) |
| **B3 pst2** | 512 | 64.0 | 36 | 9 × 4-bit values (0-8) | Confirmed (B3 + B3+Bass) |
| **Pipe pst1** | 856 | 107.0 | 36 | 9 × 4-bit values (0-8) | Confirmed (5 programs) |
| **Pipe pst2** | 904 | 113.0 | 36 | 9 × 4-bit values (0-8) | Confirmed (5 programs) |
| **fx1_type** | 952 | 119.0 | 3 | 0-7: Trem1-3, Pan1-3, Wah, Ring Mod | Confirmed |
| **fx1_enable** | 955 | 119.3 | 1 | 0=off, 1=on | Confirmed |
| **fx1_rate** | 957 | 119.5 | 7 | 0-127 (display scale varies by type) | Confirmed (before/after diff) |
| **fx2_enable** | 965 | 120.5 | 1 | 0=off, 1=on | Confirmed |
| **fx2_deep** | 966 | 120.6 | 1 | 0=off, 1=on | Confirmed |
| **fx2_type** | 968 | 121.0 | 3 | 0-5: Phase1-2, Flanger, Chorus1-2, Vibe | Confirmed |
| **fx2_rate** | 971 | 121.3 | 7 | 0-127 | Confirmed (before/after diff) |
| **delay_enable** | 979 | 122.3 | 1 | 0=off, 1=on | Confirmed |
| **delay_tempo** | 980 | 122.4 | 7 | 0-127 | Confirmed |
| **delay_pingpong** | 988 | 123.4 | 1 | 0=off, 1=on | Confirmed |
| **delay_dry_wet** | 989 | 123.5 | 7 | 0-127 (display 0.0-10.0) | Confirmed (before/after diff) |
| **eq_enable** | 997 | 124.5 | 1 | 0=off, 1=on | Confirmed |
| **eq_mid_freq** | 999 | 124.7 | 7 | 0-127 (200-8000 Hz, log scale) | Confirmed (before/after diff) |
| **eq_treble** | 1006 | 125.6 | 7 | 0-127, center=64 (-15 to +15 dB) | Confirmed (before/after diff) |
| **eq_mid** | 1013 | 126.5 | 7 | 0-127, center=64 (-15 to +15 dB) | Confirmed (before/after diff) |
| **eq_bass** | 1020 | 127.4 | 7 | 0-127, center=64 (-15 to +15 dB) | Confirmed (before/after diff) |
| **amp_enable** | 1027 | 128.3 | 1 | 0=off, 1=on | Confirmed |
| **(unknown)** | 1028 | 128.4 | 1 | Possibly rotary speed or part select | Unconfirmed |
| **amp_type** | 1029 | 128.5 | 3 | 0=Dist, 1=Small, 2=JC, 3=Twin, 4=Rotary, 5=Comp | Confirmed |
| **amp_drive** | 1032 | 129.0 | 7 | 0-127 (display 0.0-10.0) | Confirmed (before/after diff) |
| **rev_enable** | 1039 | 129.7 | 1 | 0=off, 1=on | Confirmed |
| **rev_type** | 1040 | 130.0 | 3 | 0=Room, 1=Stage Soft, 2=Stage, 3=Hall Soft, 4=Hall | Confirmed |
| **rev_dry_wet** | 1043 | 130.3 | 7 | 0-127 (display 0.0-10.0) | Confirmed (before/after diff) |

### Per-Organ-Model Drawbar Positions

Each organ model stores its drawbar data at **different bit positions** in the payload:

| Model | PST1 Start | PST2 Start | Gap (bits) | Encoding | Status |
|-------|-----------|-----------|------------|----------|--------|
| B3 | 456 | 512 | 20 (organ controls) | 9 × 4-bit (0-8) | Confirmed |
| B3+Bass | 494 | 512 | 10 | PST1: 2 × 4-bit (0-8), PST2: 9 × 4-bit (0-8) | Confirmed |
| Pipe | 856 | 904 | 12 | 9 × 4-bit (0-8) | Confirmed |
| Vox | ? | ? | ? | 9 × 4-bit (0-8) | Not mapped |
| Farfisa | ? | ? | ? | 9 × 1-bit switches | Not mapped |

### B3+Bass Organ Model Notes

B3+Bass has a split keyboard with a bass section (left hand) and a main organ section (right hand). The bass section only has **2 drawbars** (16' and 8'). This affects the drawbar encoding:

- **PST1** (bass drawbars): Position 456 is correct for the first drawbar (4 bits), but the second bass drawbar appears at bit 459 (not 460). The remaining 7 "drawbar" slots contain arbitrary data since B3+Bass only has 2 bass drawbars. **Partially decoded — needs more HW verification.**
- **PST2** (main drawbars): Position 512, standard 9 × 4-bit encoding. **Confirmed working for B3+Bass.**
- **Vibrato/percussion controls** (bits 492-497): Decode incorrectly for B3+Bass. The organ control region likely has a different layout per organ model. **Not reliable for B3+Bass.**

### Not Yet Mapped

These parameters exist in the MIDI CC map but their bit positions have not been confirmed:

- **Percussion**: enable, speed/level, harmonic (B3 only — likely in B3 gap bits 498-511)
- **Delay feedback**: 2 bits, location uncertain (near delay section, bits 987-996)
- **Part select fields**: for FX1, FX2, Amp, Delay, EQ (which part each effect applies to)
- **Octave shifts**: lower, upper
- **Part mix**: balance between lower/upper
- **Piano acoustics**: string resonance, long release
- **Piano mono**: on/off
- **Piano KBD touch**: sensitivity setting
- **Sample synth**: sample select, attack, release, dynamics, filter velocity
- **Master volume/gain**
- **Rotary speed**: slow/fast (possibly bit 1028)
- **Rotary stop mode**: on/off
- **Vox drawbar positions**: not mapped
- **Farfisa switch positions**: not mapped (tried 1/2/4-bit encodings, no consistent match found)
- **Organ controls per model**: vibrato/percussion fields differ by organ model

### Constant Regions (always zero across all 201 programs)

These byte ranges in the payload are always zero — reserved/padding:
- Bytes 0-17 (0x1C-0x2D in file): 18 bytes of zeros + version byte (0x04)
- Bytes 24-29 (between organ model and piano type): 6 bytes
- Bytes 37-41 (between piano and drawbar regions): 5 bytes
- Various single-byte gaps throughout

## Implementation

### Files Created/Modified

1. **`src/nord/backup-parser.ts`** — Pure parsing module. Contains:
   - `parseBackup(filePath)`: reads ZIP, parses all entry types
   - `decodeProgramPayload(payload)`: bit-level extraction of confirmed fields
   - `formatBackupAsMarkdown(data, date?)`: generates inventory markdown
   - Helper functions: `readBits()`, `rb()`, CBIN/CNSP/NWS parsers

2. **`src/tools/extract-backup.ts`** — MCP tool registration. Default output writes to Claude project memory folder (`~/.claude/projects/.../memory/nord_backup_inventory.md`) so the inventory is auto-loaded as context in future conversations.

3. **`src/index.ts`** — Added import and registration

4. **`package.json`** — Added `adm-zip` + `@types/adm-zip` dependencies

### Methodology for Future Decoding

The approach used to discover bit positions (from the Chris55/ns3-program-viewer project):

1. **Create test programs** on the hardware with specific known parameter values
2. **Export backup** via Nord Sound Manager
3. **Diff the binary** against a reference program using bit-level comparison
4. **Statistical search**: for each candidate bit position and width, check correlation with expected values across multiple programs
5. **Cross-validate** with at least 2-3 programs before confirming a field

Key insight: the Nord uses **direct bit-packing** (NOT MIDI 7-bit SysEx encoding). Parameters sit at arbitrary bit boundaries with MSB-first ordering.

## Verification

1. `npm run build` — compiles cleanly
2. MCP tool: `extract_backup` with `file_path` pointing to the backup
3. Verified output: 27 pianos, 153 samples, 201 programs (5 banks), 10 set lists, 3 live presets
4. Hardware-verified programs:
   - Grand Strings: Piano Grand M4, EQ on, Rev Stage dw=39(≈3.1) ✓
   - Whiter Shade: B3 [004430000], Split C4, Amp Rotary drv=21(≈1.7), Rev Stage Soft dw=64(≈5.0) ✓
   - Jazzy Click B: B3+Bass, Split F3, Amp Rotary drv=3(≈0.2), Rev Stage Soft dw=29(≈2.3) ✓
