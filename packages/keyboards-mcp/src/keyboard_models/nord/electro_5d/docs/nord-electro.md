# Nord Electro 5D — model architecture

Reference for the Nord Electro 5D-specific code under `src/keyboard_models/nord/electro_5d/`. Covers the bi-timbral part model, organ-preset routing, drawbar handling, and the backup-cache integration that drive program/set-list loads. Sister doc to `roland/juno_x/docs/juno_x.md`.

## At a glance

- **Bi-timbral**: 2 parts (Lower / Upper), each independently assignable to one of 3 sound engines.
- **Per-part engine selectors**: `part_lower_engine_select` and `part_upper_engine_select` map to `organ | piano | sample_synth`.
- **Engine-namespaced param keys**: unlike JUNO-X, Nord param keys are already engine-prefixed (`organ_model`, `piano_model`, `sample_synth_sample`). No CC ambiguity across engines, so no per-engine sub-namespaces in handler state.
- **Two organ presets**: each holds an independent drawbar registration plus per-preset vibrato/percussion toggles. `organ_preset_select` flips the active preset; subsequent drawbar/vibrato/percussion writes route to that preset's storage.
- **One-way MIDI**: CC out only. No DT1/RQ1 protocol. `get_current_state` returns a "not supported" tool result — the agent owns its memory of what it sent.
- **Backup-driven program loading**: programs come from a `.nrd` backup file parsed at boot; PC messages trigger `applyProgramParams()` against the cached program data.

## File layout

```
nord/electro_5d/
├── docs/nord-electro.md      ← this file
├── index.ts                  ← KeyboardModel export, factory wiring, system prompt
├── device.ts                 ← MCP-side NordElectro5DDevice (one-way; getState reports "not supported")
├── midi-codec.ts             ← thin wrapper around shared createCcCodec
├── midi-map.ts               ← createParameterMap (~270 params, perPart-tagged)
├── mock-handler.ts           ← pure param-domain handler (state owner)
├── backup-parser.ts          ← .nrd binary format parser
├── backup-cache.ts           ← lazy disk-backed cache of parsed backups
├── diff-programs.ts          ← program comparison helper (used by tools)
└── web/                      ← mock UI (display-only, HTML/CSS/JS loaded by Electron)
```

## Engines and parts

Two parts: **Lower** (part 1) and **Upper** (part 2). Each runs exactly one of three engines at a time.

| Engine        | Section          | Notable params                          |
|---------------|------------------|------------------------------------------|
| `organ`       | `organ`          | `organ_model`, drawbars 1-9, `vibrato_*`, `percussion*`, two presets |
| `piano`       | `piano`          | `piano_type`, `piano_model`, `piano_variation`, `piano_acoustic`     |
| `sample_synth`| `sample_synth`   | `sample_synth_sample`, attack/release, dynamics, filter velocity     |

The active engine on a part is whatever value `part_<lower|upper>_engine_select` currently holds. The handler exposes `get_active_engine(part)` / `set_active_engine(part, engine)` that read/write those params; no separate engine pointer is maintained internally.

### Why no per-engine state separation (vs JUNO-X)

JUNO-X needed `parts[i].engineParams[engine][key]` because many CCs collide across its 4 engines (e.g. CC 3 = `cutoff` in 3 engines). The handler had to keep separate state per engine so switching engines preserved the inactive ones.

Nord doesn't have that problem: organ params start with `organ_*`, piano params with `piano_*`, sample-synth params with `sample_synth_*`. A single `parts[i].params: Record<string, number>` can hold all engines' params at once because their keys are unique.

## Drawbar presets and per-preset toggles

The Nord Electro 5D has TWO organ presets (Preset 1 / Preset 2), each with its own drawbar registration plus its own vibrato/percussion enable flags. `organ_preset_select` (CC 3, user value 0=Preset 1, 1=Preset 2) flips which preset is "active" — drawbar / vibrato / percussion writes route to that preset's storage.

