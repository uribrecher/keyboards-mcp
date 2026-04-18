/**
 * Sequential Circuits Prophet-6 mock handler.
 *
 * Mono-timbral, no backup, no programs — just CC state tracking.
 * The handler owns all state; the engine is just MIDI I/O + WebSocket.
 */

import type { MockHandler, MidiMessage, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { PARAMS } from "./midi-map.js";

interface ParamState {
  value: number;
  label: string;
  name: string;
  section: string;
  type: string;
  index?: number;
  labels?: Record<number, string>;
}

export function createProphet6MockHandler(): MockHandler {
  const ccState = new Map<number, number>();

  // CC → param lookup
  const paramByCC = new Map<number, { key: string; param: KeyboardParameter }>();
  for (const [key, param] of Object.entries(PARAMS)) {
    paramByCC.set(param.cc!, { key, param });
  }

  function initState(): void {
    for (const param of Object.values(PARAMS)) {
      ccState.set(param.cc!, param.defaultValue);
    }
  }

  function labelFor(param: KeyboardParameter, midiValue: number): string {
    if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
      // Map 0-127 to discrete index
      const range = param.max - param.min;
      const index = range === 0 ? 0 : Math.round((midiValue / 127) * range);
      return param.labels[index] ?? String(midiValue);
    }
    return String(midiValue);
  }

  function buildParamEntry(param: KeyboardParameter, midiValue: number): ParamState {
    const entry: ParamState = {
      value: midiValue,
      label: labelFor(param, midiValue),
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if ((param.type === "discrete" || param.type === "toggle") && param.labels) {
      const range = param.max - param.min;
      entry.index = range === 0 ? 0 : Math.round((midiValue / 127) * range);
      entry.labels = param.labels;
    }
    return entry;
  }

  function buildFullState(lastChangeKey?: string): Record<string, any> {
    const params: Record<string, ParamState> = {};

    for (const [key, param] of Object.entries(PARAMS)) {
      const midiValue = ccState.get(param.cc!) ?? param.defaultValue;
      params[key] = buildParamEntry(param, midiValue);
    }

    const msg: Record<string, any> = { global: params };

    if (lastChangeKey) {
      const cc = PARAMS[lastChangeKey]?.cc;
      const entry = cc != null ? paramByCC.get(cc) : undefined;
      if (entry) {
        const midiValue = ccState.get(entry.param.cc!) ?? entry.param.defaultValue;
        msg.lastChange = {
          key: lastChangeKey,
          name: entry.param.name,
          cc: entry.param.cc,
          value: midiValue,
          label: labelFor(entry.param, midiValue),
        };
      }
    }

    return msg;
  }

  function handleCC(cc: number, value: number, channel: number): MockHandlerResult {
    // Bank Select — ignore
    if (cc === 0 || cc === 32) {
      return { log: `Bank Select ${cc === 0 ? "MSB" : "LSB"} = ${value} (ch${channel})` };
    }

    ccState.set(cc, value);

    const entry = paramByCC.get(cc);
    const changeKey = entry?.key;
    const desc = entry
      ? `${entry.param.name} = ${labelFor(entry.param, value)} (CC${cc}=${value} ch${channel})`
      : `CC${cc}=${value} ch${channel} [unmapped]`;

    return { state: buildFullState(changeKey), log: desc };
  }

  return {
    init(): void {
      initState();
    },

    onMIDI(msg: MidiMessage): MockHandlerResult {
      switch (msg.type) {
        case "cc":
          return handleCC(msg.controller, msg.value, msg.channel);
        case "program":
          return { log: `Program Change ${msg.number} (ch${msg.channel}) — no program storage` };
        case "sysex":
          return { log: `SysEx (${msg.bytes.length} bytes) — ignored` };
      }
    },

    getFullState(): Record<string, any> {
      return buildFullState();
    },
  };
}