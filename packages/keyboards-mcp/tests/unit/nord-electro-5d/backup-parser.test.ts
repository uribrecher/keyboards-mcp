import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSingleProgram,
  parseBackup,
  parseProgramsFolder,
  detectBackup,
  formatProgramsSection,
  formatBackupAsMarkdown,
  type ProgramEntry,
  type BackupMetadata,
} from "../../../src/keyboard_models/nord/electro_5d/backup-parser.js";
import {
  makeProgramFile,
  makeSetListFile,
  makeLivePresetFile,
  makePianoFile,
  makeSampleFile,
  buildNe5bZip,
  writeTempFile,
  type CbinHeaderFields,
  type PayloadField,
} from "../../helpers/nord-backup-fixture.js";

/** Parse a synthetic program file into a ProgramEntry. */
function prog(header: CbinHeaderFields, fields: PayloadField[], name = "Prog"): ProgramEntry {
  return parseSingleProgram(makeProgramFile(header, fields), name);
}

/** Drawbar bit-fields for an organ model: `count` nibbles starting at `startBit`, each set to `nibble`. */
function drawbars(startBit: number, count: number, nibble: number): PayloadField[] {
  return Array.from({ length: count }, (_, i): PayloadField => [startBit + i * 4, 4, nibble]);
}

// A fully-populated B3 organ program touching every "enabled"/"engine on" path.
const B3_FULL: PayloadField[] = [
  [145, 2, 0], [148, 2, 0], // lower/upper engine = Organ
  [150, 4, 8], [154, 4, 6], // octave shifts
  [158, 1, 1], [159, 1, 1], [160, 1, 1], [161, 1, 1], // sustain/ctrl pedals
  [163, 1, 1], [164, 3, 2], // split on, point C4
  [186, 3, 0], // organ B3
  [189, 1, 1], [190, 1, 1], // lower/upper enable
  [167, 1, 1], [168, 4, 9], // transpose
  [172, 7, 64], [179, 7, 100], // partMix, masterGain
  ...drawbars(456, 9, 4), // pst1
  ...drawbars(512, 9, 4), // pst2
  [427, 1, 1], [428, 1, 1], [429, 1, 1], // percussion harmonic/level/speed
  [492, 1, 1], [493, 1, 1], [494, 3, 4], // pst1 vib/perc, vibrato V3
  [548, 1, 1], [549, 1, 1], // pst2 vib/perc
  [336, 7, 20], [343, 7, 30], [350, 8, 5], [390, 2, 2], [392, 1, 1], // sample synth
  [240, 3, 4], [246, 4, 0], [255, 2, 1], [257, 2, 3], [259, 2, 2], [261, 1, 1], // piano (Clav/B)
  [952, 1, 1], [953, 1, 1], [954, 3, 6], [957, 7, 50], // fx1 Wah
  [965, 1, 1], [966, 1, 1], [968, 3, 3], [971, 7, 40], // fx2 Chorus 1
  [1067, 1, 1], [1068, 1, 1], // fx1 control pedal, fx2 deep
  [978, 1, 1], [979, 1, 1], [980, 7, 30], [988, 1, 1], [989, 7, 70], // delay ping-pong
  [997, 1, 1], [999, 7, 64], [1006, 7, 64], [1013, 7, 64], [1020, 7, 64], [1069, 2, 2], // eq Both
  [1027, 1, 1], [1028, 1, 1], [1029, 3, 4], [1032, 7, 80], // amp Rotary
  [1039, 1, 1], [1040, 3, 4], [1043, 7, 90], // reverb Hall
];

