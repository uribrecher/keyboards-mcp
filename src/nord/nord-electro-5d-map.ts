/**
 * Nord Electro 5D MIDI parameter map.
 *
 * CC numbers are taken from the official Nord Electro 5 User Manual
 * (Appendix II: MIDI Controller List, page 21).
 */

export type ParamType = "continuous" | "discrete" | "toggle";

export interface NordParameter {
  name: string;
  section: string;
  cc: number;
  min: number;
  max: number;
  defaultValue: number;
  type: ParamType;
  labels?: Record<number, string>;
  description: string;
  /** For drawbars: maps position 0-8 to MIDI 0-127 */
  drawbar?: boolean;
  /** For model/sample index params: maps index to MIDI via round(index * 2.5) */
  modelIndex?: boolean;
  /** Display is 1-based on the Nord. Input N maps to MIDI N-1. */
  oneBased?: boolean;
  /** True for parameters that are per-part (Lower/Upper) in bi-timbral mode */
  perPart?: boolean;
}

/** Convert drawbar position (0-8) to MIDI value (0-127) */
export function drawbarToMidi(position: number): number {
  return Math.round((Math.min(8, Math.max(0, position)) / 8) * 127);
}

/** Convert MIDI value (0-127) to drawbar position (0-8) */
export function midiToDrawbar(value: number): number {
  return Math.round((value / 127) * 8);
}

/**
 * Universal model index to MIDI value mapping.
 * Empirically tested — the same non-uniform spacing applies to all piano types.
 */
const MODEL_TO_MIDI = [0, 3, 6, 8, 11, 13, 16, 18, 21];

/** Convert model number (1-based, matching Nord display) to MIDI value. */
export function modelIndexToMidi(modelNumber: number): number {
  const idx = Math.max(0, modelNumber - 1);
  if (idx < MODEL_TO_MIDI.length) return MODEL_TO_MIDI[idx];
  return Math.min(127, idx * 3);
}

/** Convert MIDI value back to model number (1-based, matching Nord display) */
export function midiToModelIndex(midiValue: number): number {
  for (let i = MODEL_TO_MIDI.length - 1; i >= 0; i--) {
    if (midiValue >= MODEL_TO_MIDI[i]) return i + 1;
  }
  return 1;
}

