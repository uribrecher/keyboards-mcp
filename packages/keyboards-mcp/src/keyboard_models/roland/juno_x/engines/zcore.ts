import type { KeyboardParameter } from "../../../../shared/types.js";
import { JunoXEngine } from "./engine-types.js";

export const ZCORE_ENGINE = JunoXEngine.ZCore;

const PARTIAL_CCS: Record<string, [number, number, number, number]> = {
  level:        [16, 17, 18, 19],
  fine_tune:    [21, 31, 35, 46],
  cutoff:       [3, 54, 55, 56],
  resonance:    [9, 57, 58, 59],
  filtr_depth:  [81, 63, 79, 80],
  filtr_time1:  [83, 82, 85, 87],
  filtr_time4:  [86, 102, 103, 104],
  amp_time1:    [89, 108, 109, 111],
  amp_time4:    [90, 112, 114, 117],
  l1_rate:      [29, 20, 22, 23],
  l1_pit_depth: [26, 47, 48, 50],
  l1_amp_depth: [30, 105, 106, 107],
  l1_flt_depth: [28, 60, 61, 62],
  l2_rate:      [14, 24, 25, 27],
  l2_pit_depth: [15, 51, 52, 53],
};

export function createZCoreParams(): Record<string, KeyboardParameter> {
  const params: Record<string, KeyboardParameter> = {};

  for (let pn = 1; pn <= 4; pn++) {
    const idx = pn - 1;
    const prefix = `p${pn}_`;
    const section = `partial-${pn}`;

    const continuous = (
      key: string,
      name: string,
      defaultValue: number,
      description: string,
    ): KeyboardParameter => ({
      name,
      section,
      cc: PARTIAL_CCS[key][idx],
      min: 0,
      max: 127,
      defaultValue,
      type: "continuous",
      description,
      encoding: { kind: "raw" },
      perPart: true,
    });

    params[`${prefix}level`] = continuous(
      "level",
      `Partial ${pn} Level`,
      100,
      `Output level of ZEN-Core partial ${pn}`,
    );

    params[`${prefix}fine_tune`] = continuous(
      "fine_tune",
      `Partial ${pn} Fine Tune`,
      64,
      `Fine pitch tuning for ZEN-Core partial ${pn} (64 = center)`,
    );

    params[`${prefix}cutoff`] = continuous(
      "cutoff",
      `Partial ${pn} Cutoff`,
      127,
      `Filter cutoff frequency for ZEN-Core partial ${pn}`,
    );

    params[`${prefix}resonance`] = continuous(
      "resonance",
      `Partial ${pn} Resonance`,
      0,
      `Filter resonance for ZEN-Core partial ${pn}`,
    );

    params[`${prefix}filtr_depth`] = continuous(
      "filtr_depth",
      `Partial ${pn} Filter Env Depth`,
      0,
      `Filter envelope depth for ZEN-Core partial ${pn}`,
    );

    params[`${prefix}amp_time1`] = continuous(
      "amp_time1",
      `Partial ${pn} Amp Attack`,
      0,
      `Amplitude envelope attack time for ZEN-Core partial ${pn}`,
    );

    params[`${prefix}amp_time4`] = continuous(
      "amp_time4",
      `Partial ${pn} Amp Release`,
      32,
      `Amplitude envelope release time for ZEN-Core partial ${pn}`,
    );

    params[`${prefix}l1_rate`] = continuous(
      "l1_rate",
      `Partial ${pn} LFO1 Rate`,
      64,
      `LFO1 rate for ZEN-Core partial ${pn}`,
    );
  }

  params["amp_level"] = {
    name: "Tone Level",
    section: "tone-common",
    cc: 110,
    min: 0,
    max: 127,
    defaultValue: 100,
    type: "continuous",
    description: "Overall output level of the ZEN-Core tone",
    encoding: { kind: "raw" },
    perPart: true,
  };

  return params;
}
