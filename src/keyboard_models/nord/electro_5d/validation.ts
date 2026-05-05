/**
 * Nord Electro 5D parameter validation warnings.
 * Extracted from set-parameters.ts — these are hardware-specific constraints.
 */

import type { StateManager, ParameterMap } from "../../../shared/keyboard-model.js";
import { midiToDiscrete } from "../../../shared/parameter-resolution.js";

export function validateParameterBatch(
  parameters: Array<{ key: string; value: number | string }>,
  state: StateManager,
  targetPart: string,
  parameterMap: ParameterMap,
): string[] {
  const warnings: string[] = [];
  const otherPart = targetPart === "upper" ? "lower" : "upper";
  const splitMode = state.get("kb_split_mode");
  const isLayerMode = !splitMode || splitMode === 0;

  // Check if both parts use the same engine
  {
    let finalLower = state.get("part_lower_engine_select");
    let finalUpper = state.get("part_upper_engine_select");
    for (const { key, value } of parameters) {
      const param = parameterMap.params[key];
      if (!param) continue;
      if (key === "part_lower_engine_select") finalLower = parameterMap.resolveValue(param, value);
      if (key === "part_upper_engine_select") finalUpper = parameterMap.resolveValue(param, value);
    }

    if (finalLower !== undefined && finalUpper !== undefined && finalLower === finalUpper) {
      const engineIdx = midiToDiscrete(finalLower, 2);
      const engineNames: Record<number, string> = { 0: "Organ", 1: "Piano", 2: "Sample Synth" };
      const engineName = engineNames[engineIdx] ?? String(finalLower);

      if (isLayerMode) {
        warnings.push(
          `WARNING: In layer mode (split off), both parts CANNOT use the same engine. ` +
          `Both would be set to ${engineName}. ` +
          `Enable split mode first, or choose a different engine for one part.`,
        );
      } else if (engineIdx !== 0) {
        warnings.push(
          `WARNING: In split mode, both parts CANNOT use ${engineName} simultaneously. ` +
          `${engineName} shares model/sample selection across parts. ` +
          `Only Organ supports independent per-part configuration (via Preset 1/2).`,
        );
      }
    }
  }

  // Shared piano/sample warnings in split mode
  const targetEngineKey = targetPart === "lower" ? "part_lower_engine_select" : "part_upper_engine_select";
  const otherEngineKey = otherPart === "lower" ? "part_lower_engine_select" : "part_upper_engine_select";
  const targetEngine = state.get(targetEngineKey);
  const otherEngine = state.get(otherEngineKey);

  const sharedParams = new Set(["piano_type", "piano_model", "sample_synth_sample"]);
  for (const { key } of parameters) {
    if (!sharedParams.has(key)) continue;
    if (targetEngine !== undefined && targetEngine === otherEngine) {
      const engineName = key.startsWith("piano") ? "Piano" : "Sample Synth";
      warnings.push(
        `WARNING: Both parts are using ${engineName}. Changing ${parameterMap.params[key]?.name ?? key} will affect BOTH parts ` +
        `(hardware limitation — ${engineName} shares model/sample selection across parts).`,
      );
      break;
    }
  }

  // Vibrato + rotary speaker clash
  const spkrType = state.get("spkr_comp_type");
  const spkrEnabled = state.get("spkr_comp_enable");
  const rotaryParam = parameterMap.params["spkr_comp_type"];
  const rotaryTypeValue = rotaryParam ? parameterMap.resolveValue(rotaryParam, "Rotary") : undefined;
  const isRotaryActive = spkrEnabled !== undefined && spkrEnabled > 0
    && spkrType !== undefined && rotaryTypeValue !== undefined && spkrType === rotaryTypeValue;

  for (const { key, value } of parameters) {
    const param = parameterMap.params[key];
    if (!param) continue;

    if (key === "vibrato_enable" && parameterMap.resolveValue(param, value) > 0 && isRotaryActive) {
      warnings.push(
        `WARNING: Vibrato/chorus and the rotary speaker tend to clash. ` +
        `Consider disabling vibrato when using the Leslie/rotary effect.`,
      );
    }
    if (key === "spkr_comp_type") {
      const vibratoEnabled = state.get("vibrato_enable");
      if (vibratoEnabled !== undefined && vibratoEnabled > 0
        && rotaryTypeValue !== undefined && parameterMap.resolveValue(param, value) === rotaryTypeValue) {
        warnings.push(
          `WARNING: Vibrato/chorus and the rotary speaker tend to clash. ` +
          `Consider disabling vibrato when using the Leslie/rotary effect.`,
        );
      }
    }
  }

  // Organ preset routing hint in split mode
  if (splitMode && splitMode > 0) {
    for (const { key } of parameters) {
      if (key === "organ_preset_select") {
        warnings.push(
          `NOTE: In split mode, Organ Preset 1 routes to the Lower part and ` +
          `Preset 2 routes to the Upper part. Set drawbars on each preset ` +
          `to configure different registrations per part.`,
        );
        break;
      }
    }
  }

  // ── Disabled-section rule ──
  // Warn when a parameter is set in a section that is currently disabled.
  // Uses post-batch state (so flipping the enable flag in the same batch suppresses the warning).
  {
    const ALWAYS_ACTIVE = new Set(["global", "parts", "amp"]);

    // Map: section key → ordered display name.
    const SECTION_DISPLAY: Record<string, string> = {
      organ: "Organ engine",
      piano: "Piano engine",
      sample_synth: "Sample Synth engine",
      effect1: "Effect 1",
      effect2: "Effect 2",
      reverb: "Reverb",
      delay: "Delay",
      eq: "EQ",
      rotary: "Rotary/Speaker",
    };
    const SECTION_ORDER = [
      "organ", "piano", "sample_synth",
      "effect1", "effect2", "reverb", "delay", "eq", "rotary",
    ];

    // Effect-style sections gated by an `_enable` key.
    const ENABLE_KEY: Record<string, string> = {
      effect1: "effect1_enable",
      effect2: "effect2_enable",
      reverb: "reverb_enable",
      delay: "delay_enable",
      eq: "eq_enable",
      rotary: "spkr_comp_enable",
    };
    const SELF_CONTROL_KEYS = new Set([
      ...Object.values(ENABLE_KEY),
      "part_lower_engine_select",
      "part_upper_engine_select",
    ]);

    // Post-batch view: start from current state, then overlay the batch.
    const postBatch: Record<string, number | undefined> = {};
    for (const k of [...Object.values(ENABLE_KEY), "part_lower_engine_select", "part_upper_engine_select"]) {
      postBatch[k] = state.get(k);
    }
    for (const { key, value } of parameters) {
      if (key in postBatch) {
        const param = parameterMap.params[key];
        if (param) postBatch[key] = parameterMap.resolveValue(param, value);
      }
    }

    // Resolve engine label → MIDI value via the engine-select param itself.
    const engineParam = parameterMap.params["part_upper_engine_select"];
    const engineMidi: Record<string, number | undefined> = {
      organ: engineParam ? parameterMap.resolveValue(engineParam, "Organ") : undefined,
      piano: engineParam ? parameterMap.resolveValue(engineParam, "Piano") : undefined,
      sample_synth: engineParam ? parameterMap.resolveValue(engineParam, "Sample Synth") : undefined,
    };

    // Build the disabled set.
    const disabled = new Set<string>();
    for (const [section, enableKey] of Object.entries(ENABLE_KEY)) {
      const v = postBatch[enableKey];
      if (v === undefined || v === 0) disabled.add(section);
    }
    const lower = postBatch["part_lower_engine_select"];
    const upper = postBatch["part_upper_engine_select"];
    for (const eng of ["organ", "piano", "sample_synth"] as const) {
      const target = engineMidi[eng];
      if (target === undefined) continue;
      const onLower = lower !== undefined && lower === target;
      const onUpper = upper !== undefined && upper === target;
      if (!onLower && !onUpper) disabled.add(eng);
    }

    // Walk the batch, record disabled sections that are touched.
    const touched = new Set<string>();
    for (const { key } of parameters) {
      if (SELF_CONTROL_KEYS.has(key)) continue;
      const param = parameterMap.params[key];
      if (!param) continue;
      const section = param.section;
      if (ALWAYS_ACTIVE.has(section)) continue;
      if (disabled.has(section)) touched.add(section);
    }

    for (const section of SECTION_ORDER) {
      if (!touched.has(section)) continue;
      const display = SECTION_DISPLAY[section];
      let hint: string;
      if (section === "organ" || section === "piano" || section === "sample_synth") {
        const engineName = section === "sample_synth" ? "Sample Synth"
          : section === "piano" ? "Piano" : "Organ";
        hint = `select ${engineName} on a part`;
      } else {
        hint = `set ${ENABLE_KEY[section]} = on`;
      }
      warnings.push(
        `WARNING: ${display} is currently disabled. The parameter(s) you set will have no audible effect until ${hint}.`,
      );
    }
  }

  return warnings;
}
