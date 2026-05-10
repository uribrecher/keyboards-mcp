/**
 * JUNO-X mock handler — pure logic (#30 stages 5/5b).
 *
 * The handler speaks ONLY the param domain. Internal state is keyed by
 * canonical param name with USER-domain values, separated **per engine
 * per part** so engine switching preserves inactive engines' settings —
 * the same shape real hardware uses.
 *
 *   parts[i].activeEngine                ──> which engine drives part i
 *   parts[i].engineParams[engine][key]   ──> per-engine state, USER-domain
 *   globalParams[key]                    ──> scene-global (chorus_*, etc.)
 *
 * Routing for incoming `set_params` refs:
 *   - explicit engine field on the ref → store in that engine's namespace
 *     regardless of active engine. Used by the codec when emitting per-
 *     engine candidates for an ambiguous CC; handler keeps only the one
 *     matching active engine on the targeted part (real-HW semantics).
 *   - no engine field → if scene-global, store in globalParams. Otherwise
 *     route to the active engine on the targeted part and look up the
 *     name there. No match → log unknown.
 *
 * Codec-emitted DT1 events that resolve to a specific engine carry the
 * `engine` field; the handler stores them in that engine's namespace
 * unconditionally (sysex addresses are unique per engine).
 */

import type { MidiMessage, MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
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

  /**
   * Resolve where a `set_params` ref should land, given the targeted
   * part. Returns the engine namespace + canonical key, or null when
   * the ref doesn't match anything routable to the active engine.
   *
   * Rules:
   *  - Scene-global key → globalParams (no engine).
   *  - Ref carries explicit `engine` and the param matches the active
   *    engine on the part → store there. Otherwise drop (real-HW
   *    routes only to the active engine).
   *  - No `engine` field → look up the name in the active engine's
   *    param set. Match → store there. No match → drop.
   */
  type Target =
    | { kind: "global"; key: string }
    | { kind: "engine"; engine: JunoXEngine; key: string };

  function resolveTarget(ref: ParamRef): Target | null {
    // Scene-global takes precedence.
    if (paramMap.globalParams[ref.name]) {
      return { kind: "global", key: ref.name };
    }
    const partIdx = (ref.part ?? 1) - 1;
    const partState = parts[partIdx];
    if (!partState) return null;
    const active = partState.activeEngine;

    if (ref.engine !== undefined) {
      // Codec-emitted candidate. Real HW routes to active engine only.
      if (ref.engine !== active) return null;
      const param = paramMap.findParamInEngine(active, ref.name);
      if (!param) return null;
      return { kind: "engine", engine: active, key: ref.name };
    }
    // No engine specified — look up name in active engine.
    const param = paramMap.findParamInEngine(active, ref.name);
    if (!param) return null;
    return { kind: "engine", engine: active, key: ref.name };
  }

  function applySet(refs: ParamRef[]): MockHandlerResult {
    const logLines: string[] = [];

    for (const ref of refs) {
      const target = resolveTarget(ref);
      if (!target) {
        // Codec-emitted candidate that doesn't match active engine, OR
        // an explicit name that the active engine doesn't define. Real
        // HW would also ignore — quiet log only when the ref is fully
        // unknown (not just routed away from the active engine).
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

    onMIDI(_msg: MidiMessage): MockHandlerResult {
      // Stage 5: handler doesn't speak MIDI.
      return {};
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
  onMIDI(msg: MidiMessage): MockHandlerResult { return this.inner.onMIDI(msg); }
  set_params(refs: ParamRef[]): MockHandlerResult { return this.inner.set_params!(refs); }
  get_params(names: string[], part?: number): Record<string, number> { return this.inner.get_params!(names, part); }
  load_program(bank: number, slot: number): MockHandlerResult { return this.inner.load_program!(bank, slot); }
  get_active_engine(part: number): string | undefined { return this.inner.get_active_engine?.(part); }
  set_active_engine(part: number, engine: string): MockHandlerResult { return this.inner.set_active_engine!(part, engine); }
  get codec() { return this.inner.codec; }
  getFullState(includeInventory: boolean): Record<string, any> { return this.inner.getFullState(includeInventory); }
}
