/**
 * Per-model translator between the param domain and the MIDI byte domain.
 *
 * Used by both the mock-runner (incoming MIDI → set_params) and the MCP
 * (outgoing set_params → MIDI bytes), so wire encoding lives in exactly
 * one place per model.
 *
 * Plan: docs/plans/pending/30-midi-codec-architecture.md (stage 1).
 */

import type { KeyboardParameter } from "./types.js";

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
  | { kind: "loadSong"; bank: number; slot: number; part?: string };

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

/** A single MIDI message, in either direction. */
export type EncodedMessage =
  | { type: "cc"; controller: number; value: number; channel: number }
  | { type: "program"; number: number; channel: number }
  | { type: "sysex"; bytes: number[] };

/**
 * Per-model codec. The mock and the MCP both depend on this contract;
 * neither speaks raw MIDI bytes for model-specific values directly.
 */
export interface MidiCodec {
  /** Parameter map this codec is bound to (name → KeyboardParameter). */
  readonly params: Readonly<Record<string, KeyboardParameter>>;

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