export const NORD_ELECTRO_5D_PARAMS: Record<string, NordParameter> = {
  // ── Organ Section ──
  organ_model: {
    name: "Organ Model",
    section: "organ",
    cc: 9,
    min: 0,
    max: 4,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "B3", 1: "B3+Bass", 2: "Pipe", 3: "Vox", 4: "Farfisa" },
    description: "Organ model: B3 (Hammond), B3+Bass, Pipe, Vox (Continental), or Farfisa",
    perPart: true,
  },
  organ_preset_select: {
    name: "Organ Preset Select",
    section: "organ",
    cc: 3,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Preset 1", 1: "Preset 2" },
    description: "Select between organ Preset 1 and Preset 2. Each preset has its own drawbar registration. " +
      "In split mode, Preset 1 routes to Lower part, Preset 2 to Upper part. " +
      "Drawbar CCs (16-24) modify the currently selected preset's drawbars.",
    perPart: true,
  },
  drawbar_1: {
    name: "Drawbar 1 (Sub)",
    section: "organ",
    cc: 16,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 1 — Sub octave (16'). Values 0-8. Modifies the currently selected preset's registration. For Farfisa organ, drawbars are on/off toggles (0 or 1).",
    perPart: true,
  },
  drawbar_2: {
    name: "Drawbar 2 (Sub 3rd)",
    section: "organ",
    cc: 17,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 2 — Sub 3rd (5⅓'). Values 0-8.",
    perPart: true,
  },
  drawbar_3: {
    name: "Drawbar 3 (Fundamental)",
    section: "organ",
    cc: 18,
    min: 0,
    max: 127,
    defaultValue: 127,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 3 — Fundamental (8'). Values 0-8.",
    perPart: true,
  },
  drawbar_4: {
    name: "Drawbar 4 (2nd Harmonic)",
    section: "organ",
    cc: 19,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 4 — 2nd harmonic (4'). Values 0-8.",
    perPart: true,
  },
  drawbar_5: {
    name: "Drawbar 5 (3rd Harmonic)",
    section: "organ",
    cc: 20,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 5 — 3rd harmonic (2⅔'). Values 0-8.",
    perPart: true,
  },
  drawbar_6: {
    name: "Drawbar 6 (4th Harmonic)",
    section: "organ",
    cc: 21,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 6 — 4th harmonic (2'). Values 0-8.",
    perPart: true,
  },
  drawbar_7: {
    name: "Drawbar 7 (5th Harmonic)",
    section: "organ",
    cc: 22,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 7 — 5th harmonic (1⅗'). Values 0-8.",
    perPart: true,
  },
  drawbar_8: {
    name: "Drawbar 8 (6th Harmonic)",
    section: "organ",
    cc: 23,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 8 — 6th harmonic (1⅓'). Values 0-8.",
    perPart: true,
  },
  drawbar_9: {
    name: "Drawbar 9 (8th Harmonic)",
    section: "organ",
    cc: 24,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    drawbar: true,
    description: "Drawbar 9 — 8th harmonic (1'). Values 0-8.",
    perPart: true,
  },
  organ_drawbar_live: {
    name: "Organ Drawbar Live",
    section: "organ",
    cc: 25,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Drawbar Live mode on/off",
    perPart: true,
  },
  vibrato_type: {
    name: "Vibrato/Chorus Type",
    section: "organ",
    cc: 84,
    min: 0,
    max: 5,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "V1", 1: "C1", 2: "V2", 3: "C2", 4: "V3", 5: "C3" },
    description: "Organ vibrato/chorus type: V1-V3 (vibrato), C1-C3 (chorus)",
    perPart: true,
  },
  vibrato_enable: {
    name: "Vibrato/Chorus Enable",
    section: "organ",
    cc: 85,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Organ vibrato/chorus on/off",
    perPart: true,
  },
  percussion: {
    name: "Percussion Enable",
    section: "organ",
    cc: 87,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Organ percussion on/off (B3 only)",
    perPart: true,
  },
  percussion_speed_level: {
    name: "Percussion Speed/Level",
    section: "organ",
    cc: 88,
    min: 0,
    max: 3,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Slow/Normal", 1: "Fast/Normal", 2: "Slow/Soft", 3: "Fast/Soft" },
    description: "Percussion speed and level: Fast/Slow decay, Normal/Soft volume",
    perPart: true,
  },
  percussion_harmonic: {
    name: "Percussion Harmonic",
    section: "organ",
    cc: 95,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "2nd", 1: "3rd" },
    description: "Percussion harmonic: 2nd (bright click) or 3rd (mellow)",
    perPart: true,
  },

  // ── Piano Section ──
  piano_type: {
    name: "Piano Type",
    section: "piano",
    cc: 12,
    min: 0,
    max: 5,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Grand", 1: "Upright", 2: "EP1", 3: "EP2", 4: "Clav", 5: "Harpsichord" },
    description: "Piano type: Grand, Upright, EP1 (Rhodes-type), EP2 (Wurlitzer-type), Clav, or Harpsichord",
    perPart: true,
  },
  piano_model: {
    name: "Piano Model",
    section: "piano",
    cc: 44,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    modelIndex: true,
    description:
      "Piano model index (1-based, per-category location matching Nord hardware display). " +
      "Available models depend on piano_type and which pianos are loaded on the keyboard. " +
      "Run extract_backup to populate the inventory with model names. " +
      "For Clav type, use piano_variation to select pickup A/B/C/D.",
    perPart: true,
  },
  piano_variation: {
    name: "Piano Variation / Clav Select",
    section: "piano",
    cc: 45,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    modelIndex: true,
    description:
      "Clavinet pickup variation (CC 45). Only applies to Clav piano type. " +
      "1=D6 A (both pickups in-phase), 2=D6 B (bridge pickup), 3=D6 C (neck pickup), 4=D6 D (both pickups out-of-phase). " +
      "Uses model index encoding. Has no effect on other piano types.",
    perPart: true,
  },
  piano_kbd_touch: {
    name: "Piano KBD Touch",
    section: "piano",
    cc: 46,
    min: 0,
    max: 3,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "0", 1: "1", 2: "2", 3: "3" },
    description: "Keyboard touch sensitivity for piano sounds",
    perPart: true,
  },
  piano_acoustic: {
    name: "Piano Acoustic",
    section: "piano",
    cc: 98,
    min: 0,
    max: 3,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Off", 1: "String Resonance", 2: "Long Release", 3: "String Resonance + Long Release" },
    description: "Piano acoustic mode: Off, String Resonance, Long Release, or both",
    perPart: true,
  },
  piano_mono: {
    name: "Piano Mono",
    section: "piano",
    cc: 83,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Piano mono mode on/off",
    perPart: true,
  },

  // ── Sample Synth Section ──
  sample_synth_attack: {
    name: "Sample Synth Attack",
    section: "sample_synth",
    cc: 33,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "Sample synth attack time (0-127, display scale 0.5ms to 45s). Controls how long it takes for the sample to reach full level.",
    perPart: true,
  },
  sample_synth_release: {
    name: "Sample Synth Release",
    section: "sample_synth",
    cc: 34,
    min: 0,
    max: 127,
    defaultValue: 64,
    type: "continuous",
    description:
      "Sample synth decay/sustain/release (0-127). Three zones: " +
      "0-63 = decay time (3ms to 43s), 64 = sustain (looped sample while key held), " +
      "65-127 = release time after key up (3ms to 39s).",
    perPart: true,
  },
  sample_synth_sample: {
    name: "Sample Synth Sample",
    section: "sample_synth",
    cc: 35,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    oneBased: true,
    description: "Select sample from loaded sample bank (1-based, matching Nord display). " +
      "MIDI CC limited to samples 1-128 (slots 0-127). Samples beyond slot 128 are only accessible from the hardware panel. " +
      "Samples must be loaded via Nord Sound Manager.",
    perPart: true,
  },
  sample_synth_dynamics: {
    name: "Sample Synth Dynamics",
    section: "sample_synth",
    cc: 36,
    min: 0,
    max: 3,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Off", 1: "Low", 2: "Mid", 3: "High" },
    description:
      "Velocity response mode. Off = full velocity always. Low/Mid/High = increasing dynamic range.",
    perPart: true,
  },
  sample_synth_filter_vel: {
    name: "Sample Synth Filter Vel",
    section: "sample_synth",
    cc: 37,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description:
      "Velocity-sensitive low-pass filter. Higher values = more filter effect. " +
      "Soft playing sounds dampened, hard playing sounds brighter.",
    perPart: true,
  },

  // ── Effect 1 ──
  effect1_enable: {
    name: "Effect 1 Enable",
    section: "effect1",
    cc: 69,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Effect 1 on/off",
  },
  effect1_type: {
    name: "Effect 1 Type",
    section: "effect1",
    cc: 60,
    min: 0,
    max: 7,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Trem 1", 1: "Trem 2", 2: "Trem 3", 3: "Pan 1", 4: "Pan 2", 5: "Pan 3", 6: "Wah", 7: "Ring Mod" },
    description: "Effect 1 type: Trem 1-3, Pan 1-3, Wah, or Ring Mod",
  },
  effect1_rate: {
    name: "Effect 1 Rate",
    section: "effect1",
    cc: 63,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "Effect 1 rate/speed (0-127, display scale 0.0-10.0)",
  },

  effect1_ctrl_pedal: {
    name: "Effect 1 Ctrl Pedal",
    section: "effect1",
    cc: 73,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Let the control pedal control FX1 rate",
  },

  // ── Effect 2 ──
  effect2_enable: {
    name: "Effect 2 Enable",
    section: "effect2",
    cc: 80,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Effect 2 on/off",
  },
  effect2_type: {
    name: "Effect 2 Type",
    section: "effect2",
    cc: 61,
    min: 0,
    max: 5,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Phase 1", 1: "Phase 2", 2: "Flanger", 3: "Chorus 1", 4: "Chorus 2", 5: "Vibe" },
    description: "Effect 2 type: Phase 1-2, Flanger, Chorus 1-2, or Vibe",
  },
  effect2_rate: {
    name: "Effect 2 Rate",
    section: "effect2",
    cc: 62,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "Effect 2 rate/speed (0-127, display scale: 0.0-10.5 Hz for Phase/Flanger/Vibe, 0.0-2.7 Hz for Chorus)",
  },
  effect2_deep: {
    name: "Effect 2 Deep Mode",
    section: "effect2",
    cc: 74,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Effect 2 deep mode on/off (increases effect depth)",
  },

  // ── Speaker/Comp (Amp) ──
  spkr_comp_type: {
    name: "Speaker/Comp Type",
    section: "amp",
    cc: 81,
    min: 0,
    max: 5,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Dist", 1: "Small", 2: "JC", 3: "Twin", 4: "Rotary", 5: "Comp" },
    description: "Amp/speaker simulation: Dist, Small, JC, Twin, Rotary, or Comp",
  },
  spkr_comp_enable: {
    name: "Speaker/Comp Enable",
    section: "amp",
    cc: 86,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Speaker/comp simulation on/off",
  },
  spkr_comp_drive: {
    name: "Speaker/Comp Drive",
    section: "amp",
    cc: 111,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "Amp overdrive amount (0-127, display scale 0.0-10.0)",
  },

  // ── Rotary Speaker ──
  rotary_speed: {
    name: "Rotary Speed",
    section: "rotary",
    cc: 82,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Slow", 127: "Fast" },
    description: "Rotary speaker (Leslie) speed: Slow (0-63) or Fast (64-127)",
  },
  rotary_stop_mode: {
    name: "Rotary Stop Mode",
    section: "rotary",
    cc: 79,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Rotary speaker stop mode on/off",
  },
  // rotor_pedal (CC 90) — removed: does not respond to MIDI CC on real hardware

  // ── Reverb ──
  reverb_type: {
    name: "Reverb Type",
    section: "reverb",
    cc: 96,
    min: 0,
    max: 4,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Room", 1: "Stage Soft", 2: "Stage", 3: "Hall Soft", 4: "Hall" },
    description: "Reverb type: Room, Stage Soft, Stage, Hall Soft, or Hall",
  },
  reverb_enable: {
    name: "Reverb Enable",
    section: "reverb",
    cc: 97,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Reverb on/off",
  },
  reverb_dry_wet: {
    name: "Reverb Dry/Wet",
    section: "reverb",
    cc: 102,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "Reverb wet/dry mix (0-127, display scale 0.0-10.0)",
  },

  // ── Delay ──
  delay_tempo: {
    name: "Delay Tempo",
    section: "delay",
    cc: 92,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "Delay tempo/time (0-127)",
  },
  delay_ping_pong: {
    name: "Delay Ping Pong",
    section: "delay",
    cc: 93,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Delay ping-pong mode on/off",
  },
  delay_enable: {
    name: "Delay Enable",
    section: "delay",
    cc: 94,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Delay on/off",
  },
  delay_dry_wet: {
    name: "Delay Dry/Wet",
    section: "delay",
    cc: 103,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "Delay dry/wet mix (0-127, display scale 0.0-10.0)",
  },
  delay_feedback: {
    name: "Delay Feedback",
    section: "delay",
    cc: 104,
    min: 0,
    max: 3,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "0", 1: "1", 2: "2", 3: "3" },
    description: "Delay feedback amount (0-3)",
  },

  // ── EQ ──
  eq_treble: {
    name: "EQ Treble",
    section: "eq",
    cc: 113,
    min: 0,
    max: 127,
    defaultValue: 64,
    type: "continuous",
    description: "Treble EQ (0-127, center/flat = 64, display scale -15.0 to +15.0 dB)",
  },
  eq_enable: {
    name: "EQ Enable",
    section: "eq",
    cc: 115,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "EQ on/off",
  },
  eq_mid: {
    name: "EQ Mid",
    section: "eq",
    cc: 116,
    min: 0,
    max: 127,
    defaultValue: 64,
    type: "continuous",
    description: "Mid EQ gain (0-127, center/flat = 64, display scale -15.0 to +15.0 dB)",
  },
  eq_mid_freq: {
    name: "EQ Mid Frequency",
    section: "eq",
    cc: 117,
    min: 0,
    max: 127,
    defaultValue: 64,
    type: "continuous",
    description: "Mid EQ frequency sweep (0-127, display scale 200-8000 Hz)",
  },
  eq_bass: {
    name: "EQ Bass",
    section: "eq",
    cc: 118,
    min: 0,
    max: 127,
    defaultValue: 64,
    type: "continuous",
    description: "Bass EQ (0-127, center/flat = 64, display scale -15.0 to +15.0 dB)",
  },

  // ── Global ──
  master_volume: {
    name: "Gain Level",
    section: "global",
    cc: 7,
    min: 0,
    max: 127,
    defaultValue: 100,
    type: "continuous",
    description: "Master output volume / gain level (0-127)",
  },

  // ── Part Controls ──
  part_lower_engine_select: {
    name: "Part Lower Engine Select",
    section: "parts",
    cc: 39,
    min: 0,
    max: 2,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Organ", 1: "Piano", 2: "Sample Synth" },
    description: "Select sound engine for the Lower part",
  },
  part_upper_engine_select: {
    name: "Part Upper Engine Select",
    section: "parts",
    cc: 40,
    min: 0,
    max: 2,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Organ", 1: "Piano", 2: "Sample Synth" },
    description: "Select sound engine for the Upper part",
  },
  part_lower_enable: {
    name: "Part Lower Enable",
    section: "parts",
    cc: 41,
    min: 0,
    max: 1,
    defaultValue: 1,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Enable/disable the Lower part",
  },
  part_upper_enable: {
    name: "Part Upper Enable",
    section: "parts",
    cc: 42,
    min: 0,
    max: 1,
    defaultValue: 1,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Enable/disable the Upper part",
  },
  part_mix: {
    name: "Part Mix",
    section: "parts",
    cc: 13,
    min: 0,
    max: 127,
    defaultValue: 64,
    type: "continuous",
    description: "Mix balance between Lower and Upper parts (0=Lower, 64=center, 127=Upper)",
  },
  kb_split_mode: {
    name: "Keyboard Split Mode",
    section: "parts",
    cc: 50,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Keyboard split mode on/off",
  },
  kb_split_point: {
    name: "Keyboard Split Point",
    section: "parts",
    cc: 51,
    min: 0,
    max: 5,
    defaultValue: 2,
    type: "discrete",
    labels: { 0: "C3", 1: "F3", 2: "C4", 3: "F4", 4: "C5", 5: "F5" },
    description: "Keyboard split point note",
  },
  transpose_enable: {
    name: "Transpose Enable",
    section: "parts",
    cc: 52,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Transpose on/off",
  },
  transpose_amount: {
    name: "Transpose Amount",
    section: "parts",
    cc: 53,
    min: 0,
    max: 12,
    defaultValue: 6,
    type: "discrete",
    labels: { 0: "-6", 1: "-5", 2: "-4", 3: "-3", 4: "-2", 5: "-1", 6: "0", 7: "+1", 8: "+2", 9: "+3", 10: "+4", 11: "+5", 12: "+6" },
    description: "Transpose amount in semitones (-6 to +6, 6=no transpose)",
  },
  octave_shift_lower: {
    name: "Octave Shift Lower",
    section: "parts",
    cc: 54,
    min: 0,
    max: 13,
    defaultValue: 7,
    type: "discrete",
    labels: { 0: "-7", 1: "-6", 2: "-5", 3: "-4", 4: "-3", 5: "-2", 6: "-1", 7: "0", 8: "+1", 9: "+2", 10: "+3", 11: "+4", 12: "+5", 13: "+6" },
    description: "Octave shift for the Lower part (7=no shift, range depends on split point)",
  },
  octave_shift_upper: {
    name: "Octave Shift Upper",
    section: "parts",
    cc: 55,
    min: 0,
    max: 13,
    defaultValue: 7,
    type: "discrete",
    labels: { 0: "-7", 1: "-6", 2: "-5", 3: "-4", 4: "-3", 5: "-2", 6: "-1", 7: "0", 8: "+1", 9: "+2", 10: "+3", 11: "+4", 12: "+5", 13: "+6" },
    description: "Octave shift for the Upper part (7=no shift, range depends on split point)",
  },
  sustain_pedal_enable_lower: {
    name: "Sustain Pedal Enable Lower",
    section: "parts",
    cc: 56,
    min: 0,
    max: 1,
    defaultValue: 1,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Enable sustain pedal for the Lower part",
  },
  sustain_pedal_enable_upper: {
    name: "Sustain Pedal Enable Upper",
    section: "parts",
    cc: 57,
    min: 0,
    max: 1,
    defaultValue: 1,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Enable sustain pedal for the Upper part",
  },
  ctrl_pedal_enable_lower: {
    name: "Ctrl Pedal Enable Lower",
    section: "parts",
    cc: 58,
    min: 0,
    max: 1,
    defaultValue: 1,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Enable control (expression) pedal for the Lower part",
  },
  ctrl_pedal_enable_upper: {
    name: "Ctrl Pedal Enable Upper",
    section: "parts",
    cc: 59,
    min: 0,
    max: 1,
    defaultValue: 1,
    type: "toggle",
    labels: { 0: "Off", 1: "On" },
    description: "Enable control (expression) pedal for the Upper part",
  },

  // ── Effect Part Selects ──
  effect1_part_select: {
    name: "Effect 1 Part Select",
    section: "effect1",
    cc: 71,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Lower", 1: "Upper" },
    description: "Which part(s) Effect 1 applies to",
  },
  effect2_part_select: {
    name: "Effect 2 Part Select",
    section: "effect2",
    cc: 72,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Lower", 1: "Upper" },
    description: "Which part(s) Effect 2 applies to",
  },
  spkr_comp_part_select: {
    name: "Speaker/Comp Part Select",
    section: "amp",
    cc: 112,
    min: 0,
    max: 2,
    defaultValue: 2,
    type: "discrete",
    labels: { 0: "Lower", 1: "Upper", 2: "Both" },
    description: "Which part(s) Speaker/Comp applies to",
  },
  delay_part_select: {
    name: "Delay Part Select",
    section: "delay",
    cc: 105,
    min: 0,
    max: 1,
    defaultValue: 0,
    type: "discrete",
    labels: { 0: "Lower", 1: "Upper" },
    description: "Which part(s) Delay applies to",
  },
  eq_part_select: {
    name: "EQ Part Select",
    section: "eq",
    cc: 119,
    min: 0,
    max: 2,
    defaultValue: 2,
    type: "discrete",
    labels: { 0: "Lower", 1: "Upper", 2: "Both" },
    description: "Which part(s) EQ applies to",
  },
};

/** Check if a parameter is per-part (bi-timbral) */
export function isPerPartParam(key: string): boolean {
  const param = NORD_ELECTRO_5D_PARAMS[key];
  return param?.perPart === true;
}

/** Get a parameter by its key name */
export function getParam(key: string): NordParameter | undefined {
  return NORD_ELECTRO_5D_PARAMS[key];
}

/** Find a parameter by fuzzy name match */
export function findParam(name: string): { key: string; param: NordParameter } | undefined {
  const lower = name.toLowerCase().replace(/[\s_-]+/g, "");

  // Exact key match
  if (NORD_ELECTRO_5D_PARAMS[name]) {
    return { key: name, param: NORD_ELECTRO_5D_PARAMS[name] };
  }

  // Normalized key match
  for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
    if (key.toLowerCase().replace(/[\s_-]+/g, "") === lower) {
      return { key, param };
    }
  }

  // Name substring match
  for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
    if (param.name.toLowerCase().replace(/[\s_-]+/g, "").includes(lower)) {
      return { key, param };
    }
  }

  return undefined;
}

/** Get all parameters in a section */
export function getParamsBySection(section: string): Record<string, NordParameter> {
  const result: Record<string, NordParameter> = {};
  for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
    if (param.section === section) {
      result[key] = param;
    }
  }
  return result;
}

