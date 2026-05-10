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
import { wireToUserValue as paramResolutionWireToUser } from "./parameter-resolution.js";

/** A param to encode/apply, optionally targeted to a specific part (1-based). */
export interface ParamRef {
  name: string;
  value: number | string;
  /** 1-based part index. Required when the param has `perPart: true`. */
  part?: number;
  /**
   * Engine identifier (model-specific). Set by the codec when it can
   * resolve a param to a specific engine (e.g. JUNO-X has multiple
   * engines per part — the codec emits one candidate per engine for an
   * ambiguous CC). Handlers without engines ignore this field. Handlers
   * with engines use it to disambiguate against the active engine.
   */
  engine?: string;
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

/**
 * What `decode` returns, per inbound MIDI message. May emit MULTIPLE
 * `param` events for an ambiguous CC (one per matching engine on
 * multi-engine models like JUNO-X). The handler picks based on
 * active-engine state.
 */
export type DecodedEvent =
  | { kind: "param"; name: string; value: number; part?: number; engine?: string }
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
 * Where a param's bytes appear within an RQ1 address+size range.
 *
 * The engine uses this to fulfill an RQ1: ask the codec which params live
 * in the request range, ask the handler for their user-domain values
 * (`get_params`), encode each via `encodeBytes`, and pack the results
 * into the request's data field at the right offsets.
 */
export interface ParamAtAddress {
  /** Canonical param key (e.g. "chorus_switch"). */
  name: string;
  /** 1-based part index, when this address resolves to a per-part param. */
  part?: number;
  /** Byte offset into the request range where this param's bytes start. */
  byteOffset: number;
  /** Number of bytes this param occupies on the wire. */
  byteCount: number;
}

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
   * without resolving from the user domain. Use this on decode results
   * when you have the wire-encoded value rather than user-domain.
   */
  formatWireValue(name: string, wireValue: number): string;

  /**
   * Normalize a user-input value to a canonical numeric user-domain value.
   * String labels are looked up in `param.labels` and returned as the
   * label's index. Numbers are clamped to `[min, max]`. Throws on inputs
   * that don't resolve. This is what the handler stores: a number that,
   * when passed back into `encodeParams`, produces the same wire bytes.
   */
  normalizeUserValue(name: string, value: number | string): number;

  /**
   * Inverse of `normalizeUserValue` for the wire side: takes a wire byte
   * and returns the canonical user-domain numeric. Used by the engine
   * after `decode` to drive `handler.set_params` with user-domain values.
   */
  wireToUserValue(name: string, wireValue: number): number;

  /** Encode one or more param writes as the MIDI messages to send. */
  encodeParams(refs: ParamRef[]): EncodedMessage[];

  /**
   * Encode a single param write as just the data bytes that would appear
   * in the DT1 message's data field (no header, no checksum). Used by the
   * engine to assemble RQ1 replies — it walks `paramsAtAddress` to get
   * the layout, asks the handler for each param's user-domain value, and
   * uses this to produce the wire bytes for each.
   */
  encodeBytes(name: string, value: number | string, part?: number): number[];

  /** Encode a semantic action (loadProgram, loadSong) as MIDI messages. */
  encodeAction(action: Action): EncodedMessage[];

  /**
   * Decode an inbound MIDI message into one or more param-domain events.
   * Param events carry USER-DOMAIN values (i.e. what `set_params` accepts);
   * wire-byte translation lives entirely inside the codec.
   * Returns an empty array when the message has no model-relevant meaning.
   */
  decode(message: EncodedMessage): DecodedEvent[];

  /**
   * Reverse address lookup. Given an RQ1 address+size, return the params
   * whose addresses fall within that range, with the byte offset (within
   * the request data) where each param's bytes begin.
   */
  paramsAtAddress(address: number[], size: number): ParamAtAddress[];

  /**
   * If the message is a request (e.g. Roland RQ1), return its descriptor.
   * Otherwise undefined. Caller decides how to fulfill it (the engine
   * reads handler state and calls `buildResponse`; the MCP awaits the
   * actual reply over MIDI).
   */
  parseRequest(message: EncodedMessage): RequestDescriptor | undefined;

  /**
   * Build the reply to a request given the wire bytes that should be
   * carried in the response data field. Caller is responsible for
   * assembling those bytes (typically via `paramsAtAddress` + `encodeBytes`).
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

  function normalizeUserValue(name: string, value: number | string): number {
    const param = map.params[name];
    if (!param) throw new Error(`Unknown parameter: "${name}"`);
    if (typeof value === "number") {
      return Math.max(param.min, Math.min(param.max, Math.round(value)));
    }
    // String: try labels first, then parse as number.
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

  function encodeBytes(): number[] {
    throw new Error("encodeBytes not supported on CC-only codec — no bytes-level wire");
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
      // Decode returns USER-DOMAIN values (stage 5).
      const userValue = paramResolutionWireToUser(found.param, message.value);
      const part = found.param.perPart && message.channel !== undefined
        ? message.channel + 1
        : undefined;
      const event: DecodedEvent = part !== undefined
        ? { kind: "param", name: found.key, value: userValue, part }
        : { kind: "param", name: found.key, value: userValue };
      return [event];
    }
    if (message.type === "program") {
      return [{ kind: "loadProgram", bank: 0, slot: message.number, channel: message.channel }];
    }
    return [];
  }

  function paramsAtAddress(): ParamAtAddress[] {
    return [];   // CC-only codec has no addressable space
  }

  function parseRequest(): RequestDescriptor | undefined {
    return undefined;
  }

  function buildResponse(): EncodedMessage {
    throw new Error("buildResponse not supported on CC-only codec");
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

