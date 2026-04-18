# Roland JUNO-X Keyboard Model -- Design Spec

**Date**: 2026-04-18  
**Status**: Draft  
**Goal**: Implement a full JUNO-X keyboard model with all 4 synth engines, SysEx DT1/RQ1 parameter control, 5-part multi-timbral support, mock handler, and hardware-faithful panel UI.

This is the second Roland-protocol model in the project (after Nord Electro 5D and Sequential Prophet-6, both CC-based). It validates the architecture's ability to handle SysEx-based keyboards and engine-switching multi-timbral instruments.

---

## 1. Shared Roland DT1/RQ1 Transport

**File**: `src/shared/roland-dt1.ts`

A protocol-level module for building and parsing Roland DT1 (Data Set 1) and RQ1 (Data Request 1) messages. These are Roland's proprietary parameter read/write protocol built on top of MIDI SysEx.

### Types

```typescript
interface RolandModelId {
  bytes: number[];  // JUNO-X: [0x00, 0x00, 0x00, 0x00, 0x12]
}

interface DT1Message {
  address: number[];  // 4 bytes
  data: number[];     // 1+ bytes
}
```

### Functions

- **`buildDT1(modelId, deviceId, address, data): number[]`** -- Build complete SysEx bytes for a DT1 (write) message. Includes `F0 41 <dev> <modelId> 12 <addr> <data> <checksum> F7`.
- **`buildRQ1(modelId, deviceId, address, size): number[]`** -- Build complete SysEx bytes for an RQ1 (read request) message. Uses command byte `11`.
- **`parseDT1(sysex, modelId): DT1Message | null`** -- Parse incoming SysEx bytes. Returns address + data if valid DT1 for the given model, null otherwise.
- **`rolandChecksum(bytes): number`** -- Calculate: `(128 - (sum of bytes) % 128) % 128`. Input is address bytes + data bytes.
- **`packNibbles(value, byteCount): number[]`** -- Split a value into 4-bit nibbles for multi-byte parameters. E.g., `0xAB` with byteCount=2 becomes `[0x0A, 0x0B]`.
- **`unpackNibbles(bytes): number`** -- Reverse of packNibbles.

### Design Notes

- Reusable across all Roland DT1/RQ1 keyboards (JUPITER-X, FANTOM, etc.) -- only the model ID changes.
- The device builds DT1 bytes, then calls the existing `MidiConnection.sendSysEx()`.
- The mock handler uses `parseDT1()` to decode incoming SysEx in `onMIDI({ type: "sysex", bytes })`.
- No changes to the `MidiConnection` interface needed.

---

## 2. ParamEncoding Extension

**File**: `src/shared/types.ts`

Add a new encoding kind for DT1-addressed parameters:

```typescript
{ kind: "dt1", address: [a, b, c, d], size: number }
```

- `address`: 4-byte offset relative to the engine's base address in the SysEx address map.
- `size`: Number of data bytes. 1 for standard 7-bit values (0-127). 2+ for nibble-packed values (e.g., 0-1023 uses 4 nibble bytes).

### Resolution Logic

In `parameter-resolution.ts`, add handling for `dt1` encoding:
- For `size === 1`: value is used directly (0-127 range).
- For `size > 1`: value is nibble-packed via `packNibbles()`.

The device computes the **full SysEx address** by adding the engine's base address to the parameter's offset address. For example:
- Analog Synth Model Part 01 base: `02 10 00 00`
- Cutoff parameter offset: `00 00 00 15` (from the SysEx address map)
- Full address: `02 10 00 15`

---

## 3. JUNO-X Model File Structure

```
src/keyboard_models/roland/juno_x/
├── index.ts                  # KeyboardModel: metadata, createDevice(), createMockHandler()
├── device.ts                 # JunoXDevice extends BaseKeyboardDevice
├── engines/
│   ├── engine-types.ts       # Engine enum, base addresses, shared types
│   ├── analog-synth.ts       # JUNO-106/JUNO-60 emulation parameters
│   ├── zcore.ts              # ZCore (PCM/VA) engine parameters
│   ├── juno-x-model.ts       # JUNO-X native engine parameters
│   └── rd-piano.ts           # RD Piano engine parameters
├── scene-params.ts           # Scene-level: common, part config, effects, zones
├── midi-map.ts               # Aggregates engines + scene into ParameterMap
├── mock-handler.ts           # MockHandler implementation
├── state-manager.ts          # Per-part, per-engine state tracking
└── web/
    ├── index.html            # Mock UI entry point
    ├── juno-x-panel.css      # Panel styling (hardware-faithful layout)
    └── juno-x-panel.js       # UI logic, WebSocket connection
```

