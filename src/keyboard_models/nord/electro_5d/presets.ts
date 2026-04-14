/**
 * Built-in preset patches for common Nord Electro 5D keyboard sounds.
 * Each preset includes full parts configuration so it works regardless of current state.
 * Values use drawbar positions (0-8) for drawbar params and labels where available.
 */

import type { Preset } from "../../../shared/types.js";

export const PRESETS: Preset[] = [
  {
    name: "Jazz Organ (Jimmy Smith)",
    description:
      "Classic B3 jazz organ: 888000000 drawbars, percussion 2nd fast, slow Leslie, touch of stage reverb. " +
      "Perfect for jazz standards, soul jazz, and Jimmy Smith-style grooves.",
    genre: "jazz",
    parameters: {
      part_upper_engine_select: "Organ",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      organ_model: "B3",
      drawbar_1: 8, drawbar_2: 8, drawbar_3: 8, drawbar_4: 0, drawbar_5: 0,
      drawbar_6: 0, drawbar_7: 0, drawbar_8: 0, drawbar_9: 0,
      vibrato_type: "C3",
      vibrato_enable: "On",
      percussion: "On",
      percussion_harmonic: "2nd",
      percussion_speed_level: "Fast/Normal",
      rotary_speed: "Slow",
      effect1_enable: "Off",
      effect2_enable: "Off",
      spkr_comp_enable: "Off",
      spkr_comp_drive: 0,
      reverb_type: "Stage",
      reverb_enable: "On",
      reverb_dry_wet: 40,
      delay_enable: "Off",
      eq_treble: 70,
      eq_bass: 64,
    },
  },
  {
    name: "Gospel Organ",
    description:
      "Full, rich B3 gospel organ: 888808008 drawbars, no percussion, fast Leslie, hall reverb. " +
      "Great for gospel, church, and praise music.",
    genre: "gospel",
    parameters: {
      part_upper_engine_select: "Organ",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      organ_model: "B3",
      drawbar_1: 8, drawbar_2: 8, drawbar_3: 8, drawbar_4: 8, drawbar_5: 0,
      drawbar_6: 8, drawbar_7: 0, drawbar_8: 0, drawbar_9: 8,
      vibrato_type: "C3",
      vibrato_enable: "On",
      percussion: "Off",
      rotary_speed: "Fast",
      effect1_enable: "Off",
      effect2_enable: "Off",
      spkr_comp_enable: "Off",
      reverb_type: "Hall",
      reverb_enable: "On",
      reverb_dry_wet: 50,
      delay_enable: "Off",
      eq_treble: 72,
      eq_bass: 70,
    },
  },
  {
    name: "Rock Organ (Deep Purple)",
    description:
      "Aggressive B3 rock organ: all drawbars full, heavy overdrive, fast Leslie. " +
      "Inspired by Jon Lord / Deep Purple, also great for classic rock and blues rock.",
    genre: "rock",
    parameters: {
      part_upper_engine_select: "Organ",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      organ_model: "B3",
      drawbar_1: 8, drawbar_2: 8, drawbar_3: 8, drawbar_4: 8, drawbar_5: 8,
      drawbar_6: 8, drawbar_7: 8, drawbar_8: 8, drawbar_9: 8,
      vibrato_type: "C3",
      vibrato_enable: "On",
      percussion: "Off",
      rotary_speed: "Fast",
      effect1_enable: "Off",
      effect2_enable: "Off",
      spkr_comp_type: "Twin",
      spkr_comp_enable: "On",
      spkr_comp_drive: 100,
      reverb_type: "Room",
      reverb_enable: "On",
      reverb_dry_wet: 30,
      delay_enable: "Off",
      eq_treble: 80,
      eq_bass: 75,
    },
  },
  {
    name: "Rhodes Ballad",
    description:
      "Warm, mellow Rhodes electric piano with chorus and reverb. " +
      "Classic sound for ballads, smooth jazz, neo-soul, and R&B.",
    genre: "ballad",
    parameters: {
      part_upper_engine_select: "Piano",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      piano_type: "EP1",
      piano_model: 0,
      effect1_type: "Trem 1",
      effect1_enable: "On",
      effect1_rate: 40,
      effect2_type: "Chorus 1",
      effect2_enable: "On",
      effect2_rate: 60,
      spkr_comp_type: "JC",
      spkr_comp_enable: "On",
      spkr_comp_drive: 10,
      reverb_type: "Hall",
      reverb_enable: "On",
      reverb_dry_wet: 55,
      delay_enable: "On",
      delay_tempo: 64,
      delay_dry_wet: 25,
      eq_treble: 58,
      eq_bass: 70,
    },
  },
  {
    name: "Wurlitzer Funk",
    description:
      "Punchy Wurlitzer electric piano with tremolo. " +
      "Great for funk, soul, Motown, and Supertramp-style pop.",
    genre: "funk",
    parameters: {
      part_upper_engine_select: "Piano",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      piano_type: "EP2",
      piano_model: 0,
      effect1_type: "Trem 1",
      effect1_enable: "On",
      effect1_rate: 65,
      effect2_enable: "Off",
      spkr_comp_type: "Small",
      spkr_comp_enable: "On",
      spkr_comp_drive: 30,
      reverb_type: "Room",
      reverb_enable: "On",
      reverb_dry_wet: 20,
      delay_enable: "Off",
      eq_treble: 80,
      eq_bass: 60,
    },
  },
  {
    name: "Classic Clav",
    description:
      "Funky clavinet with auto-wah. " +
      "Stevie Wonder / Herbie Hancock style, perfect for funk and disco.",
    genre: "funk",
    parameters: {
      part_upper_engine_select: "Piano",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      piano_type: "Clav",
      piano_model: 0,
      effect1_type: "Wah",
      effect1_enable: "On",
      effect1_rate: 80,
      effect2_type: "Phase 1",
      effect2_enable: "On",
      effect2_rate: 40,
      spkr_comp_type: "Small",
      spkr_comp_enable: "On",
      spkr_comp_drive: 20,
      reverb_enable: "Off",
      delay_enable: "Off",
      eq_treble: 90,
      eq_bass: 50,
    },
  },
  {
    name: "Grand Piano",
    description:
      "Clean grand piano with a touch of reverb. " +
      "Versatile sound for pop, classical, singer-songwriter, and worship.",
    genre: "pop",
    parameters: {
      part_upper_engine_select: "Piano",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      piano_type: "Grand",
      piano_model: 0,
      effect1_enable: "Off",
      effect2_enable: "Off",
      spkr_comp_enable: "Off",
      spkr_comp_drive: 0,
      reverb_type: "Stage",
      reverb_enable: "On",
      reverb_dry_wet: 40,
      delay_enable: "Off",
      eq_treble: 64,
      eq_bass: 64,
    },
  },
  {
    name: "Honky Tonk Piano",
    description:
      "Bright, characterful upright piano with chorus for a detuned honky-tonk feel. " +
      "Great for country, boogie-woogie, and vintage rock & roll.",
    genre: "country",
    parameters: {
      part_upper_engine_select: "Piano",
      part_upper_enable: "On",
      part_lower_enable: "Off",
      kb_split_mode: "Off",
      piano_type: "Upright",
      piano_model: 0,
      effect1_enable: "Off",
      effect2_type: "Chorus 1",
      effect2_enable: "On",
      effect2_rate: 50,
      spkr_comp_enable: "Off",
      reverb_type: "Room",
      reverb_enable: "On",
      reverb_dry_wet: 35,
      delay_enable: "Off",
      eq_treble: 85,
      eq_bass: 55,
    },
  },
];

/** Find a preset by name (fuzzy match) */
export function findPreset(name: string): Preset | undefined {
  const lower = name.toLowerCase();
  return (
    PRESETS.find((p) => p.name.toLowerCase() === lower) ||
    PRESETS.find((p) => p.name.toLowerCase().includes(lower))
  );
}

/** Get presets filtered by genre */
export function getPresetsByGenre(genre: string): Preset[] {
  const lower = genre.toLowerCase();
  return PRESETS.filter((p) => p.genre.toLowerCase().includes(lower));
}
