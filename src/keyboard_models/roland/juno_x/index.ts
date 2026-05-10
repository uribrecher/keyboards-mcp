/**
 * Roland JUNO-X keyboard model.
 * Implements the KeyboardModel interface for the MCP server.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import { createParameterMap } from "./midi-map.js";
import { createJunoXCodec } from "./midi-codec.js";
import { JunoXDevice } from "./device.js";
import { JunoXMockHandler } from "./mock-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const parameterMap = createParameterMap();

const model: KeyboardModel = {
  info: {
    id: "roland-juno-x",
    displayName: "Roland JUNO-X",
    manufacturer: "Roland",
    midiPortPatterns: ["JUNO-X"],
  },

  agentSystemPrompt: `KEYBOARD: Roland JUNO-X

STATE & MEMORY:
The MCP is stateless on parameter values — it does not shadow what was sent. The JUNO-X is queryable via Roland Data Request 1 (RQ1) sysex: \`get_current_state\` issues live RQ1s and renders the device's actual values. Currently supports the scene-effect sections — \`scene-chorus\`, \`scene-delay\`, \`scene-reverb\`, \`scene-drive\`. Other sections (scene-common, scene-part, scene-modify, partials, etc.) return a "not yet supported" message; those are explicit follow-ups. Treat the response as ground truth for "what is on the device right now" — including changes you didn't make (front-panel knob turns, scene loads). Use \`get_current_state\` to verify, not to remember; you still own intent across turns.

The JUNO-X is a 5-part multi-timbral synthesizer with four distinct sound engines, a classic JUNO panel interface, and a scene-based patch system.

ENGINES:
- ZEN-Core: Roland's modern synthesis platform; versatile digital synthesis
- Analog Synth (106/60): Models of the classic JUNO-106 and JUNO-60 analog synth circuits
- RD Piano: Electric piano engine drawn from the RD-series stage pianos
- JUNO-X Model: Extended JUNO-style modeling with additional waveforms and modulation

ARCHITECTURE:
- 5 Parts per Scene, each independently assignable to any engine
- Scene-based program system: a Scene holds all 5 parts plus effect settings
- Per-scene effects: Chorus, Delay, Reverb, Drive (all SysEx-addressed)
- Classic JUNO panel controls map to the active part's engine parameters

SIGNAL PATH (per part):

  ┌──────────────────────────────────────┐
  │          TONE ENGINE                 │
  │  ZEN-Core / Analog Synth /          │
  │  RD Piano / JUNO-X Model            │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────┴───────────────────────┐
  │          PART MIXER                  │
  │  Level, Pan, Octave Shift            │
  │  Key Range, Receive Channel          │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────┴───────────────────────┐
  │        SCENE EFFECTS                 │
  │  Chorus → Delay → Reverb → Drive    │
  └──────────────┬───────────────────────┘
                 │
              OUTPUT

PROGRAM LOADING:
- Programs are Scenes stored in banks
- Bank Select MSB=85, LSB=bank-1, then Program Change (slot-1)
- Banks and slots are 1-based on the hardware display

NOTES:
- Each part can use a different engine — e.g., part 1 analog lead, part 2 RD piano, part 3 ZEN-Core pad
- The JUNO panel always edits the currently selected part
- SysEx (Roland DT1 protocol) is used for parameter access; CC is used for real-time control`,

  // Web UI files live in src/, not dist/ — tsc doesn't copy non-TS files
  mockUiDir: join(__dirname, "..", "..", "..", "..", "src", "keyboard_models", "roland", "juno_x", "web"),

  programLoader: {
    loadProgram(midi, bank, slot) {
      midi.sendCC(0, 85);       // Bank Select MSB = 85
      midi.sendCC(32, bank - 1); // Bank Select LSB = bank - 1
      midi.sendProgramChange(slot - 1); // Program Change = slot - 1
    },
    bankRange: { min: 1, max: 16 },
    slotRange: { min: 1, max: 128 },
  },

  createDevice() {
    return new JunoXDevice(model, {
      parameterMap,
      systemPromptTemplate: model.agentSystemPrompt,
    });
  },

  createCodec() {
    return createJunoXCodec();
  },

  createMockHandler() {
    return new JunoXMockHandler();
  },
};

export default model;
