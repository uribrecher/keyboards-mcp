# Nord Electro 5D MIDI CC Comparison

Comparison of the official owner's manual CC table vs our implementation in `nord-electro-5d-map.ts`.

Source: Nord Electro 5D Owner's Manual, Appendix II (screenshot in `test_data/Screenshot 2026-03-29 at 21.46.04.png`)

## Mapped CCs (all verified correct)

| CC | Manual Name | Our Key | Notes |
|----|-------------|---------|-------|
| 0 | Bank Select MSB | — | Handled in MIDI layer |
| 3 | Organ Preset Select | `organ_preset_select` | |
| 7 | Gain Level | `master_volume` | |
| 9 | Organ Model | `organ_model` | |
| 12 | Piano Type | `piano_type` | |
| 13 | Part Mix Level | `part_mix` | |
| 16-24 | Organ Drawbar 1-9 | `drawbar_1` – `drawbar_9` | |
| 25 | Organ Drawbar Live | `organ_drawbar_live` | |
| 32 | Bank Select LSB | — | Handled in MIDI layer |
| 33 | Sample Synth Attack | `sample_synth_attack` | |
| 34 | Sample Synth Release | `sample_synth_release` | |
| 35 | Sample Synth Sample | `sample_synth_sample` | 1-based (oneBased) |
| 36 | Sample Synth Dynamics | `sample_synth_dynamics` | |
| 37 | Sample Synth Filter Velocity | `sample_synth_filter_vel` | |
| 39 | Part Lower Sound Engine Select | `part_lower_engine_select` | |
| 40 | Part Upper Sound Engine Select | `part_upper_engine_select` | |
| 41 | Part Lower Enable | `part_lower_enable` | |
| 42 | Part Upper Enable | `part_upper_enable` | |
| 44 | Piano Model | `piano_model` | modelIndex encoding |
| 45 | Piano Variation | `piano_variation` | Clav A/B/C/D, modelIndex encoding |
| 46 | Piano KBD Touch | `piano_kbd_touch` | |
| 50 | KB Split Mode | `kb_split_mode` | |
| 51 | KB Split Point | `kb_split_point` | |
| 54 | Octave Shift Part Lower | `octave_shift_lower` | |
| 55 | Octave Shift Part Upper | `octave_shift_upper` | |
| 60 | Effect 1 Type | `effect1_type` | |
| 61 | Effect 2 Type | `effect2_type` | |
| 62 | Effect 2 Rate | `effect2_rate` | |
| 63 | Effect 1 Rate | `effect1_rate` | |
| 69 | Effect 1 Enable | `effect1_enable` | |
| 71 | Effect 1 Part Select | `effect1_part_select` | |
| 72 | Effect 2 Part Select | `effect2_part_select` | |
| 73 | Effect 1 Ctrl Pedal | `effect1_ctrl_pedal` | |
| 74 | Effect 2 Deep Mode | `effect2_deep` | |
| 79 | Rotary Stop Mode | `rotary_stop_mode` | |
| 80 | Effect 2 Enable | `effect2_enable` | |
| 81 | Spkr/Comp Type | `spkr_comp_type` | |
| 82 | Rotary Speed | `rotary_speed` | |
| 83 | Piano Mono Mode | `piano_mono` | |
| 84 | Organ Vibrato Type | `vibrato_type` | |
| 85 | Organ Vibrato Enable | `vibrato_enable` | |
| 86 | Spkr/Comp Enable | `spkr_comp_enable` | |
| 87 | Organ Percussion Enable | `percussion` | |
| 88 | Organ Percussion Speed/Level | `percussion_speed_level` | |
| 92 | Delay Tempo | `delay_tempo` | |
| 93 | Delay Ping Pong | `delay_ping_pong` | |
| 94 | Delay Enable | `delay_enable` | |
| 95 | Organ Percussion Harmonic | `percussion_harmonic` | |
| 96 | Reverb Type | `reverb_type` | |
| 97 | Reverb Enable | `reverb_enable` | |
| 98 | Piano Acoustic | `piano_acoustic` | |
| 102 | Reverb Dry/Wet | `reverb_dry_wet` | |
| 103 | Delay Dry/Wet | `delay_dry_wet` | |
| 104 | Delay Feedback | `delay_feedback` | |
| 105 | Delay Part Select | `delay_part_select` | |
| 111 | Spkr/Comp Drive | `spkr_comp_drive` | |
| 112 | Spkr/Comp Part Select | `spkr_comp_part_select` | |
| 113 | EQ Treble | `eq_treble` | |
| 115 | EQ Enable | `eq_enable` | |
| 116 | EQ Mid | `eq_mid` | |
| 117 | EQ Mid Frequency | `eq_mid_freq` | |
| 118 | EQ Bass | `eq_bass` | |
| 119 | EQ Part Select | `eq_part_select` | |

## Unmapped CCs (not needed for sound programming)

| CC | Manual Name | Reason not mapped |
|----|-------------|-------------------|
| 11 | Control Pedal (Expression) | Physical pedal input, not a stored parameter |
| 48 | Program/Set List/Live mode toggle | Mode switching, not a sound parameter |
| 49 | Set List Slot Select | Navigation, not a sound parameter |
| 52 | Transpose Enable | Global setting, not per-program |
| 53 | Transpose Value | Global setting, not per-program |
| 56 | Sustain Pedal Enable Part Lower | Pedal routing |
| 57 | Sustain Pedal Enable Part Upper | Pedal routing |
| 58 | Ctrl Pedal Enable Part Lower | Pedal routing |
| 59 | Ctrl Pedal Enable Part Upper | Pedal routing |
| 64 | Sustain | Physical pedal input |
| 90 | Rotor Pedal | Does not respond to MIDI CC on real hardware |
