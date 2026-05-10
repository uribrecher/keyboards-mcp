/**
 * JUNO-X mock handler.
 *
 * Processes CC messages (tone params per part) and Roland DT1 SysEx
 * (scene params). Owns all state and logic; the engine is just MIDI I/O.
 */

import type { MidiMessage, MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { ParamRef } from "../../../shared/midi-codec.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { parseDT1, addAddresses, unpackNibbles } from "../../../shared/roland-dt1.js";
import { JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, JunoXEngine, ENGINE_DISPLAY_NAMES, PART_COUNT, SCENE_BASE, SCENE_PART_OFFSETS } from "./engines/engine-types.js";
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
      // Stage 3: name-keyed view of scene-global params (chorus_*, delay_*, etc.)
      // for UIs that prefer the param domain over byte-level addr keys.
      params: buildParamsView(),
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
    // Stage 4: RQ1 is handled in the engine via codec.parseRequest +
    // handler.read_bytes — the handler never sees the request. Anything
    // that reaches handleSysEx is a write-side message (DT1).
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

  /**
   * Param-domain write. Routes each ref through the codec to derive the
   * canonical wire bytes, then applies those bytes to internal state via
   * the existing handleSysEx / handleCC paths so byte-keyed sceneGlobal /
   * parts shapes stay consistent.
   *
   * Stage 4: this no longer fills emission channels in the result.
   * Outbound MIDI emission is the engine's responsibility — for UI
   * setParam writes it asks the codec to encode and emits on the device's
   * MIDI Out itself.
   */
  function applySetParams(refs: ParamRef[]): MockHandlerResult {
    let lastState: Record<string, any> | undefined;
    const logLines: string[] = [];

    for (const ref of refs) {
      const found = codec.map.findParam(ref.name);
      if (!found) {
        logLines.push(`set: unknown param "${ref.name}"`);
        continue;
      }
      let messages;
      try {
        messages = codec.encodeParams([{ name: found.key, value: ref.value, part: ref.part }]);
      } catch (err) {
        logLines.push(`set: ${found.param.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const msg of messages) {
        let inner: MockHandlerResult = {};
        if (msg.type === "sysex") {
          inner = handleSysEx(msg.bytes);
        } else if (msg.type === "cc") {
          // Codec returns undefined channel for global params; on the mock
          // side fall back to the configured lower channel.
          inner = handleCC(msg.controller, msg.value, msg.channel ?? channels[0]);
        } else if (msg.type === "program") {
          inner = handleProgram(msg.number, msg.channel ?? channels[0]);
        }
        if (inner.state) lastState = inner.state;
      }
      logLines.push(`set: ${found.param.name} = ${codec.formatValue(found.key, ref.value)}`);
    }

    const result: MockHandlerResult = {};
    if (lastState) result.state = lastState;
    if (logLines.length > 0) result.log = logLines.join("; ");
    return result;
  }

  /**
   * Param-domain read. Returns wire-byte values keyed by canonical param
   * name. Reads from the byte-keyed sceneGlobal / parts state and runs
   * each through `codec.decode` to recover the unpacked value.
   */
  function getParams(names: string[], part?: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of names) {
      const found = codec.map.findParam(name);
      if (!found) continue;
      const param = found.param;
      const partIdx = (part ?? 1) - 1;

      if (param.sysexAddress) {
        let fullAddr: number[];
        if (param.perPart) {
          const partOffset = SCENE_PART_OFFSETS[partIdx] ?? SCENE_PART_OFFSETS[0];
          fullAddr = addAddresses(addAddresses(SCENE_BASE, partOffset), param.sysexAddress);
        } else {
          fullAddr = addAddresses(SCENE_BASE, param.sysexAddress);
        }
        const baseKey = addrKey(fullAddr);
        const sysexSize = param.sysexSize ?? 1;
        const data: number[] = [];
        const stateMap = param.perPart ? parts[partIdx]?.sceneParams ?? {} : sceneGlobal;
        for (let i = 0; i < sysexSize; i++) {
          data.push(stateMap[`${baseKey}[${i}]`] ?? 0);
        }
        // Round-trip through codec.decode to recover the unpacked value.
        const synth = codec.buildResponse(
          { protocol: "roland-rq1", address: fullAddr, size: sysexSize, deviceId: JUNO_X_DEVICE_ID },
          data,
        );
        const events = codec.decode(synth);
        const ev = events.find(e => e.kind === "param" && e.name === found.key);
        out[found.key] = ev && ev.kind === "param" ? ev.value : (data[0] ?? 0);
      } else if (param.cc !== undefined) {
        const partState = parts[partIdx];
        out[found.key] = partState?.params.get(param.cc) ?? param.defaultValue;
      }
    }
    return out;
  }

  /**
   * Build the name-keyed `params` view of current state for the broadcast
   * payload. UIs can read `data.params.<name>` instead of poking at
   * byte-keyed `sceneGlobal[<addr>]`.
   *
   * Reads `sceneGlobal[<addr>]` directly — going through `codec.decode`
   * here would walk the entire param map per param-key (decodeDt1ToParams
   * iterates `map.params`), turning a single broadcast into O(N²) work.
   * For multi-byte sysex params we use `unpackNibbles` directly; for
   * single-byte params it's just the stored byte.
   */
  function buildParamsView(): Record<string, number> {
    const view: Record<string, number> = {};
    for (const [key, param] of Object.entries(codec.map.params)) {
      if (param.perPart) continue;          // per-part values live under parts[N]
      if (param.sysexAddress === undefined) continue; // CC-only globals don't apply
      const fullAddr = addAddresses(SCENE_BASE, param.sysexAddress);
      const baseKey = addrKey(fullAddr);
      const sysexSize = param.sysexSize ?? 1;
      if (sysexSize === 1) {
        view[key] = sceneGlobal[`${baseKey}[0]`] ?? 0;
      } else {
        const bytes: number[] = [];
        for (let i = 0; i < sysexSize * 2; i++) {
          bytes.push(sceneGlobal[`${baseKey}[${i}]`] ?? 0);
        }
        view[key] = unpackNibbles(bytes);
      }
    }
    return view;
  }

  /**
   * Bytes-level read for engine-driven RQ1. Reads `size` bytes starting
   * at `address` from the byte-keyed scene state. Falls back to the
   * per-part scene-params map when the address targets a Scene Part
   * (address byte 1 ∈ 0x10..0x14). Bytes never seen are reported as 0.
   */
  function readBytes(address: number[], size: number): number[] {
    const baseKey = addrKey(address);
    const data: number[] = [];
    const isPartAddr = address[0] === 0x01 && address[1] >= 0x10 && address[1] <= 0x14;
    const stateMap = isPartAddr
      ? (parts[address[1] - 0x10]?.sceneParams ?? {})
      : sceneGlobal;
    for (let i = 0; i < size; i++) {
      data.push(stateMap[`${baseKey}[${i}]`] ?? 0);
    }
    return data;
  }

  // ── MockHandler implementation ──

  const handler: MockHandler = {
    codec,
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

    set_params(refs: ParamRef[]): MockHandlerResult {
      return applySetParams(refs);
    },

    get_params(names: string[], part?: number): Record<string, number> {
      return getParams(names, part);
    },

    read_bytes(address: number[], size: number): number[] {
      return readBytes(address, size);
    },

    /** @deprecated kept for engine-level WS backward compat — delegates to set_params. */
    onUIParam(name: string, value: number | string, channel?: number): MockHandlerResult {
      // Channel is 0-based MIDI channel; codec ParamRef.part is 1-based.
      const part = (channel ?? 0) + 1;
      return applySetParams([{ name, value, part }]);
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

  read_bytes(address: number[], size: number): number[] {
    return this.inner.read_bytes!(address, size);
  }

  get codec() {
    return this.inner.codec;
  }

  onUIParam(name: string, value: number | string, channel?: number): MockHandlerResult {
    return this.inner.onUIParam!(name, value, channel);
  }

  getFullState(includeInventory: boolean): Record<string, any> {
    return this.inner.getFullState(includeInventory);
  }
}
