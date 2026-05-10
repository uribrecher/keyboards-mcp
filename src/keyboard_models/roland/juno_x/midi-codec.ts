/**
 * JUNO-X MidiCodec — param ↔ MIDI translator. Used by both the mock
 * (incoming MIDI → handler.set_params) and the MCP device (outgoing
 * set_params → MIDI bytes, RQ1 reply decoding for `get_current_state`).
 */

import type {
  MidiCodec,
  ParamRef,
  Action,
  EncodedMessage,
  DecodedEvent,
  RequestDescriptor,
  ParamAtAddress,
} from "../../../shared/midi-codec.js";
import { createParameterMap } from "./midi-map.js";
import {
  JUNO_X_MODEL_ID,
  JUNO_X_DEVICE_ID,
  JunoXEngine,
  SCENE_BASE,
  SCENE_PART_OFFSETS,
} from "./engines/engine-types.js";
import {
  buildDT1,
  parseDT1,
  parseRQ1,
  addAddresses,
  packNibbles,
  unpackNibbles,
  decodeRolandSize,
} from "../../../shared/roland-dt1.js";
import { wireToUserValue as paramResolutionWireToUser } from "../../../shared/parameter-resolution.js";

export function createJunoXCodec(): MidiCodec {
  const map = createParameterMap();

  // ── Helpers ──

  function fullAddressFor(name: string, part?: number): number[] | undefined {
    const found = map.findParam(name);
    if (!found || !found.param.sysexAddress) return undefined;
    if (found.param.perPart) {
      const partIdx = (part ?? 1) - 1;
      const partOffset = SCENE_PART_OFFSETS[partIdx] ?? SCENE_PART_OFFSETS[0];
      return addAddresses(addAddresses(SCENE_BASE, partOffset), found.param.sysexAddress);
    }
    return addAddresses(SCENE_BASE, found.param.sysexAddress);
  }

  /** Wire bytes for a single param value — DT1 data field only. */
  function packParamData(name: string, value: number | string): number[] {
    const found = map.findParam(name);
    if (!found) throw new Error(`Unknown parameter: "${name}"`);
    const wireValue = map.resolveValue(found.param, value);
    const sysexSize = found.param.sysexSize ?? 1;
    return sysexSize > 1 ? packNibbles(wireValue, sysexSize * 2) : [wireValue];
  }

  // ── Format / normalize helpers ──

  function formatValue(name: string, userValue: number | string): string {
    const param = map.params[name];
    if (!param) return String(userValue);
    return map.formatValue(param, map.resolveValue(param, userValue));
  }

  function formatWireValue(name: string, wireValue: number): string {
    const param = map.params[name];
    if (!param) return String(wireValue);
    return map.formatValue(param, wireValue);
  }

  function normalizeUserValue(name: string, value: number | string): number {
    const param = map.params[name];
    if (!param) throw new Error(`Unknown parameter: "${name}"`);
    if (typeof value === "number") {
      return Math.max(param.min, Math.min(param.max, Math.round(value)));
    }
    if (param.labels) {
      const lower = value.toLowerCase();
      for (const [idxStr, label] of Object.entries(param.labels)) {
        if (label.toLowerCase() === lower) return Number(idxStr);
      }
    }
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return Math.max(param.min, Math.min(param.max, Math.round(parsed)));
    }
    throw new Error(`Cannot resolve "${value}" for "${param.name}"`);
  }

  function wireToUserValue(name: string, wireValue: number): number {
    const param = map.params[name];
    if (!param) return wireValue;
    return paramResolutionWireToUser(param, wireValue);
  }

  // ── Encode ──

  function encodeParam(ref: ParamRef): EncodedMessage {
    const found = map.findParam(ref.name);
    if (!found) throw new Error(`Unknown parameter: "${ref.name}"`);

    if (found.param.sysexAddress !== undefined) {
      const fullAddress = fullAddressFor(found.key, ref.part)!;
      const data = packParamData(found.key, ref.value);
      return { type: "sysex", bytes: buildDT1(JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddress, data) };
    }
    if (found.param.cc !== undefined) {
      const wireValue = map.resolveValue(found.param, ref.value);
      const channel = found.param.perPart && ref.part !== undefined
        ? ref.part - 1
        : undefined;
      return { type: "cc", controller: found.param.cc, value: wireValue, channel };
    }
    throw new Error(`${found.param.name}: no transport address (no sysexAddress or cc)`);
  }

  function encodeParams(refs: ParamRef[]): EncodedMessage[] {
    return refs.map(encodeParam);
  }

  function encodeBytes(name: string, value: number | string, _part?: number): number[] {
    return packParamData(name, value);
  }

  function encodeAction(action: Action): EncodedMessage[] {
    if (action.kind === "loadProgram" || action.kind === "loadSong") {
      const channel = action.kind === "loadSong" && action.part !== undefined
        ? action.part - 1
        : (action.kind === "loadProgram" ? action.channel : undefined);
      return [
        { type: "cc",      controller: 0,  value: (action.bank >> 7) & 0x7F, channel },
        { type: "cc",      controller: 32, value: action.bank & 0x7F,         channel },
        { type: "program", number: action.slot, channel },
      ];
    }
    return [];
  }

  // ── Decode ──

  /** Resolve a DT1 address+data into param events. `engine` is set on
   *  per-engine matches so the handler routes to the right namespace. */
  function decodeDt1ToParams(address: number[], data: number[]): DecodedEvent[] {
    const results: DecodedEvent[] = [];
    const sysexSizeFor = (param: { sysexSize?: number }) => param.sysexSize ?? 1;

    const tryMatch = (
      key: string,
      param: { sysexAddress?: number[]; sysexSize?: number; min: number; max: number; type: string; encoding: any; labels?: any },
      candidateAddr: number[],
      part: number | undefined,
      engine: JunoXEngine | undefined,
    ): boolean => {
      if (!param.sysexAddress) return false;
      if (candidateAddr.length !== address.length) return false;
      if (!candidateAddr.every((b, i) => b === address[i])) return false;
      const sysexSize = sysexSizeFor(param);
      const wireValue = sysexSize > 1 ? unpackNibbles(data.slice(0, sysexSize * 2)) : data[0];
      const userValue = paramResolutionWireToUser(param as any, wireValue);
      const event: DecodedEvent = { kind: "param", name: key, value: userValue };
      if (part !== undefined) event.part = part;
      if (engine !== undefined) event.engine = engine;
      results.push(event);
      return true;
    };

    // Scene-level params (engine-agnostic). perPart iterates part offsets.
    for (const [key, param] of Object.entries(map.globalParams)) {
      if (!param.sysexAddress) continue;
      if (param.perPart) {
        for (let p = 0; p < SCENE_PART_OFFSETS.length; p++) {
          const full = addAddresses(addAddresses(SCENE_BASE, SCENE_PART_OFFSETS[p]), param.sysexAddress);
          if (tryMatch(key, param, full, p + 1, undefined)) break;
        }
      } else {
        tryMatch(key, param, addAddresses(SCENE_BASE, param.sysexAddress), undefined, undefined);
      }
    }

    // Per-engine, per-part params.
    for (const engine of Object.values(JunoXEngine)) {
      const params = map.getParamsForEngine(engine as JunoXEngine);
      for (const [key, param] of Object.entries(params)) {
        if (!param.sysexAddress || !param.perPart) continue;
        // Skip scene-global re-iteration (they're in every engine's getParamsForEngine).
        if (map.globalParams[key]) continue;
        for (let p = 0; p < SCENE_PART_OFFSETS.length; p++) {
          const full = addAddresses(addAddresses(SCENE_BASE, SCENE_PART_OFFSETS[p]), param.sysexAddress);
          if (tryMatch(key, param, full, p + 1, engine as JunoXEngine)) break;
        }
      }
    }

    return results;
  }

  function decode(message: EncodedMessage): DecodedEvent[] {
    if (message.type === "sysex") {
      const rq1 = parseRQ1(message.bytes, JUNO_X_MODEL_ID);
      if (rq1) {
        return [{
          kind: "request",
          descriptor: {
            protocol: "roland-rq1",
            address: rq1.address,
            size: decodeRolandSize(rq1.size),
            deviceId: rq1.deviceId,
          },
        }];
      }
      const dt1 = parseDT1(message.bytes, JUNO_X_MODEL_ID);
      if (!dt1) return [{ kind: "unknown", bytes: message.bytes }];
      return decodeDt1ToParams(dt1.address, dt1.data);
    }
    if (message.type === "cc") {
      // Multi-engine CC: emit one candidate per matching engine; handler
      // picks based on active-engine state on the targeted part.
      const matches = map.getParamsByCC(message.controller);
      if (matches.length === 0) return [];
      return matches.map(({ engine, key, param }) => {
        const userValue = paramResolutionWireToUser(param, message.value);
        const part = param.perPart && message.channel !== undefined
          ? message.channel + 1
          : undefined;
        const event: DecodedEvent = { kind: "param", name: key, value: userValue, engine };
        if (part !== undefined) event.part = part;
        return event;
      });
    }
    if (message.type === "program") {
      // Bank state is engine-managed; codec only emits the PC half.
      return [{ kind: "loadProgram", bank: 0, slot: message.number, channel: message.channel }];
    }
    return [];
  }

  // ── Reverse address lookup ──

  function paramsAtAddress(address: number[], size: number): ParamAtAddress[] {
    const results: ParamAtAddress[] = [];
    const addrAsNumber = (a: number[]): number =>
      (a[0] << 21) | (a[1] << 14) | (a[2] << 7) | a[3];
    const reqStart = addrAsNumber(address);
    const reqEnd = reqStart + size;

    const considerParam = (
      key: string,
      param: { sysexAddress?: number[]; sysexSize?: number; perPart?: boolean },
    ): void => {
      if (!param.sysexAddress) return;
      const sysexSize = param.sysexSize ?? 1;
      const byteCount = sysexSize > 1 ? sysexSize * 2 : 1;
      type Candidate = { full: number[]; part: number | undefined };
      const candidates: Candidate[] = param.perPart
        ? SCENE_PART_OFFSETS.map((off, i) => ({
            full: addAddresses(addAddresses(SCENE_BASE, off), param.sysexAddress!),
            part: i + 1,
          }))
        : [{ full: addAddresses(SCENE_BASE, param.sysexAddress), part: undefined }];
      for (const c of candidates) {
        const paramStart = addrAsNumber(c.full);
        const paramEnd = paramStart + byteCount;
        if (paramStart >= reqStart && paramEnd <= reqEnd) {
          const entry: ParamAtAddress = c.part !== undefined
            ? { name: key, part: c.part, byteOffset: paramStart - reqStart, byteCount }
            : { name: key, byteOffset: paramStart - reqStart, byteCount };
          results.push(entry);
        }
      }
    };

    // Scene-global params.
    for (const [key, param] of Object.entries(map.globalParams)) considerParam(key, param);
    // Per-engine per-part params (skip duplicates already in globalParams).
    for (const engine of Object.values(JunoXEngine)) {
      const params = map.getParamsForEngine(engine as JunoXEngine);
      for (const [key, param] of Object.entries(params)) {
        if (map.globalParams[key]) continue;
        if (!param.perPart) continue;
        considerParam(key, param);
      }
    }
    return results;
  }

  function parseRequest(message: EncodedMessage): RequestDescriptor | undefined {
    if (message.type !== "sysex") return undefined;
    const rq1 = parseRQ1(message.bytes, JUNO_X_MODEL_ID);
    if (!rq1) return undefined;
    return {
      protocol: "roland-rq1",
      address: rq1.address,
      size: decodeRolandSize(rq1.size),
      deviceId: rq1.deviceId,
    };
  }

  function buildResponse(req: RequestDescriptor, paramValues: number[]): EncodedMessage {
    return {
      type: "sysex",
      bytes: buildDT1(JUNO_X_MODEL_ID, req.deviceId, req.address, paramValues),
    };
  }

  return {
    map,
    formatValue,
    formatWireValue,
    normalizeUserValue,
    wireToUserValue,
    encodeParams,
    encodeBytes,
    encodeAction,
    decode,
    paramsAtAddress,
    parseRequest,
    buildResponse,
  };
}
