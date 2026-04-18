/**
 * Shared types for the multi-keyboard model architecture.
 */

export type ParamType = "continuous" | "discrete" | "toggle";

/**
 * How a parameter's user-facing value maps to MIDI 0-127.
 *
 * "raw"         – standard 0-127 (continuous) or discrete index scaled to 0-127
 * "drawbar"     – position 0..N mapped linearly to 0-127 (e.g. Nord organ: 9 positions, 0-8)
 * "model-index" – non-uniform lookup table (1-based input → MIDI)
 * "one-based"   – display is 1-based, MIDI is 0-based (input N → MIDI N-1)
 * "custom"      – arbitrary bijection
 */
export type ParamEncoding =
  | { kind: "raw" }
  | { kind: "drawbar"; positions: number }
  | { kind: "model-index"; table: number[] }
  | { kind: "one-based" }
  | { kind: "custom"; toMidi: (v: number) => number; fromMidi: (v: number) => number };

export interface KeyboardParameter {
  name: string;
  section: string;
  cc?: number;
  sysexAddress?: number[];
  sysexSize?: number;
  min: number;
  max: number;
  defaultValue: number;
  type: ParamType;
  labels?: Record<number, string>;
  description: string;
  encoding: ParamEncoding;
  perPart?: boolean;
}

