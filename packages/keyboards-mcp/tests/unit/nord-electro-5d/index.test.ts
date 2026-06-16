import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nordModel from "../../../src/keyboard_models/nord/electro_5d/index.js";
import {
  makeProgramFile,
  makeLivePresetFile,
  buildNe5bZip,
  FakeMidiConnection,
} from "../../helpers/nord-backup-fixture.js";

describe("Nord Electro 5D model (index)", () => {
  it("exposes the expected model identity and factories", () => {
    assert.strictEqual(nordModel.info.id, "nord-electro-5d");
    assert.strictEqual(nordModel.info.displayName, "Nord Electro 5D");
    assert.strictEqual(nordModel.info.manufacturer, "Nord");
    assert.ok(nordModel.createDevice!());
    assert.ok(nordModel.createMockHandler!());
    assert.ok(nordModel.createCodec!());
  });

  describe("backup adapter", () => {
    it("detectBackup and parseBackup work over a real .ne5b archive", async () => {
      const zipPath = buildNe5bZip([
        { name: "meta.xml", data: '<root product_version="2.0" product_build="9" manager_version="1.1"/>' },
        { name: "p/Prog.ne5p", data: makeProgramFile({ bankIndex: 0, slotIndex: 0 }, []) },
        { name: "l/Live.ne5l", data: makeLivePresetFile({ slotIndex: 2 }) },
      ]);
      assert.strictEqual(await nordModel.backup!.detectBackup!(zipPath), true);
      const data = await nordModel.backup!.parseBackup(zipPath);
      assert.strictEqual(data.productVersion, "2.0");
      assert.strictEqual(data.programs.length, 1);
    });

    it("parseProgramsFolder reads .ne5p files from a directory", async () => {
      const dir = mkdtempSync(join(tmpdir(), "nord-progs-"));
      writeFileSync(join(dir, "A.ne5p"), makeProgramFile({ bankIndex: 0, slotIndex: 0 }, []));
      writeFileSync(join(dir, "B.ne5p"), makeProgramFile({ bankIndex: 0, slotIndex: 1 }, []));
      const data = await nordModel.backup!.parseProgramsFolder!(dir);
      assert.strictEqual((data.programs as unknown[]).length, 2);
    });

    it("formatAsMarkdown produces an inventory document", () => {
      const md = nordModel.backup!.formatAsMarkdown(
        {
          productVersion: "1.0",
          buildNumber: "1",
          managerVersion: "1",
          pianos: [],
          samples: [],
          programs: [],
          setLists: [],
          livePresets: [],
        },
        "2026-06-16",
      );
      assert.match(md, /Nord Electro 5D Backup Inventory/);
      assert.match(md, /Backup date: 2026-06-16/);
    });
  });

  describe("programLoader", () => {
    it("sends bank-select MSB/LSB and a program change", () => {
      const midi = new FakeMidiConnection();
      nordModel.programLoader!.loadProgram(midi, 3, 12);
      assert.deepStrictEqual(midi.cc, [
        { controller: 0, value: 0, channel: undefined },
        { controller: 32, value: 2, channel: undefined }, // bank - 1
      ]);
      assert.deepStrictEqual(midi.programChanges, [{ program: 11, channel: undefined }]); // slot - 1
    });

    it("declares its bank/slot ranges", () => {
      assert.deepStrictEqual(nordModel.programLoader!.bankRange, { min: 1, max: 5 });
      assert.deepStrictEqual(nordModel.programLoader!.slotRange, { min: 1, max: 50 });
    });
  });

  describe("songLoader", () => {
    it("sends the set-list CC batch, program change, and part-select CC", async () => {
      const midi = new FakeMidiConnection();
      await nordModel.songLoader!.loadSong(midi, 2, 4, "C");
      assert.strictEqual(midi.batches.length, 1);
      assert.deepStrictEqual(midi.batches[0], [
        { controller: 48, value: 127 },
        { controller: 0, value: 0 },
        { controller: 32, value: 1 }, // bank - 1
      ]);
      assert.deepStrictEqual(midi.programChanges, [{ program: 3, channel: undefined }]); // slot - 1
      // part C → index 2 → CC 49 value 85
      assert.ok(midi.cc.some((m) => m.controller === 49 && m.value === 85));
    });

    it("defaults to part A when no part is supplied", async () => {
      const midi = new FakeMidiConnection();
      await nordModel.songLoader!.loadSong(midi, 1, 1);
      assert.ok(midi.cc.some((m) => m.controller === 49 && m.value === 0)); // part A → 0
    });
  });
});
