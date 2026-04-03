/**
 * Nord Electro 5D backup file (.ne5b) parser.
 *
 * The .ne5b format is a standard ZIP archive containing CBIN-encoded files
 * for programs, pianos, samples, set lists, live presets, and settings.
 */

import AdmZip from "adm-zip";
import { basename, extname, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

// ── Types ──

export interface BackupMetadata {
  productVersion: string;
  buildNumber: string;
  managerVersion: string;
  pianos: PianoEntry[];
  samples: SampleEntry[];
  programs: ProgramEntry[];
  setLists: SetListEntry[];
  livePresets: LivePresetEntry[];
}

export interface PianoEntry {
  category: string;
  location: number; // 1-based per-category location (matches hardware display)
  name: string;
  variant: string;
  sizeClass: string;
  fileSizeMB: number;
}

export interface SampleEntry {
  slot: number;
  name: string;
  category: string;
  variant: string;
  fileSizeKB: number;
}

export interface ProgramParams {
  splitMode: boolean;
  splitPoint: string;
  lowerEnable: boolean;
  lowerEngine: string;
  upperEnable: boolean;
  upperEngine: string;
  lowerOctaveShift: number; // raw value; display = value - 7
  upperOctaveShift: number; // raw value; display = value - 7
  lowerSustainPedalEnable: boolean;
  upperSustainPedalEnable: boolean;
  lowerCtrlPedalEnable: boolean;
  upperCtrlPedalEnable: boolean;
  transposeEnable: boolean;
  transposeAmount: number; // raw 0-12; display = value - 6 semitones
  partMix: number;
  masterGain: number;
  organModel: string;
  pianoType: string;
  pianoModel: number;
  clavVariation: string; // "A" | "B" | "C" | "D" (only meaningful when pianoType is "Clav")
  pianoAcoustic: number; // 0=Off, 1=String Resonance, 2=Long Release, 3=Both
  pianoKbdTouch: number; // 0-3
  pianoMono: boolean;
  sampleSlot: number;
  sampleAttack: number;
  sampleDecRel: number;
  sampleDynamics: number;  // 0=Off, 1=Low, 2=Mid, 3=High
  sampleFilterVel: boolean;
  pst1Drawbars: string;
  pst1VibratoEnable: boolean;
  pst1PercussionEnable: boolean;
  pst2Drawbars: string;
  pst2VibratoEnable: boolean;
  pst2PercussionEnable: boolean;
  percussionHarmonic: string;  // "2nd" or "3rd"
  percussionSpeed: string;     // "Slow" or "Fast"
  percussionLevel: string;     // "Normal" or "Soft"
  vibratoType: string;
  fx1: { enable: boolean; type: string; rate: number; partSelect: number; controlPedal: boolean };
  fx2: { enable: boolean; type: string; rate: number; deep: boolean; partSelect: number };
  delay: { enable: boolean; partSelect: number; tempo: number; pingPong: boolean; dryWet: number };
  eq: { enable: boolean; partSelect: number; treble: number; midFreq: number; mid: number; bass: number };
  amp: { enable: boolean; partSelect: number; type: string; drive: number };
  reverb: { enable: boolean; type: string; dryWet: number };
}

export interface ProgramEntry {
  bank: number;
  slot: number;
  name: string;
  params: ProgramParams;
  payloadHex: string;
}

export interface SetListProgramRef {
  bank: number;  // 1-based
  slot: number;  // 0-based
}

export interface SetListEntry {
  name: string;
  slot: number;
  programs: [SetListProgramRef, SetListProgramRef, SetListProgramRef, SetListProgramRef]; // A, B, C, D
}

export interface LivePresetEntry {
  name: string;
  slot: number;
}

// ── Program Payload Decoder ──
// The 137-byte payload after the CBIN header is bit-packed parameter data.
// Confirmed field positions (byte offsets from payload start, MSB-first bit numbering):

const ORGAN_MODELS = ["B3", "B3+Bass", "Pipe", "Vox", "Farfisa"] as const;
const PIANO_TYPES = ["Grand", "Upright", "EP1", "EP2", "Clav", "Harpsichord"] as const;
const ENGINE_TYPES = ["Organ", "Piano", "Sample Synth"] as const;
const FX1_TYPES = ["Trem 1", "Trem 2", "Trem 3", "Pan 1", "Pan 2", "Pan 3", "Wah", "Ring Mod"] as const;
const FX2_TYPES = ["Phase 1", "Phase 2", "Flanger", "Chorus 1", "Chorus 2", "Vibe"] as const;
const AMP_TYPES = ["Dist", "Small", "JC", "Twin", "Rotary", "Comp"] as const;
const REVERB_TYPES = ["Room", "Stage Soft", "Stage", "Hall Soft", "Hall"] as const;
const VIBRATO_TYPES = ["V1", "C1", "V2", "C2", "V3", "C3"] as const;
const SPLIT_POINTS = ["C3", "F3", "C4", "F4", "C5", "F5"] as const;

/**
 * Read `bitCount` bits from a buffer at absolute bit position.
 * Bit 0 of each byte is the MSB (bit 7 in hardware terms).
 */
function readBits(buf: Buffer, _unused: number, absBitStart: number, bitCount: number): number {
  let val = 0;
  for (let i = 0; i < bitCount; i++) {
    const bi = absBitStart + i;
    const by = bi >> 3;
    const bt = 7 - (bi & 7);
    if (by < buf.length) {
      val = (val << 1) | ((buf[by] >> bt) & 1);
    }
  }
  return val;
}

/** Shorthand: read bits at absolute position */
function rb(buf: Buffer, absBit: number, count: number): number {
  return readBits(buf, 0, absBit, count);
}

function decodeProgramPayload(payload: Buffer): ProgramParams {
  // ── Part / Split ──
  const lowerEngineIdx = rb(payload, 145, 2);
  const upperEngineIdx = rb(payload, 148, 2);
  const lowerOctaveShift = rb(payload, 150, 4);
  const upperOctaveShift = rb(payload, 154, 4);
  const lowerSustainPedalEnable = rb(payload, 158, 1) === 1;
  const upperSustainPedalEnable = rb(payload, 159, 1) === 1;
  const lowerCtrlPedalEnable = rb(payload, 160, 1) === 1;
  const upperCtrlPedalEnable = rb(payload, 161, 1) === 1;
  const splitMode = rb(payload, 163, 1) === 1;
  const splitPointIdx = rb(payload, 164, 3);
  const lowerEnable = rb(payload, 189, 1) === 1;
  const upperEnable = rb(payload, 190, 1) === 1;

  // ── Organ (byte 23) ──
  const organModelIdx = rb(payload, 186, 3);

  // ── Piano (bytes 30-31) ──
  const pianoTypeIdx = rb(payload, 240, 3);
  const pianoModelIdx = rb(payload, 246, 4);
  const clavVariationIdx = rb(payload, 255, 2); // 0=A, 1=B, 2=C, 3=D (Clavinet pickup selection)
  const pianoAcoustic = rb(payload, 257, 2); // 0=Off, 1=String Resonance, 2=Long Release, 3=Both
  const pianoKbdTouch = rb(payload, 259, 2); // 0-3
  const pianoMono = rb(payload, 261, 1) === 1;

  // ── Drawbars — bit positions and counts vary by organ model ──
  const drawbarLayout: Record<number, { pst1: number; pst1Count: number; pst2: number; pst2Count: number } | null> = {
    0: { pst1: 456, pst1Count: 9, pst2: 512, pst2Count: 9 },  // B3
    1: { pst1: 494, pst1Count: 2, pst2: 512, pst2Count: 9 },  // B3+Bass (2 bass drawbars at 494)
    2: { pst1: 856, pst1Count: 9, pst2: 904, pst2Count: 9 },  // Pipe
    3: { pst1: 600, pst1Count: 8, pst2: 648, pst2Count: 8 },  // Vox (8 drawbars, no drawbar 8)
    4: { pst1: 728, pst1Count: 9, pst2: 776, pst2Count: 9 },  // Farfisa (4-bit fields, values 0 or 8 = off/on)
  };
  const dbLayout = drawbarLayout[organModelIdx] ?? null;
  const pst1 = dbLayout
    ? Array.from({ length: dbLayout.pst1Count }, (_, i) => rb(payload, dbLayout.pst1 + i * 4, 4))
    : [];
  const pst2 = dbLayout
    ? Array.from({ length: dbLayout.pst2Count }, (_, i) => rb(payload, dbLayout.pst2 + i * 4, 4))
    : [];
  // Validate: if any nibble > 8, drawbar decode is unreliable for this organ model
  const pst1Valid = pst1.length > 0 && pst1.every((v) => v <= 8);
  const pst2Valid = pst2.length > 0 && pst2.every((v) => v <= 8);

  // ── Master Gain (bit 179, 7-bit) ──
  const transposeEnable = rb(payload, 167, 1) === 1;
  const transposeAmount = rb(payload, 168, 4);
  const partMix = rb(payload, 172, 7);
  const masterGain = rb(payload, 179, 7);

  // ── Sample Synth ──
  const sampleAttack = rb(payload, 336, 7);  // bit 336, 7-bit (0-127)
  const sampleDecRel = rb(payload, 343, 7);  // bit 343, 7-bit (0-127)
  const sampleSlot = rb(payload, 350, 8);    // bit 350, 8-bit = CBIN sample slot

  // ── Percussion (B3 only) ──
  const percussionHarmonic = rb(payload, 427, 1);  // 0=2nd, 1=3rd
  const percussionSpeed = rb(payload, 429, 1);     // 0=Slow, 1=Fast
  const percussionLevel = rb(payload, 428, 1);     // 0=Normal, 1=Soft

  // ── Per-preset organ controls (B3: after each preset's drawbars) ──
  const pst1VibratoEnable = rb(payload, 492, 1) === 1;
  const pst1PercussionEnable = rb(payload, 493, 1) === 1;
  const vibratoTypeIdx = rb(payload, 494, 3);
  const pst2VibratoEnable = rb(payload, 548, 1) === 1;
  const pst2PercussionEnable = rb(payload, 549, 1) === 1;

  // ── Sample Synth extras (bits 390-392) ──
  const sampleDynamicsIdx = rb(payload, 390, 2);  // 0=Off, 1=Low, 2=Mid, 3=High
  const sampleFilterVel = rb(payload, 392, 1) === 1;

  // ── FX1 (bits 952-963) ──
  const fx1Enable = rb(payload, 952, 1) === 1;
  const fx1PartSelect = rb(payload, 953, 1);  // 0=Lower, 1=Upper
  const fx1TypeIdx = rb(payload, 954, 3);
  const fx1Rate = rb(payload, 957, 7);

  // ── FX2 (bits 964-977) ──
  const fx2Enable = rb(payload, 965, 1) === 1;
  const fx2PartSelect = rb(payload, 966, 1);  // 0=Lower, 1=Upper
  const fx2TypeIdx = rb(payload, 968, 3);
  const fx2Rate = rb(payload, 971, 7);

  // ── FX tail (bits 1067-1068) ──
  const fx1ControlPedal = rb(payload, 1067, 1) === 1;
  const fx2Deep = rb(payload, 1068, 1) === 1;

  // ── Delay (bits 978-995) ──
  const delayEnable = rb(payload, 978, 1) === 1;
  const delayPartSelect = rb(payload, 979, 1);  // 0=Lower, 1=Upper
  const delayTempo = rb(payload, 980, 7);
  const delayPingPong = rb(payload, 988, 1) === 1;
  const delayDryWet = rb(payload, 989, 7);

  // ── EQ (bits 997-1026, part select at 1069) ──
  const eqEnable = rb(payload, 997, 1) === 1;
  const eqMidFreq = rb(payload, 999, 7);
  const eqTreble = rb(payload, 1006, 7);
  const eqMid = rb(payload, 1013, 7);
  const eqBass = rb(payload, 1020, 7);
  const eqPartSelect = rb(payload, 1069, 2);  // 0=Lower, 1=Upper, 2=Both

  // ── Amp/Speaker (bits 1027-1038) ──
  const ampEnable = rb(payload, 1027, 1) === 1;
  const ampPartSelect = rb(payload, 1028, 1);  // 0=Lower, 1=Upper
  const ampTypeIdx = rb(payload, 1029, 3);
  const ampDrive = rb(payload, 1032, 7);

  // ── Reverb (bits 1039-1049) ──
  const revEnable = rb(payload, 1039, 1) === 1;
  const revTypeIdx = rb(payload, 1040, 3);
  const revDryWet = rb(payload, 1043, 7);

  return {
    splitMode,
    splitPoint: SPLIT_POINTS[splitPointIdx] ?? `Unknown(${splitPointIdx})`,
    lowerEnable,
    lowerEngine: ENGINE_TYPES[lowerEngineIdx] ?? `Unknown(${lowerEngineIdx})`,
    upperEnable,
    upperEngine: ENGINE_TYPES[upperEngineIdx] ?? `Unknown(${upperEngineIdx})`,
    lowerOctaveShift,
    upperOctaveShift,
    lowerSustainPedalEnable,
    upperSustainPedalEnable,
    lowerCtrlPedalEnable,
    upperCtrlPedalEnable,
    transposeEnable,
    transposeAmount,
    partMix,
    masterGain,
    organModel: ORGAN_MODELS[organModelIdx] ?? `Unknown(${organModelIdx})`,
    pianoType: PIANO_TYPES[pianoTypeIdx] ?? `Unknown(${pianoTypeIdx})`,
    pianoModel: pianoModelIdx + 1,
    clavVariation: "ABCD"[clavVariationIdx] ?? "A",
    pianoAcoustic,
    pianoKbdTouch,
    pianoMono,
    sampleSlot,
    sampleAttack,
    sampleDecRel,
    sampleDynamics: sampleDynamicsIdx,
    sampleFilterVel,
    pst1Drawbars: pst1Valid ? pst1.join("") : "?",
    pst1VibratoEnable,
    pst1PercussionEnable,
    pst2Drawbars: pst2Valid ? pst2.join("") : "?",
    pst2VibratoEnable,
    pst2PercussionEnable,
    percussionHarmonic: percussionHarmonic === 0 ? "2nd" : "3rd",
    percussionSpeed: percussionSpeed === 0 ? "Slow" : "Fast",
    percussionLevel: percussionLevel === 0 ? "Normal" : "Soft",
    vibratoType: VIBRATO_TYPES[vibratoTypeIdx] ?? `Unknown(${vibratoTypeIdx})`,
    fx1: {
      enable: fx1Enable,
      type: FX1_TYPES[fx1TypeIdx] ?? `Unknown(${fx1TypeIdx})`,
      rate: fx1Rate,
      partSelect: fx1PartSelect,
      controlPedal: fx1ControlPedal,
    },
    fx2: {
      enable: fx2Enable,
      type: FX2_TYPES[fx2TypeIdx] ?? `Unknown(${fx2TypeIdx})`,
      rate: fx2Rate,
      deep: fx2Deep,
      partSelect: fx2PartSelect,
    },
    delay: {
      enable: delayEnable,
      partSelect: delayPartSelect,
      tempo: delayTempo,
      pingPong: delayPingPong,
      dryWet: delayDryWet,
    },
    eq: { enable: eqEnable, partSelect: eqPartSelect, treble: eqTreble, midFreq: eqMidFreq, mid: eqMid, bass: eqBass },
    amp: {
      enable: ampEnable,
      partSelect: ampPartSelect,
      type: AMP_TYPES[ampTypeIdx] ?? `Unknown(${ampTypeIdx})`,
      drive: ampDrive,
    },
    reverb: {
      enable: revEnable,
      type: REVERB_TYPES[revTypeIdx] ?? `Unknown(${revTypeIdx})`,
      dryWet: revDryWet,
    },
  };
}

// ── CBIN Header ──

const CBIN_MAGIC = 0x4e494243; // "CBIN" as LE uint32
const CBIN_HEADER_SIZE = 0x1c; // 28 bytes

function readCbinHeader(buf: Buffer) {
  return {
    magic: buf.readUInt32LE(0),
    version: buf.readUInt32LE(4),
    typeTag: buf.subarray(8, 12).toString("ascii").replace(/\0/g, ""),
    bankIndex: buf[0x0c],
    slotIndex: buf[0x0e],
    typeDisc: buf.readUInt32LE(0x14),
    hash: buf.readUInt32LE(0x18),
  };
}

// ── Piano Name Parser (CNSP sub-header) ──

function parsePianoName(buf: Buffer): { name: string; variant: string; sizeClass: string } {
  const cnspOffset = buf.indexOf(Buffer.from("CNSP"));
  if (cnspOffset < 0) return { name: "Unknown", variant: "", sizeClass: "" };

  // Name field at CNSP + 0x18, up to ~80 bytes
  const nameStart = cnspOffset + 0x18;
  const nameRaw = buf
    .subarray(nameStart, nameStart + 80)
    .toString("ascii")
    .replace(/[\0\x01-\x1f]/g, "")
    .trim();

  // Format: "Model Name#Variant    SizeClass"
  const hashIdx = nameRaw.indexOf("#");
  if (hashIdx < 0) return { name: nameRaw, variant: "", sizeClass: "" };

  const name = nameRaw.substring(0, hashIdx).trim();
  const rest = nameRaw.substring(hashIdx + 1).trim();

  // Size class is typically the last 2-3 chars: XL, Lrg, Med, Sml
  const sizeMatch = rest.match(/\b(XL|Lrg|Med|Sml)\s*$/);
  const sizeClass = sizeMatch ? sizeMatch[1] : "";
  const variant = sizeClass ? rest.substring(0, rest.lastIndexOf(sizeClass)).trim() : rest;

  return { name, variant, sizeClass };
}

// ── Sample Name Parser (NWS/hdr sub-header) ──

const SAMPLE_CATEGORIES: Record<string, string> = {
  "1:0": "Bass",
  "3:0": "Accordion/Harm",
  "5:0": "Guitar/Plucked",
  "6:0": "Organ",
  "7:1": "Tuned Percussion",
  "8:0": "Piano",
  "9:1": "Solo Strings",
  "9:2": "Ensemble Strings",
  "9:3": "Analog Strings",
  "10:0": "Misc Synth",
  "10:1": "Pad Synth",
  "11:0": "Choir",
  "12:1": "Solo Brass",
  "12:2": "Ensemble Brass",
};

function parseSampleName(buf: Buffer): { name: string; category: string; variant: string } {
  // Base name at 0x4A (33 bytes, null-terminated)
  const baseName = buf.subarray(0x4a, 0x4a + 33).toString("ascii").split("\0")[0].trim();
  // Name suffix at 0x6B (33 bytes, null-terminated) — e.g. "Vib", "OrchStr", "Mellotron"
  const suffix = buf.subarray(0x6b, 0x6b + 33).toString("ascii").split("\0")[0].trim();
  const name = suffix ? `${baseName} ${suffix}` : baseName;
  // Variant/source at 0x8C
  const variant = buf.subarray(0x8c, 0x8c + 30).toString("ascii").split("\0")[0].trim();
  // Category from 'cat' chunk at 0xAD+9 (main category) and 0xAD+10 (sub-category)
  let category = "";
  if (buf.length > 0xb8 && buf.subarray(0xad, 0xb0).toString("ascii") === "cat") {
    const catByte = buf[0xad + 9];
    const subCatByte = buf[0xad + 10];
    const key = `${catByte}:${subCatByte}`;
    category = SAMPLE_CATEGORIES[key] ?? `Unknown(${key})`;
  }
  return { name, category, variant };
}

// ── meta.xml Parser ──

function parseMetaXml(xml: string): { productVersion: string; buildNumber: string; managerVersion: string } {
  const attr = (name: string): string => {
    const m = xml.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : "";
  };
  return {
    productVersion: attr("product_version"),
    buildNumber: attr("product_build"),
    managerVersion: attr("manager_version"),
  };
}

// ── Single Program Parser ──

export function parseSingleProgram(buf: Buffer, fileName: string): ProgramEntry {
  const hdr = readCbinHeader(buf);
  const payload = buf.subarray(CBIN_HEADER_SIZE);
  return {
    bank: hdr.bankIndex + 1,
    slot: hdr.slotIndex,
    name: fileName,
    params: decodeProgramPayload(payload),
    payloadHex: payload.toString("hex"),
  };
}

// ── Programs Folder Parser ──

export function parseProgramsFolder(dirPath: string): ProgramEntry[] {
  const files = readdirSync(dirPath).filter((f) => extname(f).toLowerCase() === ".ne5p");
  const programs: ProgramEntry[] = [];
  for (const file of files) {
    const buf = readFileSync(join(dirPath, file));
    const name = basename(file, extname(file));
    programs.push(parseSingleProgram(buf, name));
  }
  programs.sort((a, b) => a.bank - b.bank || a.slot - b.slot);
  return programs;
}

// ── Main Parser ──

export function parseBackup(filePath: string): BackupMetadata {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  let meta = { productVersion: "", buildNumber: "", managerVersion: "" };
  const pianos: PianoEntry[] = [];
  const samples: SampleEntry[] = [];
  const programs: ProgramEntry[] = [];
  const setLists: SetListEntry[] = [];
  const livePresets: LivePresetEntry[] = [];

  for (const entry of entries) {
    const path = entry.entryName;
    const ext = extname(path).toLowerCase();
    const fileName = basename(path, ext);

    if (path === "meta.xml") {
      const xml = entry.getData().toString("utf-8");
      meta = parseMetaXml(xml);
      continue;
    }

    if (ext === ".ne5p") {
      // Program preset — small file, read fully
      const buf = entry.getData();
      programs.push(parseSingleProgram(buf, fileName));
      continue;
    }

    if (ext === ".ne5l") {
      // Live preset — small file
      const buf = entry.getData();
      const hdr = readCbinHeader(buf);
      livePresets.push({
        name: fileName,
        slot: hdr.slotIndex,
      });
      continue;
    }

    if (ext === ".ne5t") {
      // Set list entry — small file with 4 program references (A/B/C/D)
      const buf = entry.getData();
      const hdr = readCbinHeader(buf);
      const payload = buf.subarray(28);
      // 4 x 9-bit linear program numbers at payload bit 144 (byte 18)
      // linear = (bank-1)*50 + slot
      const programs = [0, 1, 2, 3].map((r) => {
        const linear = rb(payload, 18 * 8 + r * 9, 9);
        return { bank: Math.floor(linear / 50) + 1, slot: linear % 50 };
      }) as SetListEntry["programs"];
      setLists.push({
        name: fileName,
        slot: hdr.slotIndex,
        programs,
      });
      continue;
    }

    if (ext === ".npno") {
      // Piano — large file, only need first ~256 bytes for metadata
      const buf = entry.getData();
      const headerBuf = buf.subarray(0, Math.min(buf.length, 256));
      const hdr = readCbinHeader(headerBuf);
      const parsed = parsePianoName(headerBuf);
      const category = path.split("/")[1] || "Unknown";
      pianos.push({
        category,
        location: hdr.slotIndex + 1, // 0-indexed in CBIN → 1-indexed for hardware display
        name: parsed.name,
        variant: parsed.variant,
        sizeClass: parsed.sizeClass,
        fileSizeMB: Math.round((entry.header.size / (1024 * 1024)) * 10) / 10,
      });
      continue;
    }

    if (ext === ".nsmp") {
      // Sample — large file, only need first ~256 bytes for metadata
      const buf = entry.getData();
      const headerBuf = buf.subarray(0, Math.min(buf.length, 256));
      const hdr = readCbinHeader(headerBuf);
      const parsed = parseSampleName(headerBuf);
      samples.push({
        slot: hdr.slotIndex,
        name: parsed.name,
        category: parsed.category,
        variant: parsed.variant,
        fileSizeKB: Math.round(entry.header.size / 1024),
      });
      continue;
    }
  }

  // Sort by slot
  samples.sort((a, b) => a.slot - b.slot);
  programs.sort((a, b) => a.bank - b.bank || a.slot - b.slot);
  setLists.sort((a, b) => a.slot - b.slot);
  livePresets.sort((a, b) => a.slot - b.slot);

  return { ...meta, pianos, samples, programs, setLists, livePresets };
}

// ── Programs Section Formatter ──

export function formatProgramsSection(
  programs: ProgramEntry[],
  sampleBySlot: Map<number, string>,
): string {
  const lines: string[] = [];
  lines.push(`## Programs (${programs.length})`);
  lines.push("");
  const byBank = new Map<number, ProgramEntry[]>();
  for (const p of programs) {
    if (!byBank.has(p.bank)) byBank.set(p.bank, []);
    byBank.get(p.bank)!.push(p);
  }
  for (const [bank, progs] of [...byBank.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`### Bank ${bank} (${progs.length} slots)`);
    lines.push("");
    lines.push("| Prog | Name | Lower | Upper | Split | Organ | Piano | Sample | PST1 | PST2 | FX1 | FX2 | Amp | Delay | Reverb | EQ | Gain |");
    lines.push("|------|------|-------|-------|-------|-------|-------|--------|------|------|-----|-----|-----|-------|--------|-----|------|");
    for (const p of progs) {
      const pm = p.params;
      const fmtVal = (v: number) => (v / 12.7).toFixed(1);
      const lower = pm.lowerEnable ? pm.lowerEngine : "off";
      const upper = pm.upperEnable ? pm.upperEngine : "off";
      const split = pm.splitMode ? pm.splitPoint : "";
      const hasOrganEngine = lower === "Organ" || upper === "Organ";
      let organ = "";
      if (hasOrganEngine) {
        organ = pm.organModel;
        if (pm.pst1VibratoEnable || pm.pst2VibratoEnable) organ += ` vib:${pm.vibratoType}`;
        if (pm.pst1PercussionEnable || pm.pst2PercussionEnable) organ += ` perc:${pm.percussionHarmonic} ${pm.percussionSpeed}/${pm.percussionLevel}`;
      }
      const pianoVariation = pm.pianoType === "Clav" ? pm.clavVariation : "-";
      const ACOUSTIC_LABELS = ["Off", "StrRes", "LongRel", "StrRes+LongRel"] as const;
      const piano =
        lower === "Piano" || upper === "Piano"
          ? `${pm.pianoType}:${pm.pianoModel}:${pianoVariation}:${pm.pianoMono ? "mono" : "stereo"}:${ACOUSTIC_LABELS[pm.pianoAcoustic] ?? "Off"}:touch${pm.pianoKbdTouch}`
          : "";
      const hasSample = lower === "Sample Synth" || upper === "Sample Synth";
      const sample = hasSample
        ? `${sampleBySlot.get(pm.sampleSlot) ?? `#${pm.sampleSlot}`} atk:${fmtVal(pm.sampleAttack)} dec:${fmtVal(pm.sampleDecRel)}`
        : "";
      const hasOrgan = lower === "Organ" || upper === "Organ";
      const pst1 = hasOrgan && pm.pst1Drawbars !== "?" ? pm.pst1Drawbars : "";
      const pst2 = hasOrgan && pm.pst2Drawbars !== "?" ? pm.pst2Drawbars : "";
      const fx1 = pm.fx1.enable ? `${pm.fx1.type} ${fmtVal(pm.fx1.rate)}${pm.fx1.controlPedal ? " cp" : ""}` : "";
      const fx2 = pm.fx2.enable
        ? `${pm.fx2.type} ${fmtVal(pm.fx2.rate)}${pm.fx2.deep ? " deep" : ""}`
        : "";
      const AMP_PART_LABELS = ["Lo", "Up"] as const;
      const ampPart = pm.amp.type === "Rotary" ? "" : (AMP_PART_LABELS[pm.amp.partSelect] ?? "");
      const amp = pm.amp.enable ? `${ampPart ? ampPart + " " : ""}${pm.amp.type} ${fmtVal(pm.amp.drive)}` : "";
      const delay = pm.delay.enable
        ? `${fmtVal(pm.delay.dryWet)}${pm.delay.pingPong ? " pp" : ""}`
        : "";
      const rev = pm.reverb.enable ? `${pm.reverb.type} ${fmtVal(pm.reverb.dryWet)}` : "";
      const EQ_PART_LABELS = ["Lo", "Up", ""] as const;
      const eqPart = EQ_PART_LABELS[pm.eq.partSelect] ?? "";
      const eq = pm.eq.enable
        ? `${eqPart ? eqPart + " " : ""}T:${fmtVal(pm.eq.treble)} M:${fmtVal(pm.eq.mid)} F:${fmtVal(pm.eq.midFreq)} B:${fmtVal(pm.eq.bass)}`
        : "";
      lines.push(
        `| ${p.slot + 1} | ${p.name} | ${lower} | ${upper} | ${split} | ${organ} | ${piano} | ${sample} | ${pst1} | ${pst2} | ${fx1} | ${fx2} | ${amp} | ${delay} | ${rev} | ${eq} | ${fmtVal(pm.masterGain)} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Markdown Formatter ──

export function formatBackupAsMarkdown(data: BackupMetadata, backupDate?: string): string {
  const lines: string[] = [];
  const sampleBySlot = new Map(data.samples.map((s) => [s.slot, s.name]));

  lines.push("---");
  lines.push("name: nord_electro_5d_backup");
  lines.push("description: Complete inventory of sounds loaded on the Nord Electro 5D keyboard");
  lines.push("type: project");
  lines.push("---");
  lines.push("");
  lines.push("# Nord Electro 5D Backup Inventory");
  lines.push("");
  if (backupDate) lines.push(`Backup date: ${backupDate}`);
  if (data.productVersion) {
    lines.push(
      `Firmware v${data.productVersion}, Build ${data.buildNumber}, Manager v${data.managerVersion}`
    );
  }
  lines.push("");

  // ── Compute usage counts ──
  const typeToCategory: Record<string, string> = {
    Grand: "Grand", EP1: "EPiano1", EP2: "EPiano2",
    Harpsichord: "Harps", Upright: "Upright", Clav: "Clavinet",
  };
  // Map "category:location" → global piano array index for usage counting
  const pianoKeyToIndex = new Map<string, number>();
  data.pianos.forEach((p, i) => {
    pianoKeyToIndex.set(`${p.category}:${p.location}`, i);
  });
  const pianoUsage = new Array(data.pianos.length).fill(0);
  const sampleUsage = new Map<number, number>();
  for (const p of data.programs) {
    const pm = p.params;
    const lowerActive = pm.lowerEnable ? pm.lowerEngine : "";
    const upperActive = pm.upperEnable ? pm.upperEngine : "";
    if (lowerActive === "Piano" || upperActive === "Piano") {
      const cat = typeToCategory[pm.pianoType];
      if (cat) {
        const idx = pianoKeyToIndex.get(`${cat}:${pm.pianoModel}`);
        if (idx !== undefined) pianoUsage[idx]++;
      }
    }
    if (lowerActive === "Sample Synth" || upperActive === "Sample Synth") {
      sampleUsage.set(pm.sampleSlot, (sampleUsage.get(pm.sampleSlot) ?? 0) + 1);
    }
  }

  // ── Pianos ──
  lines.push(`## Piano Models (${data.pianos.length})`);
  lines.push("");
  lines.push("> Note: Clavinet D6 has 4 pickup variations (A/B/C/D) selected per-program via piano_variation, not listed here.");
  lines.push("");
  lines.push("| Location | Category | Name | Variant | Size Class | File Size | Used by |");
  lines.push("|----------|----------|------|---------|------------|-----------|---------|");
  data.pianos.forEach((p, i) => {
    const used = pianoUsage[i] > 0 ? `${pianoUsage[i]} program${pianoUsage[i] > 1 ? "s" : ""}` : "Unused";
    lines.push(
      `| ${p.location} | ${p.category} | ${p.name} | ${p.variant} | ${p.sizeClass} | ${p.fileSizeMB} MB | ${used} |`
    );
  });
  lines.push("");

  // ── Samples ──
  lines.push(`## Sample Library (${data.samples.length})`);
  lines.push("");
  lines.push("| MIDI # | Name | Category | Source | Size | Used by |");
  lines.push("|--------|------|----------|--------|------|---------|");
  data.samples.forEach((s, i) => {
    const size = s.fileSizeKB >= 1024
      ? `${(s.fileSizeKB / 1024).toFixed(1)} MB`
      : `${s.fileSizeKB} KB`;
    const count = sampleUsage.get(s.slot) ?? 0;
    const used = count > 0 ? `${count} program${count > 1 ? "s" : ""}` : "Unused";
    lines.push(`| ${s.slot + 1} | ${s.name} | ${s.category} | ${s.variant} | ${size} | ${used} |`);
  });
  lines.push("");

  // ── Programs by bank ──
  lines.push(formatProgramsSection(data.programs, sampleBySlot));

  // ── Set Lists ──
  if (data.setLists.length > 0) {
    const progByBankSlot = new Map(
      data.programs.map((p) => [`${p.bank}:${p.slot}`, p.name])
    );
    const resolveRef = (ref: SetListProgramRef) =>
      progByBankSlot.get(`${ref.bank}:${ref.slot}`) ?? `B${ref.bank}:${ref.slot + 1}`;
    lines.push(`## Set Lists (${data.setLists.length})`);
    lines.push("");
    lines.push("| # | Name | Program A | Program B | Program C | Program D |");
    lines.push("|---|------|-----------|-----------|-----------|-----------|");
    data.setLists.forEach((s, i) => {
      const [a, b, c, d] = s.programs.map(resolveRef);
      lines.push(`| ${i + 1} | ${s.name} | ${a} | ${b} | ${c} | ${d} |`);
    });
    lines.push("");
  }

  // ── Live Presets ──
  if (data.livePresets.length > 0) {
    lines.push(`## Live Presets (${data.livePresets.length})`);
    lines.push("");
    lines.push("| # | Name |");
    lines.push("|---|------|");
    data.livePresets.forEach((l, i) => {
      lines.push(`| ${i + 1} | ${l.name} |`);
    });
    lines.push("");
  }

  return lines.join("\n");
}
