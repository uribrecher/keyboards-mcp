/**
 * Sequential Circuits Prophet-6 keyboard model.
 * Implements the KeyboardModel interface for the MCP server.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import { createParameterMap } from "./midi-map.js";
import { Prophet6Device } from "./device.js";
import { createProphet6MockHandler } from "./mock-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const parameterMap = createParameterMap();

const model: KeyboardModel = {
  info: {
    id: "sequential-prophet-6",
    displayName: "Prophet-6",
    manufacturer: "Sequential Circuits",
    midiPortPatterns: ["prophet", "sequential", "dsi"],
  },

  agentSystemPrompt: `KEYBOARD: Sequential Circuits Prophet-6

The Prophet-6 is a 6-voice polyphonic analog synthesizer with a classic subtractive synthesis signal path.

SIGNAL PATH:

  ┌──────────────────────────────────────┐
  │           POLY MOD                   │
  │  Filter Env → Osc 1 Freq / PW       │
  │  Osc 2 → Osc 1 Freq / PW / LP Freq │
  └──────────────┬───────────────────────┘
                 │ (modulation)
  ┌──────────────┴───────────────────────┐
  │          OSCILLATORS                 │
  │  VCO 1: Saw / Pulse / PW            │
  │  VCO 2: Saw / Pulse / PW / Fine     │
  │  Sub Osc (square, 1 oct below VCO1) │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────┴───────────────────────┐
  │            MIXER                     │
  │  Osc 1 Level, Osc 2 Level,          │
  │  Sub Osc Level, Noise               │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────┴───────────────────────┐
  │        LOW-PASS FILTER (VCF)         │
  │  4-pole transistor ladder filter     │
  │  Cutoff, Resonance, Key Track,      │
  │  Velocity, Env Amount               │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────┴───────────────────────┐
  │       HIGH-PASS FILTER               │
  │  2-pole OTA filter                   │
  │  Cutoff, Resonance, Key Track,       │
  │  Velocity, Env Amount               │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────┴───────────────────────┐
  │         AMPLIFIER (VCA)              │
  │  Env Amount, Velocity Amount         │
  │  ADSR Envelope                       │
  └──────────────┬───────────────────────┘
                 │
  ┌──────────────┴───────────────────────┐
  │          EFFECTS                     │
  │  Distortion (analog)                 │
  │  Bucket-brigade delay                │
  │  Stereo chorus / phase shifter       │
  └──────────────┬───────────────────────┘
                 │
              OUTPUT

ENVELOPES:
- Filter Envelope (ADSR): Controls LP and HP filter cutoff modulation
- VCA Envelope (ADSR): Controls the amplifier volume shape

LFO:
- Single LFO with multiple shapes
- Routes to oscillator pitch, pulse width, filter cutoff, and amplifier

POLY MOD:
- Routes Filter Envelope and Osc 2 as modulation sources
- Destinations: Osc 1 Frequency, Osc 1 Pulse Width, LP Filter Cutoff

ARPEGGIATOR:
- Modes: Up, Down, Up/Down, Random, Assign
- Range: 1-3 octaves
- Syncable to BPM

NOTES:
- Mono-timbral: single sound engine, no split or layer
- 6 voices of polyphony
- True analog signal path (VCOs, VCF, VCA)
- The low-pass filter is a 4-pole (24 dB/oct) transistor ladder design
- The high-pass filter is a 2-pole (12 dB/oct) OTA design`,

  // Web UI files live in src/, not dist/
  mockUiDir: join(__dirname, "..", "..", "..", "..", "src", "keyboard_models", "sequential_circuits", "prophet_6", "web"),

  createDevice() {
    return new Prophet6Device(model, {
      parameterMap,
      systemPromptTemplate: model.agentSystemPrompt,
    });
  },

  createMockHandler() {
    return createProphet6MockHandler();
  },
};

export default model;
