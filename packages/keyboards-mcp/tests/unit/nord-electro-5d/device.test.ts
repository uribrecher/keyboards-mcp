import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import nordModel from "../../../src/keyboard_models/nord/electro_5d/index.js";
import type { KeyboardDevice } from "../../../src/shared/keyboard-model.js";
import { FakeMidiConnection } from "../../helpers/nord-backup-fixture.js";

/** A representative backup inventory for inventory-query tests. */
function inventory(): Record<string, unknown> {
  return {
    pianos: [
      { category: "Grand", location: 1, name: "Royal Grand" },
      { category: "Grand", location: 2, name: "Studio Grand" },
      { category: "Clavinet", location: 1, name: "Clav D6" },
      { category: "EPiano1", location: 1, name: "Rhodes" },
    ],
    programs: [
      { bank: 1, slot: 0, name: "Opener" },
      { bank: 1, slot: 1, name: "Verse" },
      { bank: 2, slot: 0, name: "Chorus" },
    ],
    setLists: [
      {
        bank: 1,
        slot: 0,
        name: "Show One",
        programs: [
          { bank: 1, slot: 0 }, // → Opener
          { bank: 1, slot: 1 }, // → Verse
          { bank: 9, slot: 4 }, // not in programs → fallback B9:5
          { bank: 2, slot: 0 }, // → Chorus
        ],
      },
      {
        bank: 2,
        slot: 0,
        name: "Show Two",
        programs: [
          { bank: 1, slot: 0 },
          { bank: 1, slot: 0 },
          { bank: 1, slot: 0 },
          { bank: 1, slot: 0 },
        ],
      },
    ],
  };
}

let device: KeyboardDevice;

describe("NordElectro5DDevice", () => {
  beforeEach(() => {
    device = nordModel.createDevice!();
  });

  describe("getState", () => {
    it("reports that get_current_state is unsupported (one-way MIDI)", () => {
      const result = device.getState!() as { content: Array<{ text: string }> };
      assert.match(result.content[0].text, /one-way/i);
    });
  });

  describe("formatParameterExtra (piano model discovery in listParameters)", () => {
    it("lists piano models per category when backup data is present", () => {
      device.backupData = inventory();
      const text = device.listParameters!("piano").content[0].text;
      assert.match(text, /Grand: 1=Royal Grand, 2=Studio Grand/);
      assert.match(text, /Clav: 1=Clav D6/);
      assert.match(text, /EP1: 1=Rhodes/);
    });

    it("hints to run extract_backup when no backup data is loaded", () => {
      const text = device.listParameters!("piano").content[0].text;
      assert.match(text, /Run extract_backup to see available model names/);
    });
  });

  describe("loadSong", () => {
    it("annotates the loaded song with program names and a part marker", async () => {
      device.backupData = inventory();
      device.attach!(new FakeMidiConnection());
      const result = await device.loadSong!(1, 1, "B");
      const text = result.content[0].text;
      assert.match(text, /Loaded "Show One"/);
      assert.match(text, /A: Opener/);
      assert.match(text, /B: Verse ←/); // marker on the requested part
      assert.match(text, /C: B9:5/); // unresolved ref → fallback label
      assert.match(text, /D: Chorus/);
    });

    it("defaults to part A when no part is given", async () => {
      device.backupData = inventory();
      device.attach!(new FakeMidiConnection());
      const result = await device.loadSong!(1, 1);
      assert.match(result.content[0].text, /A: Opener ←/);
    });

    it("returns a bare message when the song slot has no backup entry", async () => {
      device.backupData = inventory();
      device.attach!(new FakeMidiConnection());
      const result = await device.loadSong!(1, 5, "A"); // slot 5 → no entry at slot 4
      assert.match(result.content[0].text, /Set list 1, song 5, part A/);
      assert.doesNotMatch(result.content[0].text, /Loaded "/);
    });

    it("rejects when not connected", async () => {
      device.backupData = inventory();
      await assert.rejects(async () => {
        await device.loadSong!(1, 1, "A");
      }, /Not connected/);
    });
  });

  describe("listPrograms", () => {
    it("reports no data when no backup is loaded", () => {
      assert.match(device.listPrograms!().content[0].text, /No backup data loaded/);
    });

    it("lists all programs with no filter", () => {
      device.backupData = inventory();
      const text = device.listPrograms!().content[0].text;
      assert.match(text, /All programs \(3\)/);
      assert.match(text, /1:1 {2}Opener/);
    });

    it("filters by bank", () => {
      device.backupData = inventory();
      const text = device.listPrograms!(undefined, 2).content[0].text;
      assert.match(text, /bank 2/);
      assert.match(text, /Chorus/);
      assert.doesNotMatch(text, /Opener/);
    });

    it("filters by name (case-insensitive)", () => {
      device.backupData = inventory();
      const text = device.listPrograms!("verse").content[0].text;
      assert.match(text, /name "verse"/);
      assert.match(text, /Verse/);
    });

    it("reports no matches when filter excludes everything", () => {
      device.backupData = inventory();
      const text = device.listPrograms!("nonexistent", 1).content[0].text;
      assert.match(text, /No programs matching/);
      assert.match(text, /Total programs: 3/);
    });
  });

  describe("listSongs", () => {
    it("reports no data when no set lists are loaded", () => {
      assert.match(device.listSongs!().content[0].text, /No backup data loaded/);
    });

    it("lists all songs with resolved program names and fallbacks", () => {
      device.backupData = inventory();
      const text = device.listSongs!().content[0].text;
      assert.match(text, /All songs \(2\)/);
      assert.match(text, /Show One/);
      assert.match(text, /A: Opener/);
      assert.match(text, /C: B9:5/); // fallback for unresolved ref
    });

    it("filters songs by bank", () => {
      device.backupData = inventory();
      const text = device.listSongs!(undefined, 2).content[0].text;
      assert.match(text, /bank 2/);
      assert.match(text, /Show Two/);
      assert.doesNotMatch(text, /Show One/);
    });

    it("filters songs by name", () => {
      device.backupData = inventory();
      const text = device.listSongs!("one").content[0].text;
      assert.match(text, /name "one"/);
      assert.match(text, /Show One/);
    });

    it("reports no matches when the song filter excludes everything", () => {
      device.backupData = inventory();
      const text = device.listSongs!("missing").content[0].text;
      assert.match(text, /No songs matching/);
      assert.match(text, /Total songs: 2/);
    });
  });
});
