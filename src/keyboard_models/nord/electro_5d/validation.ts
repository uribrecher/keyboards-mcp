/**
 * Nord Electro 5D parameter validation.
 *
 * Two flavors:
 *   - {@link validateParameterBatch} returns advisory warnings (engine collisions,
 *     shared piano/sample, vibrato/rotary clash, organ preset routing hint).
 *   - {@link preflightDisabledSections} returns blocking errors + the set of
 *     parameter keys to refuse: setting parameters in a section that is currently
 *     off (effects, engine not selected on any enabled part, vibrato_type while
 *     vibrato is off) is an error, not a warning. The caller MUST skip applying
 *     any key in `blockedKeys`.
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

/**
 * Block parameter changes whose section is currently disabled.
 *
 * Uses post-batch state — flipping the gate in the same batch un-blocks the
 * dependent params.
 *
 * Returns the set of param keys that the caller must skip when applying, plus
 * one ERROR message per disabled section / per disabled gate-param.
 */
export function preflightDisabledSections(
  parameters: Array<{ key: string; value: number | string }>,
  state: StateManager,
  parameterMap: ParameterMap,
): { errors: string[]; blockedKeys: Set<string> } {
  const errors: string[] = [];
  const blockedKeys = new Set<string>();

  const ALWAYS_ACTIVE = new Set(["global", "parts"]);

  const SECTION_DISPLAY: Record<string, string> = {
    organ: "Organ engine",
    piano: "Piano engine",
    sample_synth: "Sample Synth engine",
    effect1: "Effect 1",
    effect2: "Effect 2",
    reverb: "Reverb",
    delay: "Delay",
    eq: "EQ",
    amp: "Amp/Speaker",
    rotary: "Rotary/Speaker",
  };
  const SECTION_ORDER = [
    "organ", "piano", "sample_synth",
    "effect1", "effect2", "reverb", "delay", "eq", "amp", "rotary",
  ];

  // The amp section and the rotary section share `spkr_comp_enable` — when the
  // speaker/comp block is off, neither the amp model nor the rotary speed has
  // any audible effect.
  const ENABLE_KEY: Record<string, string> = {
    effect1: "effect1_enable",
    effect2: "effect2_enable",
    reverb: "reverb_enable",
    delay: "delay_enable",
    eq: "eq_enable",
    amp: "spkr_comp_enable",
    rotary: "spkr_comp_enable",
  };
  const SELF_CONTROL_KEYS = new Set([
    ...Object.values(ENABLE_KEY),
    "part_lower_engine_select",
    "part_upper_engine_select",
  ]);

  // Post-batch view: start from current state, then overlay the batch.
  // part_*_enable defaults to On (1) on hardware; treat undefined as enabled.
  const postBatch: Record<string, number | undefined> = {};
  const POST_BATCH_KEYS = [
    ...Object.values(ENABLE_KEY),
    "part_lower_engine_select", "part_upper_engine_select",
    "part_lower_enable", "part_upper_enable",
    "vibrato_enable",
  ];
  for (const k of POST_BATCH_KEYS) {
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

  // Build the disabled section set. We only block when we have observed the
  // gate as explicitly off; undefined means "unknown" (no state pulled yet) and
  // we err on the side of letting the change through.
  const disabled = new Set<string>();
  for (const [section, enableKey] of Object.entries(ENABLE_KEY)) {
    if (postBatch[enableKey] === 0) disabled.add(section);
  }
  const lower = postBatch["part_lower_engine_select"];
  const upper = postBatch["part_upper_engine_select"];
  const lowerEnabled = postBatch["part_lower_enable"] !== 0;
  const upperEnabled = postBatch["part_upper_enable"] !== 0;
  // Engine sections: only block when BOTH parts have an observed engine
  // selection AND neither one selects this engine on an enabled part. If
  // either part's engine is unknown, we can't be sure → don't block.
  if (lower !== undefined && upper !== undefined) {
    for (const eng of ["organ", "piano", "sample_synth"] as const) {
      const target = engineMidi[eng];
      if (target === undefined) continue;
      const onLower = lower === target && lowerEnabled;
      const onUpper = upper === target && upperEnabled;
      if (!onLower && !onUpper) disabled.add(eng);
    }
  }

  // Walk the batch: collect the keys touched per disabled section and mark
  // them as blocked.
  const touchedKeys = new Map<string, string[]>();
  for (const { key } of parameters) {
    if (SELF_CONTROL_KEYS.has(key)) continue;
    const param = parameterMap.params[key];
    if (!param) continue;
    const section = param.section;
    if (ALWAYS_ACTIVE.has(section)) continue;
    if (!disabled.has(section)) continue;
    blockedKeys.add(key);
    if (!touchedKeys.has(section)) touchedKeys.set(section, []);
    touchedKeys.get(section)!.push(parameterMap.params[key]?.name ?? key);
  }

  for (const section of SECTION_ORDER) {
    const names = touchedKeys.get(section);
    if (!names) continue;
    const display = SECTION_DISPLAY[section];
    let hint: string;
    if (section === "organ" || section === "piano" || section === "sample_synth") {
      const engineName = section === "sample_synth" ? "Sample Synth"
        : section === "piano" ? "Piano" : "Organ";
      hint = `select ${engineName} on a part AND make sure that part is enabled (part_lower_enable / part_upper_enable)`;
    } else {
      hint = `set ${ENABLE_KEY[section]} = on`;
    }
    errors.push(
      `ERROR: ${display} is currently disabled — refusing to change ${names.join(", ")}. ` +
      `${hint.charAt(0).toUpperCase()}${hint.slice(1)} first, then retry.`,
    );
  }

  // ── Per-parameter sub-rule: vibrato ──
  // Vibrato has its own enable inside the organ; block vibrato_type only when
  // we have observed vibrato_enable as explicitly off.
  {
    const VIBRATO_PARAMS = new Set(["vibrato_type"]);
    const vibratoEnabled = postBatch["vibrato_enable"];
    if (vibratoEnabled === 0) {
      const touched: string[] = [];
      for (const { key } of parameters) {
        if (!VIBRATO_PARAMS.has(key)) continue;
        blockedKeys.add(key);
        touched.push(parameterMap.params[key]?.name ?? key);
      }
      if (touched.length > 0) {
        errors.push(
          `ERROR: Vibrato is currently disabled — refusing to change ${touched.join(", ")}. ` +
          `Set vibrato_enable = on first, then retry.`,
        );
      }
    }
  }

  return { errors, blockedKeys };
}
