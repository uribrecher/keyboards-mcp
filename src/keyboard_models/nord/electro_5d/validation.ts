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

  return warnings;
}
