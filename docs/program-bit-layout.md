# Nord Electro 5D Program Payload Bit Layout

137-byte (1096-bit) payload after 28-byte CBIN header. MSB-first bit numbering (bit 0 of each byte = MSB).

```
Bit       Width  Field                        Values / Notes
────────  ─────  ───────────────────────────  ──────────────────────────────────
  0-144          [unknown / reserved]

 ── Part / Split ──────────────────────────────────────────────────────────────
145-146    2     lowerEngine                  0=Organ, 1=Piano, 2=Sample Synth
147              [gap]
148-149    2     upperEngine                  0=Organ, 1=Piano, 2=Sample Synth
150-153    4     lowerOctaveShift             raw value; display = value - 7 (range varies by split point)
154-157    4     upperOctaveShift             raw value; display = value - 7 (range varies by split point)
158        1     lowerSustainPedalEnable      0=off, 1=on
159        1     upperSustainPedalEnable      0=off, 1=on
160        1     lowerCtrlPedalEnable         0=off, 1=on
161        1     upperCtrlPedalEnable         0=off, 1=on
162              [unknown]
163        1     splitMode                    0=off, 1=on
164-166    3     splitPoint                   0=C3,1=F3,2=C4,3=F4,4=C5,5=F5

 ── Master ────────────────────────────────────────────────────────────────────
167        1     transposeEnable              0=off, 1=on
168-171    4     transposeAmount              raw value 0-12; display = value - 6 semitones
172-178    7     partMix                      0-127 (0=Lower, 64=center, 127=Upper)
179-185    7     masterGain                   0-127

 ── Organ ─────────────────────────────────────────────────────────────────────
186-188    3     organModel                   0=B3,1=B3+Bass,2=Pipe,3=Vox,4=Farfisa
189        1     lowerEnable                  0=off, 1=on
190        1     upperEnable                  0=off, 1=on
191-239          [unknown]

 ── Piano ─────────────────────────────────────────────────────────────────────
240-242    3     pianoType                    0=Grand,1=Upright,2=EP1,3=EP2,4=Clav,5=Harpsi
243-245          [unknown]
246-249    4     pianoModel                   0-based index within type (1-based on display)
250-254          [unknown]
255-256    2     clavVariation                0=A, 1=B, 2=C, 3=D
257-258    2     pianoAcoustic                0=Off, 1=String Resonance, 2=Long Release, 3=Both
259-260    2     pianoKbdTouch                0-3 (touch sensitivity)
261        1     pianoMono                    0=off, 1=on
262-335          [unknown — 74 bits]

 ── Sample Synth ──────────────────────────────────────────────────────────────
336-342    7     sampleAttack                 0-127
343-349    7     sampleDecRel                 0-127 (0-63=decay, 64=sustain, 65-127=release)
350-357    8     sampleSlot                   0-based CBIN slot index (0-152)
358-389          [unknown — 32 bits]
390-391    2     sampleDynamics               0=Off, 1=Low, 2=Mid, 3=High
392        1     sampleFilterVel              0=off, 1=on
393-426          [unknown — 34 bits]

 ── Percussion (B3 organ model only) ──────────────────────────────────────────
427        1     percussionHarmonic           0=2nd, 1=3rd
428        1     percussionLevel              0=Normal, 1=Soft
429        1     percussionSpeed              0=Slow, 1=Fast
430-455          [unknown]

 ── Drawbars (positions vary by organ model) ──────────────────────────────────

  B3:
    456-491   9×4  preset1 drawbars 1-9       4-bit each (0-8)
    492        1   preset1 vibratoEnable       0=off, 1=on
    493        1   preset1 percussionEnable    0=off, 1=on
    494-496    3   vibratoType                 0=V1,1=C1,2=V2,3=C2,4=V3,5=C3
    497-511        [unknown]
    512-547   9×4  preset2 drawbars 1-9       4-bit each (0-8)
    548        1   preset2 vibratoEnable       0=off, 1=on
    549        1   preset2 percussionEnable    0=off, 1=on
    550-551        [unknown]

  B3+Bass:
    494-501   2×4  preset1 bass drawbars       4-bit each (0-8)
    512-547   9×4  preset2 drawbars 1-9       4-bit each (0-8)

  Vox:
    600-631   8×4  preset1 drawbars 1-8       4-bit each (0-8), no drawbar 9
    648-679   8×4  preset2 drawbars 1-8       4-bit each (0-8)

  Farfisa:
    728-763   9×4  preset1 drawbars 1-9       4-bit each (0 or 8 = off/on)
    776-811   9×4  preset2 drawbars 1-9       4-bit each (0 or 8 = off/on)

  Pipe:
    856-891   9×4  preset1 drawbars 1-9       4-bit each (0-8)
    904-939   9×4  preset2 drawbars 1-9       4-bit each (0-8)

940-951          [unknown — 12 bits]

 ── Effects ───────────────────────────────────────────────────────────────────

  FX1 (bits 952-963):
    952        1   fx1Enable                   0=off, 1=on
    953        1   fx1PartSelect               0=Lower, 1=Upper
    954-956    3   fx1Type                     0=Trem1..7=RingMod
    957-963    7   fx1Rate                     0-127
                   (fx1ControlPedal is at bit 1067 in the tail section)

  FX2 (bits 964-977):
    964              [gap]
    965        1   fx2Enable                   0=off, 1=on
    966        1   fx2PartSelect               0=Lower, 1=Upper
    967              [gap]
    968-970    3   fx2Type                     0=Phase1..5=Vibe
    971-977    7   fx2Rate                     0-127
                   (fx2Deep is at bit 1068 in the tail section)

  Delay (bits 978-995):
    978        1   delayEnable                 0=off, 1=on
    979        1   delayPartSelect             0=Lower, 1=Upper
    980-986    7   delayTempo                  0-127
    987              [gap]
    988        1   delayPingPong               0=off, 1=on
    989-995    7   delayDryWet                 0-127

  EQ (bits 997-1026, part select at 1069):
    997        1   eqEnable                    0=off, 1=on
    998              [gap]
    999-1005   7   eqMidFreq                   0-127
   1006-1012   7   eqTreble                    0-127
   1013-1019   7   eqMid                       0-127
   1020-1026   7   eqBass                      0-127

  Amp/Speaker (bits 1027-1038):
   1027        1   ampEnable                   0=off, 1=on
   1028              [unknown — 1 bit]
   1029-1031   3   ampType                     0=Dist,1=Small,2=JC,3=Twin,4=Rotary,5=Comp
   1032-1038   7   ampDrive                    0-127

  Reverb (bits 1039-1049):
   1039        1   revEnable                   0=off, 1=on
   1040-1042   3   revType                     0=Room,1=StageSoft,2=Stage,3=HallSoft,4=Hall
   1043-1049   7   revDryWet                   0-127

 ── Tail ──────────────────────────────────────────────────────────────────────
1050-1066        [unknown — 17 bits]
1067       1     fx1ControlPedal               0=off, 1=on
1068       1     fx2Deep                       0=off, 1=on
1069-1070  2     eqPartSelect                  0=Lower, 1=Upper, 2=Both
1071-1095        [unknown — 25 bits]
```

## Notes

- All fields are MSB-first (bit 0 of each byte = hardware bit 7)
- Drawbar positions are model-dependent — the bit layout changes based on organModel
- Percussion, vibrato enable, and vibrato type are per-preset and per-organ-model. Bit positions confirmed for B3 only; other organ models store them at different positions (likely near their respective drawbar regions)
- Unknown regions likely contain: eq part-select, amp part-select