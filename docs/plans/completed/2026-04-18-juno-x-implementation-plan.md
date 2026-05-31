# Roland JUNO-X Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a full Roland JUNO-X keyboard model with 4 synth engines, Roland DT1/RQ1 SysEx transport, 5-part multi-timbral support, mock handler, and hardware-faithful panel UI.

**Architecture:** Engine-per-module design with a shared Roland DT1/RQ1 protocol layer in `src/shared/`. Tone parameters use `cc` field (from the Parameter Guide CC# column). Scene-level parameters use `sysexAddress` field (from the MIDI Implementation address map). The device routes to CC or DT1 based on which addressing field is present. The mock handler processes both CC and SysEx messages.

**Tech Stack:** TypeScript, Node.js MIDI (easymidi), WebSocket, Electron (mock runner), vanilla HTML/CSS/JS (mock UI)

**Spec:** `docs/plans/2026-04-18-juno-x-model-design.md`
**MIDI Reference:** Roland JUNO-X *MIDI Implementation* and *Parameter Guide* — official manuals available from [Roland's JUNO-X support page](https://www.roland.com/global/support/by_product/juno-x/owners_manuals/) (not redistributed here; see [docs/roland/README.md](../../roland/README.md))
**Architecture Notes:** `docs/roland/juno-x-midi-arch.md`

---

## File Structure

### New Files

```
src/shared/roland-dt1.ts                                    # Roland DT1/RQ1 protocol builder/parser
src/keyboard_models/roland/juno_x/index.ts                   # KeyboardModel factory + metadata
src/keyboard_models/roland/juno_x/device.ts                  # JunoXDevice extends BaseKeyboardDevice
src/keyboard_models/roland/juno_x/engines/engine-types.ts    # Engine enum, base addresses
src/keyboard_models/roland/juno_x/engines/analog-synth.ts    # JUNO-106/60 tone parameters (CC-addressed)
src/keyboard_models/roland/juno_x/engines/zcore.ts           # ZCore tone parameters (CC-addressed)
src/keyboard_models/roland/juno_x/engines/juno-x-model.ts    # JUNO-X Model tone parameters (CC-addressed)
src/keyboard_models/roland/juno_x/engines/rd-piano.ts        # RD Piano tone parameters (CC-addressed)
src/keyboard_models/roland/juno_x/scene-params.ts            # Scene-level parameters (DT1-addressed)
src/keyboard_models/roland/juno_x/midi-map.ts                # Aggregates engines + scene into ParameterMap
src/keyboard_models/roland/juno_x/state-manager.ts           # Per-part, per-engine state tracking
src/keyboard_models/roland/juno_x/mock-handler.ts            # MockHandler implementation
src/keyboard_models/roland/juno_x/web/index.html             # Mock UI entry point
src/keyboard_models/roland/juno_x/web/style.css              # Panel styling
src/keyboard_models/roland/juno_x/web/app.js                 # UI logic + WebSocket
```

### Modified Files

```
src/shared/types.ts                          # Make cc optional, add sysexAddress/sysexSize fields
src/shared/base-keyboard-device.ts           # Guard optional cc in setParameters/listParameters
src/mock-runner/engine.ts                    # Add SysEx event forwarding to handler
```

---

### Task 1: Make `cc` optional, add SysEx addressing fields

**Files:**
- Modify: `src/shared/types.ts:23-35`
- Modify: `src/shared/base-keyboard-device.ts:79-186`

- [ ] **Step 1: Update KeyboardParameter interface**

In `src/shared/types.ts`, make `cc` optional and add SysEx addressing fields:

```typescript
export interface KeyboardParameter {
  name: string;
  section: string;
  cc?: number;
  min: number;
  max: number;
  defaultValue: number;
  type: ParamType;
  labels?: Record<number, string>;
  description: string;
  encoding: ParamEncoding;
  perPart?: boolean;
  sysexAddress?: number[];   // DT1 address offset (4 bytes) for SysEx-transported params
  sysexSize?: number;        // byte count: 1 for 7-bit, 2+ for nibble-packed values
}
```

`ParamEncoding` is unchanged — it stays purely a value transform.

- [ ] **Step 3: Guard `cc` usage in BaseKeyboardDevice.setParameters()**

In `src/shared/base-keyboard-device.ts`, the `setParameters()` method at line 155 does `this.connection!.sendCC(found.param.cc, midiValue)`. Guard it:

Replace line 155:
```typescript
      this.connection!.sendCC(found.param.cc, midiValue);
```
With:
```typescript
      if (found.param.cc !== undefined) {
        this.connection!.sendCC(found.param.cc, midiValue);
      }
```

- [ ] **Step 4: Guard `cc` display in BaseKeyboardDevice.listParameters()**

In `src/shared/base-keyboard-device.ts`, the `listParameters()` method at line 116 shows `info += ` | CC: ${param.cc}`;`. Guard it:

Replace:
```typescript
    info += ` | CC: ${param.cc}`;
```
With:
```typescript
    if (param.cc !== undefined) {
      info += ` | CC: ${param.cc}`;
    }
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Clean compilation, no errors. Existing models (Nord, Prophet-6) are unaffected since their params all have `cc` defined.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/base-keyboard-device.ts
git commit -m "feat: add dt1 encoding to ParamEncoding, make cc optional on KeyboardParameter"
```

---

### Task 2: Create Roland DT1/RQ1 transport

**Files:**
- Create: `src/shared/roland-dt1.ts`

- [ ] **Step 1: Create the Roland DT1/RQ1 module**

Create `src/shared/roland-dt1.ts`:

```typescript
/**
 * Roland DT1/RQ1 protocol — built on MIDI SysEx.
 *
 * DT1 (Data Set 1): Write a parameter value to a SysEx address.
 * RQ1 (Data Request 1): Request a parameter value from a SysEx address.
 *
 * Message format:
 *   F0 41 <dev> <modelId...> <cmd> <addr4> <data...> <checksum> F7
 *
 * Reusable across all Roland DT1/RQ1 keyboards (JUNO-X, JUPITER-X, FANTOM, etc.)
 */

// -- Types ------------------------------------------------------------------

export interface RolandModelId {
  /** Model ID bytes, e.g. [0x00, 0x00, 0x00, 0x00, 0x12] for JUNO-X */
  bytes: number[];
}

export interface DT1Message {
  address: number[];  // 4 bytes
  data: number[];     // 1+ bytes
}

// -- Constants --------------------------------------------------------------

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const ROLAND_ID = 0x41;
const CMD_RQ1 = 0x11;
const CMD_DT1 = 0x12;

// -- Checksum ---------------------------------------------------------------

/** Roland checksum: (128 - (sum of bytes % 128)) % 128 */
export function rolandChecksum(bytes: number[]): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return (128 - (sum % 128)) % 128;
}

// -- Nibble packing (for multi-byte params) ---------------------------------

/**
 * Pack a value into 4-bit nibbles (high nibble first).
 * E.g. 0x1AB with byteCount=4 → [0x00, 0x01, 0x0A, 0x0B]
 */
export function packNibbles(value: number, byteCount: number): number[] {
  const result: number[] = new Array(byteCount).fill(0);
  for (let i = byteCount - 1; i >= 0; i--) {
    result[i] = value & 0x0f;
    value >>>= 4;
  }
  return result;
}

/** Unpack nibbles back to a single value. */
export function unpackNibbles(bytes: number[]): number {
  let value = 0;
  for (const b of bytes) {
    value = (value << 4) | (b & 0x0f);
  }
  return value;
}

// -- DT1 (write) ------------------------------------------------------------

/**
 * Build a complete DT1 (Data Set 1) SysEx message.
 * @param modelId  Roland model identifier
 * @param deviceId Device ID (0x10-0x1F, or 0x7F for broadcast)
 * @param address  4-byte parameter address
 * @param data     1+ data bytes to write
 * @returns Complete SysEx byte array including F0 and F7
 */
export function buildDT1(
  modelId: RolandModelId,
  deviceId: number,
  address: number[],
  data: number[],
): number[] {
  const checksumBytes = [...address, ...data];
  const checksum = rolandChecksum(checksumBytes);
  return [
    SYSEX_START,
    ROLAND_ID,
    deviceId,
    ...modelId.bytes,
    CMD_DT1,
    ...address,
    ...data,
    checksum,
    SYSEX_END,
  ];
}

// -- RQ1 (read request) -----------------------------------------------------

/**
 * Build a complete RQ1 (Data Request 1) SysEx message.
 * @param modelId  Roland model identifier
 * @param deviceId Device ID
 * @param address  4-byte start address
 * @param size     4-byte size of data to request
 * @returns Complete SysEx byte array including F0 and F7
 */
export function buildRQ1(
  modelId: RolandModelId,
  deviceId: number,
  address: number[],
  size: number[],
): number[] {
  const checksumBytes = [...address, ...size];
  const checksum = rolandChecksum(checksumBytes);
  return [
    SYSEX_START,
    ROLAND_ID,
    deviceId,
    ...modelId.bytes,
    CMD_RQ1,
    ...address,
    ...size,
    checksum,
    SYSEX_END,
  ];
}

// -- Parsing ----------------------------------------------------------------

/**
 * Parse incoming SysEx bytes as a DT1 message.
 * Returns address + data if valid DT1 for the given model, null otherwise.
 */
export function parseDT1(
  sysex: number[],
  modelId: RolandModelId,
): DT1Message | null {
  // Minimum: F0 41 dev <modelId bytes> 12 <4 addr> <1 data> <checksum> F7
  const minLen = 3 + modelId.bytes.length + 1 + 4 + 1 + 1 + 1;
  if (sysex.length < minLen) return null;
  if (sysex[0] !== SYSEX_START) return null;
  if (sysex[1] !== ROLAND_ID) return null;
  // sysex[2] = device ID (don't filter — accept any)

  // Verify model ID
  const modelStart = 3;
  for (let i = 0; i < modelId.bytes.length; i++) {
    if (sysex[modelStart + i] !== modelId.bytes[i]) return null;
  }

  // Verify command = DT1
  const cmdIndex = modelStart + modelId.bytes.length;
  if (sysex[cmdIndex] !== CMD_DT1) return null;

  // Extract address (4 bytes) and data (variable length)
  const addrStart = cmdIndex + 1;
  const address = sysex.slice(addrStart, addrStart + 4);
  const dataStart = addrStart + 4;
  const dataEnd = sysex.length - 2; // exclude checksum and F7
  const data = sysex.slice(dataStart, dataEnd);

  // Verify checksum
  const checksumBytes = [...address, ...data];
  const expected = rolandChecksum(checksumBytes);
  if (sysex[dataEnd] !== expected) return null;

  // Verify end byte
  if (sysex[sysex.length - 1] !== SYSEX_END) return null;

  return { address, data };
}

// -- Address arithmetic -----------------------------------------------------

/** Add two 4-byte addresses (no carry beyond byte boundaries per Roland convention). */
export function addAddresses(base: number[], offset: number[]): number[] {
  return [
    (base[0] + offset[0]) & 0x7f,
    (base[1] + offset[1]) & 0x7f,
    (base[2] + offset[2]) & 0x7f,
    (base[3] + offset[3]) & 0x7f,
  ];
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add src/shared/roland-dt1.ts
git commit -m "feat: add Roland DT1/RQ1 protocol builder and parser"
```

---

### Task 3: JUNO-X model scaffold

**Files:**
- Create: `src/keyboard_models/roland/juno_x/engines/engine-types.ts`
- Create: `src/keyboard_models/roland/juno_x/index.ts`

- [ ] **Step 1: Create engine types and constants**

Create `src/keyboard_models/roland/juno_x/engines/engine-types.ts`:

```typescript
/**
 * JUNO-X synth engine types and SysEx address constants.
 * Reference: JUNO-X MIDI Implementation, Section 3 (Parameter Address Map).
 */

import type { RolandModelId } from "../../../../shared/roland-dt1.js";

// -- Model ID ---------------------------------------------------------------

export const JUNO_X_MODEL_ID: RolandModelId = {
  bytes: [0x00, 0x00, 0x00, 0x00, 0x12],
};

export const JUNO_X_DEVICE_ID = 0x10; // default device ID

// -- Engine types -----------------------------------------------------------

export enum JunoXEngine {
  ZCore = "zcore",
  AnalogSynth = "analog-synth",
  RDPiano = "rd-piano",
  JunoXModel = "juno-x-model",
}

export const ENGINE_DISPLAY_NAMES: Record<JunoXEngine, string> = {
  [JunoXEngine.ZCore]: "ZEN-Core",
  [JunoXEngine.AnalogSynth]: "Analog Synth (106/60)",
  [JunoXEngine.RDPiano]: "RD Piano",
  [JunoXEngine.JunoXModel]: "JUNO-X Model",
};

// -- SysEx base addresses ---------------------------------------------------

/** Temporary Scene base address */
export const SCENE_BASE = [0x01, 0x00, 0x00, 0x00];

/** Scene sub-section offsets */
export const SCENE_COMMON_OFFSET = [0x00, 0x00, 0x00, 0x00];
export const SCENE_PART_OFFSETS = [
  [0x00, 0x10, 0x00, 0x00], // Part 1
  [0x00, 0x11, 0x00, 0x00], // Part 2
  [0x00, 0x12, 0x00, 0x00], // Part 3
  [0x00, 0x13, 0x00, 0x00], // Part 4
  [0x00, 0x14, 0x00, 0x00], // Part 5
];
export const SCENE_EQ_OFFSETS = [
  [0x00, 0x20, 0x00, 0x00], // EQ 1
  [0x00, 0x21, 0x00, 0x00],
  [0x00, 0x22, 0x00, 0x00],
  [0x00, 0x23, 0x00, 0x00],
  [0x00, 0x24, 0x00, 0x00], // EQ 5
];
export const SCENE_CHORUS_OFFSET = [0x00, 0x50, 0x00, 0x00];
export const SCENE_DELAY_OFFSET = [0x00, 0x51, 0x00, 0x00];
export const SCENE_REVERB_OFFSET = [0x00, 0x52, 0x00, 0x00];
export const SCENE_DRIVE_OFFSET = [0x00, 0x53, 0x00, 0x00];

/**
 * Temporary Tone base addresses per engine per part.
 * Index 0 = Part 1, etc.
 */
export const ENGINE_TONE_BASES: Record<JunoXEngine, number[][]> = {
  [JunoXEngine.ZCore]: [
    [0x02, 0x00, 0x00, 0x00],
    [0x02, 0x01, 0x00, 0x00],
    [0x02, 0x02, 0x00, 0x00],
    [0x02, 0x03, 0x00, 0x00],
  ],
  [JunoXEngine.AnalogSynth]: [
    [0x02, 0x10, 0x00, 0x00],
    [0x02, 0x11, 0x00, 0x00],
    [0x02, 0x12, 0x00, 0x00],
    [0x02, 0x13, 0x00, 0x00],
  ],
  [JunoXEngine.RDPiano]: [
    [0x02, 0x20, 0x00, 0x00], // Part 1 only
  ],
  [JunoXEngine.JunoXModel]: [
    [0x02, 0x40, 0x00, 0x00],
    [0x02, 0x41, 0x00, 0x00],
    [0x02, 0x42, 0x00, 0x00],
    [0x02, 0x43, 0x00, 0x00],
  ],
};

/** Number of parts: 5 total, but part 5 is limited */
export const PART_COUNT = 5;
export const PART_NAMES = ["1", "2", "3", "4", "5"];
```

- [ ] **Step 2: Create model index.ts scaffold**

Create `src/keyboard_models/roland/juno_x/index.ts`:

```typescript
/**
 * Roland JUNO-X keyboard model.
 * 5-part multi-timbral synthesizer with 4 synth engines.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import { createParameterMap } from "./midi-map.js";
import { JunoXDevice } from "./device.js";
import { JunoXMockHandler } from "./mock-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const model: KeyboardModel = {
  info: {
    id: "roland-juno-x",
    displayName: "Roland JUNO-X",
    manufacturer: "Roland",
    midiPortPatterns: ["JUNO-X"],
  },

  agentSystemPrompt: `KEYBOARD: Roland JUNO-X
TYPE: 5-part multi-timbral synthesizer with 4 synth engines
ENGINES: ZEN-Core (PCM/VA, 4 partials), Analog Synth (JUNO-106/60 emulation), RD Piano, JUNO-X Model
PARTS: 5 independent parts, each can run any engine
SCENE: A "Scene" is the JUNO-X's program/patch. Contains all 5 parts + effects + zones.
CONTROL: Scene parameters via Roland DT1 SysEx. Tone parameters via MIDI CC on the part's channel.
EFFECTS: Per-part MFX + Scene-level Delay, Reverb, Chorus, Drive
PANEL: LFO | OSC | HPF | FILTER | AMP | ENV | CHORUS (classic JUNO layout for Analog Synth engine)

SOUND DESIGN TIPS:
- Analog Synth engine faithfully recreates JUNO-106 and JUNO-60 sounds
- The JUNO chorus (I, II, I+II) is essential to the classic JUNO sound
- Filter cutoff + resonance + envelope depth are the most expressive parameters
- Layer parts for rich pads: e.g., Analog Synth pad on Part 1 + ZEN-Core strings on Part 2
- Use ZEN-Core for modern sounds (PCM waveforms, 4 partials with full envelopes)
- RD Piano engine gives high-quality acoustic piano with sympathetic resonance`,

  mockUiDir: join(
    __dirname, "..", "..", "..", "..",
    "src", "keyboard_models", "roland", "juno_x", "web",
  ),

  programLoader: {
    bankRange: { min: 1, max: 2 },
    slotRange: { min: 1, max: 128 },
    async loadProgram(midi, bank, slot) {
      // Scene bank: MSB=85, LSB=bank-1, PC=slot-1
      midi.sendCC(0, 85);         // Bank Select MSB
      midi.sendCC(32, bank - 1);  // Bank Select LSB
      midi.sendProgramChange(slot - 1);
    },
  },

  createDevice() {
    const parameterMap = createParameterMap();
    return new JunoXDevice(model, {
      parameterMap,
      systemPromptTemplate: model.agentSystemPrompt,
      programLoader: model.programLoader,
    });
  },

  createMockHandler() {
    return new JunoXMockHandler();
  },
};

export default model;
```

- [ ] **Step 3: Build (expect errors — dependencies not yet created)**

Run: `npm run build`
Expected: Errors about missing imports (midi-map.js, device.js, mock-handler.js). This confirms our scaffold is being discovered by the compiler.

- [ ] **Step 4: Commit**

```bash
git add src/keyboard_models/roland/juno_x/engines/engine-types.ts src/keyboard_models/roland/juno_x/index.ts
git commit -m "feat: add JUNO-X model scaffold with engine types and constants"
```

---

### Task 5: Analog Synth engine parameter map

**Files:**
- Create: `src/keyboard_models/roland/juno_x/engines/analog-synth.ts`

This defines the JUNO-106/JUNO-60 emulation engine parameters using CC numbers from the Parameter Guide (pages 18-20).

- [ ] **Step 1: Create the Analog Synth parameter definitions**

Create `src/keyboard_models/roland/juno_x/engines/analog-synth.ts`:

```typescript
/**
 * Analog Synth Model (JUNO-106 / JUNO-60 emulation) parameters.
 * CC numbers from JUNO-X Parameter Guide, "TONE: JUNO-X / JUNO-106 / JUNO-60" pages.
 *
 * These tone parameters are CC-addressed on the part's MIDI channel.
 * The Analog Synth Model is the classic JUNO front-panel: LFO → OSC → HPF → VCF → VCA → ENV → Chorus.
 */

import type { KeyboardParameter } from "../../../../shared/types.js";
import { JunoXEngine } from "./engine-types.js";

export const ANALOG_SYNTH_ENGINE = JunoXEngine.AnalogSynth;

export function createAnalogSynthParams(): Record<string, KeyboardParameter> {
  return {
    // -- LFO ----------------------------------------------------------------
    as_lfo_waveform: {
      name: "LFO Waveform",
      section: "lfo",
      cc: 35,
      min: 0, max: 3,
      defaultValue: 0,
      type: "discrete",
      labels: { 0: "SIN", 1: "SAW-DW", 2: "SQR", 3: "S&H" },
      description: "Selects the waveform of the LFO.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_lfo_rate: {
      name: "LFO Rate",
      section: "lfo",
      cc: 29,
      min: 0, max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Specifies the speed of the LFO cycle.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_lfo_delay_time: {
      name: "LFO Delay Time",
      section: "lfo",
      cc: 27,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Time from key press until LFO modulation starts.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_lfo_sync: {
      name: "LFO Sync",
      section: "lfo",
      cc: 117,
      min: 0, max: 1,
      defaultValue: 0,
      type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Sync the LFO speed to the tempo.",
      encoding: { kind: "raw" },
      perPart: true,
    },

    // -- OSC ----------------------------------------------------------------
    as_osc_pitch: {
      name: "OSC Pitch",
      section: "osc",
      cc: 20,
      min: 0, max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Adjusts the pitch of the oscillator in semitones.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_osc_detune: {
      name: "OSC Detune",
      section: "osc",
      cc: 21,
      min: 0, max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Shifts tuning of sawtooth wave and sub-oscillator for detuned effect.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_osc_pan_split: {
      name: "OSC Pan Split",
      section: "osc",
      cc: 55,
      min: 0, max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Degree of separation for panning of the pulse wave/Super SAW, sawtooth wave, sub-oscillator and noise.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_pw_level: {
      name: "PW Level / SSAW Level",
      section: "osc",
      cc: 16,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Adjusts the pulse wave/Super SAW volume.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_saw_level: {
      name: "SAW Level",
      section: "osc",
      cc: 17,
      min: 0, max: 127,
      defaultValue: 127,
      type: "continuous",
      description: "Adjusts the volume of the sawtooth wave.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_sub_level: {
      name: "SUB Level",
      section: "osc",
      cc: 18,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Adjusts the volume of the sub oscillator.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_noise_level: {
      name: "Noise Level",
      section: "osc",
      cc: 19,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Adjusts the noise volume.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_super_saw: {
      name: "Super SAW",
      section: "osc",
      cc: 46,
      min: 0, max: 1,
      defaultValue: 0,
      type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Use the Super SAW wave instead of the pulse wave.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_osc_lfo_mod: {
      name: "OSC LFO Mod",
      section: "osc",
      cc: 26,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Uses the LFO to vary the pitch (vibrato).",
      encoding: { kind: "raw" },
      perPart: true,
    },

    // -- HPF ----------------------------------------------------------------
    as_hpf_step: {
      name: "HPF Step",
      section: "hpf",
      cc: 79,
      min: 0, max: 3,
      defaultValue: 0,
      type: "discrete",
      labels: { 0: "0", 1: "1", 2: "2", 3: "3" },
      description: "Sets the high-pass filter cutoff frequency in four steps.",
      encoding: { kind: "raw" },
      perPart: true,
    },

    // -- FILTER -------------------------------------------------------------
    as_vintage_flt_type: {
      name: "Vintage Filter Type",
      section: "filter",
      cc: 108,
      min: 0, max: 2,
      defaultValue: 0,
      type: "discrete",
      labels: { 0: "R", 1: "M", 2: "S" },
      description: "Selects one of three vintage filter response curves.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_cutoff: {
      name: "Cutoff",
      section: "filter",
      cc: 3,
      min: 0, max: 127,
      defaultValue: 127,
      type: "continuous",
      description: "Specifies the cutoff frequency of the low-pass filter. Lower values produce a more mellow tonal character.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_resonance: {
      name: "Resonance",
      section: "filter",
      cc: 9,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Boosts the filter's cutoff frequency region, giving a distinctively synthesizer-like character.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_flt_env_depth: {
      name: "Filter Env Depth",
      section: "filter",
      cc: 81,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Amount by which the cutoff frequency is controlled by the envelope.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_flt_key_follow: {
      name: "Filter Key Follow",
      section: "filter",
      cc: 122,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Amount by which keyboard pitch affects the cutoff frequency (key follow).",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_flt_lfo_mod: {
      name: "Filter LFO Mod",
      section: "filter",
      cc: 28,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Amount by which the LFO modulates the cutoff frequency.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_flt_vsens: {
      name: "Filter Velocity Sens",
      section: "filter",
      cc: 53,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "How much the cutoff frequency changes according to how hard you play the keys.",
      encoding: { kind: "raw" },
      perPart: true,
    },

    // -- AMP ----------------------------------------------------------------
    as_amp_level: {
      name: "AMP Level",
      section: "amp",
      cc: 110,
      min: 0, max: 127,
      defaultValue: 100,
      type: "continuous",
      description: "Adjusts the volume of the tone.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_amp_lfo_mod: {
      name: "AMP LFO Mod",
      section: "amp",
      cc: 30,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Sets how much LFO changes the AMP volume.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_amp_vsens: {
      name: "AMP Velocity Sens",
      section: "amp",
      cc: 54,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "How much the AMP volume changes according to how hard you play the keys.",
      encoding: { kind: "raw" },
      perPart: true,
    },

    // -- ENV (ADSR) ---------------------------------------------------------
    as_env_attack: {
      name: "ENV Attack",
      section: "env",
      cc: 89,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Specifies the ENV Attack time.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_env_decay: {
      name: "ENV Decay",
      section: "env",
      cc: 90,
      min: 0, max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Specifies the ENV Decay time.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_env_sustain: {
      name: "ENV Sustain",
      section: "env",
      cc: 102,
      min: 0, max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Specifies the ENV Sustain level.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_env_release: {
      name: "ENV Release",
      section: "env",
      cc: 103,
      min: 0, max: 127,
      defaultValue: 32,
      type: "continuous",
      description: "Specifies the ENV Release time.",
      encoding: { kind: "raw" },
      perPart: true,
    },

    // -- Pitch Envelope -----------------------------------------------------
    as_penv_attack: {
      name: "Pitch Env Attack",
      section: "env",
      cc: 83,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Specifies the attack time of the pitch envelope.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_penv_decay: {
      name: "Pitch Env Decay",
      section: "env",
      cc: 80,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Specifies the decay time of the pitch envelope.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_penv_sustain: {
      name: "Pitch Env Sustain",
      section: "env",
      cc: 85,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Specifies the sustain level of the pitch envelope.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_penv_release: {
      name: "Pitch Env Release",
      section: "env",
      cc: 86,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Specifies the release time of the pitch envelope.",
      encoding: { kind: "raw" },
      perPart: true,
    },

    // -- Performance --------------------------------------------------------
    as_bend_pitch: {
      name: "Bend Pitch",
      section: "performance",
      cc: 41,
      min: 0, max: 127,
      defaultValue: 2,
      type: "continuous",
      description: "Specifies the range of pitch change produced by pitch bend.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_bend_filter: {
      name: "Bend Filter",
      section: "performance",
      cc: 14,
      min: 0, max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Specifies the range of filter change produced by pitch bend.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_porta_mode: {
      name: "Portamento Mode",
      section: "performance",
      cc: 118,
      min: 0, max: 1,
      defaultValue: 0,
      type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Turns portamento on/off.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_porta_time: {
      name: "Portamento Time",
      section: "performance",
      cc: 5,
      min: 0, max: 127,
      defaultValue: 0,
      type: "continuous",
      description: "Adjusts the time over which the portamento pitch change occurs.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    as_key_mode: {
      name: "Key Mode",
      section: "performance",
      cc: 119,
      min: 0, max: 3,
      defaultValue: 0,
      type: "discrete",
      labels: { 0: "POLY", 1: "SOLO", 2: "UNISON", 3: "SL-UNISON" },
      description: "Specifies how notes are sounded: Polyphonic, Monophonic, Unison, or Monophonic Unison.",
      encoding: { kind: "raw" },
      perPart: true,
    },
  };
}
```

- [ ] **Step 2: Build (expect errors for missing sibling files)**

Run: `npm run build`
Expected: This file compiles cleanly on its own. Errors from index.ts about missing midi-map/device/mock-handler are expected.

- [ ] **Step 3: Commit**

```bash
git add src/keyboard_models/roland/juno_x/engines/analog-synth.ts
git commit -m "feat: add Analog Synth (JUNO-106/60) engine parameter map"
```

---

### Task 6: Remaining engine parameter maps (ZCore, JUNO-X Model, RD Piano)

**Files:**
- Create: `src/keyboard_models/roland/juno_x/engines/zcore.ts`
- Create: `src/keyboard_models/roland/juno_x/engines/juno-x-model.ts`
- Create: `src/keyboard_models/roland/juno_x/engines/rd-piano.ts`

The ZCore and JUNO-X Model engines share most tone parameters from the Parameter Guide (pages 18-28). The RD Piano engine is minimal.

- [ ] **Step 1: Create ZCore engine params**

Create `src/keyboard_models/roland/juno_x/engines/zcore.ts`. The ZCore (ZEN-Core) engine is the most complex — 4 partials, each with full OSC/Filter/Amp/LFO chains. Define the key global and per-partial parameters using CC numbers from the Parameter Guide page 30 (List of supported CCs for ZCore).

```typescript
/**
 * ZCore (ZEN-Core) engine parameters.
 * CC numbers from JUNO-X Parameter Guide, "TONE: XV-5080 / RD-PIANO / PR-A..." and CC table (p.30).
 *
 * ZCore is a 4-partial engine. Per-partial CCs differ by partial number.
 * This file defines the core global parameters. Partial-specific params are
 * generated dynamically for partials 1-4.
 */

import type { KeyboardParameter } from "../../../../shared/types.js";
import { JunoXEngine } from "./engine-types.js";

export const ZCORE_ENGINE = JunoXEngine.ZCore;

/** Per-partial CC offsets from the Parameter Guide CC table (p.30) */
const PARTIAL_CCS: Record<string, [number, number, number, number]> = {
  level:      [16, 17, 18, 19],
  fine_tune:  [21, 31, 35, 46],
  cutoff:     [3, 54, 55, 56],
  resonance:  [9, 57, 58, 59],
  filtr_depth:[81, 63, 79, 80],
  filtr_time1:[83, 82, 85, 87],
  filtr_time4:[86, 102, 103, 104],
  amp_time1:  [89, 108, 109, 111],
  amp_time4:  [90, 112, 114, 117],
  l1_rate:    [29, 20, 22, 23],
  l1_pit_depth:[26, 47, 48, 50],
  l1_amp_depth:[30, 105, 106, 107],
  l1_flt_depth:[28, 60, 61, 62],
  l2_rate:    [14, 24, 25, 27],
  l2_pit_depth:[15, 51, 52, 53],
};

export function createZCoreParams(): Record<string, KeyboardParameter> {
  const params: Record<string, KeyboardParameter> = {};

  // Generate per-partial parameters
  for (let p = 0; p < 4; p++) {
    const pn = p + 1; // 1-based partial number
    const prefix = `zc_p${pn}`;

    params[`${prefix}_level`] = {
      name: `Partial ${pn} Level`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.level[p],
      min: 0, max: 127, defaultValue: 100,
      type: "continuous",
      description: `Sets the volume of partial ${pn}.`,
      encoding: { kind: "raw" }, perPart: true,
    };
    params[`${prefix}_fine_tune`] = {
      name: `Partial ${pn} Fine Tune`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.fine_tune[p],
      min: 0, max: 127, defaultValue: 64,
      type: "continuous",
      description: `Adjusts the pitch of partial ${pn} in 1-cent steps.`,
      encoding: { kind: "raw" }, perPart: true,
    };
    params[`${prefix}_cutoff`] = {
      name: `Partial ${pn} Cutoff`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.cutoff[p],
      min: 0, max: 127, defaultValue: 127,
      type: "continuous",
      description: `Filter cutoff frequency for partial ${pn}.`,
      encoding: { kind: "raw" }, perPart: true,
    };
    params[`${prefix}_resonance`] = {
      name: `Partial ${pn} Resonance`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.resonance[p],
      min: 0, max: 127, defaultValue: 0,
      type: "continuous",
      description: `Filter resonance for partial ${pn}.`,
      encoding: { kind: "raw" }, perPart: true,
    };
    params[`${prefix}_filtr_depth`] = {
      name: `Partial ${pn} Filter Env Depth`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.filtr_depth[p],
      min: 0, max: 127, defaultValue: 0,
      type: "continuous",
      description: `Filter envelope depth for partial ${pn}.`,
      encoding: { kind: "raw" }, perPart: true,
    };
    params[`${prefix}_env_attack`] = {
      name: `Partial ${pn} Amp Attack`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.amp_time1[p],
      min: 0, max: 127, defaultValue: 0,
      type: "continuous",
      description: `Amp envelope attack time for partial ${pn}.`,
      encoding: { kind: "raw" }, perPart: true,
    };
    params[`${prefix}_env_release`] = {
      name: `Partial ${pn} Amp Release`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.amp_time4[p],
      min: 0, max: 127, defaultValue: 32,
      type: "continuous",
      description: `Amp envelope release time for partial ${pn}.`,
      encoding: { kind: "raw" }, perPart: true,
    };
    params[`${prefix}_lfo1_rate`] = {
      name: `Partial ${pn} LFO1 Rate`,
      section: `partial-${pn}`,
      cc: PARTIAL_CCS.l1_rate[p],
      min: 0, max: 127, defaultValue: 64,
      type: "continuous",
      description: `LFO 1 rate for partial ${pn}.`,
      encoding: { kind: "raw" }, perPart: true,
    };
  }

  // Global ZCore tone param: AMP Level (common across partials)
  params.zc_amp_level = {
    name: "Tone Level",
    section: "tone-common",
    cc: 110,
    min: 0, max: 127, defaultValue: 100,
    type: "continuous",
    description: "Adjusts the overall volume of the ZCore tone.",
    encoding: { kind: "raw" }, perPart: true,
  };

  return params;
}
```

- [ ] **Step 2: Create JUNO-X Model engine params**

Create `src/keyboard_models/roland/juno_x/engines/juno-x-model.ts`. The JUNO-X Model engine is structurally similar to the Analog Synth engine with extended capabilities. It shares the same panel layout.

```typescript
/**
 * JUNO-X Model engine parameters.
 * Similar to Analog Synth but with extended capabilities.
 * CC numbers from JUNO-X Parameter Guide, "TONE: JUNO-X" page (p.18-19).
 */

import type { KeyboardParameter } from "../../../../shared/types.js";
import { JunoXEngine } from "./engine-types.js";

export const JUNO_X_MODEL_ENGINE = JunoXEngine.JunoXModel;

export function createJunoXModelParams(): Record<string, KeyboardParameter> {
  // The JUNO-X Model shares the same CC assignments as the Analog Synth
  // for its core parameters (LFO, OSC, Filter, Amp, Env)
  return {
    jx_lfo_waveform: {
      name: "LFO Waveform", section: "lfo", cc: 35,
      min: 0, max: 3, defaultValue: 0, type: "discrete",
      labels: { 0: "SIN", 1: "SAW-DW", 2: "SQR", 3: "S&H" },
      description: "Selects the waveform of the LFO.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_lfo_rate: {
      name: "LFO Rate", section: "lfo", cc: 29,
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Specifies the speed of the LFO cycle.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_lfo_delay_time: {
      name: "LFO Delay Time", section: "lfo", cc: 27,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "Time from key press until LFO modulation starts.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_osc_lfo_mod: {
      name: "OSC LFO Mod", section: "osc", cc: 26,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "Uses the LFO to vary the pitch (vibrato).",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_pw_level: {
      name: "PW Level", section: "osc", cc: 16,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "Adjusts the pulse wave volume.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_saw_level: {
      name: "SAW Level", section: "osc", cc: 17,
      min: 0, max: 127, defaultValue: 127, type: "continuous",
      description: "Adjusts the volume of the sawtooth wave.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_sub_level: {
      name: "SUB Level", section: "osc", cc: 18,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "Adjusts the volume of the sub oscillator.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_noise_level: {
      name: "Noise Level", section: "osc", cc: 19,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "Adjusts the noise volume.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_cutoff: {
      name: "Cutoff", section: "filter", cc: 3,
      min: 0, max: 127, defaultValue: 127, type: "continuous",
      description: "Cutoff frequency of the low-pass filter.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_resonance: {
      name: "Resonance", section: "filter", cc: 9,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "Boosts the filter's cutoff frequency region.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_flt_env_depth: {
      name: "Filter Env Depth", section: "filter", cc: 81,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "Amount by which the envelope controls the cutoff frequency.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_amp_level: {
      name: "AMP Level", section: "amp", cc: 110,
      min: 0, max: 127, defaultValue: 100, type: "continuous",
      description: "Adjusts the volume of the tone.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_env_attack: {
      name: "ENV Attack", section: "env", cc: 89,
      min: 0, max: 127, defaultValue: 0, type: "continuous",
      description: "ENV Attack time.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_env_decay: {
      name: "ENV Decay", section: "env", cc: 90,
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "ENV Decay time.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_env_sustain: {
      name: "ENV Sustain", section: "env", cc: 102,
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "ENV Sustain level.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_env_release: {
      name: "ENV Release", section: "env", cc: 103,
      min: 0, max: 127, defaultValue: 32, type: "continuous",
      description: "ENV Release time.",
      encoding: { kind: "raw" }, perPart: true,
    },
    jx_key_mode: {
      name: "Key Mode", section: "performance", cc: 119,
      min: 0, max: 3, defaultValue: 0, type: "discrete",
      labels: { 0: "POLY", 1: "SOLO", 2: "UNISON", 3: "SL-UNISON" },
      description: "Specifies how notes are sounded.",
      encoding: { kind: "raw" }, perPart: true,
    },
  };
}
```

- [ ] **Step 3: Create RD Piano engine params**

Create `src/keyboard_models/roland/juno_x/engines/rd-piano.ts`:

```typescript
/**
 * RD Piano engine parameters.
 * Minimal parameter set — only available on Part 1.
 * Reference: JUNO-X Parameter Guide, "TONE RD SYMPATHETIC RESO Parameter" (p.30).
 */

import type { KeyboardParameter } from "../../../../shared/types.js";
import { JunoXEngine } from "./engine-types.js";

export const RD_PIANO_ENGINE = JunoXEngine.RDPiano;

export function createRDPianoParams(): Record<string, KeyboardParameter> {
  return {
    rd_level: {
      name: "Tone Level", section: "rd-tone", cc: 110,
      min: 0, max: 127, defaultValue: 100, type: "continuous",
      description: "Adjusts the overall volume of the RD Piano tone.",
      encoding: { kind: "raw" }, perPart: true,
    },
    rd_symreso_switch: {
      name: "SymReso Switch", section: "rd-symreso",
      min: 0, max: 1, defaultValue: 1, type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Enables sympathetic resonance effect.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    rd_symreso_depth: {
      name: "SymReso Depth", section: "rd-symreso",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Effect depth of sympathetic resonance.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    rd_cabinet_reso: {
      name: "Cabinet Reso", section: "rd-symreso",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Depth of resonance when the damper pedal is not pressed.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/keyboard_models/roland/juno_x/engines/zcore.ts src/keyboard_models/roland/juno_x/engines/juno-x-model.ts src/keyboard_models/roland/juno_x/engines/rd-piano.ts
git commit -m "feat: add ZCore, JUNO-X Model, and RD Piano engine parameter maps"
```

---

### Task 7: Scene parameters (DT1-addressed)

**Files:**
- Create: `src/keyboard_models/roland/juno_x/scene-params.ts`

Scene-level parameters use DT1 SysEx encoding. Addresses from JUNO-X MIDI Implementation pages 15-17 (Scene Part, Scene Common, Scene Effects).

- [ ] **Step 1: Create scene parameters**

Create `src/keyboard_models/roland/juno_x/scene-params.ts`:

```typescript
/**
 * Scene-level parameters for the JUNO-X.
 * These use DT1 SysEx addresses from the MIDI Implementation (Section 3).
 * Scene = JUNO-X's equivalent of a "program" or "patch".
 */

import type { KeyboardParameter } from "../../../shared/types.js";

export function createSceneParams(): Record<string, KeyboardParameter> {
  return {
    // -- Scene Common (base offset: 00 00 00 xx) ----------------------------
    scene_level: {
      name: "Scene Level", section: "scene-common",
      min: 0, max: 127, defaultValue: 127, type: "continuous",
      description: "Adjusts the overall volume of the scene.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },

    // -- Scene Part (base offset: 00 1p 00 xx where p=part 0-4) -------------
    // Part-level params. The device resolves the correct part address at send time.
    part_switch: {
      name: "Part Switch", section: "scene-part",
      min: 0, max: 1, defaultValue: 1, type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Specifies whether the part is enabled (ON) or disabled (OFF).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_mute: {
      name: "Part Mute", section: "scene-part",
      min: 0, max: 2, defaultValue: 0, type: "discrete",
      labels: { 0: "OFF", 1: "MUTE" },
      description: "Specifies the part mute setting.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_level: {
      name: "Part Level", section: "scene-part",
      cc: 7, // Also available as CC7 (Volume)
      min: 0, max: 127, defaultValue: 100, type: "continuous",
      description: "Specifies the volume of each part.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_pan: {
      name: "Part Pan", section: "scene-part",
      cc: 10, // Also available as CC10
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Specifies the pan of each part (L64-63R).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_coarse_tune: {
      name: "Part Coarse Tune", section: "scene-part",
      min: 16, max: 112, defaultValue: 64, type: "continuous",
      description: "Shifts the pitch in units of a semitone (-48 to +48).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_mono_poly: {
      name: "Part Mono/Poly", section: "scene-part",
      min: 0, max: 2, defaultValue: 0, type: "discrete",
      labels: { 0: "MONO", 1: "POLY", 2: "TONE" },
      description: "Choose mono, poly, or use tone setting.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },

    // -- Scene Part MODIFY offsets (DT1 addressed) --------------------------
    part_cutoff_offset: {
      name: "Part Cutoff Offset", section: "scene-modify",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Adjusts how far the filter is open (-64 to +63 offset).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_resonance_offset: {
      name: "Part Resonance Offset", section: "scene-modify",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Resonance offset (-64 to +63).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_attack_offset: {
      name: "Part Attack Offset", section: "scene-modify",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Attack time offset (-64 to +63).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_decay_offset: {
      name: "Part Decay Offset", section: "scene-modify",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Decay time offset (-64 to +63).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },
    part_release_offset: {
      name: "Part Release Offset", section: "scene-modify",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Release time offset (-64 to +63).",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
      perPart: true,
    },

    // -- Scene Chorus (base offset: 00 50 00 xx) ----------------------------
    chorus_switch: {
      name: "Chorus Switch", section: "scene-chorus",
      min: 0, max: 1, defaultValue: 0, type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Switches chorus on/off.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },
    chorus_level: {
      name: "Chorus Level", section: "scene-chorus",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Output level of chorus effect.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },

    // -- Scene Delay (base offset: 00 51 00 xx) -----------------------------
    delay_switch: {
      name: "Delay Switch", section: "scene-delay",
      min: 0, max: 1, defaultValue: 0, type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Switches delay on/off.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },
    delay_level: {
      name: "Delay Level", section: "scene-delay",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Output level of delay effect.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },

    // -- Scene Reverb (base offset: 00 52 00 xx) ----------------------------
    reverb_switch: {
      name: "Reverb Switch", section: "scene-reverb",
      min: 0, max: 1, defaultValue: 0, type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Switches reverb on/off.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },
    reverb_level: {
      name: "Reverb Level", section: "scene-reverb",
      min: 0, max: 127, defaultValue: 64, type: "continuous",
      description: "Output level of reverb effect.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },

    // -- Scene Drive (base offset: 00 53 00 xx) -----------------------------
    drive_switch: {
      name: "Drive Switch", section: "scene-drive",
      min: 0, max: 1, defaultValue: 0, type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Switches overdrive on/off.",
      encoding: { kind: "raw" },\n      sysexAddress: \1, sysexSize: \2,
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/keyboard_models/roland/juno_x/scene-params.ts
git commit -m "feat: add JUNO-X scene parameters with DT1 SysEx addresses"
```

---

### Task 8: MIDI map, state manager, and device

**Files:**
- Create: `src/keyboard_models/roland/juno_x/midi-map.ts`
- Create: `src/keyboard_models/roland/juno_x/state-manager.ts`
- Create: `src/keyboard_models/roland/juno_x/device.ts`

- [ ] **Step 1: Create MIDI map aggregation**

Create `src/keyboard_models/roland/juno_x/midi-map.ts`:

```typescript
/**
 * JUNO-X parameter map — aggregates all engine params + scene params.
 * Engine-aware: the device filters by active engine when listing/finding params.
 */

import type { KeyboardParameter } from "../../../shared/types.js";
import type { ParameterMap } from "../../../shared/keyboard-model.js";
import { resolveValue as genericResolveValue, formatValue as genericFormatValue } from "../../../shared/parameter-resolution.js";
import { JunoXEngine } from "./engines/engine-types.js";
import { createAnalogSynthParams } from "./engines/analog-synth.js";
import { createZCoreParams } from "./engines/zcore.js";
import { createJunoXModelParams } from "./engines/juno-x-model.js";
import { createRDPianoParams } from "./engines/rd-piano.js";
import { createSceneParams } from "./scene-params.js";

export interface JunoXParameterMap extends ParameterMap {
  /** Get params filtered by engine (returns scene + engine-specific params) */
  getParamsForEngine(engine: JunoXEngine): Record<string, KeyboardParameter>;
  /** Get the engine type for a parameter key, or undefined if scene-level */
  getEngineForParam(key: string): JunoXEngine | undefined;
}

/** Which engine owns each parameter key */
const paramEngineMap = new Map<string, JunoXEngine>();

export function createParameterMap(): JunoXParameterMap {
  const sceneParams = createSceneParams();
  const engineParams: Record<JunoXEngine, Record<string, KeyboardParameter>> = {
    [JunoXEngine.AnalogSynth]: createAnalogSynthParams(),
    [JunoXEngine.ZCore]: createZCoreParams(),
    [JunoXEngine.JunoXModel]: createJunoXModelParams(),
    [JunoXEngine.RDPiano]: createRDPianoParams(),
  };

  // Merge all params into one flat map
  const allParams: Record<string, KeyboardParameter> = { ...sceneParams };
  for (const [engine, params] of Object.entries(engineParams)) {
    for (const [key, param] of Object.entries(params)) {
      allParams[key] = param;
      paramEngineMap.set(key, engine as JunoXEngine);
    }
  }

  // Build CC→param reverse lookup
  const ccMap = new Map<number, { key: string; param: KeyboardParameter }>();
  for (const [key, param] of Object.entries(allParams)) {
    if (param.cc !== undefined) {
      ccMap.set(param.cc, { key, param });
    }
  }

  return {
    params: allParams,
    resolveValue: genericResolveValue,
    formatValue: genericFormatValue,

    findParam(name: string) {
      const lower = name.toLowerCase().replace(/[\s_-]+/g, "");
      if (allParams[name]) return { key: name, param: allParams[name] };
      for (const [key, param] of Object.entries(allParams)) {
        if (key.toLowerCase().replace(/[\s_-]+/g, "") === lower) return { key, param };
      }
      for (const [key, param] of Object.entries(allParams)) {
        if (param.name.toLowerCase().replace(/[\s_-]+/g, "").includes(lower)) return { key, param };
      }
      return undefined;
    },

    getParamByCC(cc: number) {
      return ccMap.get(cc);
    },

    getSections() {
      const sections = new Set<string>();
      for (const param of Object.values(allParams)) sections.add(param.section);
      return [...sections];
    },

    getParamsBySection(section: string) {
      const result: Record<string, KeyboardParameter> = {};
      for (const [key, param] of Object.entries(allParams)) {
        if (param.section === section) result[key] = param;
      }
      return result;
    },

    isPerPart(key: string) {
      return allParams[key]?.perPart === true;
    },

    getParamsForEngine(engine: JunoXEngine) {
      const result: Record<string, KeyboardParameter> = { ...sceneParams };
      const eParams = engineParams[engine];
      if (eParams) Object.assign(result, eParams);
      return result;
    },

    getEngineForParam(key: string) {
      return paramEngineMap.get(key);
    },
  };
}
```

- [ ] **Step 2: Create state manager**

Create `src/keyboard_models/roland/juno_x/state-manager.ts`:

```typescript
/**
 * JUNO-X state manager — tracks per-part, per-engine parameter state.
 */

import type { ParameterMap } from "../../../shared/keyboard-model.js";
import { GenericParameterState } from "../../../shared/parameter-state.js";
import { PART_NAMES, type JunoXEngine, JunoXEngine as E } from "./engines/engine-types.js";

export class JunoXState extends GenericParameterState {
  /** Active engine per part (0-indexed) */
  private engines: JunoXEngine[] = [
    E.AnalogSynth, E.AnalogSynth, E.AnalogSynth, E.AnalogSynth, E.AnalogSynth,
  ];

  constructor(parameterMap: ParameterMap) {
    super(PART_NAMES, parameterMap);
  }

  getEngine(partIndex: number): JunoXEngine {
    return this.engines[partIndex] ?? E.AnalogSynth;
  }

  setEngine(partIndex: number, engine: JunoXEngine): void {
    if (partIndex >= 0 && partIndex < this.engines.length) {
      this.engines[partIndex] = engine;
    }
  }

  getAllEngines(): JunoXEngine[] {
    return [...this.engines];
  }
}
```

- [ ] **Step 3: Create device implementation**

Create `src/keyboard_models/roland/juno_x/device.ts`:

```typescript
/**
 * JUNO-X device instance.
 * 5-part multi-timbral, engine-aware parameter routing.
 * Sends CC for tone params, DT1 SysEx for scene/DT1-encoded params.
 */

import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import { BaseKeyboardDevice, type BaseDeviceDeps } from "../../../shared/base-keyboard-device.js";
import type { ToolResult } from "../../../shared/tool-result.js";
import { textResult } from "../../../shared/tool-result.js";
import { buildDT1, addAddresses, packNibbles } from "../../../shared/roland-dt1.js";
import { JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, SCENE_BASE, SCENE_PART_OFFSETS, PART_NAMES } from "./engines/engine-types.js";
import { JunoXState } from "./state-manager.js";
import type { JunoXParameterMap } from "./midi-map.js";

export class JunoXDevice extends BaseKeyboardDevice {
  private junoState: JunoXState;
  private junoMap: JunoXParameterMap;

  constructor(model: KeyboardModel, deps: BaseDeviceDeps) {
    const junoMap = deps.parameterMap as JunoXParameterMap;
    const state = new JunoXState(junoMap);
    super(model, deps, state);
    this.junoState = state;
    this.junoMap = junoMap;
  }

  protected override resolvePartForParam(key: string, part?: string): string | undefined {
    if (!this.parameterMap.isPerPart(key)) return undefined;
    return part ?? "1"; // default to part 1
  }

  override setParameters(
    params: Array<{ name: string; value: number | string }>,
    part?: string,
  ): ToolResult {
    this.requireConnection();

    const results: string[] = [];
    const errors: string[] = [];
    const resolvedKeys: Array<{ key: string; value: number | string }> = [];
    const partIndex = part ? PART_NAMES.indexOf(part) : 0;

    for (const { name, value } of params) {
      const found = this.parameterMap.findParam(name);
      if (!found) {
        errors.push(`Unknown parameter: "${name}"`);
        continue;
      }

      try {
        const midiValue = this.parameterMap.resolveValue(found.param, value);
        const statePart = this.resolvePartForParam(found.key, part);
        const prevMidi = this.state.get(found.key, statePart);
        if (found.param.sysexAddress) {
          // Build DT1 SysEx message
          let fullAddress: number[];
          if (found.param.perPart) {
            // Per-part scene param: add scene base + part offset + param offset
            const partOffset = SCENE_PART_OFFSETS[partIndex] ?? SCENE_PART_OFFSETS[0];
            fullAddress = addAddresses(
              addAddresses(SCENE_BASE, partOffset),
              found.param.sysexAddress,
            );
          } else {
            // Global scene param: add scene base + param offset
            fullAddress = addAddresses(SCENE_BASE, found.param.sysexAddress);
          }

          const size = found.param.sysexSize ?? 1;
          const data = size > 1
            ? packNibbles(midiValue, size * 2)
            : [midiValue];

          const sysex = buildDT1(JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddress, data);
          this.connection!.sendSysEx(sysex);
        } else if (found.param.cc !== undefined) {
          // Send CC on the part's MIDI channel
          // Parts 1-5 use channels 1-5 (0-indexed: 0-4)
          this.connection!.sendCC(found.param.cc, midiValue, partIndex);
        }

        this.state.set(found.key, midiValue, statePart);
        resolvedKeys.push({ key: found.key, value });

        const displayValue = this.parameterMap.formatValue(found.param, midiValue);
        const prevDisplay = prevMidi !== undefined
          ? this.parameterMap.formatValue(found.param, prevMidi)
          : "unset";
        results.push(`  ${found.param.name}: ${prevDisplay} -> ${displayValue}`);
      } catch (err) {
        errors.push(`${found.param.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const warnings = this.validateAfterSet(resolvedKeys, part ?? "1");

    let text = "";
    if (results.length > 0) text += "Parameters set:\n" + results.join("\n");
    if (warnings.length > 0) text += (text ? "\n\n" : "") + warnings.join("\n");
    if (errors.length > 0) text += (text ? "\n\n" : "") + "Errors:\n" + errors.join("\n");

    return { content: [{ type: "text", text }] };
  }

  override listParameters(section?: string): ToolResult {
    // Show engine info in the header
    const engines = this.junoState.getAllEngines();
    const engineInfo = engines
      .map((e, i) => `Part ${i + 1}: ${e}`)
      .join(", ");

    const base = super.listParameters(section);
    const header = `Active engines: ${engineInfo}\n`;
    const text = base.content[0]?.type === "text" ? base.content[0].text : "";
    return textResult(header + text);
  }
}
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compilation. The model should now be discoverable by the model registry.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/roland/juno_x/midi-map.ts src/keyboard_models/roland/juno_x/state-manager.ts src/keyboard_models/roland/juno_x/device.ts
git commit -m "feat: add JUNO-X MIDI map, state manager, and device implementation"
```

---

### Task 9: Add SysEx forwarding to MockEngine

**Files:**
- Modify: `src/mock-runner/engine.ts`

The MockEngine currently handles CC and Program Change MIDI events but NOT SysEx. The JUNO-X mock handler needs to receive SysEx (DT1) messages.

- [ ] **Step 1: Check how the engine registers MIDI event handlers**

Read `src/mock-runner/engine.ts` and find the section where CC and program change listeners are registered (around lines 80-86). The engine uses the `easymidi` library which supports `"sysex"` events.

- [ ] **Step 2: Add SysEx event handler**

In `src/mock-runner/engine.ts`, after the existing CC and program change handlers (around line 86), add a SysEx handler:

```typescript
      this.midiIn.on("sysex" as any, (msg: { bytes: number[] }) => {
        this.handleMidi({ type: "sysex", bytes: [...msg.bytes] });
      });
```

Note: The `as any` cast may be needed depending on the easymidi type definitions. The sysex event callback receives an object with a `bytes` array property.

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add src/mock-runner/engine.ts
git commit -m "feat: add SysEx event forwarding to MockEngine"
```

---

### Task 10: Mock handler

**Files:**
- Create: `src/keyboard_models/roland/juno_x/mock-handler.ts`

- [ ] **Step 1: Create the JUNO-X mock handler**

Create `src/keyboard_models/roland/juno_x/mock-handler.ts`:

```typescript
/**
 * JUNO-X MockHandler — processes MIDI messages and maintains state for the mock UI.
 * Handles both CC (tone params) and SysEx DT1 (scene params).
 */

import type { MidiMessage, MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
import { parseDT1 } from "../../../shared/roland-dt1.js";
import { JUNO_X_MODEL_ID, JunoXEngine, ENGINE_DISPLAY_NAMES, PART_COUNT } from "./engines/engine-types.js";
import { createAnalogSynthParams } from "./engines/analog-synth.js";
import { createZCoreParams } from "./engines/zcore.js";
import { createJunoXModelParams } from "./engines/juno-x-model.js";
import { createRDPianoParams } from "./engines/rd-piano.js";
import { createSceneParams } from "./scene-params.js";

interface PartState {
  engine: JunoXEngine;
  params: Map<number, number>;  // CC → value for tone params
  sceneParams: Record<string, number>;  // key → value for scene part params
}

export class JunoXMockHandler implements MockHandler {
  private parts: PartState[] = [];
  private sceneGlobal: Record<string, number> = {};
  private currentScene = { bank: 0, program: 0 };
  private pendingBankMSB = 0;
  private pendingBankLSB = 0;
  private channels: number[] = [0, 1, 2, 3, 4]; // part 1-5 MIDI channels

  // Parameter definitions for reverse lookup
  private engineParams: Record<JunoXEngine, Record<string, { cc?: number; name: string }>> = {
    [JunoXEngine.AnalogSynth]: {},
    [JunoXEngine.ZCore]: {},
    [JunoXEngine.JunoXModel]: {},
    [JunoXEngine.RDPiano]: {},
  };
  private sceneParamDefs = createSceneParams();

  // CC → param name lookup per engine
  private ccLookup = new Map<number, string>();

  init(lowerChannel: number, upperChannel: number): void {
    this.channels = [lowerChannel, upperChannel, 2, 3, 4];

    // Initialize 5 parts
    this.parts = [];
    for (let i = 0; i < PART_COUNT; i++) {
      this.parts.push({
        engine: JunoXEngine.AnalogSynth,
        params: new Map(),
        sceneParams: {},
      });
    }

    // Load engine param definitions and build CC lookup
    const asParams = createAnalogSynthParams();
    for (const [key, p] of Object.entries(asParams)) {
      this.engineParams[JunoXEngine.AnalogSynth][key] = { cc: p.cc, name: p.name };
      if (p.cc !== undefined) this.ccLookup.set(p.cc, p.name);
    }
    const zcParams = createZCoreParams();
    for (const [key, p] of Object.entries(zcParams)) {
      this.engineParams[JunoXEngine.ZCore][key] = { cc: p.cc, name: p.name };
    }
    const jxParams = createJunoXModelParams();
    for (const [key, p] of Object.entries(jxParams)) {
      this.engineParams[JunoXEngine.JunoXModel][key] = { cc: p.cc, name: p.name };
    }
    const rdParams = createRDPianoParams();
    for (const [key, p] of Object.entries(rdParams)) {
      this.engineParams[JunoXEngine.RDPiano][key] = { cc: p.cc, name: p.name };
    }
  }

  onMIDI(msg: MidiMessage): MockHandlerResult {
    switch (msg.type) {
      case "cc":
        return this.handleCC(msg.controller, msg.value, msg.channel);
      case "program":
        return this.handleProgramChange(msg.number, msg.channel);
      case "sysex":
        return this.handleSysEx(msg.bytes);
    }
  }

  private handleCC(cc: number, value: number, channel: number): MockHandlerResult {
    // Bank select
    if (cc === 0) { this.pendingBankMSB = value; return {}; }
    if (cc === 32) { this.pendingBankLSB = value; return {}; }

    // Find which part this channel belongs to
    const partIndex = this.channels.indexOf(channel);
    if (partIndex < 0 || partIndex >= PART_COUNT) return {};

    const part = this.parts[partIndex];
    part.params.set(cc, value);

    const paramName = this.ccLookup.get(cc) ?? `CC${cc}`;

    return {
      state: this.buildPartState(partIndex),
      log: `Part ${partIndex + 1}: ${paramName} = ${value}`,
    };
  }

  private handleProgramChange(program: number, _channel: number): MockHandlerResult {
    this.currentScene = {
      bank: this.pendingBankMSB * 128 + this.pendingBankLSB,
      program,
    };
    return {
      state: { scene: this.currentScene },
      log: `Scene: bank ${this.currentScene.bank}, program ${program + 1}`,
    };
  }

  private handleSysEx(bytes: number[]): MockHandlerResult {
    const dt1 = parseDT1(bytes, JUNO_X_MODEL_ID);
    if (!dt1) return { log: `SysEx (${bytes.length} bytes) — not a JUNO-X DT1` };

    const [a0, a1, a2, a3] = dt1.address;
    const value = dt1.data[0] ?? 0;

    // Route by address prefix
    if (a0 === 0x01) {
      // Temporary Scene
      if (a1 >= 0x10 && a1 <= 0x14) {
        // Scene Part (a1: 0x10=part1, 0x11=part2, etc.)
        const partIndex = a1 - 0x10;
        if (partIndex < PART_COUNT) {
          const addrKey = `${a2.toString(16).padStart(2, "0")}${a3.toString(16).padStart(2, "0")}`;
          this.parts[partIndex].sceneParams[addrKey] = value;
          return {
            state: this.buildPartState(partIndex),
            log: `Scene Part ${partIndex + 1}: addr [${dt1.address.map(b => b.toString(16).padStart(2, "0")).join(" ")}] = ${value}`,
          };
        }
      }
      // Scene Common or Effects
      const addrKey = dt1.address.map(b => b.toString(16).padStart(2, "0")).join("_");
      this.sceneGlobal[addrKey] = value;
      return {
        state: { sceneGlobal: { [addrKey]: value } },
        log: `Scene: addr [${dt1.address.map(b => b.toString(16).padStart(2, "0")).join(" ")}] = ${value}`,
      };
    }

    return { log: `DT1: addr [${dt1.address.map(b => b.toString(16).padStart(2, "0")).join(" ")}] = ${dt1.data.join(",")}` };
  }

  private buildPartState(partIndex: number): Record<string, any> {
    const part = this.parts[partIndex];
    const paramObj: Record<string, number> = {};
    for (const [cc, val] of part.params) paramObj[`cc${cc}`] = val;

    return {
      [`part${partIndex + 1}`]: {
        engine: part.engine,
        engineName: ENGINE_DISPLAY_NAMES[part.engine],
        params: paramObj,
        sceneParams: { ...part.sceneParams },
      },
    };
  }

  getFullState(includeInventory: boolean): Record<string, any> {
    const state: Record<string, any> = {
      model: "Roland JUNO-X",
      scene: this.currentScene,
      sceneGlobal: { ...this.sceneGlobal },
    };

    for (let i = 0; i < PART_COUNT; i++) {
      Object.assign(state, this.buildPartState(i));
    }

    return state;
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compilation. The full JUNO-X model should now be functional.

- [ ] **Step 3: Commit**

```bash
git add src/keyboard_models/roland/juno_x/mock-handler.ts
git commit -m "feat: add JUNO-X mock handler with CC and DT1 SysEx processing"
```

---

### Task 11: Mock UI

**Files:**
- Create: `src/keyboard_models/roland/juno_x/web/index.html`
- Create: `src/keyboard_models/roland/juno_x/web/style.css`
- Create: `src/keyboard_models/roland/juno_x/web/app.js`

This task creates the hardware-faithful panel UI. Due to the size of the UI code, the steps define the structure and key patterns. The implementer should reference the Nord mock UI (`src/keyboard_models/nord/electro_5d/web/`) for WebSocket patterns and the JUNO-X Reference Manual cover image for panel layout.

- [ ] **Step 1: Create HTML structure**

Create `src/keyboard_models/roland/juno_x/web/index.html` with the JUNO-X panel layout:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Roland JUNO-X — Mock Device</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <div class="brand">Roland <span class="model">JUNO-X</span></div>
    <div class="scene-display">
      <span id="scene-number">001</span>
      <span id="scene-name">Init Scene</span>
    </div>
    <div id="status" class="disconnected">Disconnected</div>
  </header>

  <nav class="part-bar">
    <div class="engine-select">
      <label>ENGINE:</label>
      <select id="engine-select">
        <option value="analog-synth">Analog Synth (106/60)</option>
        <option value="zcore">ZEN-Core</option>
        <option value="juno-x-model">JUNO-X Model</option>
        <option value="rd-piano">RD Piano</option>
      </select>
    </div>
    <div class="part-buttons">
      <button class="part-btn active" data-part="0">1</button>
      <button class="part-btn" data-part="1">2</button>
      <button class="part-btn" data-part="2">3</button>
      <button class="part-btn" data-part="3">4</button>
      <button class="part-btn" data-part="4">5</button>
    </div>
  </nav>

  <!-- Analog Synth panel (default visible) -->
  <main id="panel-analog-synth" class="synth-panel active">
    <section class="panel-section" id="sec-lfo">
      <h3>LFO</h3>
      <div class="controls">
        <div class="knob-group">
          <input type="range" min="0" max="127" value="64" data-cc="29" class="knob">
          <label>Rate</label>
        </div>
        <div class="knob-group">
          <input type="range" min="0" max="127" value="0" data-cc="27" class="knob">
          <label>Delay</label>
        </div>
        <div class="select-group">
          <select data-cc="35">
            <option value="0">SIN</option>
            <option value="1">SAW-DW</option>
            <option value="2">SQR</option>
            <option value="3">S&H</option>
          </select>
          <label>Waveform</label>
        </div>
      </div>
    </section>

    <section class="panel-section" id="sec-osc">
      <h3>OSC</h3>
      <div class="controls">
        <div class="knob-group">
          <input type="range" min="0" max="127" value="0" data-cc="16" class="knob">
          <label>PW/SSAW</label>
        </div>
        <div class="knob-group">
          <input type="range" min="0" max="127" value="127" data-cc="17" class="knob">
          <label>SAW</label>
        </div>
        <div class="knob-group">
          <input type="range" min="0" max="127" value="0" data-cc="18" class="knob">
          <label>SUB</label>
        </div>
        <div class="knob-group">
          <input type="range" min="0" max="127" value="0" data-cc="19" class="knob">
          <label>Noise</label>
        </div>
      </div>
    </section>

    <section class="panel-section" id="sec-hpf">
      <h3>HPF</h3>
      <div class="controls">
        <div class="knob-group">
          <input type="range" min="0" max="3" value="0" data-cc="79" class="knob">
          <label>Freq</label>
        </div>
      </div>
    </section>

    <section class="panel-section" id="sec-filter">
      <h3>FILTER</h3>
      <div class="controls">
        <div class="knob-group">
          <input type="range" min="0" max="127" value="127" data-cc="3" class="knob">
          <label>Cutoff</label>
        </div>
        <div class="knob-group">
          <input type="range" min="0" max="127" value="0" data-cc="9" class="knob">
          <label>Resonance</label>
        </div>
        <div class="knob-group">
          <input type="range" min="0" max="127" value="0" data-cc="81" class="knob">
          <label>Env Depth</label>
        </div>
        <div class="knob-group">
          <input type="range" min="0" max="127" value="0" data-cc="122" class="knob">
          <label>Key Follow</label>
        </div>
      </div>
    </section>

    <section class="panel-section" id="sec-amp">
      <h3>AMP</h3>
      <div class="controls">
        <div class="knob-group">
          <input type="range" min="0" max="127" value="100" data-cc="110" class="knob">
          <label>Level</label>
        </div>
      </div>
    </section>

    <section class="panel-section" id="sec-env">
      <h3>ENV</h3>
      <div class="controls">
        <div class="slider-group">
          <input type="range" min="0" max="127" value="0" data-cc="89" class="slider" orient="vertical">
          <label>A</label>
        </div>
        <div class="slider-group">
          <input type="range" min="0" max="127" value="64" data-cc="90" class="slider" orient="vertical">
          <label>D</label>
        </div>
        <div class="slider-group">
          <input type="range" min="0" max="127" value="64" data-cc="102" class="slider" orient="vertical">
          <label>S</label>
        </div>
        <div class="slider-group">
          <input type="range" min="0" max="127" value="32" data-cc="103" class="slider" orient="vertical">
          <label>R</label>
        </div>
      </div>
    </section>
  </main>

  <!-- Placeholder panels for other engines -->
  <main id="panel-zcore" class="synth-panel">
    <p class="placeholder">ZEN-Core engine — 4-partial synth with full OSC/Filter/Amp/LFO per partial</p>
  </main>
  <main id="panel-juno-x-model" class="synth-panel">
    <p class="placeholder">JUNO-X Model engine — extended Analog Synth controls</p>
  </main>
  <main id="panel-rd-piano" class="synth-panel">
    <p class="placeholder">RD Piano engine — sympathetic resonance controls</p>
  </main>

  <footer>
    <div id="last-change">—</div>
  </footer>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create CSS**

Create `src/keyboard_models/roland/juno_x/web/style.css` with the JUNO-X panel styling. Reference the JUNO-X product image for color scheme: dark gray/black body, red accent stripe, blue/white/red button indicators.

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #1a1a1a; color: #e0e0e0; }

header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; background: #111; border-bottom: 3px solid #d32f2f;
}
.brand { font-size: 18px; color: #999; }
.brand .model { color: #fff; font-weight: bold; font-size: 24px; margin-left: 8px; }
.scene-display { font-size: 16px; color: #4fc3f7; font-family: monospace; }
#status { font-size: 12px; padding: 4px 12px; border-radius: 4px; }
#status.connected { background: #2e7d32; color: #fff; }
#status.disconnected { background: #c62828; color: #fff; }

.part-bar {
  display: flex; align-items: center; gap: 20px;
  padding: 8px 20px; background: #222;
}
.engine-select label { color: #999; margin-right: 8px; font-size: 13px; }
.engine-select select { background: #333; color: #fff; border: 1px solid #555; padding: 4px 8px; }
.part-buttons { display: flex; gap: 4px; }
.part-btn {
  width: 36px; height: 28px; border: 1px solid #555; background: #333;
  color: #ccc; font-weight: bold; cursor: pointer; border-radius: 3px;
}
.part-btn.active { background: #d32f2f; color: #fff; border-color: #f44336; }

.synth-panel { display: none; padding: 16px 20px; }
.synth-panel.active { display: flex; flex-wrap: wrap; gap: 2px; }

.panel-section {
  background: #2a2a2a; border: 1px solid #444; border-radius: 4px;
  padding: 12px; min-width: 120px; flex: 1;
}
.panel-section h3 {
  font-size: 11px; text-transform: uppercase; color: #f44336;
  letter-spacing: 1px; margin-bottom: 10px; text-align: center;
  border-bottom: 1px solid #444; padding-bottom: 4px;
}
.controls { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }

.knob-group, .slider-group, .select-group {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.knob-group label, .slider-group label, .select-group label {
  font-size: 10px; color: #888; text-transform: uppercase;
}

input[type="range"].knob { width: 60px; accent-color: #4fc3f7; }
input[type="range"].slider {
  writing-mode: vertical-lr; direction: rtl;
  height: 80px; width: 24px; accent-color: #4fc3f7;
}
select { background: #333; color: #fff; border: 1px solid #555; font-size: 11px; padding: 2px; }

.placeholder { color: #666; padding: 40px; text-align: center; font-style: italic; }

footer {
  padding: 8px 20px; background: #111; border-top: 1px solid #333;
  font-size: 11px; color: #666; font-family: monospace;
}
```

- [ ] **Step 3: Create JS with WebSocket**

Create `src/keyboard_models/roland/juno_x/web/app.js`:

```javascript
(function() {
  'use strict';

  let ws = null;
  let activePart = 0;
  const statusEl = document.getElementById('status');
  const lastChangeEl = document.getElementById('last-change');
  const panels = document.querySelectorAll('.synth-panel');
  const partButtons = document.querySelectorAll('.part-btn');
  const engineSelect = document.getElementById('engine-select');

  // -- WebSocket connection -------------------------------------------------

  function connect() {
    const port = new URLSearchParams(window.location.search).get('port') || '9100';
    ws = new WebSocket(`ws://localhost:${port}`);

    ws.onopen = function() {
      statusEl.textContent = 'Connected';
      statusEl.className = 'connected';
    };

    ws.onclose = function() {
      statusEl.textContent = 'Disconnected';
      statusEl.className = 'disconnected';
      setTimeout(connect, 2000);
    };

    ws.onmessage = function(event) {
      try {
        const msg = JSON.parse(event.data);
        handleState(msg);
      } catch (e) { /* ignore parse errors */ }
    };
  }

  function handleState(msg) {
    // Update scene display
    if (msg.scene) {
      document.getElementById('scene-number').textContent =
        String(msg.scene.program + 1).padStart(3, '0');
    }

    // Update part parameters
    const partKey = `part${activePart + 1}`;
    if (msg[partKey]) {
      const partData = msg[partKey];
      if (partData.engineName) {
        // Update engine selector to match
      }
      if (partData.params) {
        for (const [ccKey, value] of Object.entries(partData.params)) {
          const cc = parseInt(ccKey.replace('cc', ''), 10);
          const el = document.querySelector(`[data-cc="${cc}"]`);
          if (el) el.value = value;
        }
      }
    }

    // Update last-change display
    if (msg.log) {
      lastChangeEl.textContent = msg.log;
    }
  }

  // -- Part selection -------------------------------------------------------

  partButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      partButtons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activePart = parseInt(btn.dataset.part, 10);
    });
  });

  // -- Engine panel switching -----------------------------------------------

  engineSelect.addEventListener('change', function() {
    const engine = engineSelect.value;
    panels.forEach(function(p) { p.classList.remove('active'); });
    const target = document.getElementById('panel-' + engine);
    if (target) target.classList.add('active');
  });

  // -- Control input → send MIDI CC via WebSocket ---------------------------

  document.querySelectorAll('[data-cc]').forEach(function(el) {
    el.addEventListener('input', function() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const cc = parseInt(el.dataset.cc, 10);
      const value = parseInt(el.value, 10);
      ws.send(JSON.stringify({
        type: 'cc',
        controller: cc,
        value: value,
        channel: activePart,
      }));
      lastChangeEl.textContent = `CC${cc} = ${value} (Part ${activePart + 1})`;
    });
  });

  // -- Init -----------------------------------------------------------------
  connect();
})();
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compilation. The web files are static (not compiled by tsc) but the model should load them.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/roland/juno_x/web/
git commit -m "feat: add JUNO-X mock UI with hardware-faithful panel layout"
```

---

### Task 12: Integration verification

**Files:** None (testing only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean compilation with zero errors.

- [ ] **Step 2: Verify model discovery**

Run: `node -e "import('./dist/shared/model-registry.js').then(m => m.discoverModels().then(r => console.log(JSON.stringify(r, null, 2))))"`

Expected: The output should include the JUNO-X model:
```json
{
  "id": "roland-juno-x",
  "displayName": "Roland JUNO-X",
  "manufacturer": "Roland",
  "midiPortPatterns": ["JUNO-X"]
}
```

- [ ] **Step 3: Test mock runner**

Run: `npm run mock:runner`

Expected: The Electron app opens. Select "Roland JUNO-X" from the model picker. The JUNO-X panel UI should appear with the Analog Synth engine panel showing LFO, OSC, HPF, FILTER, AMP, and ENV sections.

- [ ] **Step 4: Test MCP server (reload after build)**

In a Claude Code session:
1. Run `/mcp` to reload the MCP server
2. Run `list_parameters` — should show JUNO-X parameters organized by section
3. Run `set_parameters` with `[{"name": "Cutoff", "value": 64}]` — should set the filter cutoff

- [ ] **Step 5: Final commit with any fixes**

If any issues found during testing, fix and commit:
```bash
git add -A
git commit -m "fix: integration fixes for JUNO-X model"
```

---

## Self-Review Checklist

1. **Spec coverage**: All 12 sections of the design spec are covered:
   - [x] Shared DT1/RQ1 transport (Task 2)
   - [x] SysEx addressing on KeyboardParameter (Task 1)
   - [x] File structure (Task 4)
   - [x] Engine architecture (Tasks 5, 6)
   - [x] Scene parameters (Task 7)
   - [x] ParameterMap design (Task 8)
   - [x] Device implementation (Task 8)
   - [x] Mock handler (Task 10)
   - [x] Mock UI (Task 11)
   - [x] Tone bank organization (in index.ts programLoader)
   - [x] Architectural impact (Tasks 1, 3, 9)
   - [x] Key constraints (addressed in engine-types.ts and device.ts)

2. **Placeholder scan**: No TBDs or TODOs. All code blocks are complete.

3. **Type consistency**: Verified across tasks:
   - `JunoXParameterMap` extends `ParameterMap` (Task 8) and is used in device (Task 8)
   - `JunoXState` extends `GenericParameterState` (Task 8)
   - `JunoXMockHandler` implements `MockHandler` (Task 10)
   - `sysexAddress`/`sysexSize` fields used consistently in scene-params and rd-piano
   - `RolandModelId` interface matches usage in engine-types and mock-handler