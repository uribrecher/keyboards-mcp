/**
 * JUNO-X mock handler — pure param-domain logic. State is keyed by
 * canonical param name with user-domain values, separated per (part,
 * engine) so switching engines preserves inactive-engine state.
 *
 *   parts[i].activeEngine                ──> drives routing for part i
 *   parts[i].engineParams[engine][key]   ──> per-engine values
 *   globalParams[key]                    ──> scene-global (chorus_*, etc.)
 *
 * `set_params` routing: scene-global names go to globalParams; otherwise
 * we look up the name in the active engine's param set. Refs that carry
 * an explicit `engine` field (codec candidates for an ambiguous CC) are
 * applied only when the engine matches the active engine on the part —
 * real-HW behavior.
 */

import type { MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { ParamRef } from "../../../shared/midi-codec.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { JunoXEngine, ENGINE_DISPLAY_NAMES, PART_COUNT } from "./engines/engine-types.js";
import { createJunoXCodec } from "./midi-codec.js";
import type { JunoXParameterMap } from "./midi-map.js";
import { createParameterMap } from "./midi-map.js";

// ── Internal state ──

interface PartState {
  activeEngine: JunoXEngine;
  /** Per-engine param state. Switching engines preserves inactive ones. */
  engineParams: Record<JunoXEngine, Record<string, number>>;
}

interface ParamEntryState {
  value: number;
  name: string;
  displayName?: string;
  section: string;
  type: string;
  index?: number;
  labels?: Record<number, string>;
}

// ── Factory ──

export function createJunoXMockHandler(): MockHandler {
  let parts: PartState[] = [];
  let globalParams: Record<string, number> = {};
  let currentScene = { bank: 0, program: 0 };

  const codec = createJunoXCodec();
  const paramMap = createParameterMap() as JunoXParameterMap;

  function emptyEngineParams(): Record<JunoXEngine, Record<string, number>> {
    return {
      [JunoXEngine.AnalogSynth]: {},
      [JunoXEngine.ZCore]: {},
      [JunoXEngine.JunoXModel]: {},
      [JunoXEngine.RDPiano]: {},
    };
  }

  function initParts(_lowerChannel: number, _upperChannel: number): void {
    parts = Array.from({ length: PART_COUNT }, () => ({
      activeEngine: JunoXEngine.AnalogSynth,
      engineParams: emptyEngineParams(),
    }));
    globalParams = {};
  }

  // ── Param-domain writes ──

  type Target =
    | { kind: "global"; key: string }
    | { kind: "engine"; engine: JunoXEngine; key: string };

  /** Where a `set_params` ref should land. Null when not routable. */
  function resolveTarget(ref: ParamRef): Target | null {
    if (paramMap.globalParams[ref.name]) return { kind: "global", key: ref.name };
    const partState = parts[(ref.part ?? 1) - 1];
    if (!partState) return null;
    const active = partState.activeEngine;
    // Explicit engine on the ref must match the active engine; bare
    // refs route to the active engine if it defines the name.
    if (ref.engine !== undefined && ref.engine !== active) return null;
    if (!paramMap.findParamInEngine(active, ref.name)) return null;
    return { kind: "engine", engine: active, key: ref.name };
  }

  function applySet(refs: ParamRef[]): MockHandlerResult {
    const logLines: string[] = [];

    for (const ref of refs) {
      const target = resolveTarget(ref);
      if (!target) {
        // Quietly ignore refs that just don't match the active engine
        // (real-HW behavior); only log when the name is fully unknown.
        const known = paramMap.findParam(ref.name) || paramMap.globalParams[ref.name];
        if (!known) logLines.push(`set: unknown param "${ref.name}"`);
        continue;
      }

      const param = target.kind === "global"
        ? paramMap.globalParams[target.key]
        : paramMap.findParamInEngine(target.engine, target.key)!;

      let userValue: number;
      try {
        userValue = codec.normalizeUserValue(target.key, ref.value);
      } catch (err) {
        logLines.push(`set: ${param.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (target.kind === "global") {
        globalParams[target.key] = userValue;
      } else {
        const partIdx = (ref.part ?? 1) - 1;
        parts[partIdx].engineParams[target.engine][target.key] = userValue;
      }
      logLines.push(`set: ${param.name} = ${codec.formatValue(target.key, userValue)}`);
    }

    return {
      state: getFullStateObj(),
      log: logLines.join("; "),
    };
  }

  // ── Param-domain reads ──

  function readParams(names: string[], part?: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of names) {
      if (paramMap.globalParams[name]) {
        out[name] = globalParams[name] ?? paramMap.globalParams[name].defaultValue;
        continue;
      }
      const partIdx = (part ?? 1) - 1;
      const partState = parts[partIdx];
      if (!partState) continue;
      const active = partState.activeEngine;
      const param = paramMap.findParamInEngine(active, name);
      if (!param) continue;
      out[name] = partState.engineParams[active][name] ?? param.defaultValue;
    }
    return out;
  }

  // ── Active-engine controls ──

  function getActiveEngine(part: number): string | undefined {
    return parts[part - 1]?.activeEngine;
  }

  function setActiveEngine(part: number, engine: string): MockHandlerResult {
    const partIdx = part - 1;
    const partState = parts[partIdx];
    if (!partState) return { log: `set_active_engine: invalid part ${part}` };
    if (!Object.values(JunoXEngine).includes(engine as JunoXEngine)) {
      return { log: `set_active_engine: unknown engine "${engine}"` };
    }
    partState.activeEngine = engine as JunoXEngine;
    return {
      state: getFullStateObj(),
      log: `active engine on part ${part} = ${engine}`,
    };
  }

  // ── Program change ──

  function loadProgram(bank: number, slot: number): MockHandlerResult {
    currentScene = { bank, program: slot };
    return {
      state: getFullStateObj(),
      log: `load_program: bank=${bank} slot=${slot}`,
    };
  }

  // ── Broadcast state ──

  function buildParamEntry(_key: string, param: KeyboardParameter, value: number): ParamEntryState {
    const entry: ParamEntryState = {
      value,
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if (param.displayName) entry.displayName = param.displayName;
    if (param.type === "discrete" && param.labels) {
      entry.index = value;
      entry.labels = param.labels;
    }
    return entry;
  }

  function partsToState(): Record<string, any> {
    const result: Record<string, any> = {};
    for (let i = 0; i < PART_COUNT; i++) {
      const part = parts[i];
      const active = part.activeEngine;
      const enginedParams = paramMap.getParamsForEngine(active);
      const paramObj: Record<string, ParamEntryState> = {};
      for (const [key, param] of Object.entries(enginedParams)) {
        if (!param.perPart) continue;
        const value = part.engineParams[active][key] ?? param.defaultValue;
        paramObj[key] = buildParamEntry(key, param, value);
      }
      result[`part${i + 1}`] = {
        engine: active,
        engineName: ENGINE_DISPLAY_NAMES[active],
        params: paramObj,
      };
    }
    return result;
  }

  function getFullStateObj(): Record<string, any> {
    return {
      model: "Roland JUNO-X",
      scene: { ...currentScene },
      params: { ...globalParams },
      ...partsToState(),
    };
  }

  // ── MockHandler implementation ──

  const handler: MockHandler = {
    codec,
    init(lowerChannel: number, upperChannel: number): void {
      initParts(lowerChannel, upperChannel);
    },

    set_params(refs: ParamRef[]): MockHandlerResult {
      return applySet(refs);
    },

    get_params(names: string[], part?: number): Record<string, number> {
      return readParams(names, part);
    },

    load_program(bank: number, slot: number): MockHandlerResult {
      return loadProgram(bank, slot);
    },

    get_active_engine(part: number): string | undefined {
      return getActiveEngine(part);
    },

    set_active_engine(part: number, engine: string): MockHandlerResult {
      return setActiveEngine(part, engine);
    },

    getFullState(_includeInventory: boolean): Record<string, any> {
      return getFullStateObj();
    },
  };

  return handler;
}

/** Class wrapper so index.ts can use `new JunoXMockHandler()`. */
export class JunoXMockHandler implements MockHandler {
  private inner: MockHandler;
  constructor() { this.inner = createJunoXMockHandler(); }
  init(l: number, u: number, label?: string): void { this.inner.init(l, u, label); }
  set_params(refs: ParamRef[]): MockHandlerResult { return this.inner.set_params!(refs); }
  get_params(names: string[], part?: number): Record<string, number> { return this.inner.get_params!(names, part); }
  load_program(bank: number, slot: number): MockHandlerResult { return this.inner.load_program!(bank, slot); }
  get_active_engine(part: number): string | undefined { return this.inner.get_active_engine?.(part); }
  set_active_engine(part: number, engine: string): MockHandlerResult { return this.inner.set_active_engine!(part, engine); }
  get codec() { return this.inner.codec; }
  getFullState(includeInventory: boolean): Record<string, any> { return this.inner.getFullState(includeInventory); }
}