describe("Nord backup parser — parseSingleProgram / decodeProgramPayload", () => {
  it("decodes a fully-populated B3 organ program", () => {
    const p = prog({ bankIndex: 0, slotIndex: 2 }, B3_FULL, "B3 Full");
    assert.strictEqual(p.bank, 1); // bankIndex + 1
    assert.strictEqual(p.slot, 2);
    assert.strictEqual(p.name, "B3 Full");
    assert.ok(p.payloadHex.length > 0);

    const pm = p.params;
    assert.strictEqual(pm.splitMode, true);
    assert.strictEqual(pm.splitPoint, "C4");
    assert.strictEqual(pm.lowerEngine, "Organ");
    assert.strictEqual(pm.upperEngine, "Organ");
    assert.strictEqual(pm.lowerEnable, true);
    assert.strictEqual(pm.upperEnable, true);
    assert.strictEqual(pm.lowerOctaveShift, 8);
    assert.strictEqual(pm.upperOctaveShift, 6);
    assert.strictEqual(pm.transposeEnable, true);
    assert.strictEqual(pm.transposeAmount, 9);
    assert.strictEqual(pm.partMix, 64);
    assert.strictEqual(pm.masterGain, 100);
    assert.strictEqual(pm.organModel, "B3");
    assert.strictEqual(pm.pianoType, "Clav");
    assert.strictEqual(pm.pianoModel, 1);
    assert.strictEqual(pm.clavVariation, "B");
    assert.strictEqual(pm.pianoAcoustic, 3);
    assert.strictEqual(pm.pianoKbdTouch, 2);
    assert.strictEqual(pm.pianoMono, true);
    assert.strictEqual(pm.sampleSlot, 5);
    assert.strictEqual(pm.sampleAttack, 20);
    assert.strictEqual(pm.sampleDecRel, 30);
    assert.strictEqual(pm.sampleDynamics, 2);
    assert.strictEqual(pm.sampleFilterVel, true);
    assert.strictEqual(pm.pst1Drawbars, "444444444");
    assert.strictEqual(pm.pst2Drawbars, "444444444");
    assert.strictEqual(pm.pst1VibratoEnable, true);
    assert.strictEqual(pm.pst1PercussionEnable, true);
    assert.strictEqual(pm.vibratoType, "V3");
    assert.strictEqual(pm.percussionHarmonic, "3rd");
    assert.strictEqual(pm.percussionSpeed, "Fast");
    assert.strictEqual(pm.percussionLevel, "Soft");
    assert.deepStrictEqual(pm.fx1, { enable: true, type: "Wah", rate: 50, partSelect: 1, controlPedal: true });
    assert.deepStrictEqual(pm.fx2, { enable: true, type: "Chorus 1", rate: 40, deep: true, partSelect: 1 });
    assert.deepStrictEqual(pm.delay, { enable: true, partSelect: 1, tempo: 30, pingPong: true, dryWet: 70 });
    assert.deepStrictEqual(pm.eq, { enable: true, partSelect: 2, treble: 64, midFreq: 64, mid: 64, bass: 64 });
    assert.deepStrictEqual(pm.amp, { enable: true, partSelect: 1, type: "Rotary", drive: 80 });
    assert.deepStrictEqual(pm.reverb, { enable: true, type: "Hall", dryWet: 90 });
  });

  it("decodes default (all-zero) values for a blank payload", () => {
    const p = prog({}, [], "Blank");
    const pm = p.params;
    assert.strictEqual(pm.splitMode, false);
    assert.strictEqual(pm.splitPoint, "C3"); // idx 0
    assert.strictEqual(pm.lowerEngine, "Organ"); // idx 0
    assert.strictEqual(pm.organModel, "B3"); // idx 0
    assert.strictEqual(pm.pianoType, "Grand"); // idx 0
    assert.strictEqual(pm.clavVariation, "A"); // idx 0
    assert.strictEqual(pm.percussionHarmonic, "2nd");
    assert.strictEqual(pm.percussionSpeed, "Slow");
    assert.strictEqual(pm.percussionLevel, "Normal");
    assert.strictEqual(pm.fx1.type, "Trem 1");
    assert.strictEqual(pm.reverb.type, "Room");
    // B3 layout with all-zero nibbles is valid (≤ 8) → joined "000000000"
    assert.strictEqual(pm.pst1Drawbars, "000000000");
  });

  it("falls back to Unknown(...) for out-of-range indices", () => {
    const p = prog({}, [
      [145, 2, 3], // engine idx 3 → Unknown(3)
      [148, 2, 3],
      [164, 3, 6], // split point idx 6 → Unknown
      [186, 3, 6], // organ idx 6 → no layout, Unknown
      [240, 3, 6], // piano type idx 6 → Unknown
      [494, 3, 7], // vibrato idx 7 → Unknown
      [968, 3, 6], // fx2 idx 6 → Unknown
      [1029, 3, 7], // amp idx 7 → Unknown
      [1040, 3, 7], // reverb idx 7 → Unknown
    ]);
    const pm = p.params;
    assert.strictEqual(pm.lowerEngine, "Unknown(3)");
    assert.strictEqual(pm.upperEngine, "Unknown(3)");
    assert.strictEqual(pm.splitPoint, "Unknown(6)");
    assert.strictEqual(pm.organModel, "Unknown(6)");
    assert.strictEqual(pm.pianoType, "Unknown(6)");
    assert.strictEqual(pm.vibratoType, "Unknown(7)");
    assert.strictEqual(pm.fx2.type, "Unknown(6)");
    assert.strictEqual(pm.amp.type, "Unknown(7)");
    assert.strictEqual(pm.reverb.type, "Unknown(7)");
    // No drawbar layout for organ idx 6 → empty → invalid → "?"
    assert.strictEqual(pm.pst1Drawbars, "?");
    assert.strictEqual(pm.pst2Drawbars, "?");
  });

  const ORGAN_LAYOUTS: Array<{ idx: number; model: string; pst1: [number, number]; pst2: [number, number] }> = [
    { idx: 0, model: "B3", pst1: [456, 9], pst2: [512, 9] },
    { idx: 1, model: "B3+Bass", pst1: [494, 2], pst2: [512, 9] },
    { idx: 2, model: "Pipe", pst1: [856, 9], pst2: [904, 9] },
    { idx: 3, model: "Vox", pst1: [600, 8], pst2: [648, 8] },
    { idx: 4, model: "Farfisa", pst1: [728, 9], pst2: [776, 9] },
  ];

  for (const layout of ORGAN_LAYOUTS) {
    it(`decodes drawbars for organ model ${layout.model} (idx ${layout.idx})`, () => {
      const p = prog({}, [
        [186, 3, layout.idx],
        ...drawbars(layout.pst1[0], layout.pst1[1], 4),
        ...drawbars(layout.pst2[0], layout.pst2[1], 4),
      ]);
      assert.strictEqual(p.params.organModel, layout.model);
      assert.strictEqual(p.params.pst1Drawbars, "4".repeat(layout.pst1[1]));
      assert.strictEqual(p.params.pst2Drawbars, "4".repeat(layout.pst2[1]));
    });
  }

  it("marks drawbars as '?' when a nibble exceeds 8 (unreliable decode)", () => {
    const p = prog({}, [
      [186, 3, 4], // Farfisa
      [728, 4, 15], // first pst1 nibble = 15 (> 8) → invalid
      ...drawbars(776, 9, 8), // pst2 all valid
    ]);
    assert.strictEqual(p.params.pst1Drawbars, "?");
    assert.strictEqual(p.params.pst2Drawbars, "888888888");
  });
});

