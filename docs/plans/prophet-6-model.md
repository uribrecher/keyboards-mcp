# Sequential Circuits Prophet-6 Model

## Context

Adding a second keyboard model to validate the multi-model architecture. The Prophet-6 is a polyphonic analog synthesizer — very different from the Nord (no samples, no split/layer, no backup files). This tests that the generic infrastructure works with a minimal model.

## Files to Create

### `src/keyboard_models/sequential_circuits/prophet_6/midi-map.ts`

Parameter definitions from the MIDI CC table screenshot. All params are global (no `perPart`). Sections:

- **oscillator_1**: Freq (67), Level (69), Shape (70), Pulse Width (71)
- **oscillator_2**: Freq (75), Freq Fine (76), Level (77), Shape (78), Pulse Width (79)
- **mixer**: Sub Osc Level (8)
- **lowpass_filter**: Freq (102), Resonance (103), Key Amt (104), Vel On/Off (105), Env Amt (47)
- **highpass_filter**: Freq (106), Resonance (107), Key Amt (108), Vel On/Off (109), Env Amt (54)
- **filter_envelope**: Attack (50), Decay (51), Sustain (52), Release (53)
- **amplifier**: VCA Env Amt (40), Vel Amt (41), Attack (43), Decay (44), Sustain (45), Release (46)
- **effects**: Distortion Amount (9)
- **arpeggiator**: On/Off (58), Mode (59), Range (60), Time Signature (62)
- **performance**: Glide On/Off (65), Glide Mode (5), BPM (3), Damper Pedal (64), MIDI Volume (7)

### `src/keyboard_models/sequential_circuits/prophet_6/index.ts`

Minimal `KeyboardModel` implementation using `GenericParameterState`, empty presets, and a system prompt describing the Prophet-6 signal path.

## Verification

1. `npm run build`
2. `npm run mock:runner` — model picker should show both models
3. `list_parameters` after connecting — should show all Prophet-6 sections