/**
 * JUNO-X mock handler.
 *
 * Processes CC messages (tone params per part) and Roland DT1 SysEx
 * (scene params). Owns all state and logic; the engine is just MIDI I/O.
 */

import type { MidiMessage, MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { parseDT1, addAddresses } from "../../../shared/roland-dt1.js";
import { JUNO_X_MODEL_ID, JunoXEngine, ENGINE_DISPLAY_NAMES, PART_COUNT, SCENE_BASE, SCENE_PART_OFFSETS } from "./engines/engine-types.js";
import { createAnalogSynthParams } from "./engines/analog-synth.js";
import { createZCoreParams } from "./engines/zcore.js";
import { createJunoXModelParams } from "./engines/juno-x-model.js";
import { createRDPianoParams } from "./engines/rd-piano.js";
import { createSceneParams } from "./scene-params.js";
import { createJunoXCodec } from "./midi-codec.js";

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
  // Codec is the source of truth for param ↔ MIDI translation. Parsing
  // RQ1, building DT1 replies, and encoding UI-driven param writes all
  // delegate here so the same wire-encoding rules are shared with the MCP.
  const codec = createJunoXCodec();

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
    const message = { type: "sysex", bytes } as const;

    // Codec recognizes Roland RQ1 → request descriptor. Real JUNO-X
    // hardware responds to RQ1 with a DT1 carrying the requested bytes;
    // the mock mirrors that so the MCP can use `get_current_state`.
    const req = codec.parseRequest(message);
    if (req) {
      const baseKey = addrKey(req.address);
      const data: number[] = [];
      for (let i = 0; i < req.size; i++) {
        data.push(sceneGlobal[`${baseKey}[${i}]`] ?? 0);
      }
      // `buildResponse` echoes the requester's device ID into the DT1.
      const dt1Response = codec.buildResponse(req, data);
      const replyBytes = dt1Response.type === "sysex" ? dt1Response.bytes : [];
      return {
        log: `RQ1: addr=${baseKey} size=${req.size} dev=0x${req.deviceId.toString(16)} → DT1 ${data.join(",")}`,
        sysexOut: [replyBytes],
      };
    }

    // For DT1, the codec tells us the param identity (name / part); we still
    // parse the raw address+data here because state is keyed byte-level by
    // address (stage 3 will re-key by name and drop this last raw parse).
    const dt1 = parseDT1(bytes, JUNO_X_MODEL_ID);
    if (!dt1) {
      return { log: `SysEx (${bytes.length} bytes) — not a JUNO-X DT1, ignored` };
    }
    const { address, data } = dt1;
    const ak = addrKey(address);
    const paramName = sysexLookup.get(ak);

    if (address[0] === 0x01) {
      const subAddr = address[1];
      if (subAddr >= 0x10 && subAddr <= 0x14) {
        // Scene Part (partIndex 0-4)
        const partIdx = subAddr - 0x10;
        for (let i = 0; i < data.length; i++) {
          parts[partIdx].sceneParams[`${ak}[${i}]`] = data[i];
        }
        const label = paramName ?? `addr ${ak}`;
        return { state: getFullStateObj(), log: `DT1: ${label} = ${data.join(",")}` };
      } else {
        // Scene global params
        for (let i = 0; i < data.length; i++) {
          sceneGlobal[`${ak}[${i}]`] = data[i];
        }
        const label = paramName ?? `Scene @ ${ak}`;
        return { state: getFullStateObj(), log: `DT1: ${label} = ${data.join(",")}` };
      }
    }

    const label = paramName ?? `addr ${ak}`;
    return { log: `DT1: ${label} = ${data.join(",")} (not routed)` };
  }

  function handleUIParam(name: string, value: number | string, channel: number): MockHandlerResult {
    const found = codec.map.findParam(name);
    if (!found) {
      return { log: `UI: unknown param "${name}"` };
    }

    // 1-based part for the codec (channel is 0-based MIDI channel).
    const part = channel + 1;
    let messages;
    try {
      messages = codec.encodeParams([{ name: found.key, value, part }]);
    } catch (err) {
      return { log: `UI: ${found.param.name}: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Apply each encoded message to internal state and collect emit packets.
    const ccOut: MockHandlerResult["ccOut"] = [];
    const sysexOut: number[][] = [];
    let lastInner: MockHandlerResult = {};
    for (const msg of messages) {
      if (msg.type === "sysex") {
        lastInner = handleSysEx(msg.bytes);
        sysexOut.push(msg.bytes);
      } else if (msg.type === "cc") {
        const ch = msg.channel ?? channel;
        lastInner = handleCC(msg.controller, msg.value, ch);
        ccOut.push({ controller: msg.controller, value: msg.value, channel: ch });
      } else if (msg.type === "program") {
        lastInner = handleProgram(msg.number, msg.channel ?? channel);
      }
    }

    const result: MockHandlerResult = {
      state: lastInner.state,
      log: `UI: ${found.param.name} = ${codec.formatValue(found.key, value)}`,
    };
    if (sysexOut.length > 0) result.sysexOut = sysexOut;
    if (ccOut.length > 0) result.ccOut = ccOut;
    return result;
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

    onUIParam(name: string, value: number | string, channel?: number): MockHandlerResult {
      return handleUIParam(name, value, channel ?? 0);
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

  onUIParam(name: string, value: number | string, channel?: number): MockHandlerResult {
    return this.inner.onUIParam!(name, value, channel);
  }

  getFullState(includeInventory: boolean): Record<string, any> {
    return this.inner.getFullState(includeInventory);
  }
}