describe("Nord backup parser — parseBackup (ZIP archive)", () => {
  it("parses a complete backup with all entry types", () => {
    const zipPath = buildNe5bZip([
      { name: "meta.xml", data: '<root product_version="1.4.2" product_build="2031" manager_version="3.1"/>' },
      { name: "programs/Bank1/Organ Jam.ne5p", data: makeProgramFile({ bankIndex: 0, slotIndex: 5 }, B3_FULL) },
      { name: "programs/Bank1/Aux.ne5p", data: makeProgramFile({ bankIndex: 0, slotIndex: 1 }, []) },
      { name: "live/Quick.ne5l", data: makeLivePresetFile({ slotIndex: 7 }) },
      { name: "setlists/Show.ne5t", data: makeSetListFile({ bankIndex: 1, slotIndex: 3 }, [5, 50, 99, 200]) },
      { name: "pianos/Grand/Royal.npno", data: makePianoFile({ slotIndex: 0 }, { cnspName: "Royal Grand#Bright    Lrg" }) },
      { name: "pianos/EPiano1/Rhodes.npno", data: makePianoFile({ slotIndex: 1 }, { cnspName: "Plain Rhodes" }) },
      { name: "pianos/Misc/NoHeader.npno", data: makePianoFile({ slotIndex: 2 }, { withCnsp: false }) },
      { name: "samples/Mello.nsmp", data: makeSampleFile({ slotIndex: 3 }, { name: "Mellotron", suffix: "Choir", variant: "Tape", catKey: "11:0" }) },
      { name: "samples/Odd.nsmp", data: makeSampleFile({ slotIndex: 1 }, { name: "Weird", catKey: "99:9" }) },
    ]);

    const data = parseBackup(zipPath);

    assert.strictEqual(data.productVersion, "1.4.2");
    assert.strictEqual(data.buildNumber, "2031");
    assert.strictEqual(data.managerVersion, "3.1");

    assert.strictEqual(data.programs.length, 2);
    // sorted by bank then slot
    assert.strictEqual(data.programs[0].slot, 1);
    assert.strictEqual(data.programs[1].slot, 5);

    assert.strictEqual(data.livePresets.length, 1);
    assert.strictEqual(data.livePresets[0].slot, 7);

    assert.strictEqual(data.setLists.length, 1);
    assert.strictEqual(data.setLists[0].bank, 2); // bankIndex + 1
    assert.strictEqual(data.setLists[0].slot, 3);
    // linear 5 → bank 1, slot 5 ; 50 → bank 2 slot 0 ; 99 → bank 2 slot 49 ; 200 → bank 5 slot 0
    assert.deepStrictEqual(data.setLists[0].programs[0], { bank: 1, slot: 5 });
    assert.deepStrictEqual(data.setLists[0].programs[1], { bank: 2, slot: 0 });
    assert.deepStrictEqual(data.setLists[0].programs[3], { bank: 5, slot: 0 });

    assert.strictEqual(data.pianos.length, 3);
    const royal = data.pianos.find((p) => p.name === "Royal Grand");
    assert.ok(royal);
    assert.strictEqual(royal.variant, "Bright");
    assert.strictEqual(royal.sizeClass, "Lrg");
    assert.strictEqual(royal.category, "Grand"); // from path segment
    assert.strictEqual(royal.location, 1); // slotIndex + 1
    // No '#' → whole string is the name, no variant/size
    const rhodes = data.pianos.find((p) => p.name === "Plain Rhodes");
    assert.ok(rhodes);
    assert.strictEqual(rhodes.variant, "");
    // No CNSP header → "Unknown"
    assert.ok(data.pianos.some((p) => p.name === "Unknown"));

    assert.strictEqual(data.samples.length, 2);
    const mello = data.samples.find((s) => s.name === "Mellotron Choir");
    assert.ok(mello);
    assert.strictEqual(mello.category, "Choir"); // 11:0
    assert.strictEqual(mello.variant, "Tape");
    // unknown cat key → Unknown(99:9), no suffix appended
    const weird = data.samples.find((s) => s.name === "Weird");
    assert.ok(weird);
    assert.strictEqual(weird.category, "Unknown(99:9)");
    // samples sorted by slot
    assert.strictEqual(data.samples[0].slot, 1);
  });

  it("handles a backup with no meta attributes and a piano file outside a folder", () => {
    const zipPath = buildNe5bZip([
      { name: "meta.xml", data: "<root/>" },
      { name: "LoosePiano.npno", data: makePianoFile({ slotIndex: 0 }, { cnspName: "Lonely Grand#Soft  Med" }) },
      { name: "NoCatSample.nsmp", data: makeSampleFile({ slotIndex: 0 }, { name: "Raw" }) },
    ]);
    const data = parseBackup(zipPath);
    assert.strictEqual(data.productVersion, "");
    assert.strictEqual(data.buildNumber, "");
    // entry name with no second path segment → category "Unknown"
    assert.strictEqual(data.pianos[0].category, "Unknown");
    // no "cat" chunk → empty category
    assert.strictEqual(data.samples[0].category, "");
  });
});

