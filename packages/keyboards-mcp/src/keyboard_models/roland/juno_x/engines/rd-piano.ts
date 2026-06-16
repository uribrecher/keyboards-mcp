import type { KeyboardParameter } from "../../../../shared/types.js";
import { JunoXEngine } from "./engine-types.js";

export const RD_PIANO_ENGINE = JunoXEngine.RDPiano;

export function createRDPianoParams(): Record<string, KeyboardParameter> {
  return {
    amp_level: {
      name: "Tone Level",
      section: "rd-tone",
      cc: 110,
      min: 0,
      max: 127,
      defaultValue: 100,
      type: "continuous",
      description: "Controls the overall output level of the RD Piano tone.",
      encoding: { kind: "raw" },
      perPart: true,
    },
    symreso_switch: {
      name: "SymReso Switch",
      section: "rd-symreso",
      min: 0,
      max: 1,
      defaultValue: 1,
      type: "toggle",
      labels: { 0: "OFF", 1: "ON" },
      description: "Enables or disables the Sympathetic Resonance effect.",
      encoding: { kind: "raw" },
      sysexAddress: [0x01, 0x00, 0x00, 0x00],
      sysexSize: 1,
      perPart: true,
    },
    symreso_depth: {
      name: "SymReso Depth",
      section: "rd-symreso",
      min: 0,
      max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Controls the depth of the Sympathetic Resonance effect.",
      encoding: { kind: "raw" },
      sysexAddress: [0x01, 0x00, 0x00, 0x01],
      sysexSize: 1,
      perPart: true,
    },
    cabinet_reso: {
      name: "Cabinet Reso",
      section: "rd-symreso",
      min: 0,
      max: 127,
      defaultValue: 64,
      type: "continuous",
      description: "Controls the level of cabinet resonance coloring the piano tone.",
      encoding: { kind: "raw" },
      sysexAddress: [0x01, 0x00, 0x00, 0x02],
      sysexSize: 1,
      perPart: true,
    },
  };
}
