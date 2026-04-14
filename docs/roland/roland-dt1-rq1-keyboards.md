# Roland Keyboards Using DT1/RQ1 SysEx Protocol

Roland has used the DT1 (Data Set 1) / RQ1 (Data Request 1) SysEx protocol since the late 1980s. It's their standard mechanism for deep parameter control — every synth parameter gets a 4-byte address, and you read/write values via structured SysEx messages.

## Modern (ZEN-Core era, ~2019+)

These all share the same fundamental architecture — ZEN-Core engine with DT1/RQ1 control. Because they share an engine, a large portion of the SysEx address map is reusable across the family.

| Model | Keys | Engine | Notes |
|-------|------|--------|-------|
| **FANTOM-6/7/8** | 61/76/88 | ZEN-Core + SuperNATURAL | Flagship workstations |
| **FANTOM-06/07/08** | 61/76/88 | ZEN-Core + SuperNATURAL | Lighter "FANTOM-0" series, same engine |
| **JUPITER-X** | 61 | ZEN-Core + Model Expansions | JP-8, JUNO-106, SH-101 emulations |
| **JUPITER-Xm** | 37 (mini) | ZEN-Core + Model Expansions | Same engine as Jupiter-X, compact |
| **JUNO-X** | 61 | ZEN-Core + Analog Synth Model | JUNO-106/60 emulation + ZEN-Core |
| **JUNO-DS61/88** | 61/88 | SuperNATURAL | Lighter workstation |
| **JUNO-D6/D7/D8** | 61/76/88 | ZEN-Core | 2024 release |
| **RD-2000** | 88 | SuperNATURAL + V-Piano | Stage piano |
| **RD-88** | 88 | ZEN-Core + SuperNATURAL | Stage piano |
| **JD-XA** | 49 | Analog + SuperNATURAL | True analog + digital hybrid |
| **JD-Xi** | 37 (mini) | Analog + digital | Confirmed DT1/RQ1 |
| **FA-06/07/08** | 61/76/88 | SuperNATURAL | Pre-ZEN-Core workstations |

## Classic/Vintage

Roland has used this same protocol architecture (with variations in model ID size and address width) since the D-50:

| Model | Era | Notes |
|-------|-----|-------|
| **D-50** | 1987 | One of the first with DT1/RQ1 |
| **D-10/D-20/D-70** | Late '80s | Linear synthesis |
| **JV-80/JV-90/JV-1000** | Early '90s | Workstation keyboards |
| **XP-50/XP-60/XP-80** | Mid '90s | Expanded JV architecture |
| **Fantom-S/X** | 2003-04 | Pre-modern Fantom |
| **Fantom-G6/G7/G8** | 2008 | Last "classic" Fantom |
| **JUNO-G** | 2006 | Budget workstation |
| **Jupiter-50/80** | 2012 | SuperNATURAL era |

## Protocol summary

```
DT1 (write):  F0 41 <dev> <model_id...> 12 <addr_4bytes> <data...> <checksum> F7
RQ1 (read):   F0 41 <dev> <model_id...> 11 <addr_4bytes> <size_4bytes> <checksum> F7
```

- Manufacturer ID: `41` (Roland)
- Model ID: varies per device (1-5 bytes depending on era)
- Command: `11` = RQ1, `12` = DT1
- Checksum: `(128 - (sum of address + data) & 0x7F) & 0x7F`

## Implementation insight

The modern ZEN-Core keyboards (FANTOM, JUPITER-X, JUNO-X) share very similar SysEx address maps because they run the same synthesis engine. If we implement DT1/RQ1 support for one (e.g., JUNO-X), a large portion would be reusable across the whole family — the tone engine parameters are essentially the same, just with different Model Expansions available.

## Sources

- [Roland Fantom 6/7/8 MIDI Tool (GitHub)](https://github.com/rtmalikian/fantom-6-7-8-midi-tool)
- [Roland FP-30 SysEx reverse engineering (GitHub)](https://github.com/bluebrother/fp30remote/)
- [Jupiter-Xm MIDI Implementation (Roland)](https://static.roland.com/assets/media/pdf/JUPITER-Xm_MIDI_imple_eng01_W.pdf)
- [JD-Xi MIDI Implementation (Roland)](https://static.roland.com/assets/media/pdf/JD-Xi_MIDI_Imple_e01_W.pdf)
- [Roland SysEx info (Vintage Synth Explorer)](https://forum.vintagesynth.com/viewtopic.php?t=94630)
- [Dialog Audio SysEx Database](https://dialogaudio.com/modulationprocessor/sysex_info.php)