### Model Metadata (index.ts)

```typescript
{
  id: "roland-juno-x",
  displayName: "Roland JUNO-X",
  manufacturer: "Roland",
  midiPortPatterns: ["JUNO-X"]
}
```

Capabilities:
- `programLoader`: Scene switching via bank select (MSB=85, LSB=0) + program change (0-127 for scenes 1-128, continued with bank increments for 129-256).
- `createDevice()`: Returns JunoXDevice instance.
- `createMockHandler()`: Returns JunoXMockHandler instance.
- `mockUiDir`: Points to `web/` directory.
- `agentSystemPrompt`: Description of the JUNO-X signal path, 4 engines, 5-part multi-timbral, and sound design guidelines.

---

## 4. Engine Architecture

### 4.1 Engine Types (`engines/engine-types.ts`)

```typescript
enum JunoXEngine {
  ZCore = "zcore",
  AnalogSynth = "analog-synth",   // JUNO-106 / JUNO-60
  RDPiano = "rd-piano",
  JunoXModel = "juno-x-model"
}

// SysEx base addresses for Temporary Tone per engine per part
const ENGINE_BASE_ADDRESSES: Record<JunoXEngine, number[][]> = {
  [JunoXEngine.ZCore]:       [[0x02, 0x00, 0x00, 0x00], [0x02, 0x01, 0x00, 0x00], ...],  // parts 1-4
  [JunoXEngine.AnalogSynth]: [[0x02, 0x10, 0x00, 0x00], [0x02, 0x11, 0x00, 0x00], ...],
  [JunoXEngine.RDPiano]:     [[0x02, 0x20, 0x00, 0x00]],  // part 1 only
  [JunoXEngine.JunoXModel]:  [[0x02, 0x40, 0x00, 0x00], [0x02, 0x41, 0x00, 0x00], ...],
}
```

### 4.2 Engine Parameter Maps

Each engine module exports a function returning `KeyboardParameter[]` with `dt1` encoding:

**Analog Synth Model** (`engines/analog-synth.ts`):
Based on the JUNO-X MIDI Implementation "SynMdl" address map. Key sections:
- Model Parameter (MDLSYNO): LFO rate/delay/waveform, OSC pitch/detune/waveform/PWM, sub-osc, noise, HPF, filter cutoff/resonance/env depth/key follow, VCA level/env select, ADSR, chorus type
- MFX: Multi-effects parameters
- Tone Common: Name, category, level, pan, portamento, etc.

Parameters include both JUNO-106 and JUNO-60 model variants (different waveform sets, octave ranges).

**ZCore** (`engines/zcore.ts`):
The most complex engine -- 4 partials, each with oscillator, pitch envelope, filter envelope, amp envelope, LFO, EQ. Plus tone common, synth common, synth partials, tone PMT.

Parameters from the "ZCore" address map. Partial parameters are indexed by partial number (1-4) with address offsets.

**JUNO-X Model** (`engines/juno-x-model.ts`):
Similar structure to Analog Synth Model (MDLJUNOX address space). Extended capabilities over the pure 106/60 emulation.

**RD Piano** (`engines/rd-piano.ts`):
Minimal -- tone name, sympathetic resonance parameters (SymReso Switch, Depth, Cabinet Reso). Available for Part 1 only.

### 4.3 Scene Parameters (`scene-params.ts`)

Scene-level parameters accessible regardless of engine:

- **Scene Common**: Scene name, level, tempo, slider assignments, button assignments.
- **Scene Part (x5)**: Part switch, mute, level, pan, coarse/fine tune, octave shift, bend range, mono/poly, legato, portamento, key range, velocity range, MIDI channel, modify offsets (cutoff/resonance/attack/decay/release/vibrato).
- **Scene EQ (x5)**: Per-part 3-band parametric EQ.
- **Scene Zone (x5)**: Keyboard split/layer configuration.
- **Scene Effects**: Delay (type + params), Reverb (type + params), Chorus (type + params), Drive, Arpeggio.
- **Scene MFX (x5)**: Per-part multi-effects.

Base address for Temporary Scene: `01 00 00 00`.

---

## 5. ParameterMap Design (`midi-map.ts`)

The JUNO-X ParameterMap is **engine-aware**. It aggregates:

1. Scene parameters (always available)
2. Active engine parameters (per part, based on current engine selection)

### Sections

