/**
 * JUNO-X MIDI parameter map.
 *
 * After the stage-5b refactor, params are NOT merged into a single flat
 * namespace. Engine-specific param sets are kept distinct so that the
 * codec and handler can disambiguate the same CC across engines (e.g.
 * CC 3 = `cutoff` in AnalogSynth, JunoXModel, AND ZCore's `p1_cutoff`).
 *
 * A flat `params` view IS still exposed for callers that just want a
 * lookup of "all params on this model" (list_parameters tool, etc.) —
 * collisions on shared keys are last-wins, but that's acceptable for
 * those callers because they don't drive routing.
 */

import type { KeyboardParameter } from "../../../shared/types.js";
import type { ParameterMap } from "../../../shared/keyboard-model.js";
import {
  resolveValue as genericResolveValue,
  formatValue as genericFormatValue,
} from "../../../shared/parameter-resolution.js";
import { JunoXEngine } from "./engines/engine-types.js";
import { createAnalogSynthParams } from "./engines/analog-synth.js";
import { createZCoreParams } from "./engines/zcore.js";
import { createJunoXModelParams } from "./engines/juno-x-model.js";
import { createRDPianoParams } from "./engines/rd-piano.js";
import { createSceneParams } from "./scene-params.js";

export interface JunoXParameterMap extends ParameterMap {
  /** Scene-global params (chorus_*, delay_*, etc.) — not per-engine. */
  globalParams: Record<string, KeyboardParameter>;
  /** All params for the given engine. */
  getParamsForEngine(engine: JunoXEngine): Record<string, KeyboardParameter>;
  /** Find a param by key in a specific engine. Undefined if absent. */
  findParamInEngine(engine: JunoXEngine, key: string): KeyboardParameter | undefined;
  /** Reverse-lookup: every (engine, key) that has the given CC. */
  getParamsByCC(cc: number): Array<{ engine: JunoXEngine; key: string; param: KeyboardParameter }>;
  /** Best-effort engine resolution for a key — returns the first engine that defines it. */
  getEngineForParam(key: string): JunoXEngine | undefined;
}

export function createParameterMap(): JunoXParameterMap {
  const sceneParams = createSceneParams();
  const engineParamSets: Record<JunoXEngine, Record<string, KeyboardParameter>> = {
    [JunoXEngine.AnalogSynth]: createAnalogSynthParams(),
    [JunoXEngine.ZCore]: createZCoreParams(),
    [JunoXEngine.JunoXModel]: createJunoXModelParams(),
    [JunoXEngine.RDPiano]: createRDPianoParams(),
  };

  // Flat view for callers that just want any param by key (list_parameters,
  // list_sections, etc.). Collisions on shared keys are last-wins; consumers
  // who care about cross-engine ambiguity use `findParamInEngine` /
  // `getParamsByCC` instead.
  const allParams: Record<string, KeyboardParameter> = { ...sceneParams };
  for (const params of Object.values(engineParamSets)) {
    Object.assign(allParams, params);
  }

  // Reverse lookup: CC → all (engine, key, param) matches.
  const ccToMatches = new Map<number, Array<{ engine: JunoXEngine; key: string; param: KeyboardParameter }>>();
  for (const [engineStr, params] of Object.entries(engineParamSets) as [JunoXEngine, Record<string, KeyboardParameter>][]) {
    for (const [key, param] of Object.entries(params)) {
      if (param.cc === undefined) continue;
      const list = ccToMatches.get(param.cc) ?? [];
      list.push({ engine: engineStr, key, param });
      ccToMatches.set(param.cc, list);
    }
  }

  // Best-effort: first engine that defines a key.
  function getEngineForParam(key: string): JunoXEngine | undefined {
    for (const [engineStr, params] of Object.entries(engineParamSets) as [JunoXEngine, Record<string, KeyboardParameter>][]) {
      if (params[key]) return engineStr;
    }
    return undefined;
  }

  return {
    params: allParams,
    globalParams: sceneParams,

    resolveValue: genericResolveValue,
    formatValue: genericFormatValue,

    findParam(name: string): { key: string; param: KeyboardParameter } | undefined {
      if (allParams[name]) return { key: name, param: allParams[name] };
      const lower = name.toLowerCase().replace(/[\s_-]+/g, "");
      for (const [key, param] of Object.entries(allParams)) {
        if (key.toLowerCase().replace(/[\s_-]+/g, "") === lower) return { key, param };
      }
      for (const [key, param] of Object.entries(allParams)) {
        if (param.name.toLowerCase().replace(/[\s_-]+/g, "") === lower) return { key, param };
      }
      for (const [key, param] of Object.entries(allParams)) {
        if (param.name.toLowerCase().replace(/[\s_-]+/g, "").includes(lower)) return { key, param };
      }
      return undefined;
    },

    /** Returns the first match in iteration order — last-wins on collisions. */
    getParamByCC(cc: number): { key: string; param: KeyboardParameter } | undefined {
      const matches = ccToMatches.get(cc);
      if (!matches || matches.length === 0) return undefined;
      const last = matches[matches.length - 1];
      return { key: last.key, param: last.param };
    },

    getSections(): string[] {
      const sections = new Set<string>();
      for (const param of Object.values(allParams)) sections.add(param.section);
      return [...sections];
    },

    getParamsBySection(section: string): Record<string, KeyboardParameter> {
      const result: Record<string, KeyboardParameter> = {};
      for (const [key, param] of Object.entries(allParams)) {
        if (param.section === section) result[key] = param;
      }
      return result;
    },

    isPerPart(key: string): boolean {
      return allParams[key]?.perPart === true;
    },

    getParamsForEngine(engine: JunoXEngine): Record<string, KeyboardParameter> {
      return { ...sceneParams, ...engineParamSets[engine] };
    },

    findParamInEngine(engine: JunoXEngine, key: string): KeyboardParameter | undefined {
      return engineParamSets[engine]?.[key];
    },

    getParamsByCC(cc: number): Array<{ engine: JunoXEngine; key: string; param: KeyboardParameter }> {
      return ccToMatches.get(cc) ?? [];
    },

    getEngineForParam,
  };
}
