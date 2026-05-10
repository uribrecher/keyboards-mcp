/**
 * JUNO-X mock handler — pure logic (#30 stage 5).
 *
 * The handler speaks ONLY the param domain: `set_params`, `get_params`,
 * `load_program`, `getFullState`. No MIDI bytes, no addresses, no
 * protocol awareness. The engine and the codec own all MIDI.
 *
 * Internal state is keyed by canonical param name. Stored values are
 * user-domain numerics (the same numbers `set_params` accepts). Wire-
 * byte translation lives entirely in the codec — when the engine
 * fulfills a Roland RQ1 it asks the codec for layout, asks us for
 * values via `get_params`, and the codec produces wire bytes.
 */

import type { MidiMessage, MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { ParamRef } from "../../../shared/midi-codec.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { JunoXEngine, ENGINE_DISPLAY_NAMES, PART_COUNT } from "./engines/engine-types.js";
import { createAnalogSynthParams } from "./engines/analog-synth.js";
import { createZCoreParams } from "./engines/zcore.js";
import { createJunoXModelParams } from "./engines/juno-x-model.js";
import { createRDPianoParams } from "./engines/rd-piano.js";
import { createJunoXCodec } from "./midi-codec.js";

// ── Internal part state — keyed by canonical param name ──

interface PartState {
  engine: JunoXEngine;
  /** paramKey → user-domain numeric value (e.g. chorus_switch=1, chorus_level=80). */
  params: Record<string, number>;
}

interface ParamEntryState {
  value: number;
  name: string;
  displayName?: string;
  section: string;
  type: string;
  cc?: number;
  index?: number;
  labels?: Record<number, string>;
}

// ── Per-engine param sets (used to seed defaults on the active part) ──

function buildEnginedParamSets(): Record<JunoXEngine, Record<string, KeyboardParameter>> {
  return {
    [JunoXEngine.AnalogSynth]: createAnalogSynthParams(),
    [JunoXEngine.ZCore]: createZCoreParams(),
    [JunoXEngine.JunoXModel]: createJunoXModelParams(),
    [JunoXEngine.RDPiano]: createRDPianoParams(),
  };
}

// ── Factory ──

export function createJunoXMockHandler(): MockHandler {
  let parts: PartState[] = [];
  let globalParams: Record<string, number> = {};
  let currentScene = { bank: 0, program: 0 };

  const codec = createJunoXCodec();
  const engineParamSets = buildEnginedParamSets();

  /**
   * Find the param key in the given engine's param set that has the
   * specified CC. Returns undefined if no param with that CC exists in
   * that engine. Used by `set_params` to translate cross-engine CC
   * names (e.g. as_cutoff → jx_cutoff when the active engine changes).
   */
  function engineKeyForCc(engine: JunoXEngine, cc: number): string | undefined {
    const params = engineParamSets[engine];
    for (const [key, param] of Object.entries(params)) {
      if (param.cc === cc && param.perPart) return key;
    }
    return undefined;
  }

  function initParts(_lowerChannel: number, _upperChannel: number): void {
    parts = Array.from({ length: PART_COUNT }, () => {
      const seed: Record<string, number> = {};
      const defaults = engineParamSets[JunoXEngine.AnalogSynth];
      for (const [key, param] of Object.entries(defaults)) {
        if (param.perPart) seed[key] = param.defaultValue;
      }
      return { engine: JunoXEngine.AnalogSynth, params: seed };
    });
    globalParams = {};
  }

  // ── Param-domain state writes/reads ──

  function applySet(refs: ParamRef[]): MockHandlerResult {
    const logLines: string[] = [];

    for (const ref of refs) {
      const found = codec.map.findParam(ref.name);
      if (!found) {
        logLines.push(`set: unknown param "${ref.name}"`);
        continue;
      }
      let userValue: number;
      try {
        userValue = codec.normalizeUserValue(found.key, ref.value);
      } catch (err) {
        logLines.push(`set: ${found.param.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (found.param.perPart) {
        const partIdx = (ref.part ?? 1) - 1;
        const part = parts[partIdx];
        if (!part) {
          logLines.push(`set: ${found.param.name}: part ${ref.part} out of range`);
          continue;
        }
        // Engine-aware key resolution for CC params: the same CC has
        // different param keys across engines (e.g. CC 3 = as_cutoff /
        // jx_cutoff / zc_cutoff). The codec's CC reverse-lookup is
        // last-wins on the merged map so it might give us a key that
        // doesn't match this part's active engine. Find the matching
        // CC in the active engine's params and store under THAT key, so
        // the broadcast (which iterates the active engine's params) can
        // find it.
        const storeKey = found.param.cc !== undefined
          ? (engineKeyForCc(part.engine, found.param.cc) ?? found.key)
          : found.key;
        part.params[storeKey] = userValue;
      } else {
        globalParams[found.key] = userValue;
      }
      logLines.push(`set: ${found.param.name} = ${codec.formatValue(found.key, userValue)}`);
    }

    return {
      state: getFullStateObj(),
      log: logLines.join("; "),
    };
  }

  function readParams(names: string[], part?: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of names) {
      const found = codec.map.findParam(name);
      if (!found) continue;
      if (found.param.perPart) {
        const partIdx = (part ?? 1) - 1;
        const partState = parts[partIdx];
        // Same engine-aware lookup as `set_params` — translate the asked
        // name to the active engine's matching CC param key.
        const lookupKey = found.param.cc !== undefined && partState
          ? (engineKeyForCc(partState.engine, found.param.cc) ?? found.key)
          : found.key;
        out[found.key] = partState?.params[lookupKey] ?? found.param.defaultValue;
      } else {
        out[found.key] = globalParams[found.key] ?? found.param.defaultValue;
      }
    }
    return out;
  }

  function loadProgram(bank: number, slot: number): MockHandlerResult {
    currentScene = { bank, program: slot };
    return {
      state: getFullStateObj(),
      log: `load_program: bank=${bank} slot=${slot}`,
    };
  }

  // ── Display helpers for the broadcast state ──

  function buildParamEntry(_key: string, param: KeyboardParameter, value: number): ParamEntryState {
    const entry: ParamEntryState = {
      value,
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if (param.displayName) entry.displayName = param.displayName;
    if (param.cc !== undefined) entry.cc = param.cc;
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
      const enginedParams = engineParamSets[part.engine];
      const paramObj: Record<string, ParamEntryState> = {};
      for (const [key, param] of Object.entries(enginedParams)) {
        if (!param.perPart) continue;
        const value = part.params[key] ?? param.defaultValue;
        paramObj[key] = buildParamEntry(key, param, value);
      }
      result[`part${i + 1}`] = {
        engine: part.engine,
        engineName: ENGINE_DISPLAY_NAMES[part.engine],
        params: paramObj,
      };
    }
    return result;
  }

  function getFullStateObj(): Record<string, any> {
    // `params` is the canonical name-keyed view of scene-global params
    // (chorus_*, delay_*, reverb_*, drive_*). UIs read `data.params.<name>`
    // and `data.parts[N].params.<name>`.
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
      // Stage 5: handler doesn't speak MIDI. Engine + codec handle it all.
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

    getFullState(_includeInventory: boolean): Record<string, any> {
      return getFullStateObj();
    },
  };

  return handler;
}

/**
 * Class wrapper so index.ts can use `new JunoXMockHandler()`.
 */
export class JunoXMockHandler implements MockHandler {
  private inner: MockHandler;

  constructor() {
    this.inner = createJunoXMockHandler();
  }

  init(lowerChannel: number, upperChannel: number, label?: string): void {
    this.inner.init(lowerChannel, upperChannel, label);
  }

  onMIDI(msg: MidiMessage): MockHandlerResult {
    return this.inner.onMIDI(msg);
  }

  set_params(refs: ParamRef[]): MockHandlerResult {
    return this.inner.set_params!(refs);
  }

  get_params(names: string[], part?: number): Record<string, number> {
    return this.inner.get_params!(names, part);
  }

  load_program(bank: number, slot: number): MockHandlerResult {
    return this.inner.load_program!(bank, slot);
  }

  get codec() {
    return this.inner.codec;
  }

  getFullState(includeInventory: boolean): Record<string, any> {
    return this.inner.getFullState(includeInventory);
  }
}