Parameters are organized into sections that match the hardware panel:
- `scene-common`, `scene-part`, `scene-eq`, `scene-zone`
- `scene-delay`, `scene-reverb`, `scene-chorus`, `scene-drive`, `scene-arpeggio`
- Engine sections vary per engine type:
  - Analog Synth: `synth-lfo`, `synth-osc`, `synth-filter`, `synth-amp`, `synth-env`, `synth-chorus`
  - ZCore: `tone-common`, `tone-pmt`, `partial-osc`, `partial-filter`, `partial-amp`, `partial-lfo`, `partial-eq`, `synth-common`, `synth-partial`
  - JUNO-X Model: similar to Analog Synth with extensions
  - RD Piano: `rd-tone`, `rd-symreso`

### Dynamic Filtering

`listParameters(section?)` and `findParam(name)` are filtered based on the current engine for the target part. The user only sees parameters relevant to the active engine.

---

## 6. Device Implementation (`device.ts`)

`JunoXDevice extends BaseKeyboardDevice`

### Key Overrides

- **`setParameters(params, part?)`**: 
  1. Resolve part (default: 1)
  2. Look up active engine for that part
  3. Find parameter in engine's map or scene map
  4. For scene params: compute full address = scene base + offset
  5. For engine params: compute full address = engine base[part] + offset
  6. Build DT1 message via `buildDT1()`
  7. Send via `connection.sendSysEx()`
  8. Update state

- **`listParameters(section?)`**: Filter by active engine for the target part. Show engine name in header.

- **`loadProgram(bank, slot)`**: Send bank select MSB (CC0) + LSB (CC32) + Program Change. Scene bank: MSB=85, LSB=0, PC=0-127.

- **`resolvePartForParam(key, part?)`**: Map parts 1-5 to appropriate state buckets.

- **`getSystemPrompt()`**: Return JUNO-X specific prompt describing 4 engines, 5 parts, panel layout.

### State

Per-part state tracking includes:
- Active engine per part
- Parameter values per part per engine
- Scene-level values

---

## 7. Mock Handler (`mock-handler.ts`)

Implements `MockHandler` interface.

### State Model

```typescript
{
  parts: [{
    engine: JunoXEngine,
    engineParams: Record<string, number>,  // current engine's param values
    scenePartParams: Record<string, number>,  // part-level scene params
  }],  // x5
  sceneCommon: Record<string, number>,
  sceneEffects: { delay: {...}, reverb: {...}, chorus: {...}, drive: {...} },
  currentScene: { bank: number, program: number },
}
```

### onMIDI Processing

1. **SysEx (DT1)**: Parse with `parseDT1()`. Route by address prefix:
   - `00 xx`: System params
   - `01 00 xx`: Scene params (common, part, EQ, zone, effects)
   - `02 0x xx`: ZCore tone (part determined by second byte)
   - `02 1x xx`: Analog Synth Model tone
   - `02 20 xx`: RD Piano tone (part 1 only)
   - `02 4x xx`: JUNO-X Model tone
   Update state, return diff.

2. **CC**: Handle performance controls (volume CC7, expression CC11, sustain CC64, mod wheel CC1). Also handle modify offsets (CC71-78, CC91, CC93) as state updates.

3. **Program Change**: Switch current scene. Update state.

4. **Bank Select**: CC0 + CC32, store for next program change.

### getFullState

Returns complete state for WebSocket broadcast to UI, including:
- All 5 parts with their engine types and parameter values
- Scene-level settings
- Current scene number

---

## 8. Mock UI (`web/`)

### Layout

Hardware-faithful recreation of the JUNO-X front panel:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [MODEL: JUNO-106 ▼]  [PART: 1 2 3 4 5]  [SCENE: 001 Factory Init]        │
├──────────────────────────────────────────────────────────────────────────────┤
│ I-ARPEGGIO │   LFO    │     OSC      │ HPF │   FILTER   │  AMP  │   ENV    │
│            │          │              │     │            │       │          │
│ [controls] │ Rate     │ Range  16/8/4│ Freq│ Cutoff     │ Level │ A  D S R │
│            │ Delay    │ PW / PWM     │     │ Resonance  │ Env   │          │
│            │ Waveform │ Sub / Noise  │     │ Env Depth  │       │          │
│            │          │ Saw Switch   │     │ Key Follow │       │          │
├──────────────────────────────────────────────────────────────────────────────┤
│ CHORUS: I / II / I+II │  EFFECTS: [Delay] [Reverb] [Drive]  │  SCENE LEVEL │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Behavior

