/**
 * Nord Electro 5D keyboard model.
 * Implements the KeyboardModel interface for the MCP server.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import type { MidiSender } from "../../../shared/midi-sender.js";
import { NordElectro5DDevice } from "./device.js";
import { createParameterMap } from "./midi-map.js";
import { createBackupCache } from "./backup-cache.js";
import {
  detectBackup,
  parseBackup,
  parseProgramsFolder,
  formatBackupAsMarkdown,
  type BackupMetadata,
} from "./backup-parser.js";
import { createNordElectro5DMockHandler } from "./mock-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const parameterMap = createParameterMap();

const model: KeyboardModel = {
  info: {
    id: "nord-electro-5d",
    displayName: "Nord Electro 5D",
    manufacturer: "Nord",
    midiPortPatterns: ["nord"],
  },

  backup: {
    async detectBackup(filePath: string) {
      return detectBackup(filePath);
    },
    async parseBackup(filePath: string) {
      return parseBackup(filePath);
    },
    async parseProgramsFolder(folderPath: string) {
      return { programs: parseProgramsFolder(folderPath) } as unknown as BackupMetadata;
    },
    formatAsMarkdown(data, date?) {
      return formatBackupAsMarkdown(data as BackupMetadata, date);
    },
  },

  programLoader: {
    loadProgram(midi: MidiSender, bank: number, slot: number) {
      midi.sendCC(0, 0);
      midi.sendCC(32, bank - 1);
      midi.sendProgramChange(slot - 1);
    },
    bankRange: { min: 1, max: 5 },
    slotRange: { min: 1, max: 50 },
  },

  songLoader: {
    async loadSong(midi: MidiSender, bank: number, slot: number, part?: string) {
      const partLabels = ["A", "B", "C", "D"];
      const partIndex = partLabels.indexOf(part ?? "A");
      const partMidiValues = [0, 43, 85, 127];

      await midi.sendCCBatch([
        { controller: 48, value: 127 },
        { controller: 0, value: 0 },
        { controller: 32, value: bank - 1 },
      ]);
      midi.sendProgramChange(slot - 1);

      await new Promise((r) => setTimeout(r, 50));
      midi.sendCC(49, partMidiValues[partIndex]);
    },
    bankRange: { min: 1, max: 5 },
    slotRange: { min: 1, max: 50 },
    parts: ["A", "B", "C", "D"],
  },

  backupCache: createBackupCache(),

  agentSystemPrompt: `KEYBOARD: Nord Electro 5D

BI-TIMBRAL MODE:
The Nord Electro 5D has two parts (Lower and Upper).
- LAYER MODE (split off): Both parts span the entire keyboard. You CANNOT assign the same engine type to both parts — each layer must use a different engine (e.g., Organ + Piano, Piano + Sample Synth, Organ + Sample Synth).
- SPLIT MODE (split on): Each part gets its own keyboard zone. You CAN use the same engine on both parts. However, Piano and Sample Synth share model/sample selection across parts — only one piano model and one sample at a time.

ORGAN PRESET ROUTING:
In split mode, Organ Preset 1 routes to the Lower part and Preset 2 routes to the Upper part. The organ model is global (shared), but each preset has its own drawbar registration. To set different organ sounds per part: select Preset 1, set its drawbars, then select Preset 2 and set different drawbars.

ORGAN MODEL CAPABILITIES:
- B3: Full vibrato (V1-V3, C1-C3), full percussion, drawbars 0-8
- B3+Bass: Similar to B3
- Vox: Vibrato V1-V3 only (no chorus). No percussion. Drawbars 0-8.
- Farfisa: Vibrato V1, V2, C2, C3 only. No percussion. Drawbars are on/off toggles (0 or 1).
- Pipe: No vibrato. No percussion.

PIANO NOTES:
Piano model index is 1-based and per-category (matching the Nord display).
Sample index is also 1-based.
Clavinet has only one model but 4 pickup variations (A/B/C/D) set via piano_variation.

AUDIO SIGNAL PATH:
              ┌─────────────────┐
              │     KEYBED      │  61 semi-weighted keys
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │  SPLIT / LAYER  │  Split: keys divided at split point
              │                 │  Layer: both parts span full keyboard
              │                 │  Layer: engines must differ (no Piano+Piano)
              └───┬─────────┬───┘
                  │         │
  LOWER engine ◄──┘         └──► UPPER engine
       │                              │
           ┌─────┴─────────┴─────┐
           │  FX1  [Lo/Up]       │  Trem1/2/3, Pan1/2, Chorus1/2
           │  FX2  [Lo/Up]       │  Phase1/2, Chorus1/2, Vibe, Flanger
           │  AMP  [Lo/Up]       │  Dist, Small, JC, Twin, Rotary, Comp
           │  EQ   [Lo/Up/Both]  │  Treble, Mid, Bass + Mid Freq
           │  DELAY [Lo/Up]      │  Tempo, Dry/Wet, Ping-Pong
           └─────┬─────────┬─────┘
                 │         │
              PART MIX (balance Lo/Up)
                    │
                 REVERB (global — no part select)
                    │
               MASTER GAIN
                    │
                 OUTPUT

Notes:
- Amp/Speaker Rotary + both engines Organ → part select forced to Both.
- EQ is the only per-part effect that supports a "Both" option.
- Reverb has no part select — it always processes the mixed signal.

SOUND DESIGN TIPS:
- Do NOT use vibrato/chorus together with the rotary speaker (Leslie) — they clash sonically.
- When using the rotary speaker, set spkr_comp_type to "Rotary" and spkr_comp_enable to on.
- For classic Hammond organ tones, use B3 model with appropriate drawbar settings and the Leslie rotary speaker.`,

  // Web UI files live in src/, not dist/ (tsc doesn't copy non-TS files)
  mockUiDir: join(__dirname, "..", "..", "..", "..", "src", "keyboard_models", "nord", "electro_5d", "web"),

  createMockHandler() {
    return createNordElectro5DMockHandler();
  },

  createDevice() {
    return new NordElectro5DDevice(model, {
      parameterMap,
      programLoader: model.programLoader!,
      songLoader: model.songLoader!,
      systemPromptTemplate: model.agentSystemPrompt!,
    });
  },
};

export default model;
