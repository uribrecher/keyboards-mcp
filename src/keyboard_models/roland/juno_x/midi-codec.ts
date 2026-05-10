/**
 * JUNO-X MidiCodec — param ↔ MIDI translator.
 *
 * Single source of truth for the wire bytes that correspond to each
 * JUNO-X parameter. Used by both the JUNO-X mock (incoming MIDI →
 * set_params) and the MCP-side `JunoXDevice` (outgoing set_params →
 * MIDI bytes, plus inbound DT1 decoding for `get_current_state`).
 *
 * Plan: docs/plans/pending/30-midi-codec-architecture.md (stages 1-5).
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

  /**
   * Pack a single param's wire bytes — what would appear in the data
   * field of a DT1 (no header/checksum). The `part` argument doesn't
   * affect the data bytes (only the address); it's the caller's job to
   * include it when calling `encodeBytes` so the API is symmetric with
   * `encodeParams`.
   */
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

  /**
   * Walk the parameter map and emit a `param` event for any param whose
   * full address (with each candidate part offset) matches `address`.
   * For `perPart` params the part is reported in the event. Decoded values
   * are USER-DOMAIN (stage 5) — wire-byte translation lives here.
   */
  function decodeDt1ToParams(address: number[], data: number[]): DecodedEvent[] {
    const results: DecodedEvent[] = [];
    for (const [key, param] of Object.entries(map.params)) {
      if (!param.sysexAddress) continue;
      type Candidate = { full: number[]; part: number | undefined };
      const candidates: Candidate[] = param.perPart
        ? SCENE_PART_OFFSETS.map((off, i) => ({
            full: addAddresses(addAddresses(SCENE_BASE, off), param.sysexAddress!),
            part: i + 1,
          }))
        : [{ full: addAddresses(SCENE_BASE, param.sysexAddress), part: undefined }];
      for (const c of candidates) {
        if (c.full.length !== address.length) continue;
        if (!c.full.every((b, i) => b === address[i])) continue;
        const sysexSize = param.sysexSize ?? 1;
        const wireValue = sysexSize > 1
          ? unpackNibbles(data.slice(0, sysexSize * 2))
          : data[0];
        const userValue = paramResolutionWireToUser(param, wireValue);
        const event: DecodedEvent = c.part !== undefined
          ? { kind: "param", name: key, value: userValue, part: c.part }
          : { kind: "param", name: key, value: userValue };
        results.push(event);
        break;
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
      const ccLookup = map.getParamByCC(message.controller);
      if (!ccLookup) return [];
      const userValue = paramResolutionWireToUser(ccLookup.param, message.value);
      const part = ccLookup.param.perPart && message.channel !== undefined
        ? message.channel + 1
        : undefined;
      const event: DecodedEvent = part !== undefined
        ? { kind: "param", name: ccLookup.key, value: userValue, part }
        : { kind: "param", name: ccLookup.key, value: userValue };
      return [event];
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
    const reqEnd = reqStart + size; // exclusive

    for (const [key, param] of Object.entries(map.params)) {
      if (!param.sysexAddress) continue;
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
        const paramEnd = paramStart + byteCount; // exclusive
        // Param fits entirely within the request range.
        if (paramStart >= reqStart && paramEnd <= reqEnd) {
          const entry: ParamAtAddress = c.part !== undefined
            ? { name: key, part: c.part, byteOffset: paramStart - reqStart, byteCount }
            : { name: key, byteOffset: paramStart - reqStart, byteCount };
          results.push(entry);
        }
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