In real HW (split mode), Preset 1 routes to Lower and Preset 2 to Upper. In layer mode, the active preset is just the one being heard.

### Handler routing for drawbars (Option B1 from the refactor plan)

```
set_params([{name: "drawbar_3", value: 8, part: 1}])
        ↓
codec.normalizeUserValue → 8 (drawbar position)
        ↓
parts[0].params["drawbar_3"] = 8        ← per-part snapshot
parts[1].params["drawbar_3"] = 8        ← auto-propagate (see below)
presetDrawbars["preset1"]["drawbar_3"] = 8   ← saved registration for active preset
```

Switching `organ_preset_select` to 1 changes `activePreset`. The next drawbar write lands in `presetDrawbars["preset2"]` instead. Preset 1's drawbars stay intact in `presetDrawbars["preset1"]` and surface in the broadcast state under `preset1Drawbars`.

`vibrato_enable` and `percussion` follow the same pattern: they're stored per-part as regular params AND mirrored into `presetOrganToggles.{pst1Vib|pst2Vib|pst1Prc|pst2Prc}` for the active preset.

The codec stays MIDI-agnostic-of-preset state — it emits a canonical `drawbar_N` event; the handler does the active-preset routing because preset state is HW state owned by the handler.

## State shape

```ts
interface PartState { params: Record<string, number>; }  // user-domain values

let parts: [PartState, PartState];                       // [lower, upper]
let globalParams: Record<string, number>;                // non-perPart params
let presetDrawbars: { preset1: Record<string, number>;   // per-preset drawbar
                      preset2: Record<string, number> };  //   registration
let presetOrganToggles: { pst1Vib, pst1Prc, pst2Vib, pst2Prc };
let activePreset: 1 | 2;                                 // HW state, follows
                                                         // organ_preset_select
let setListMode: boolean;
let currentSetList, currentSong, currentPart: number;
let currentBank, currentProgram: number;
let programLoaded: boolean;
```

All values are USER-DOMAIN: drawbar positions are 0-8, discrete params are label indices, toggles are 0|1, continuous raw params are 0-127. Broadcast state mirrors the same domain — the UI consumes user-domain values throughout.

## Auto-propagate semantics for perPart params

The handler preserves a quirk from the pre-refactor CC dispatch: `set_params` refs with `part: 1` (or no part) write to BOTH parts; refs with `part: 2` write upper only. This matches the historical "lower-channel CC = global, also affects upper" behavior on real HW.

```ts
const part = ref.part ?? 1;
if (part === 2) {
  parts[1].params[name] = userValue;
} else {
  parts[0].params[name] = userValue;
  parts[1].params[name] = userValue;
}
```

External MIDI follows the same rule: codec.decode tags CC events with `part = channel + 1` (0-based channel + 1), so a CC on the lower channel arrives as `part: 1` and propagates to both parts.

## Codec → handler routing for incoming MIDI

Nord uses the shared `createCcCodec` (no model-specific codec logic), so the path is identical to Prophet-6's:

```
   external CC bytes
        ↓
   engine.dispatch (mock-runner)
        ↓
   codec.decode({type:"cc", controller, value, channel})
        ↓
   {kind:"param", name, value, part?}    ← user-domain value
        ↓
   handler.set_params([{name, value, part?}])
```

For Program Change: `engine.dispatch` accumulates bank-select MSB/LSB per channel, and on the PC message synthesizes `handler.load_program(bank, slot)`. The handler resolves the program from the backup cache and runs `applyProgramParams()` against the cached struct.

## Backup-driven program loading

`load_program(bank, slot)` differs significantly from JUNO-X:

1. **Backup cache lookup**: the parsed `.nrd` data is loaded once at `init()` time (or via `onCacheReload()`). `currentBank` + `currentProgram` index into `_backup.programs` to find the cached `ProgramParams` struct.
2. **`applyProgramParams(params)`**:
   - Resets state (clears parts and presets).
   - Walks `PROGRAM_PARAM_MAP` (a list of `[paramKey, getter]` pairs) and writes each value into the right namespace.
   - Bools become 0/1; strings go through `codec.normalizeUserValue` (label lookup); numbers go through the same.
   - `sample_synth_sample` is special-cased — backup hands us a 0-based slot, codec converts to 1-based user value via `wireToUserValue`.
   - Drawbars come as 9-character strings ("8 8000 000"); `applyDrawbars` parses each digit into the corresponding `drawbar_N` user value, writes to BOTH parts plus the matching preset slot.
   - `presetOrganToggles` is replaced wholesale from the program's pst1/pst2 flags.

3. **Set-list mode**: when `setListMode` is true, PC selects a song instead of a program. The handler resolves the song's `parts[currentPart]` reference and applies that program's `params`.

## Active-engine API

```ts
get_active_engine(part: number): "organ" | "piano" | "sample_synth"
set_active_engine(part: number, engine: string): MockHandlerResult
```

These wrap the per-part engine-select param. No separate engine pointer is maintained — the active engine is just whatever `part_<lower|upper>_engine_select` currently reads.

## Broadcast state

`getFullState(includeInventory)` produces:

```
{
  lower:   { [name]: ParamState },     // perPart params, USER-domain values
  upper:   { [name]: ParamState },
  global:  { [name]: ParamState },     // non-perPart params

  preset1Drawbars: { drawbar_1: { value, position, label, ... }, ... },
  preset2Drawbars: { ... },
  presetOrganToggles: { pst1Vib, pst1Prc, pst2Vib, pst2Prc },

  // raw set-list / program state (plan #9 mockrack round-trip)
  setListMode, currentSetList, currentSong, currentPart,
  currentBank, currentProgram, programLoaded,

  // optional, when programLoaded:
  program: { bank, slot, name? },

  // optional, when setListMode:
  setList: { mode, listNumber, songNumber, songName, part, programBank, programSlot, programName },

  // optional, when includeInventory:
  pianoModels: { "0": ["Steinway D", ...], ... },
  sampleNames: ["MellotronStrings", ...],

  // optional, set after a fresh load_program:
  lastProgramChange: { bank, slot, name? },

  // optional, set after a set_params call:
  lastChange: { key, name, value, label, part },
}
```

Each `ParamState` is `{value, label, name, section, type, displayName?, position?, index?, labels?}`. All numeric fields are USER-domain.

### Amp/Rotary edge case

When both engines = `organ` AND `spkr_comp_type` = "Rotary" (label index 4), the broadcast forces `global.spkr_comp_part_select` to display "Both" / index 2, mirroring real-HW behavior where the rotary speaker affects the whole signal regardless of part-select.

## setFullState (plan #9 mockrack)

`setFullState(snapshot)` is a tolerant restore of `getFullState(false)` output. It walks the `lower`/`upper`/`global` sections, the `preset{1|2}Drawbars`, `presetOrganToggles`, and the raw set-list / program fields. Inputs are user-domain (matching what `buildFullState` emits). Missing fields keep current defaults; unknown fields are ignored.

This lets the mock-runner snapshot a full Nord state to disk and re-load it later, e.g. across mock restarts or for plan #9's MockRack file format.

## Known gaps / follow-ups

Tracked in `docs/plans/pending/todo-list.md`:

- **No `get_current_state` support** — Nord MIDI is one-way. The MCP returns a "not supported" tool result; the agent must keep its own notes.
- **UI is display-only** — `web/app.js` renders state but has no slider/button controls feeding back to the handler. All state changes come from external MIDI / MCP.
- **No engine-select propagation in `set_active_engine`** — calling it writes the param-select user value but doesn't re-broadcast a fresh `lastChange` (low priority; the broadcast still reflects the new active engine).
