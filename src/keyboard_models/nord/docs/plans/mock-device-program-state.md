# Plan: Mock Device Program Change State Loading

## Context

When a Program Change arrives, the mock device updates the program display but all parameter knobs/drawbars/LEDs stay unchanged. The real hardware loads all parameters from memory. The backup cache already contains decoded `ProgramParams` for every program — we just need to map them to CC values and write into the mock device's internal state.

## Implementation

### 1. New function in `src/nord/backup-parser.ts`

Add `programParamsToCCs(params: ProgramParams): Array<{cc: number, value: number, channel: number}>` that maps each ProgramParams field to CC number + MIDI value, using NORD_ELECTRO_5D_PARAMS for CC lookups and resolveValue() for discrete→MIDI conversion.

### 2. Update `src/mock-device.ts` program change handler

In the `program` event handler (~line 400):
1. Look up the program's `params` from `_backup.programs` (already done for name)
2. Call `programParamsToCCs(params)` to get CC values
3. Reset `channelState` to defaults via `initChannel()`
4. Write all CC values into `channelState` and `presetDrawbarState`
5. Broadcast the updated state (already happening)

### Key Mappings

| ProgramParams field | MIDI map key | Notes |
|---|---|---|
| `organModel` ("B3") | `organ_model` CC9 | String → discrete index → MIDI |
| `pianoType` ("EP1") | `piano_type` CC12 | String → discrete index → MIDI |
| `pianoModel` (1-based) | `piano_model` CC13 | Index → model MIDI value |
| `clavVariation` ("A") | `piano_variation` CC14 | Letter → index → MIDI |
| `pst1Drawbars` ("888000000") | `drawbar_1`-`drawbar_9` | Position 0-8 → MIDI 0-127 |
| `pst2Drawbars` | same CCs, preset2 state | Same mapping |
| `fx1.enable/type/rate` | `effect1_*` | Boolean/string/number |
| `fx2.enable/type/rate/deep` | `effect2_*` | Boolean/string/number |
| `delay.*` | `delay_*` | Enable/tempo/pingPong/dryWet |
| `eq.*` | `eq_*` | Enable/treble/mid/midFreq/bass |
| `amp.*` | `spkr_comp_*` | Enable/type/drive |
| `reverb.*` | `reverb_*` | Enable/type/dryWet |
| `masterGain` | `master_volume` CC7 | Direct 0-127 |
| `splitMode/splitPoint` | `kb_split_mode/point` | Boolean/string |
| `lowerEnable/upperEnable` | `part_lower/upper_enable` | Boolean |
| `lowerEngine/upperEngine` | `part_lower/upper_engine_select` | String → discrete |
| `vibratoType/Enable` | `vibrato_type/enable` | String/boolean |
| `percussion*` | `percussion*` | Enable/harmonic/speed+level |

### Verification
1. `npm run build`
2. Start mock device + agent
3. Load a program via chat
4. Verify the mock UI updates all controls to match the program
