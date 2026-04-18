import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  discreteToMidi,
  midiToDiscrete,
  drawbarToMidi,
  midiToDrawbar,
  modelIndexToMidi,
  midiToModelIndex,
  resolveValue,
  formatValue,
} from "../../src/shared/parameter-resolution.js";
import type { KeyboardParameter } from "../../src/shared/types.js";

// ── Helpers to build test params ──

function makeRawContinuous(overrides: Partial<KeyboardParameter> = {}): KeyboardParameter {
  return {
    name: "Test Param",
    section: "test",
    cc: 1,
    min: 0,
    max: 127,
    defaultValue: 0,
    type: "continuous",
    description: "test",
    encoding: { kind: "raw" },
    ...overrides,
  };
}

function makeRawDiscrete(max: number, labels: Record<number, string>): KeyboardParameter {
  return {
    name: "Test Discrete",
    section: "test",
    cc: 2,
    min: 0,
    max,
    defaultValue: 0,
    type: "discrete",
    description: "test",
    encoding: { kind: "raw" },
    labels,
  };
}

// ═══════════════════════════════════════════
//  2a. discreteToMidi / midiToDiscrete
// ═══════════════════════════════════════════

describe("discreteToMidi / midiToDiscrete", () => {
  it("maps index 0 to MIDI 0", () => {
    assert.strictEqual(discreteToMidi(0, 4), 0);
  });

  it("maps max index to MIDI 127", () => {
    assert.strictEqual(discreteToMidi(4, 4), 127);
  });

  it("maps midpoint correctly", () => {
    // index 2 out of max 4 → 2/4 * 127 = 63.5 → 64
    assert.strictEqual(discreteToMidi(2, 4), 64);
  });

  it("handles max=0 edge case", () => {
    assert.strictEqual(discreteToMidi(0, 0), 0);
    assert.strictEqual(midiToDiscrete(64, 0), 0);
  });

  for (const max of [1, 2, 3, 4, 5, 7, 12, 13]) {
    it(`round-trips all values for max=${max}`, () => {
      for (let i = 0; i <= max; i++) {
        const midi = discreteToMidi(i, max);
        const back = midiToDiscrete(midi, max);
        assert.strictEqual(back, i, `max=${max}, index=${i}: encoded to ${midi}, decoded to ${back}`);
      }
    });
  }
});

// ═══════════════════════════════════════════
//  2b. drawbarToMidi / midiToDrawbar
// ═══════════════════════════════════════════

describe("drawbarToMidi / midiToDrawbar", () => {
  it("maps position 0 to MIDI 0 (9 positions)", () => {
    assert.strictEqual(drawbarToMidi(0, 9), 0);
  });

  it("maps position 8 to MIDI 127 (9 positions)", () => {
    assert.strictEqual(drawbarToMidi(8, 9), 127);
  });

  it("round-trips all 9 positions", () => {
    for (let pos = 0; pos <= 8; pos++) {
      const midi = drawbarToMidi(pos, 9);
      const back = midiToDrawbar(midi, 9);
      assert.strictEqual(back, pos, `position ${pos}: encoded to ${midi}, decoded to ${back}`);
    }
  });

  it("clamps negative positions to 0", () => {
    assert.strictEqual(drawbarToMidi(-1, 9), 0);
  });

  it("clamps positions above max to max", () => {
    assert.strictEqual(drawbarToMidi(10, 9), 127);
  });
});

// ═══════════════════════════════════════════
//  2c. modelIndexToMidi / midiToModelIndex
// ═══════════════════════════════════════════

describe("modelIndexToMidi / midiToModelIndex", () => {
  // From Nord organ model table
  const TABLE = [0, 3, 6, 8, 11, 13, 16, 18, 21];

  it("maps 1-based model numbers to MIDI values via table", () => {
    assert.strictEqual(modelIndexToMidi(1, TABLE), 0);
    assert.strictEqual(modelIndexToMidi(2, TABLE), 3);
    assert.strictEqual(modelIndexToMidi(5, TABLE), 11);
    assert.strictEqual(modelIndexToMidi(9, TABLE), 21);
  });

  it("reverse maps exact MIDI values back to model numbers", () => {
    assert.strictEqual(midiToModelIndex(0, TABLE), 1);
    assert.strictEqual(midiToModelIndex(3, TABLE), 2);
    assert.strictEqual(midiToModelIndex(11, TABLE), 5);
    assert.strictEqual(midiToModelIndex(21, TABLE), 9);
  });

  it("reverse maps intermediate MIDI values to nearest lower model", () => {
    // MIDI 4 is between 3 (model 2) and 6 (model 3) → model 2
    assert.strictEqual(midiToModelIndex(4, TABLE), 2);
    // MIDI 7 is between 6 (model 3) and 8 (model 4) → model 3
    assert.strictEqual(midiToModelIndex(7, TABLE), 3);
  });

  it("handles out-of-range model number gracefully", () => {
    // Beyond table length: uses idx * 3 fallback
    const midi = modelIndexToMidi(20, TABLE);
    assert.ok(midi >= 0 && midi <= 127);
  });

  it("returns model 1 for MIDI 0", () => {
    assert.strictEqual(midiToModelIndex(0, TABLE), 1);
  });
});

// ═══════════════════════════════════════════
//  2d. resolveValue
// ═══════════════════════════════════════════

