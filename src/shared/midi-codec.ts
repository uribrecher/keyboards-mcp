/**
 * Per-model translator between the param domain and the MIDI byte domain.
 *
 * Used by both the mock-runner (incoming MIDI → set_params) and the MCP
 * (outgoing set_params → MIDI bytes), so wire encoding lives in exactly
 * one place per model.
 *
 * Plan: docs/plans/pending/30-midi-codec-architecture.md (stage 1).
 */

import type { ParameterMap } from "./keyboard-model.js";

/** A param to encode, optionally targeted to a specific part (1-based). */
export interface ParamRef {
  name: string;
  value: number | string;
  /** 1-based part index. Required when the param has `perPart: true`. */
  part?: number;
}

/** A semantic action that translates to a sequence of MIDI messages. */
export type Action =
  | { kind: "loadProgram"; bank: number; slot: number; channel?: number }
  /**
   * `part` is a 1-based numeric index. Models with letter-labeled parts
   * (e.g. Nord A/B/C/D) translate the label to a part index BEFORE
   * dispatching the action — encoding stays a numeric concern.
   */
  | { kind: "loadSong"; bank: number; slot: number; part?: number };

/** Roland-style request descriptor (RQ1: address + size). */
export interface RequestDescriptor {
  protocol: "roland-rq1";
  address: number[];
  size: number;
  deviceId: number;
}

/** What `decode` returns, per inbound MIDI message. */
export type DecodedEvent =
  | { kind: "param"; name: string; value: number; part?: number }
  | { kind: "loadProgram"; bank: number; slot: number; channel?: number }
  | { kind: "loadSong"; bank: number; slot: number; part?: string }
  | { kind: "request"; descriptor: RequestDescriptor }
  | { kind: "unknown"; bytes?: number[] };

/**
 * A single MIDI message, in either direction.
 *
 * `channel` is OPTIONAL on cc/program. When omitted, the dispatcher should
 * use the connection's configured default channel (this matches
 * `MidiManager.sendCC`'s `channel?` semantics). Codecs MUST only set a
 * channel when targeting is explicit — e.g. a `perPart` param where the
 * caller passed `part` — so that the connection's default channel is used
 * for global params on real devices configured for non-default channels.
 */
export type EncodedMessage =
  | { type: "cc"; controller: number; value: number; channel?: number }
  | { type: "program"; number: number; channel?: number }
  | { type: "sysex"; bytes: number[] };

/**
 * Per-model codec. The mock and the MCP both depend on this contract;
 * neither speaks raw MIDI bytes for model-specific values directly.
 */
export interface MidiCodec {
  /**
   * The full parameter map this codec is bound to. Includes `findParam`,
   * `formatValue`, `getSections`, etc. — the codec subsumes the parameter
   * map for callers that already have the codec.
   */
  readonly map: ParameterMap;

  /**
   * Format a user-domain value as a display string by way of the wire
   * encoding (i.e. label lookup happens after `resolveValue`). Use this
   * when you want to show what `encodeParams` would put on the wire.
   * Returns `String(userValue)` if the param name is unknown.
   */
  formatValue(name: string, userValue: number | string): string;

  /**
   * Format a wire byte (or already-resolved value) as a display string,
   * without resolving from the user domain. Use this on decode results,
   * where you already have the wire-encoded value.
   */
  formatWireValue(name: string, wireValue: number): string;

  /** Encode one or more param writes as the MIDI messages to send. */
  encodeParams(refs: ParamRef[]): EncodedMessage[];

  /** Encode a semantic action (loadProgram, loadSong) as MIDI messages. */
  encodeAction(action: Action): EncodedMessage[];

  /**
   * Decode an inbound MIDI message into one or more param-domain events.
   * Returns an empty array when the message has no model-relevant meaning.
   */
  decode(message: EncodedMessage): DecodedEvent[];

  /**
   * If the message is a request (e.g. Roland RQ1), return its descriptor.
   * Otherwise undefined. Caller decides how to fulfill it (the mock reads
   * its own state and calls `buildResponse`; the MCP awaits the actual
   * reply over MIDI).
   */
  parseRequest(message: EncodedMessage): RequestDescriptor | undefined;

  /**
   * Build the reply to a request given the param values that should be
   * carried in the response. Caller is responsible for resolving the
   * request descriptor's address into the right param values.
   */
  buildResponse(req: RequestDescriptor, paramValues: number[]): EncodedMessage;
}

// ─── Generic CC-only codec helper ───────────────────────────────────────────
//
// Most non-Roland models use only CC for parameter access (Nord, Prophet-6).
// They share an identical encode / decode shape, so this helper saves each
// model from copying the same dozen lines.

/** Construct a CC-only codec from any `ParameterMap`. */
export function createCcCodec(map: ParameterMap): MidiCodec {
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

  function encodeParams(refs: ParamRef[]): EncodedMessage[] {
    return refs.map((ref) => {
      const found = map.findParam(ref.name);
      if (!found) throw new Error(`Unknown parameter: "${ref.name}"`);
      if (found.param.cc === undefined) {
        throw new Error(`${found.param.name}: no CC mapping (CC-only codec)`);
      }
      const wireValue = map.resolveValue(found.param, ref.value);
      // Only set channel when the caller explicitly targets a part. Otherwise
      // leave undefined so the connection's default channel is used.
      const channel = ref.part !== undefined ? ref.part - 1 : undefined;
      return { type: "cc", controller: found.param.cc, value: wireValue, channel };
    });
  }

  function encodeAction(action: Action): EncodedMessage[] {
    if (action.kind === "loadProgram" || action.kind === "loadSong") {
      // loadSong.part is 1-based numeric (models with letter labels translate
      // before dispatch). loadProgram has its own optional channel field.
      // Undefined channel → use the connection's default channel.
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

  function decode(message: EncodedMessage): DecodedEvent[] {
    if (message.type === "cc") {
      const found = map.getParamByCC(message.controller);
      if (!found) return [];
      // Inbound channel is undefined when the message had no channel info;
      // for perPart params we map it to a 1-based part index when present.
      const part = found.param.perPart && message.channel !== undefined
        ? message.channel + 1
        : undefined;
      const event: DecodedEvent = part !== undefined
        ? { kind: "param", name: found.key, value: message.value, part }
        : { kind: "param", name: found.key, value: message.value };
      return [event];
    }
    if (message.type === "program") {
      return [{ kind: "loadProgram", bank: 0, slot: message.number, channel: message.channel }];
    }
    return [];
  }

  function parseRequest(): RequestDescriptor | undefined {
    return undefined;
  }

  function buildResponse(): EncodedMessage {
    throw new Error("buildResponse not supported on CC-only codec");
  }

  return { map, formatValue, formatWireValue, encodeParams, encodeAction, decode, parseRequest, buildResponse };
}

