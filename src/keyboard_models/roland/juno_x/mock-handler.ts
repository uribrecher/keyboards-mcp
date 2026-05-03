/**
 * JUNO-X mock handler.
 *
 * Processes CC messages (tone params per part) and Roland DT1 SysEx
 * (scene params). Owns all state and logic; the engine is just MIDI I/O.
 */

import type { MidiMessage, MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { parseDT1 } from "../../../shared/roland-dt1.js";
import { addAddresses } from "../../../shared/roland-dt1.js";
import { JUNO_X_MODEL_ID, JunoXEngine, ENGINE_DISPLAY_NAMES, PART_COUNT, SCENE_BASE, SCENE_PART_OFFSETS } from "./engines/engine-types.js";
import { createAnalogSynthParams } from "./engines/analog-synth.js";
import { createZCoreParams } from "./engines/zcore.js";
import { createJunoXModelParams } from "./engines/juno-x-model.js";
import { createRDPianoParams } from "./engines/rd-piano.js";
import { createSceneParams } from "./scene-params.js";

// ── Internal part state ──

interface PartState {
  engine: JunoXEngine;
  params: Map<number, number>;           // CC → value
  sceneParams: Record<string, number>;   // address-key → value
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

// ── Build per-engine CC → param lookups ──

function buildEngineCcLookups(): Record<JunoXEngine, Map<number, KeyboardParameter>> {
  const lookups: Record<JunoXEngine, Map<number, KeyboardParameter>> = {
    [JunoXEngine.AnalogSynth]: paramMapToCcLookup(createAnalogSynthParams()),
    [JunoXEngine.ZCore]: paramMapToCcLookup(createZCoreParams()),
    [JunoXEngine.JunoXModel]: paramMapToCcLookup(createJunoXModelParams()),
    [JunoXEngine.RDPiano]: paramMapToCcLookup(createRDPianoParams()),
  };
  return lookups;
}

function paramMapToCcLookup(map: Record<string, KeyboardParameter>): Map<number, KeyboardParameter> {
  const lookup = new Map<number, KeyboardParameter>();
  for (const param of Object.values(map)) {
    if (param.cc !== undefined && !lookup.has(param.cc)) {
      lookup.set(param.cc, param);
    }
  }
  return lookup;
}

// ── Cross-engine CC → param-name (for log lines) ──

function buildCcLookup(): Map<number, string> {
  const allParams = {
    ...createAnalogSynthParams(),
    ...createZCoreParams(),
    ...createJunoXModelParams(),
    ...createRDPianoParams(),
  };
  const lookup = new Map<number, string>();
  for (const [name, param] of Object.entries(allParams)) {
    if (param.cc !== undefined && !lookup.has(param.cc)) {
      lookup.set(param.cc, name);
    }
  }
  return lookup;
}

// ── Build a SysEx address → param-name lookup for scene params ──

function addrKey(addr: number[]): string {
  return addr.map(b => b.toString(16).padStart(2, "0")).join(":");
}

function buildSysexLookup(): Map<string, string> {
  const lookup = new Map<string, string>();
  const sceneParams = createSceneParams();

  for (const [_key, param] of Object.entries(sceneParams)) {
    if (!param.sysexAddress) continue;

    if (param.perPart) {
      // Register for each of the 5 parts
      for (let p = 0; p < PART_COUNT; p++) {
        const partOffset = SCENE_PART_OFFSETS[p];
        if (!partOffset) continue;
        const fullAddr = addAddresses(addAddresses(SCENE_BASE, partOffset), param.sysexAddress);
        lookup.set(addrKey(fullAddr), `${param.name} [Part ${p + 1}]`);
      }
    } else {
      const fullAddr = addAddresses(SCENE_BASE, param.sysexAddress);
      lookup.set(addrKey(fullAddr), param.name);
    }
  }

  // Also register RD Piano SysEx params (symreso)
  const rdParams = createRDPianoParams();
  for (const [_key, param] of Object.entries(rdParams)) {
    if (!param.sysexAddress) continue;
    // RD Piano is Part 1 only, tone base = 02:20:00:00
    const fullAddr = addAddresses([0x02, 0x20, 0x00, 0x00], param.sysexAddress);
    lookup.set(addrKey(fullAddr), param.name);
  }

  return lookup;
}

// ── Factory ──

export function createJunoXMockHandler(): MockHandler {
  let channels: number[] = [1, 2, 2, 3, 4]; // channels for parts 1-5 (overwritten in init)
  let parts: PartState[] = [];
  let sceneGlobal: Record<string, number> = {};
  let currentScene = { bank: 0, program: 0 };
  let pendingBankMSB = 0;
  let pendingBankLSB = 0;

  const ccLookup: Map<number, string> = buildCcLookup();
  const engineCcLookups = buildEngineCcLookups();
  const sysexLookup: Map<string, string> = buildSysexLookup();

  function initParts(lowerChannel: number, upperChannel: number): void {
    channels = [lowerChannel, upperChannel, 2, 3, 4];
    parts = Array.from({ length: PART_COUNT }, () => {
      const params = new Map<number, number>();
      // Seed the active engine's CCs with defaults so the UI can drive labels
      // and initial values from state metadata before any MIDI arrives.
      const defaults = engineCcLookups[JunoXEngine.AnalogSynth];
      for (const [cc, param] of defaults) {
        params.set(cc, param.defaultValue);
      }
      return {
        engine: JunoXEngine.AnalogSynth,
        params,
        sceneParams: {},
      };
    });
    sceneGlobal = {};
  }

  function findPartIndex(channel: number): number {
    return channels.indexOf(channel);
  }

  function buildParamEntry(param: KeyboardParameter, value: number): ParamEntryState {
    const entry: ParamEntryState = {
      value,
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if (param.displayName) entry.displayName = param.displayName;
    if (param.type === "discrete" && param.labels) {
      const range = param.max - param.min;
      entry.index = range === 0 ? 0 : Math.round((value / 127) * range);
      entry.labels = param.labels;
    }
    return entry;
  }

  function partsToState(): Record<string, any> {
    const result: Record<string, any> = {};
    for (let i = 0; i < PART_COUNT; i++) {
      const part = parts[i];
      const paramObj: Record<string, ParamEntryState | number> = {};
      const lookup = engineCcLookups[part.engine];
      for (const [cc, value] of part.params) {
        const param = lookup.get(cc);
        paramObj[`cc${cc}`] = param ? buildParamEntry(param, value) : value;
      }
      result[`part${i + 1}`] = {
        engine: part.engine,
        engineName: ENGINE_DISPLAY_NAMES[part.engine],
        params: paramObj,
        sceneParams: { ...part.sceneParams },
      };
    }
    return result;
  }

  function getFullStateObj(): Record<string, any> {
    return {
      model: "Roland JUNO-X",
      scene: { ...currentScene },
      sceneGlobal: { ...sceneGlobal },
      ...partsToState(),
    };
  }

  // ── MIDI handlers ──

  function handleCC(controller: number, value: number, channel: number): MockHandlerResult {
    // Bank Select MSB (CC 0)
    if (controller === 0) {
      pendingBankMSB = value;
      return { log: `Bank Select MSB = ${value} (ch${channel})` };
    }

    // Bank Select LSB (CC 32)
    if (controller === 32) {
      pendingBankLSB = value;
      return { log: `Bank Select LSB = ${value} (ch${channel})` };
    }

    // Route to part by channel
    const partIdx = findPartIndex(channel);
    if (partIdx !== -1) {
      parts[partIdx].params.set(controller, value);
    }

    const paramName = ccLookup.get(controller) ?? `cc${controller}`;
    const partLabel = partIdx !== -1 ? `part${partIdx + 1}` : `ch${channel}`;
    return {
      state: getFullStateObj(),
      log: `CC${controller}=${value} ${partLabel} [${paramName}]`,
    };
  }

  function handleProgram(number: number, channel: number): MockHandlerResult {
    const bank = (pendingBankMSB << 7) | pendingBankLSB;
    currentScene = { bank, program: number };
    return {
      state: getFullStateObj(),
      log: `Program Change: bank=${bank} program=${number} (ch${channel})`,
    };
  }

  function handleSysEx(bytes: number[]): MockHandlerResult {
    const dt1 = parseDT1(bytes, JUNO_X_MODEL_ID);
    if (!dt1) {
      return { log: `SysEx (${bytes.length} bytes) — not a JUNO-X DT1, ignored` };
    }

    const { address, data } = dt1;
    const ak = addrKey(address);
    const paramName = sysexLookup.get(ak);

    // Route by address[0]
    if (address[0] === 0x01) {
      // Temporary Scene
      const subAddr = address[1];
      if (subAddr >= 0x10 && subAddr <= 0x14) {
        // Scene Part (partIndex 0-4)
        const partIdx = subAddr - 0x10;
        for (let i = 0; i < data.length; i++) {
          const key = `${ak}[${i}]`;
          parts[partIdx].sceneParams[key] = data[i];
        }
        const label = paramName ?? `addr ${ak}`;
        return {
          state: getFullStateObj(),
          log: `DT1: ${label} = ${data.join(",")}`,
        };
      } else {
        // Scene global params
        for (let i = 0; i < data.length; i++) {
          const key = `${ak}[${i}]`;
          sceneGlobal[key] = data[i];
        }
        const label = paramName ?? `Scene @ ${ak}`;
        return {
          state: getFullStateObj(),
          log: `DT1: ${label} = ${data.join(",")}`,
        };
      }
    }

    // Any other DT1 prefix — just log
    const label = paramName ?? `addr ${ak}`;
    return { log: `DT1: ${label} = ${data.join(",")} (not routed)` };
  }

  // ── MockHandler implementation ──

  const handler: MockHandler = {
    init(lowerChannel: number, upperChannel: number): void {
      initParts(lowerChannel, upperChannel);
    },

    onMIDI(msg: MidiMessage): MockHandlerResult {
      switch (msg.type) {
        case "cc":
          return handleCC(msg.controller, msg.value, msg.channel);
        case "program":
          return handleProgram(msg.number, msg.channel);
        case "sysex":
          return handleSysEx(msg.bytes);
      }
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

  getFullState(includeInventory: boolean): Record<string, any> {
    return this.inner.getFullState(includeInventory);
  }
}
