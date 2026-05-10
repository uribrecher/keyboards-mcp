/**
 * Sequential Circuits Prophet-6 mock handler — pure param-domain.
 *
 * Mono-timbral, no parts, no engines, no programs. State is keyed by
 * canonical param name with USER-domain values. The handler doesn't
 * speak MIDI; the codec owns all wire-byte translation.
 */

import type { MockHandler, MidiMessage, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { ParamRef } from "../../../shared/midi-codec.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { PARAMS } from "./midi-map.js";
import { createProphet6Codec } from "./midi-codec.js";

interface ParamState {
  value: number;
  label: string;
  name: string;
  displayName?: string;
  section: string;
  type: string;
  index?: number;
  labels?: Record<number, string>;
}

export function createProphet6MockHandler(): MockHandler {
  const codec = createProphet6Codec();
  const params: Record<string, number> = {};

  function initState(): void {
    for (const [key, param] of Object.entries(PARAMS)) {
      params[key] = param.defaultValue;
    }
  }

  function labelFor(param: KeyboardParameter, userValue: number): string {
    if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
      return param.labels[userValue] ?? String(userValue);
    }
    return String(userValue);
  }

  function buildParamEntry(param: KeyboardParameter, userValue: number): ParamState {
    const entry: ParamState = {
      value: userValue,
      label: labelFor(param, userValue),
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if (param.displayName) entry.displayName = param.displayName;
    if ((param.type === "discrete" || param.type === "toggle") && param.labels) {
      entry.index = userValue;
    }
    if (param.type === "discrete" && param.labels) {
      entry.labels = param.labels;
    }
    return entry;
  }

  function buildFullState(lastChangeKey?: string): Record<string, any> {
    const out: Record<string, ParamState> = {};
    for (const [key, param] of Object.entries(PARAMS)) {
      const userValue = params[key] ?? param.defaultValue;
      out[key] = buildParamEntry(param, userValue);
    }
    const msg: Record<string, any> = { global: out };
    if (lastChangeKey && PARAMS[lastChangeKey]) {
      const param = PARAMS[lastChangeKey];
      const userValue = params[lastChangeKey] ?? param.defaultValue;
      msg.lastChange = {
        key: lastChangeKey,
        name: param.name,
        cc: param.cc,
        value: userValue,
        label: labelFor(param, userValue),
      };
    }
    return msg;
  }

  function applySet(refs: ParamRef[]): MockHandlerResult {
    const logLines: string[] = [];
    let lastKey: string | undefined;
    for (const ref of refs) {
      const param = PARAMS[ref.name];
      if (!param) {
        logLines.push(`set: unknown param "${ref.name}"`);
        continue;
      }
      let userValue: number;
      try {
        userValue = codec.normalizeUserValue(ref.name, ref.value);
      } catch (err) {
        logLines.push(`set: ${param.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      params[ref.name] = userValue;
      lastKey = ref.name;
      logLines.push(`set: ${param.name} = ${codec.formatValue(ref.name, userValue)}`);
    }
    return {
      state: buildFullState(lastKey),
      log: logLines.join("; "),
    };
  }

  function readParams(names: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of names) {
      const param = PARAMS[name];
      if (!param) continue;
      out[name] = params[name] ?? param.defaultValue;
    }
    return out;
  }

  return {
    codec,
    init(): void {
      initState();
    },

    /** Handler doesn't speak MIDI; engine + codec own all wire I/O. */
    onMIDI(_msg: MidiMessage): MockHandlerResult {
      return {};
    },

    set_params(refs: ParamRef[]): MockHandlerResult {
      return applySet(refs);
    },

    get_params(names: string[]): Record<string, number> {
      return readParams(names);
    },

    getFullState(_includeInventory: boolean): Record<string, any> {
      return buildFullState();
    },
  };
}