describe("Nord backup parser — detectBackup", () => {
  it("returns true for a directory containing .ne5p files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ne5p-dir-"));
    writeFileSync(join(dir, "a.ne5p"), makeProgramFile({}, []));
    assert.strictEqual(detectBackup(dir), true);
  });

  it("returns false for a directory with no .ne5p files", () => {
    const dir = mkdtempSync(join(tmpdir(), "empty-dir-"));
    writeFileSync(join(dir, "readme.txt"), "nothing here");
    assert.strictEqual(detectBackup(dir), false);
  });

  it("returns true for a file with the .ne5b extension (fast path)", () => {
    const path = buildNe5bZip([{ name: "meta.xml", data: "<root/>" }]);
    assert.strictEqual(detectBackup(path), true);
  });

  it("returns true for a non-.ne5b ZIP containing Nord entries (fallback)", () => {
    const path = buildNe5bZip(
      [{ name: "x/Prog.ne5p", data: makeProgramFile({}, []) }],
      "archive.zip",
    );
    assert.strictEqual(detectBackup(path), true);
  });

  it("returns false for a non-ZIP, non-.ne5b file", () => {
    const path = writeTempFile("not a zip at all", "random.bin");
    assert.strictEqual(detectBackup(path), false);
  });
});

describe("Nord backup parser — parseProgramsFolder", () => {
  it("parses and sorts .ne5p files in a folder, ignoring others", () => {
    const dir = mkdtempSync(join(tmpdir(), "progs-folder-"));
    writeFileSync(join(dir, "Second.ne5p"), makeProgramFile({ bankIndex: 0, slotIndex: 4 }, []));
    writeFileSync(join(dir, "First.ne5p"), makeProgramFile({ bankIndex: 0, slotIndex: 1 }, []));
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    const programs = parseProgramsFolder(dir);
    assert.strictEqual(programs.length, 2);
    assert.strictEqual(programs[0].slot, 1); // sorted
    assert.strictEqual(programs[1].slot, 4);
    assert.strictEqual(programs[0].name, "First"); // basename without extension
  });
});