/** All section names */
export function getSections(): string[] {
  const sections = new Set<string>();
  for (const param of Object.values(NORD_ELECTRO_5D_PARAMS)) {
    sections.add(param.section);
  }
  return [...sections];
}

/** Build reverse lookup: CC number → { key, param } */
const ccToParamMap = new Map<number, { key: string; param: NordParameter }>();
for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
  ccToParamMap.set(param.cc, { key, param });
}

/** Look up a parameter by its CC number */
export function getParamByCC(cc: number): { key: string; param: NordParameter } | undefined {
  return ccToParamMap.get(cc);
}

/** Scale a discrete label index to MIDI 0-127 range */
function discreteToMidi(index: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((index / max) * 127);
}

/** Convert a MIDI 0-127 value back to discrete label index */
export function midiToDiscrete(midiValue: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((midiValue / 127) * max);
}

/** Resolve a string label to a numeric MIDI value for a parameter */
export function resolveValue(param: NordParameter, value: number | string): number {
  if (typeof value === "number") {
    if (param.drawbar) {
      return drawbarToMidi(value);
    }
    if (param.modelIndex) {
      return modelIndexToMidi(Math.max(0, Math.round(value)));
    }
    if (param.oneBased) {
      return Math.max(0, Math.min(127, Math.round(value) - 1));
    }
    if (param.type === "discrete" || param.type === "toggle") {
      const clamped = Math.max(param.min, Math.min(param.max, Math.round(value)));
      return discreteToMidi(clamped, param.max);
    }
    return Math.max(0, Math.min(127, Math.round(value)));
  }

  // String label resolution
  const lower = value.toLowerCase();

  if (param.labels) {
    for (const [numStr, label] of Object.entries(param.labels)) {
      if (label.toLowerCase() === lower) {
        const index = Number(numStr);
        return discreteToMidi(index, param.max);
      }
    }
  }

  // Try parsing as number
  const parsed = Number(value);
  if (!isNaN(parsed)) {
    if (param.drawbar) return drawbarToMidi(parsed);
    if (param.modelIndex) return modelIndexToMidi(Math.max(0, Math.round(parsed)));
    if (param.oneBased) return Math.max(0, Math.min(127, Math.round(parsed) - 1));
    if (param.type === "discrete" || param.type === "toggle") {
      const clamped = Math.max(param.min, Math.min(param.max, Math.round(parsed)));
      return discreteToMidi(clamped, param.max);
    }
    return Math.max(0, Math.min(127, Math.round(parsed)));
  }

  throw new Error(
    `Cannot resolve value "${value}" for parameter "${param.name}". ` +
      (param.labels
        ? `Valid labels: ${Object.values(param.labels).join(", ")}`
        : `Expected a number between ${param.min} and ${param.max}`)
  );
}
