# Plan: Eliminate hardcoded name duplication — inventory as single source of truth

## Context

Piano model names, sample names, and other instrument names are hardcoded in multiple source files. When the user loads different pianos/samples on the keyboard, these hardcoded names become stale and wrong. The backup inventory (generated from the actual hardware backup) should be the single source of truth. If no inventory exists, the system should fall back to numeric indices and suggest the user generate one.

## Duplication Map

### Piano model names (worst offender)
All 27 model names appear in:
1. **`src/nord/nord-electro-5d-map.ts:293-300`** — `piano_model` description string lists every model by name
2. **`src/web/app.js:50-55`** — `PIANO_MODELS` array with all model names per category
3. **`src/agent.ts:52-53`** — system prompt mentions "Italian Grand is 1:10"

### Piano variation names
- **`src/nord/nord-electro-5d-map.ts:312-313`** — Clavinet D6 A/B/C/D in description
- **`src/web/app.js:54`** — Clavinet variations

### Other label arrays (organ models, FX types, etc.)
These are **hardware constants** (same regardless of loaded content) and should NOT be changed:
- Organ models (B3, Vox, Farfisa, Pipe) — fixed hardware
- FX types, amp types, reverb types — fixed hardware
- Piano types (Grand, Upright, EP1, etc.) — fixed hardware categories

### What IS user-dependent (changes with loaded content)
- Piano model names within each category (depends on what pianos are loaded)
- Sample names and their slot assignments
- Program names and their bank:slot assignments

## Approach

### Step 1: Cache parsed BackupMetadata in MCP server

**File:** `src/index.ts`

- Add a module-level `backupData: BackupMetadata | null` cache
- When `extract_backup` is called, store the parsed result in the cache
- Add a helper `getBackupData()` that returns the cache (or null)

### Step 2: Make piano_model description dynamic

**File:** `src/nord/nord-electro-5d-map.ts`

- Remove the hardcoded model name list from `piano_model` description
- Change description to: `"Piano model index (1-based, per-category). Use the backup inventory to find available models for each type."`
- Similarly update `piano_variation` description to remove "Clavinet D6 A/B/C/D" names (keep the A/B/C/D letters since those are hardware constants)

### Step 3: Add inventory-aware model name resolution

**File:** `src/tools/set-parameters.ts` or a new helper

- When displaying `formatDisplay()` results for piano_model, look up the name from cached BackupMetadata if available
- If no inventory: show `"Grand:3"` (numeric only)
- If inventory loaded: show `"Grand:3 (Studio Grand 2)"`

### Step 4: Update list_parameters to show dynamic model info

**File:** `src/tools/list-parameters.ts`

- When listing the piano section, if BackupMetadata is cached, dynamically append available model names from the inventory
- If no inventory: show generic description with recommendation to run extract_backup

### Step 5: Update web app piano models

**File:** `src/web/app.js`

- Remove hardcoded PIANO_MODELS array
- Either: fetch from MCP server, or show numeric indices with a note to load inventory

### Step 6: Update agent system prompt

**File:** `src/agent.ts`

- Remove the hardcoded example "Italian Grand is 1:10"
- Add: "Consult the NORD BACKUP INVENTORY section for model names. If no inventory is loaded, use numeric references (e.g., Grand:1) and suggest the user run extract_backup."
- The inventory markdown already provides all names — no need to duplicate in the prompt

## Files to modify

- `src/index.ts` — add BackupMetadata cache
- `src/tools/extract-backup.ts` — store parsed data in cache after extraction
- `src/nord/nord-electro-5d-map.ts` — remove hardcoded model names from descriptions
- `src/tools/list-parameters.ts` — dynamic model info from cache
- `src/tools/set-parameters.ts` — name resolution from cache in display
- `src/web/app.js` — remove hardcoded PIANO_MODELS
- `src/agent.ts` — remove hardcoded name example

## Out of scope (hardware constants, not user-dependent)

- Organ model names (B3, Vox, etc.) — hardware constant
- Piano type names (Grand, Upright, etc.) — hardware constant categories
- FX/amp/reverb type names — hardware constant
- Clavinet variation letters (A/B/C/D) — hardware constant
- Preset definitions in presets.ts (use numeric piano_model=0, not names)
- Program names — these are already only in the inventory, not hardcoded elsewhere
- Synth sample names — already only in the inventory

## Verification

1. `npm run build` — no errors
2. Without inventory: `list_parameters` shows piano section with generic description and recommendation
3. After `extract_backup`: `list_parameters` shows model names from inventory
4. `set_parameters` with piano_model displays resolved name when inventory is cached
5. Web app shows numeric indices or loaded names appropriately
