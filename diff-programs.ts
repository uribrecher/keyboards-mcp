/**
 * Diff two .ne5p program files using the known bit layout.
 * Shows changed parameters with human-readable labels,
 * plus any changed bits in unknown regions.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve("~/test/keyboards-mcp/test_data/before_after");

// ── Bit extraction ──────────────────────────────────────────────────────────

function readBits(buf: Buffer, absBitStart: number, bitCount: number): number {
  let val = 0;
  for (let i = 0; i < bitCount; i++) {
    const bi = absBitStart + i;
    const byteIdx = bi >> 3;
    const bitIdx = 7 - (bi & 7);
    if (byteIdx < buf.length) {
      val = (val << 1) | ((buf[byteIdx] >> bitIdx) & 1);
    }
  }
  return val;
}

// ── Field definitions from program-bit-layout.md ────────────────────────────

type Field = {
  bit: number;
  width: number;
  name: string;
  labels?: Record<number, string>;
  format?: (v: number) => string;
};

const FIELDS: Field[] = [
  // Part / Split
  { bit: 145, width: 2, name: "lowerEngine", labels: { 0: "Organ", 1: "Piano", 2: "Sample Synth" } },
  { bit: 148, width: 2, name: "upperEngine", labels: { 0: "Organ", 1: "Piano", 2: "Sample Synth" } },
  { bit: 163, width: 1, name: "splitMode", labels: { 0: "off", 1: "on" } },
  { bit: 164, width: 3, name: "splitPoint", labels: { 0: "C3", 1: "F3", 2: "C4", 3: "F4", 4: "C5", 5: "F5" } },

  // Master
  { bit: 179, width: 7, name: "masterGain" },

  // Organ
  { bit: 186, width: 3, name: "organModel", labels: { 0: "B3", 1: "B3+Bass", 2: "Pipe", 3: "Vox", 4: "Farfisa" } },
  { bit: 189, width: 1, name: "lowerEnable", labels: { 0: "off", 1: "on" } },
  { bit: 190, width: 1, name: "upperEnable", labels: { 0: "off", 1: "on" } },

  // Piano
  { bit: 240, width: 3, name: "pianoType", labels: { 0: "Grand", 1: "Upright", 2: "EP1", 3: "EP2", 4: "Clav", 5: "Harpsi" } },
  { bit: 246, width: 4, name: "pianoModel", format: v => `${v} (display: ${v + 1})` },
  { bit: 255, width: 2, name: "clavVariation", labels: { 0: "A", 1: "B", 2: "C", 3: "D" } },
  { bit: 257, width: 2, name: "pianoAcoustic", labels: { 0: "Off", 1: "String Resonance", 2: "Long Release", 3: "Both" } },
  { bit: 259, width: 2, name: "pianoKbdTouch" },
  { bit: 261, width: 1, name: "pianoMono", labels: { 0: "off", 1: "on" } },

  // Sample Synth
  { bit: 336, width: 7, name: "sampleAttack" },
  { bit: 343, width: 7, name: "sampleDecRel", format: v => {
    if (v < 64) return `${v} (decay)`;
    if (v === 64) return `${v} (sustain)`;
    return `${v} (release)`;
  }},
  { bit: 350, width: 8, name: "sampleSlot", format: v => `${v} (0-based CBIN index)` },
  { bit: 390, width: 2, name: "sampleDynamics", labels: { 0: "Off", 1: "Low", 2: "Mid", 3: "High" } },
  { bit: 392, width: 1, name: "sampleFilterVel", labels: { 0: "off", 1: "on" } },

  // Percussion (B3 only)
  { bit: 427, width: 1, name: "percussionHarmonic", labels: { 0: "2nd", 1: "3rd" } },
  { bit: 428, width: 1, name: "percussionLevel", labels: { 0: "Normal", 1: "Soft" } },
  { bit: 429, width: 1, name: "percussionSpeed", labels: { 0: "Slow", 1: "Fast" } },

  // B3 drawbars preset 1
  ...Array.from({ length: 9 }, (_, i) => ({
    bit: 456 + i * 4, width: 4, name: `b3_preset1_drawbar${i + 1}`,
  })),
  { bit: 492, width: 1, name: "b3_preset1_vibratoEnable", labels: { 0: "off", 1: "on" } },
  { bit: 493, width: 1, name: "b3_preset1_percussionEnable", labels: { 0: "off", 1: "on" } },
  { bit: 494, width: 3, name: "vibratoType", labels: { 0: "V1", 1: "C1", 2: "V2", 3: "C2", 4: "V3", 5: "C3" } },

  // B3 drawbars preset 2
  ...Array.from({ length: 9 }, (_, i) => ({
    bit: 512 + i * 4, width: 4, name: `b3_preset2_drawbar${i + 1}`,
  })),
  { bit: 548, width: 1, name: "b3_preset2_vibratoEnable", labels: { 0: "off", 1: "on" } },
  { bit: 549, width: 1, name: "b3_preset2_percussionEnable", labels: { 0: "off", 1: "on" } },

  // FX1
  { bit: 952, width: 1, name: "fx1Enable", labels: { 0: "off", 1: "on" } },
  { bit: 953, width: 1, name: "fx1PartSelect", labels: { 0: "Lower", 1: "Upper" } },
  { bit: 954, width: 3, name: "fx1Type", labels: { 0: "Trem1", 1: "Trem2", 2: "Trem3", 3: "Pan1", 4: "Pan2", 5: "Pan3", 6: "Wah", 7: "RingMod" } },
  { bit: 957, width: 7, name: "fx1Rate" },

  // FX2
  { bit: 965, width: 1, name: "fx2Enable", labels: { 0: "off", 1: "on" } },
  { bit: 966, width: 1, name: "fx2PartSelect", labels: { 0: "Lower", 1: "Upper" } },
  { bit: 968, width: 3, name: "fx2Type", labels: { 0: "Phase1", 1: "Phase2", 2: "Flanger", 3: "Chorus1", 4: "Chorus2", 5: "Vibe" } },
  { bit: 971, width: 7, name: "fx2Rate" },

  // Delay
  { bit: 978, width: 1, name: "delayEnable", labels: { 0: "off", 1: "on" } },
  { bit: 979, width: 1, name: "delayPartSelect", labels: { 0: "Lower", 1: "Upper" } },
  { bit: 980, width: 7, name: "delayTempo" },
  { bit: 988, width: 1, name: "delayPingPong", labels: { 0: "off", 1: "on" } },
  { bit: 989, width: 7, name: "delayDryWet" },

  // EQ
  { bit: 997, width: 1, name: "eqEnable", labels: { 0: "off", 1: "on" } },
  { bit: 999, width: 7, name: "eqMidFreq" },
  { bit: 1006, width: 7, name: "eqTreble" },
  { bit: 1013, width: 7, name: "eqMid" },
  { bit: 1020, width: 7, name: "eqBass" },

  // Amp/Speaker
  { bit: 1027, width: 1, name: "ampEnable", labels: { 0: "off", 1: "on" } },
  { bit: 1029, width: 3, name: "ampType", labels: { 0: "Dist", 1: "Small", 2: "JC", 3: "Twin", 4: "Rotary", 5: "Comp" } },
  { bit: 1032, width: 7, name: "ampDrive" },

  // Reverb
  { bit: 1039, width: 1, name: "revEnable", labels: { 0: "off", 1: "on" } },
  { bit: 1040, width: 3, name: "revType", labels: { 0: "Room", 1: "StageSoft", 2: "Stage", 3: "HallSoft", 4: "Hall" } },
  { bit: 1043, width: 7, name: "revDryWet" },

  // Tail
  { bit: 1067, width: 1, name: "fx1ControlPedal", labels: { 0: "off", 1: "on" } },
  { bit: 1068, width: 1, name: "fx2Deep", labels: { 0: "off", 1: "on" } },
];

// ── Gaps (documented single-bit holes between known fields) ─────────────────

const GAPS = [147, 964, 967, 987, 998, 1028];

// ── Build coverage map (which bits are claimed by known fields or gaps) ─────

const PAYLOAD_BITS = 1096;
const knownBits = new Set<number>();
for (const f of FIELDS) {
  for (let i = 0; i < f.width; i++) knownBits.add(f.bit + i);
}
// Do NOT add gaps to knownBits — we want them to show up as unknown changes

// ── File discovery ──────────────────────────────────────────────────────────

const allFiles = readdirSync(DIR).filter(f => f.endsWith(".ne5p")).sort();
if (allFiles.length < 2) {
  console.error(`Need at least 2 .ne5p files in ${DIR}, found ${allFiles.length}`);
  process.exit(1);
}

// Pick the two files to compare (accept CLI args or default to first two)
const [argA, argB] = process.argv.slice(2);
let fileA: string, fileB: string;

if (argA && argB) {
  fileA = argA;
  fileB = argB;
} else {
  // Default: plain name = before, #1 = after
  const beforeFile = allFiles.find(f => !f.includes("#"))!;
  const afterFile = allFiles.find(f => f.includes("#1"))!;
  if (!beforeFile || !afterFile) {
    console.error(`Cannot auto-detect before/after. Pass filenames as arguments.`);
    console.error(`Files: ${allFiles.join(", ")}`);
    process.exit(1);
  }
  fileA = beforeFile;
  fileB = afterFile;
}

console.log(`A: ${fileA}`);
console.log(`B: ${fileB}\n`);

const bufA = readFileSync(resolve(DIR, fileA));
const bufB = readFileSync(resolve(DIR, fileB));

const HEADER_SIZE = 28;
const payloadA = bufA.subarray(HEADER_SIZE);
const payloadB = bufB.subarray(HEADER_SIZE);

// ── CBIN header info ────────────────────────────────────────────────────────

console.log("=== Header ===");
console.log(`  A: bank=${bufA[0x0c]} slot=${bufA[0x0e]}`);
console.log(`  B: bank=${bufB[0x0c]} slot=${bufB[0x0e]}`);

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatValue(field: Field, val: number): string {
  if (field.format) return field.format(val);
  if (field.labels && val in field.labels) return `${val} (${field.labels[val]})`;
  return `${val}`;
}

// ── Build unknown regions (contiguous ranges of bits not covered by FIELDS) ─

type UnknownRegion = { start: number; end: number };
const unknownRegions: UnknownRegion[] = [];
let runStart: number | null = null;

for (let bit = 0; bit < PAYLOAD_BITS; bit++) {
  if (knownBits.has(bit)) {
    if (runStart !== null) {
      unknownRegions.push({ start: runStart, end: bit - 1 });
      runStart = null;
    }
  } else {
    if (runStart === null) runStart = bit;
  }
}
if (runStart !== null) {
  unknownRegions.push({ start: runStart, end: PAYLOAD_BITS - 1 });
}

// ── Build unified row list ──────────────────────────────────────────────────

type Row = { name: string; before: string; after: string; changed: boolean };
const rows: Row[] = [];

// Sort all entries by bit position: known fields + unknown regions interleaved
type Entry =
  | { kind: "field"; field: Field; bit: number }
  | { kind: "unknown"; region: UnknownRegion; bit: number };

const entries: Entry[] = [
  ...FIELDS.map(f => ({ kind: "field" as const, field: f, bit: f.bit })),
  ...unknownRegions.map(r => ({ kind: "unknown" as const, region: r, bit: r.start })),
];
entries.sort((a, b) => a.bit - b.bit);

for (const entry of entries) {
  if (entry.kind === "field") {
    const f = entry.field;
    const valA = readBits(payloadA, f.bit, f.width);
    const valB = readBits(payloadB, f.bit, f.width);
    rows.push({
      name: `${f.name} [${f.bit}, ${f.width}b]`,
      before: formatValue(f, valA),
      after: formatValue(f, valB),
      changed: valA !== valB,
    });
  } else {
    const r = entry.region;
    const width = r.end - r.start + 1;
    // Check for any changed bits in this unknown region
    const changedBits: number[] = [];
    for (let b = r.start; b <= r.end; b++) {
      const a = readBits(payloadA, b, 1);
      const bv = readBits(payloadB, b, 1);
      if (a !== bv) changedBits.push(b);
    }
    if (changedBits.length === 0) {
      // No changes — show region as single summary row
      rows.push({
        name: `??? [${r.start}–${r.end}, ${width}b]`,
        before: "(no change)",
        after: "",
        changed: false,
      });
    } else {
      // Show region header, then each changed bit
      rows.push({
        name: `??? [${r.start}–${r.end}, ${width}b]`,
        before: `${changedBits.length} bit(s) changed`,
        after: "",
        changed: true,
      });
      for (const bit of changedBits) {
        const a = readBits(payloadA, bit, 1);
        const bv = readBits(payloadB, bit, 1);
        rows.push({
          name: `  ↳ bit ${bit}`,
          before: `${a}`,
          after: `${bv}`,
          changed: true,
        });
      }
    }
  }
}

// ── Render table ────────────────────────────────────────────────────────────

const COL_FIELD = "Field";
const COL_BEFORE = "Before";
const COL_AFTER = "After";

const wField = Math.max(COL_FIELD.length, ...rows.map(r => r.name.length));
const wBefore = Math.max(COL_BEFORE.length, ...rows.map(r => r.before.length));
const wAfter = Math.max(COL_AFTER.length, ...rows.map(r => r.after.length));

const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
const sep = `${"─".repeat(wField + 2)}┼${"─".repeat(wBefore + 2)}┼${"─".repeat(wAfter + 2)}`;

console.log();
console.log(` ${pad(COL_FIELD, wField)} │ ${pad(COL_BEFORE, wBefore)} │ ${pad(COL_AFTER, wAfter)}`);
console.log(sep);

for (const row of rows) {
  const marker = row.changed ? "*" : " ";
  console.log(`${marker}${pad(row.name, wField)} │ ${pad(row.before, wBefore)} │ ${pad(row.after, wAfter)}`);
}
