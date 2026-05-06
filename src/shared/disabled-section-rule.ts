/**
 * Generic "disabled-section" warning helper.
 *
 * Common pattern: a model has a set of sections, each gated by a single
 * boolean parameter (effect on/off, arp on/off, etc.). When the user sets
 * a parameter inside a section whose gate is currently off, emit a
 * one-shot warning per disabled section.
 *
 * Models with more nuanced gating (engine selection, per-part state) keep
 * their own validation logic and only delegate the simple section→gate
 * case to this helper, then concatenate.
 */

import type { ParameterMap, StateManager } from "./keyboard-model.js";

export interface DisabledSectionConfig {
  /** Section key → the parameter key that enables it. */
  sectionGates: Record<string, string>;
  /** Section key → display name used in the warning. Falls back to the section key. */
  display?: Record<string, string>;
  /** Sections that are always active (never warn). */
  alwaysActive?: ReadonlySet<string>;
  /** Stable ordering of sections in the emitted warnings. Defaults to insertion order of `sectionGates`. */
  order?: readonly string[];
}

export function disabledSectionWarnings(
  parameters: ReadonlyArray<{ key: string; value: number | string }>,
  state: StateManager,
  parameterMap: ParameterMap,
  config: DisabledSectionConfig,
): string[] {
  const sectionGates = config.sectionGates;
  const alwaysActive = config.alwaysActive ?? new Set<string>();
  const display = config.display ?? {};
  const order = config.order ?? Object.keys(sectionGates);

  const gateKeys = new Set(Object.values(sectionGates));

  // Post-batch view of every gate parameter — overlay the batch on current state.
  const postBatch = new Map<string, number | undefined>();
  for (const k of gateKeys) postBatch.set(k, state.get(k));
  for (const { key, value } of parameters) {
    if (!gateKeys.has(key)) continue;
    const param = parameterMap.params[key];
    if (param) postBatch.set(key, parameterMap.resolveValue(param, value));
  }

  const disabled = new Set<string>();
  for (const [section, gateKey] of Object.entries(sectionGates)) {
    const v = postBatch.get(gateKey);
    if (v === undefined || v === 0) disabled.add(section);
  }

  const touched = new Set<string>();
  for (const { key } of parameters) {
    if (gateKeys.has(key)) continue; // setting the gate itself never warns
    const param = parameterMap.params[key];
    if (!param) continue;
    const section = param.section;
    if (alwaysActive.has(section)) continue;
    if (disabled.has(section)) touched.add(section);
  }

  const warnings: string[] = [];
  for (const section of order) {
    if (!touched.has(section)) continue;
    const name = display[section] ?? section;
    const gateKey = sectionGates[section];
    warnings.push(
      `WARNING: ${name} is currently disabled. The parameter(s) you set will have no audible effect until you set ${gateKey} = on.`,
    );
  }
  return warnings;
}

/**
 * Per-parameter "this specific param is gated by another flag" check.
 * Used for cases like vibrato_type gated by vibrato_enable, where the param
 * lives in a section that has its own coarser gate.
 */
export function disabledParamWarnings(
  parameters: ReadonlyArray<{ key: string; value: number | string }>,
  state: StateManager,
  parameterMap: ParameterMap,
  config: { paramGates: Record<string, string>; display?: Record<string, string> },
): string[] {
  const paramGates = config.paramGates;
  const display = config.display ?? {};
  const gateKeys = new Set(Object.values(paramGates));

  const postBatch = new Map<string, number | undefined>();
  for (const k of gateKeys) postBatch.set(k, state.get(k));
  for (const { key, value } of parameters) {
    if (!gateKeys.has(key)) continue;
    const param = parameterMap.params[key];
    if (param) postBatch.set(key, parameterMap.resolveValue(param, value));
  }

  const triggered = new Set<string>();
  for (const { key } of parameters) {
    const gateKey = paramGates[key];
    if (gateKey === undefined) continue;
    const v = postBatch.get(gateKey);
    if (v === undefined || v === 0) triggered.add(gateKey);
  }

  const warnings: string[] = [];
  for (const gateKey of triggered) {
    const name = display[gateKey] ?? gateKey;
    warnings.push(
      `WARNING: ${name} is currently disabled. The parameter(s) you set will have no audible effect until you set ${gateKey} = on.`,
    );
  }
  return warnings;
}
