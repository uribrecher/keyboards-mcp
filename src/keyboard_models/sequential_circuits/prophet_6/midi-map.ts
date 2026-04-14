/**
 * Sequential Circuits Prophet-6 MIDI parameter map.
 *
 * CC numbers from the Prophet-6 MIDI Implementation chart.
 * The Prophet-6 is a mono-timbral analog synth — all parameters are global.
 */

import type { KeyboardParameter } from "../../../shared/types.js";
import type { ParameterMap } from "../../../shared/keyboard-model.js";
import {
  resolveValue as genericResolveValue,
  formatValue as genericFormatValue,
} from "../../../shared/parameter-resolution.js";

const RAW = { kind: "raw" as const };

export const PARAMS: Record<string, KeyboardParameter> = {
  // ── Oscillator 1 ──
  osc1_freq: {
    name: "Osc 1 Freq",
    section: "oscillator_1",
    cc: 67,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Oscillator 1 frequency",
    encoding: RAW,
  },
  osc1_level: {
    name: "Osc 1 Level",
    section: "oscillator_1",
    cc: 69,
    min: 0, max: 127, defaultValue: 127,
    type: "continuous",
    description: "Oscillator 1 level in the mixer",
    encoding: RAW,
  },
  osc1_shape: {
    name: "Osc 1 Shape",
    section: "oscillator_1",
    cc: 70,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Oscillator 1 waveshape (sawtooth to pulse)",
    encoding: RAW,
  },
  osc1_pulse_width: {
    name: "Osc 1 Pulse Width",
    section: "oscillator_1",
    cc: 71,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Oscillator 1 pulse width",
    encoding: RAW,
  },

  // ── Oscillator 2 ──
  osc2_freq: {
    name: "Osc 2 Freq",
    section: "oscillator_2",
    cc: 75,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Oscillator 2 frequency",
    encoding: RAW,
  },
  osc2_freq_fine: {
    name: "Osc 2 Freq Fine",
    section: "oscillator_2",
    cc: 76,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Oscillator 2 fine frequency",
    encoding: RAW,
  },
  osc2_level: {
    name: "Osc 2 Level",
    section: "oscillator_2",
    cc: 77,
    min: 0, max: 127, defaultValue: 127,
    type: "continuous",
    description: "Oscillator 2 level in the mixer",
    encoding: RAW,
  },
  osc2_shape: {
    name: "Osc 2 Shape",
    section: "oscillator_2",
    cc: 78,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Oscillator 2 waveshape (sawtooth to pulse)",
    encoding: RAW,
  },
  osc2_pulse_width: {
    name: "Osc 2 Pulse Width",
    section: "oscillator_2",
    cc: 79,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Oscillator 2 pulse width",
    encoding: RAW,
  },

  // ── Mixer ──
  sub_osc_level: {
    name: "Sub Osc Level",
    section: "mixer",
    cc: 8,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Sub oscillator level (one octave below Osc 1)",
    encoding: RAW,
  },

  // ── Low-Pass Filter ──
  lp_freq: {
    name: "Low-Pass Freq",
    section: "lowpass_filter",
    cc: 102,
    min: 0, max: 127, defaultValue: 127,
    type: "continuous",
    description: "Low-pass filter cutoff frequency",
    encoding: RAW,
  },
  lp_resonance: {
    name: "Low-Pass Resonance",
    section: "lowpass_filter",
    cc: 103,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Low-pass filter resonance",
    encoding: RAW,
  },
  lp_key_amt: {
    name: "Low-Pass Key Amt",
    section: "lowpass_filter",
    cc: 104,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Low-pass filter keyboard tracking amount",
    encoding: RAW,
  },
  lp_vel_on_off: {
    name: "Low-Pass Vel On/Off",
    section: "lowpass_filter",
    cc: 105,
    min: 0, max: 1, defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Low-pass filter velocity sensitivity on/off",
    encoding: RAW,
  },
  lp_env_amt: {
    name: "Low-Pass Env Amt",
    section: "lowpass_filter",
    cc: 47,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Low-pass filter envelope amount",
    encoding: RAW,
  },

  // ── High-Pass Filter ──
  hp_freq: {
    name: "High-Pass Freq",
    section: "highpass_filter",
    cc: 106,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "High-pass filter cutoff frequency",
    encoding: RAW,
  },
  hp_resonance: {
    name: "High-Pass Resonance",
    section: "highpass_filter",
    cc: 107,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "High-pass filter resonance",
    encoding: RAW,
  },
  hp_key_amt: {
    name: "High-Pass Key Amt",
    section: "highpass_filter",
    cc: 108,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "High-pass filter keyboard tracking amount",
    encoding: RAW,
  },
  hp_vel_on_off: {
    name: "High-Pass Vel On/Off",
    section: "highpass_filter",
    cc: 109,
    min: 0, max: 1, defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "High-pass filter velocity sensitivity on/off",
    encoding: RAW,
  },
  hp_env_amt: {
    name: "High-Pass Env Amt",
    section: "highpass_filter",
    cc: 54,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "High-pass filter envelope amount",
    encoding: RAW,
  },

  // ── Filter Envelope ──
  filter_env_attack: {
    name: "Filter Env Attack",
    section: "filter_envelope",
    cc: 50,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Filter envelope attack time",
    encoding: RAW,
  },
  filter_env_decay: {
    name: "Filter Env Decay",
    section: "filter_envelope",
    cc: 51,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Filter envelope decay time",
    encoding: RAW,
  },
  filter_env_sustain: {
    name: "Filter Env Sustain",
    section: "filter_envelope",
    cc: 52,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Filter envelope sustain level",
    encoding: RAW,
  },
  filter_env_release: {
    name: "Filter Env Release",
    section: "filter_envelope",
    cc: 53,
    min: 0, max: 127, defaultValue: 32,
    type: "continuous",
    description: "Filter envelope release time",
    encoding: RAW,
  },

  // ── Amplifier (VCA) ──
  vca_env_amt: {
    name: "VCA Env Amt",
    section: "amplifier",
    cc: 40,
    min: 0, max: 127, defaultValue: 127,
    type: "continuous",
    description: "VCA envelope amount",
    encoding: RAW,
  },
  vca_vel_amt: {
    name: "VCA Vel Amt",
    section: "amplifier",
    cc: 41,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "VCA velocity sensitivity amount",
    encoding: RAW,
  },
  vca_env_attack: {
    name: "VCA Env Attack",
    section: "amplifier",
    cc: 43,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "VCA envelope attack time",
    encoding: RAW,
  },
  vca_env_decay: {
    name: "VCA Env Decay",
    section: "amplifier",
    cc: 44,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "VCA envelope decay time",
    encoding: RAW,
  },
  vca_env_sustain: {
    name: "VCA Env Sustain",
    section: "amplifier",
    cc: 45,
    min: 0, max: 127, defaultValue: 127,
    type: "continuous",
    description: "VCA envelope sustain level",
    encoding: RAW,
  },
  vca_env_release: {
    name: "VCA Env Release",
    section: "amplifier",
    cc: 46,
    min: 0, max: 127, defaultValue: 32,
    type: "continuous",
    description: "VCA envelope release time",
    encoding: RAW,
  },

  // ── Effects ──
  distortion_amount: {
    name: "Distortion Amount",
    section: "effects",
    cc: 9,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Distortion drive amount",
    encoding: RAW,
  },

  // ── Arpeggiator ──
  arp_on_off: {
    name: "Arp On/Off",
    section: "arpeggiator",
    cc: 58,
    min: 0, max: 1, defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Arpeggiator on/off",
    encoding: RAW,
  },
  arp_mode: {
    name: "Arp Mode",
    section: "arpeggiator",
    cc: 59,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Arpeggiator mode (Up, Down, Up/Down, Random, etc.)",
    encoding: RAW,
  },
  arp_range: {
    name: "Arp Range",
    section: "arpeggiator",
    cc: 60,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Arpeggiator range in octaves",
    encoding: RAW,
  },
  arp_time_signature: {
    name: "Arp Time Signature",
    section: "arpeggiator",
    cc: 62,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Arpeggiator time signature / note division",
    encoding: RAW,
  },

  // ── Performance ──
  mod_wheel: {
    name: "Mod Wheel",
    section: "performance",
    cc: 1,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Modulation wheel",
    encoding: RAW,
  },
  bpm: {
    name: "BPM",
    section: "performance",
    cc: 3,
    min: 0, max: 127, defaultValue: 64,
    type: "continuous",
    description: "Tempo / BPM",
    encoding: RAW,
  },
  glide_mode: {
    name: "Glide Mode",
    section: "performance",
    cc: 5,
    min: 0, max: 127, defaultValue: 0,
    type: "continuous",
    description: "Glide mode (fixed rate, fixed time, etc.)",
    encoding: RAW,
  },
  midi_volume: {
    name: "MIDI Volume",
    section: "performance",
    cc: 7,
    min: 0, max: 127, defaultValue: 127,
    type: "continuous",
    description: "MIDI volume",
    encoding: RAW,
  },
  damper_pedal: {
    name: "Damper Pedal",
    section: "performance",
    cc: 64,
    min: 0, max: 1, defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Damper (sustain) pedal",
    encoding: RAW,
  },
  glide_on_off: {
    name: "Glide On/Off",
    section: "performance",
    cc: 65,
    min: 0, max: 1, defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Glide (portamento) on/off",
    encoding: RAW,
  },
};