describe("Nord backup parser — formatProgramsSection", () => {
  it("formats organ, piano (Clav), and sample-synth programs into a markdown table", () => {
    const organP = prog({ bankIndex: 0, slotIndex: 0 }, B3_FULL, "Organ One");
    // Piano (Clav) on lower part
    const pianoP = prog({ bankIndex: 0, slotIndex: 1 }, [
      [145, 2, 1], [189, 1, 1], // lower = Piano, enabled
      [240, 3, 4], [246, 4, 2], [255, 2, 2], // Clav, model 3, variation C
      [1027, 1, 1], [1028, 1, 0], [1029, 3, 1], [1032, 7, 40], // amp Small (non-rotary, part Lo)
      [997, 1, 1], [1069, 2, 0], // eq enabled, part Lower
    ], "Clav Two");
    // Sample synth on lower part
    const sampleP = prog({ bankIndex: 0, slotIndex: 2 }, [
      [145, 2, 2], [189, 1, 1], // lower = Sample Synth, enabled
      [350, 8, 9], [336, 7, 10], [343, 7, 12], // sample slot 9
    ], "Sample Three");

    const md = formatProgramsSection([organP, pianoP, sampleP], new Map([[9, "Strings"]]));
    assert.match(md, /## Programs \(3\)/);
    assert.match(md, /### Bank 1 \(3 slots\)/);
    assert.match(md, /Organ One/);
    assert.match(md, /Clav Two/);
    assert.match(md, /Sample Three/);
    assert.match(md, /Strings/); // sample name resolved from map
    assert.match(md, /Rotary/); // organ program's amp
  });

  it("renders an unknown sample slot as #N when not in the slot map", () => {
    const sampleP = prog({ bankIndex: 0, slotIndex: 0 }, [
      [145, 2, 2], [189, 1, 1], [350, 8, 42],
    ], "Mystery");
    const md = formatProgramsSection([sampleP], new Map());
    assert.match(md, /#42/);
  });
});

describe("Nord backup parser — formatBackupAsMarkdown", () => {
  function fullMetadata(): BackupMetadata {
    const grandProg = prog({ bankIndex: 0, slotIndex: 0 }, [
      [145, 2, 1], [189, 1, 1], // lower = Piano
      [240, 3, 0], [246, 4, 0], // Grand, model 1
    ], "Grand Tune");
    const sampleProg = prog({ bankIndex: 0, slotIndex: 1 }, [
      [145, 2, 2], [189, 1, 1], [350, 8, 0], // Sample Synth, slot 0
    ], "Sampler");
    return {
      productVersion: "1.0",
      buildNumber: "100",
      managerVersion: "2.0",
      pianos: [
        { category: "Grand", location: 1, name: "Royal", variant: "Bright", sizeClass: "Lrg", fileSizeMB: 12.3 },
        { category: "EPiano1", location: 2, name: "Wurli", variant: "", sizeClass: "Med", fileSizeMB: 4.1 },
      ],
      samples: [
        { slot: 0, name: "Strings", category: "Ensemble Strings", variant: "Real", fileSizeKB: 2048 },
        { slot: 1, name: "Bell", category: "Tuned Percussion", variant: "", fileSizeKB: 256 },
      ],
      programs: [grandProg, sampleProg],
      setLists: [
        {
          bank: 1,
          name: "Set A",
          slot: 0,
          programs: [
            { bank: 1, slot: 0 }, // resolves to "Grand Tune"
            { bank: 1, slot: 1 }, // resolves to "Sampler"
            { bank: 4, slot: 9 }, // no program → fallback "B4:10"
            { bank: 1, slot: 0 },
          ],
        },
        {
          bank: 2,
          name: "Set B",
          slot: 0,
          programs: [
            { bank: 1, slot: 0 },
            { bank: 1, slot: 0 },
            { bank: 1, slot: 0 },
            { bank: 1, slot: 0 },
          ],
        },
      ],
      livePresets: [{ name: "Live One", slot: 0 }],
    };
  }

  it("renders all sections with date and firmware", () => {
    const md = formatBackupAsMarkdown(fullMetadata(), "2026-06-16");
    assert.match(md, /Backup date: 2026-06-16/);
    assert.match(md, /Firmware v1\.0, Build 100, Manager v2\.0/);
    assert.match(md, /## Piano Models \(2\)/);
    assert.match(md, /## Sample Library \(2\)/);
    assert.match(md, /## Programs \(2\)/);
    assert.match(md, /## Set Lists \(2 banks\)/);
    assert.match(md, /## Live Presets \(1\)/);
    // Piano usage: Grand:1 used by Grand Tune → "1 program"; Wurli unused
    assert.match(md, /Royal .* 1 program/);
    assert.match(md, /Wurli .* Unused/);
    // Sample sizes: 2048 KB → "2.0 MB"; 256 KB → "256 KB"
    assert.match(md, /2\.0 MB/);
    assert.match(md, /256 KB/);
    // Set list ref resolution + fallback
    assert.match(md, /Grand Tune/);
    assert.match(md, /B4:10/);
  });

  it("omits date, firmware, set lists and live presets when absent", () => {
    const minimal: BackupMetadata = {
      productVersion: "",
      buildNumber: "",
      managerVersion: "",
      pianos: [],
      samples: [],
      programs: [],
      setLists: [],
      livePresets: [],
    };
    const md = formatBackupAsMarkdown(minimal);
    assert.doesNotMatch(md, /Backup date:/);
    assert.doesNotMatch(md, /Firmware v/);
    assert.doesNotMatch(md, /## Set Lists/);
    assert.doesNotMatch(md, /## Live Presets/);
    assert.match(md, /## Piano Models \(0\)/);
  });

  it("uses singular 'bank' for a single set-list bank", () => {
    const meta = fullMetadata();
    meta.setLists = [meta.setLists[0]]; // keep only bank 1
    const md = formatBackupAsMarkdown(meta);
    assert.match(md, /## Set Lists \(1 bank\)/);
  });
});
