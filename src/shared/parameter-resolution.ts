/**
 * Generic parameter value resolution driven by ParamEncoding.
 * Works for any keyboard model.
 */

import type { KeyboardParameter } from "./types.js";

/** Scale a discrete label index (0..max) to MIDI 0-127 */
export function discreteToMidi(index: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((index / max) * 127);
}

/** Convert a MIDI 0-127 value back to discrete label index (0..max) */
export function midiToDiscrete(midiValue: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((midiValue / 127) * max);
}

/** Convert a drawbar position (0..positions-1) to MIDI 0-127 */
export function drawbarToMidi(position: number, positions: number): number {
  const max = positions - 1;
  return Math.round((Math.min(max, Math.max(0, position)) / max) * 127);
}

/** Convert MIDI 0-127 to drawbar position (0..positions-1) */
export function midiToDrawbar(midiValue: number, positions: number): number {
  return Math.round((midiValue / 127) * (positions - 1));
}

/** Convert a 1-based model index to MIDI via lookup table */
export function modelIndexToMidi(modelNumber: number, table: number[]): number {
  const idx = Math.max(0, modelNumber - 1);
  if (idx < table.length) return table[idx];
  return Math.min(127, idx * 3);
}

/** Convert MIDI value back to 1-based model index via lookup table */
export function midiToModelIndex(midiValue: number, table: number[]): number {
  for (let i = table.length - 1; i >= 0; i--) {
    if (midiValue >= table[i]) return i + 1;
  }
  return 1;
}

/** Resolve a numeric user value to MIDI 0-127 based on param encoding */
function resolveNumeric(param: KeyboardParameter, value: number): number {
  const enc = param.encoding;
  switch (enc.kind) {
    case "drawbar":
      return drawbarToMidi(value, enc.positions);
    case "model-index":
      return modelIndexToMidi(Math.max(0, Math.round(value)), enc.table);
    case "one-based":
      return Math.max(0, Math.min(127, Math.round(value) - 1));
    case "custom":
      return enc.toMidi(value);
    case "raw":
    default:
      if (param.type === "discrete" || param.type === "toggle") {
        const clamped = Math.max(param.min, Math.min(param.max, Math.round(value)));
        return discreteToMidi(clamped, param.max);
      }
      return Math.max(0, Math.min(127, Math.round(value)));
  }
}

/** Resolve a user-provided value (number or label string) to MIDI 0-127 */
export function resolveValue(param: KeyboardParameter, value: number | string): number {
  if (typeof value === "number") {
    return resolveNumeric(param, value);
  }

  // Try label match first
  const lower = value.toLowerCase();
  if (param.labels) {
    for (const [numStr, label] of Object.entries(param.labels)) {
      if (label.toLowerCase() === lower) {
        const index = Number(numStr);
        return discreteToMidi(index, param.max);
      }
    }
  }

  // Try parsing as number
  const parsed = Number(value);
  if (!isNaN(parsed)) {
    return resolveNumeric(param, parsed);
  }

  throw new Error(
    `Cannot resolve value "${value}" for parameter "${param.name}". ` +
      (param.labels
        ? `Valid labels: ${Object.values(param.labels).join(", ")}`
        : `Expected a number between ${param.min} and ${param.max}`),
  );
}

/**
 * Inverse of `resolveValue` — convert a wire-byte (MIDI 0-127) value back to
 * a canonical user-domain numeric value.
 *
 * For continuous params the wire byte and user value are identical; for
 * scaled discretes / drawbars / model-index / one-based / custom encodings,
 * we apply the proper inverse so the handler's user-domain state is the
 * mirror of what `resolveValue` would have produced for the same input.
 *
 * String labels are NOT returned here — `formatValue` is the right helper
 * for display strings. This always returns a number that callers can pass
 * back into `resolveValue` and get the same wire byte.
 */
export function wireToUserValue(param: KeyboardParameter, wireValue: number): number {
  const enc = param.encoding;
  switch (enc.kind) {
    case "drawbar":
      return midiToDrawbar(wireValue, enc.positions);
    case "model-index":
      return midiToModelIndex(wireValue, enc.table);
    case "one-based": {
      const userValue = Math.max(0, Math.min(127, Math.round(wireValue))) + 1;
      return Math.max(param.min, Math.min(param.max, userValue));
    }
    case "custom":
      return enc.fromMidi(wireValue);
    case "raw":
    default:
      if (param.type === "discrete" || param.type === "toggle") {
        return midiToDiscrete(wireValue, param.max);
      }
      return Math.max(0, Math.min(127, Math.round(wireValue)));
  }
}

/** Format a MIDI value back to a human-readable display string */
export function formatValue(param: KeyboardParameter, midiValue: number): string {
  const enc = param.encoding;
  switch (enc.kind) {
    case "drawbar":
      return `${midiToDrawbar(midiValue, enc.positions)} (MIDI: ${midiValue})`;
    case "model-index":
      return `index ${midiToModelIndex(midiValue, enc.table)} (MIDI: ${midiValue})`;
    case "one-based":
      return `${midiValue + 1} (MIDI: ${midiValue})`;
    case "custom":
      return `${enc.fromMidi(midiValue)} (MIDI: ${midiValue})`;
    case "raw":
    default:
      if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
        const index = midiToDiscrete(midiValue, param.max);
        const label = param.labels[index];
        return label ? `${label} (${midiValue})` : `${midiValue}`;
      }
      return `${midiValue}`;
  }
}
