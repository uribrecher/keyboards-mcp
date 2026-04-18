/**
 * JUNO-X MIDI parameter map aggregation.
 *
 * Merges scene parameters with all four engine parameter sets into a single
 * JunoXParameterMap. Engine-specific helpers allow callers to retrieve only
 * the params relevant to a given engine (scene params are always included).
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
  getParamsForEngine(engine: JunoXEngine): Record<string, KeyboardParameter>;
  getEngineForParam(key: string): JunoXEngine | undefined;
}

export function createParameterMap(): JunoXParameterMap {
  // Build per-engine param sets
  const sceneParams = createSceneParams();
  const engineParamSets: Record<JunoXEngine, Record<string, KeyboardParameter>> = {
    [JunoXEngine.AnalogSynth]: createAnalogSynthParams(),
    [JunoXEngine.ZCore]: createZCoreParams(),
    [JunoXEngine.JunoXModel]: createJunoXModelParams(),
    [JunoXEngine.RDPiano]: createRDPianoParams(),
  };

  // Flat map of all params (scene first, then each engine in order)
  const allParams: Record<string, KeyboardParameter> = { ...sceneParams };
  for (const params of Object.values(engineParamSets)) {
    Object.assign(allParams, params);
  }

  // Track which engine owns each param key (scene params have no entry)
  const paramEngineMap = new Map<string, JunoXEngine>();
  for (const [engine, params] of Object.entries(engineParamSets) as [JunoXEngine, Record<string, KeyboardParameter>][]) {
    for (const key of Object.keys(params)) {
      paramEngineMap.set(key, engine);
    }
  }

  // CC reverse-lookup (only for params that have cc defined)
  const ccMap = new Map<number, { key: string; param: KeyboardParameter }>();
  for (const [key, param] of Object.entries(allParams)) {
    if (param.cc !== undefined) {
      ccMap.set(param.cc, { key, param });
    }
  }

  return {
    params: allParams,

    resolveValue: genericResolveValue,
    formatValue: genericFormatValue,

    findParam(name: string): { key: string; param: KeyboardParameter } | undefined {
      // Tier 1: exact key match
      if (allParams[name]) {
        return { key: name, param: allParams[name] };
      }

      const lower = name.toLowerCase().replace(/[\s_-]+/g, "");

      // Tier 2: normalized key match
      for (const [key, param] of Object.entries(allParams)) {
        if (key.toLowerCase().replace(/[\s_-]+/g, "") === lower) {
          return { key, param };
        }
      }

      // Tier 3: exact name match (normalized)
      for (const [key, param] of Object.entries(allParams)) {
        if (param.name.toLowerCase().replace(/[\s_-]+/g, "") === lower) {
          return { key, param };
        }
      }

      // Tier 4: name substring match
      for (const [key, param] of Object.entries(allParams)) {
        if (param.name.toLowerCase().replace(/[\s_-]+/g, "").includes(lower)) {
          return { key, param };
        }
      }

      return undefined;
    },

    getParamByCC(cc: number): { key: string; param: KeyboardParameter } | undefined {
      return ccMap.get(cc);
    },

    getSections(): string[] {
      const sections = new Set<string>();
      for (const param of Object.values(allParams)) {
        sections.add(param.section);
      }
      return [...sections];
    },

    getParamsBySection(section: string): Record<string, KeyboardParameter> {
      const result: Record<string, KeyboardParameter> = {};
      for (const [key, param] of Object.entries(allParams)) {
        if (param.section === section) {
          result[key] = param;
        }
      }
      return result;
    },

    isPerPart(key: string): boolean {
      return allParams[key]?.perPart === true;
    },

    getParamsForEngine(engine: JunoXEngine): Record<string, KeyboardParameter> {
      return { ...sceneParams, ...engineParamSets[engine] };
    },

    getEngineForParam(key: string): JunoXEngine | undefined {
      return paramEngineMap.get(key);
    },
  };
}