// ── Reverse CC lookup ──
const ccToParamMap = new Map<number, { key: string; param: KeyboardParameter }>();
for (const [key, param] of Object.entries(PARAMS)) {
  ccToParamMap.set(param.cc, { key, param });
}

export function createParameterMap(): ParameterMap {
  return {
    params: PARAMS,

    resolveValue: genericResolveValue,
    formatValue: genericFormatValue,

    findParam(name: string): { key: string; param: KeyboardParameter } | undefined {
      const lower = name.toLowerCase().replace(/[\s_-]+/g, "");

      if (PARAMS[name]) {
        return { key: name, param: PARAMS[name] };
      }

      for (const [key, param] of Object.entries(PARAMS)) {
        if (key.toLowerCase().replace(/[\s_-]+/g, "") === lower) {
          return { key, param };
        }
      }

      for (const [key, param] of Object.entries(PARAMS)) {
        if (param.name.toLowerCase().replace(/[\s_-]+/g, "").includes(lower)) {
          return { key, param };
        }
      }

      return undefined;
    },

    getParamByCC(cc: number): { key: string; param: KeyboardParameter } | undefined {
      return ccToParamMap.get(cc);
    },

    getSections(): string[] {
      const sections = new Set<string>();
      for (const param of Object.values(PARAMS)) {
        sections.add(param.section);
      }
      return [...sections];
    },

    getParamsBySection(section: string): Record<string, KeyboardParameter> {
      const result: Record<string, KeyboardParameter> = {};
      for (const [key, param] of Object.entries(PARAMS)) {
        if (param.section === section) {
          result[key] = param;
        }
      }
      return result;
    },

    isPerPart(key: string): boolean {
      return PARAMS[key]?.perPart === true;
    },
  };
}
