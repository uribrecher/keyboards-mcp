/**
 * JUNO-X MidiCodec — param ↔ MIDI translator.
 *
 * Single source of truth for the wire bytes that correspond to each
 * JUNO-X parameter. Used by both the JUNO-X mock (incoming MIDI →
 * set_params) and the MCP-side `JunoXDevice` (outgoing set_params →
 * MIDI bytes, plus inbound DT1 decoding for `get_current_state`).
 *
 * Plan: docs/plans/pending/30-midi-codec-architecture.md (stage 1).
 */

import type {
  MidiCodec,
  ParamRef,
  Action,
  EncodedMessage,
  DecodedEvent,
  RequestDescriptor,
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

export function createJunoXCodec(): MidiCodec {
  const map = createParameterMap();

  function encodeParam(ref: ParamRef): EncodedMessage {
    const found = map.findParam(ref.name);
    if (!found) throw new Error(`Unknown parameter: "${ref.name}"`);
    const midiValue = map.resolveValue(found.param, ref.value);

    if (found.param.sysexAddress !== undefined) {
      const partIdx = (ref.part ?? 1) - 1;
      let fullAddress: number[];
      if (found.param.perPart) {
        const partOffset = SCENE_PART_OFFSETS[partIdx] ?? SCENE_PART_OFFSETS[0];
        fullAddress = addAddresses(addAddresses(SCENE_BASE, partOffset), found.param.sysexAddress);
      } else {
        fullAddress = addAddresses(SCENE_BASE, found.param.sysexAddress);
      }
      const sysexSize = found.param.sysexSize ?? 1;
      const data = sysexSize > 1 ? packNibbles(midiValue, sysexSize * 2) : [midiValue];
      const bytes = buildDT1(JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddress, data);
      return { type: "sysex", bytes };
    }
    if (found.param.cc !== undefined) {
      const channel = (ref.part ?? 1) - 1;
      return { type: "cc", controller: found.param.cc, value: midiValue, channel };
    }
    throw new Error(`${found.param.name}: no transport address (no sysexAddress or cc)`);
  }

  function encodeParams(refs: ParamRef[]): EncodedMessage[] {
    return refs.map(encodeParam);
  }

  function encodeAction(action: Action): EncodedMessage[] {
    if (action.kind === "loadProgram") {
      const channel = action.channel ?? 0;
      return [
        { type: "cc",      controller: 0,  value: (action.bank >> 7) & 0x7F, channel },
        { type: "cc",      controller: 32, value: action.bank & 0x7F,         channel },
        { type: "program", number: action.slot, channel },
      ];
    }
    if (action.kind === "loadSong") {
      const channel = action.part ? (parseInt(action.part, 10) - 1) : 0;
      return [
        { type: "cc",      controller: 0,  value: (action.bank >> 7) & 0x7F, channel },
        { type: "cc",      controller: 32, value: action.bank & 0x7F,         channel },
        { type: "program", number: action.slot, channel },
      ];
    }
    return [];
  }

  /**
   * Walk the parameter map and emit a `param` event for any param whose
   * full address (with each candidate part offset) matches `address`.
   * For `perPart` params the part is reported in the event.
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
        const value = sysexSize > 1
          ? unpackNibbles(data.slice(0, sysexSize * 2))
          : data[0];
        const event: DecodedEvent = c.part !== undefined
          ? { kind: "param", name: key, value, part: c.part }
          : { kind: "param", name: key, value };
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
      const part = ccLookup.param.perPart ? message.channel + 1 : undefined;
      const event: DecodedEvent = part !== undefined
        ? { kind: "param", name: ccLookup.key, value: message.value, part }
        : { kind: "param", name: ccLookup.key, value: message.value };
      return [event];
    }
    if (message.type === "program") {
      // Bank state is engine/handler-managed; codec only emits the PC half.
      // Caller reconstructs full bank state from accumulated bank-select CCs.
      return [{ kind: "loadProgram", bank: 0, slot: message.number, channel: message.channel }];
    }
    return [];
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
    params: map.params,
    encodeParams,
    encodeAction,
    decode,
    parseRequest,
    buildResponse,
  };
}
