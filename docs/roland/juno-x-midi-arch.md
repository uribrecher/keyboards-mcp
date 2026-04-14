# Roland Juno-X MIDI Architecture

Source: JUNO-X MIDI Implementation v1.10 (April 26, 2022), 92 pages.

## Overview

The Juno-X uses a dual-layer MIDI system: standard CCs for high-level macros, and Roland SysEx (DT1/RQ1) for deep parameter control. This is fundamentally different from simple CC-mapped keyboards like the Nord Electro 5D or Prophet-6.

## Layer 1: Standard MIDI CCs (indirect control)

Basic CCs map to **Scene Part "MODIFY" parameters** — high-level offsets applied on top of the tone's own settings:

| CC | Parameter | Notes |
|----|-----------|-------|
| 1 | Mod Wheel | |
| 5 | Portamento Time | |
| 7 | Volume | Per-part level |
| 10 | Pan | |
| 11 | Expression | |
| 64 | Hold 1 (Sustain) | |
| 65 | Portamento Switch | |
| 71 | Resonance | Modify offset, not absolute |
| 72 | Release | Modify offset |
| 73 | Attack | Modify offset |
| 74 | Cutoff (Brightness) | Modify offset |
| 75 | Decay | Modify offset |
| 76 | Vibrato Rate | Modify offset |
| 77 | Vibrato Depth | Modify offset |
| 78 | Vibrato Delay | Modify offset |
| 80 | Reverb Send | |
| 81 | Chorus Send | |

**Key point**: CC74 (Cutoff) doesn't directly set the filter cutoff of the synth engine — it modifies the Scene Part's "Cutoff" offset, which is layered on top of the tone's own cutoff setting.

## Layer 2: Roland SysEx (full control)

### Protocol: DT1/RQ1

- **DT1 (Data Set 1)**: Write a parameter value to a specific address
- **RQ1 (Data Request 1)**: Request a parameter value from a specific address

### Message format

```
DT1 (write):  F0 41 <dev> 00 00 00 00 12 12 <aa> <bb> <cc> <dd> <data...> <checksum> F7
RQ1 (read):   F0 41 <dev> 00 00 00 00 12 11 <aa> <bb> <cc> <dd> <ss> <tt> <uu> <vv> <checksum> F7
```

- Model ID: `00 00 00 00 12` (5 bytes)
- Device ID: `10` - `1F` or `7F` (broadcast)
- Command: `11` = RQ1, `12` = DT1
- Address: 4 bytes (`aa bb cc dd`)
- Checksum: `(128 - (sum of address + data bytes) & 0x7F) & 0x7F`

### Parameters wider than 7 bits

Parameters marked with `#` in the docs span multiple bytes. For example, a 10-bit value (0-1023) is split into nibbles:

```
Byte 0: 0000 aaaa  (high nibble)
Byte 1: 0000 bbbb  (low nibble of high byte)
Byte 2: 0000 cccc  (high nibble of low byte)
Byte 3: 0000 dddd  (low nibble)
```

Example: `0ABH` → sent as `00 0A 00 0B`.

## Address Map Hierarchy

### Top level

| Address | Description |
|---------|-------------|
| `00 00 00 00` | System (master tune, global effects, master EQ/comp) |
| `00 10 00 00` | Setup (scene bank select + program change) |
| `01 00 00 00` | Temporary Scene |
| `02 00 00 00` | Temporary Tone ZCore (parts 01-04) |
| `02 10 00 00` | Temporary Tone Analog Synth Model (parts 01-04) |
| `02 20 00 00` | Temporary Tone RD Piano (part 01) |
| `02 40 00 00` | Temporary Tone JUNO-X Model (parts 01-04) |
| `40 00 00 00` | User Scene storage (001-256) |
| `50 00 00 00` | User Tone storage (001-256) |

### Scene structure (01 00 00 00)

A Scene is the Juno-X's equivalent of a "patch" or "program". Contains:

| Offset | Description |
|--------|-------------|
| `00 00 00` | Scene Common |
| `00 10 00` - `00 14 00` | Scene Part (01-05) — tone selection, level, pan, MIDI |
| `00 20 00` - `00 24 00` | Scene EQ (01-05) — per-part EQ |
| `00 30 00` - `00 38 00` | Scene MFX (01-05) — per-part multi-effects |
| `00 40 00` - `00 44 00` | Scene Zone (01-05) — keyboard split/layer zones |
| `00 50 00` | Scene Chorus |
| `00 51 00` | Scene Delay |
| `00 52 00` | Scene Reverb |
| `00 53 00` | Scene Drive |
| `00 54 00` | Scene Arpeggio Common |
| `00 55 00` - `00 59 00` | Scene Arpeggio Part (01-05) |

### Tone engines

Each part can run one of four completely different synth engines, each with its own parameter set:

#### ZCore (Roland's modern PCM/VA engine)
4 partials, each with:
- Oscillator (PCM wave or VA waveform)
- Pitch envelope
- Filter (with envelope)
- Amplifier (with envelope)
- LFO
- Per-partial EQ

Plus: Tone Common, Tone PMT (partial mix table), Synth Common, Synth Partials, MFX.

#### Analog Synth Model (JUNO-106 / JUNO-60 emulation)
Faithful recreation of the original JUNO panel controls:
- LFO (waveform, rate, delay)
- OSC 1 & 2 (waveform, feet, coarse/fine tune, PWM, pulse width)
- Mixer (osc balance, sub osc, noise)
- Filter (cutoff, resonance, env depth, key follow)
- VCA & Envelope (ADSR)
- Chorus (type I, II, I+II)

Model selection: JUNO-106 or JUNO-60 (different waveform sets and behavior).

#### RD Piano
RD piano model with sympathetic resonance parameters.

#### JUNO-X Model
The Juno-X's own synth engine (similar structure to Analog Synth Model but with extended capabilities).

## Multi-timbral: 5 parts

The Juno-X is 5-part multi-timbral:
- Each part has its own MIDI channel, tone, level, pan, effects
- Parts can be layered or split across keyboard zones
- Each part can independently run any of the 4 synth engines

## Tone bank select

Tones are organized by bank (MSB/LSB) and program number:

| MSB | LSB | Group |
|-----|-----|-------|
| 071 | 003-004 | User Tone (256) |
| 071 | 067 | PR-X (factory) |
| 071 | 069 | RD-PIANO |
| 071 | 070 | VOCODER |
| 087 | 064-077 | PR-B, PR-C, PR-D (factory) |
| 087 | 078-084 | XV-5080 (legacy) |
| 087 | 085-091 | COMMON |
| 087 | 092-093 | PR-A (factory) |
| 097 | 066 | JUNO-106 (122 tones) |
| 097 | 074-075 | JUNO-60 (137 tones) |
| 097 | 076-077 | JUNO-X (145 tones) |

## Implementation considerations

For an MCP implementation, the Juno-X would require:

1. **SysEx sender**: DT1 messages with 4-byte address calculation and Roland checksum — not just CC sends
2. **Engine-aware parameter routing**: Different parameter sets depending on which synth model a part is running
3. **Multi-part awareness**: 5 independent parts, each potentially on a different engine
4. **Nibble packing**: Parameters wider than 7 bits need nibble-split encoding
5. **CC layer**: The standard CCs still work for the "modify" macros and would be the simplest starting point
6. **Scene management**: Scene = program. Bank select + program change to switch scenes

### Possible phased approach

- **Phase 1**: CC-only control (modify macros — cutoff, resonance, attack, decay, release, etc.)
- **Phase 2**: SysEx DT1/RQ1 for the Analog Synth Model (JUNO-106/60 emulation params)
- **Phase 3**: Full ZCore and JUNO-X Model SysEx control
- **Phase 4**: Scene/Part management, zone configuration