- **Part selector**: Clicking part 1-5 switches the displayed engine panel.
- **Engine selector**: Dropdown or buttons for ZCore / Analog Synth / RD Piano / JUNO-X Model. Changes which panel sections are shown.
- **Knobs**: Rotary controls for continuous params. Click-drag or scroll to change.
- **Sliders**: ADSR faders.
- **Toggles/Buttons**: Discrete switches (PW/Saw, Chorus I/II).
- **Real-time sync**: WebSocket receives state updates from mock handler, UI reflects changes. User changes in UI send MIDI back through the mock engine.

### Engine-Specific Panels

- **Analog Synth (106/60)**: Classic JUNO panel -- LFO, DCO (with Sub Osc, Noise), HPF, VCF, VCA, ENV, Chorus. Model selector (JUNO-106 / JUNO-60) changes available waveforms.
- **ZCore**: More complex -- partial selector (1-4), per-partial OSC/Filter/Amp/LFO/EQ, plus synth common. Tabbed or scrollable.
- **JUNO-X Model**: Similar to Analog Synth but with extended controls.
- **RD Piano**: Minimal -- just sympathetic resonance controls.

---

## 9. Tone Bank Organization

The JUNO-X organizes tones by bank:

| MSB | LSB | Group | Count |
|-----|-----|-------|-------|
| 097 | 066 | JUNO-106 | 122 tones |
| 097 | 074-075 | JUNO-60 | 137 tones |
| 097 | 076-077 | JUNO-X | 145 tones |
| 071 | 067 | PR-X (factory) | 35 tones |
| 071 | 069 | RD-PIANO | 5 tones |
| 087 | 064+ | PR-B/C/D, XV-5080, COMMON | various |
| 085 | 000-001 | SCENE (programs) | 1-256 |

Scene switching: MSB=85, LSB=0, PC for scenes 1-128. Increment LSB for higher scene numbers.

---

## 10. Architectural Impact on Shared Code

### Changes Required

1. **`src/shared/types.ts`**: Add `{ kind: "dt1", address: number[], size: number }` to `ParamEncoding` union type.

2. **`src/shared/parameter-resolution.ts`**: Add `dt1` encoding handling in `resolveValue()` and `formatValue()`. For dt1, the "MIDI value" is the raw value; address computation happens in the device.

3. **New file `src/shared/roland-dt1.ts`**: Roland DT1/RQ1 protocol builder/parser.

### No Changes Required

- `MidiConnection` interface -- `sendSysEx()` already exists.
- `KeyboardModel` / `KeyboardDevice` interfaces -- all engine logic lives in the device.
- `BaseKeyboardDevice` -- JUNO-X device overrides `setParameters()` to use DT1 instead of CC.
- `MockHandler` interface -- `onMIDI({ type: "sysex", bytes })` already supported.
- Tools layer -- tools delegate to device methods, no changes needed.

---

## 11. Open Design Decisions

### `cc` field on KeyboardParameter

Currently `KeyboardParameter.cc` is required. DT1 parameters don't have a CC number -- their address is in the encoding. Options:
- Make `cc` optional in `KeyboardParameter`. Existing models still set it. DT1 params omit it.
- The `getParamByCC()` lookup on ParameterMap returns nothing for DT1 params (expected -- there's no CC to look up).
- The device's `setParameters()` checks the encoding kind: if `dt1`, build DT1 message; if `raw`/etc., send CC as before.

**Decision**: Make `cc` optional. This is the simplest change and doesn't break existing models.

### Dynamic ParameterMap and Engine Context

The ParameterMap needs to know the active engine to filter parameters. Two options:
- **Option A**: The map holds all parameters from all engines, tagged with engine type. `listParameters()` takes an engine filter argument. The device passes the current engine when calling.
- **Option B**: The device swaps the ParameterMap entirely when the engine changes.

**Decision**: Option A -- single map with engine tagging. Add an `engine?: JunoXEngine` field to JUNO-X parameters. The device filters when listing. `findParam()` also respects the active engine context.

---

## 12. Key Constraints

- **Part 5**: Only receives MIDI, no tone editing in some contexts.
- **RD Piano**: Only available on Part 1. The MFX is replaced by sympathetic resonance effect.
- **Nibble packing**: Parameters marked with `#` in the MIDI Implementation span multiple bytes using 4-bit nibble encoding. Values >127 require this.
- **Multi-byte values**: Cutoff (0-1023), Resonance (0-1023), envelope times (0-1023), portamento time (0-1023) all use nibble packing.
- **Model ID**: `00 00 00 00 12` -- 5 bytes, device ID default `10` (can be `10`-`1F` or `7F` broadcast).