describe("resolveValue", () => {
  it("raw continuous: numeric value passes through clamped to 0-127", () => {
    const param = makeRawContinuous();
    assert.strictEqual(resolveValue(param, 64), 64);
    assert.strictEqual(resolveValue(param, 0), 0);
    assert.strictEqual(resolveValue(param, 127), 127);
  });

  it("raw continuous: clamps out-of-range values", () => {
    const param = makeRawContinuous();
    assert.strictEqual(resolveValue(param, -5), 0);
    assert.strictEqual(resolveValue(param, 200), 127);
  });

  it("raw discrete: string label resolves to correct MIDI value", () => {
    const param = makeRawDiscrete(3, { 0: "Off", 1: "Low", 2: "Mid", 3: "High" });
    assert.strictEqual(resolveValue(param, "Off"), 0);
    assert.strictEqual(resolveValue(param, "High"), 127);
  });

  it("raw discrete: label matching is case-insensitive", () => {
    const param = makeRawDiscrete(1, { 0: "Off", 1: "On" });
    assert.strictEqual(resolveValue(param, "on"), 127);
    assert.strictEqual(resolveValue(param, "OFF"), 0);
  });

  it("raw discrete: numeric index resolves correctly", () => {
    const param = makeRawDiscrete(3, { 0: "A", 1: "B", 2: "C", 3: "D" });
    assert.strictEqual(resolveValue(param, 0), 0);
    assert.strictEqual(resolveValue(param, 3), 127);
  });

  it("drawbar encoding: position maps to MIDI", () => {
    const param = makeRawContinuous({
      encoding: { kind: "drawbar", positions: 9 },
    });
    assert.strictEqual(resolveValue(param, 0), 0);
    assert.strictEqual(resolveValue(param, 8), 127);
    assert.strictEqual(resolveValue(param, 4), drawbarToMidi(4, 9));
  });

  it("model-index encoding: 1-based model number maps via table", () => {
    const table = [0, 3, 6, 8, 11];
    const param = makeRawContinuous({
      encoding: { kind: "model-index", table },
    });
    assert.strictEqual(resolveValue(param, 1), 0);
    assert.strictEqual(resolveValue(param, 3), 6);
  });

  it("one-based encoding: value 1 → MIDI 0, value 5 → MIDI 4", () => {
    const param = makeRawContinuous({
      encoding: { kind: "one-based" },
    });
    assert.strictEqual(resolveValue(param, 1), 0);
    assert.strictEqual(resolveValue(param, 5), 4);
  });

  it("custom encoding: delegates to toMidi function", () => {
    const param = makeRawContinuous({
      encoding: {
        kind: "custom",
        toMidi: (v: number) => v * 2,
        fromMidi: (v: number) => v / 2,
      },
    });
    assert.strictEqual(resolveValue(param, 10), 20);
  });

  it("string that parses as number is resolved numerically", () => {
    const param = makeRawContinuous();
    assert.strictEqual(resolveValue(param, "64"), 64);
  });

  it("invalid label throws with descriptive message", () => {
    const param = makeRawDiscrete(2, { 0: "A", 1: "B", 2: "C" });
    assert.throws(
      () => resolveValue(param, "Invalid"),
      (err: Error) => err.message.includes("Cannot resolve value") && err.message.includes("A, B, C"),
    );
  });
});

// ═══════════════════════════════════════════
//  2e. formatValue
// ═══════════════════════════════════════════

describe("formatValue", () => {
  it("raw continuous: returns MIDI value as string", () => {
    const param = makeRawContinuous();
    assert.strictEqual(formatValue(param, 64), "64");
  });

  it("raw discrete with labels: returns label and MIDI", () => {
    const param = makeRawDiscrete(2, { 0: "Off", 1: "Mid", 2: "On" });
    const result = formatValue(param, 0);
    assert.ok(result.includes("Off"), `Expected "Off" in "${result}"`);
  });

  it("drawbar encoding: returns position and MIDI", () => {
    const param = makeRawContinuous({
      encoding: { kind: "drawbar", positions: 9 },
    });
    const midi = drawbarToMidi(5, 9);
    const result = formatValue(param, midi);
    assert.ok(result.includes("5"), `Expected "5" in "${result}"`);
    assert.ok(result.includes("MIDI"), `Expected "MIDI" in "${result}"`);
  });

  it("model-index encoding: returns index and MIDI", () => {
    const table = [0, 3, 6, 8, 11];
    const param = makeRawContinuous({
      encoding: { kind: "model-index", table },
    });
    const result = formatValue(param, 6);
    assert.ok(result.includes("index 3"), `Expected "index 3" in "${result}"`);
  });

  it("one-based encoding: returns 1-based value and MIDI", () => {
    const param = makeRawContinuous({
      encoding: { kind: "one-based" },
    });
    const result = formatValue(param, 4);
    assert.ok(result.includes("5"), `Expected "5" in "${result}"`);
    assert.ok(result.includes("MIDI"), `Expected "MIDI" in "${result}"`);
  });

  it("custom encoding: delegates to fromMidi", () => {
    const param = makeRawContinuous({
      encoding: {
        kind: "custom",
        toMidi: (v: number) => v * 2,
        fromMidi: (v: number) => v / 2,
      },
    });
    const result = formatValue(param, 20);
    assert.ok(result.includes("10"), `Expected "10" in "${result}"`);
  });
});
