import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import nordModel from "../../../src/keyboard_models/nord/electro_5d/index.js";
import type { KeyboardDevice } from "../../../src/shared/keyboard-model.js";
import { FakeMidiConnection } from "../../helpers/nord-backup-fixture.js";

// Exercises the generic BaseKeyboardDevice machinery through the Nord device,
// which inherits setParameters / loadProgram / getSystemPrompt / listParameters
// unchanged from the base class.

let device: KeyboardDevice;
let conn: FakeMidiConnection;

describe("BaseKeyboardDevice (via Nord device)", () => {
  beforeEach(() => {
    device = nordModel.createDevice!();
    conn = new FakeMidiConnection();
  });

  describe("setParameters", () => {
    it("throws when not connected", () => {
      assert.throws(() => device.setParameters!([{ name: "organ_model", value: "B3" }]), /Not connected/);
    });

    it("encodes and sends valid parameters via the codec", () => {
      device.attach!(conn);
      const result = device.setParameters!([
        { name: "organ_model", value: "B3" },
        { name: "drawbar_1", value: 8 },
      ]);
      assert.match(result.content[0].text, /Parameters set:/);
      assert.ok(conn.cc.length > 0, "expected CC messages to be sent");
    });

    it("reports unknown parameters as errors", () => {
      device.attach!(conn);
      const result = device.setParameters!([{ name: "made_up_param", value: 1 }]);
      assert.match(result.content[0].text, /Unknown parameter: "made_up_param"/);
    });

    it("reports a per-parameter error for an unresolvable value", () => {
      device.attach!(conn);
      const result = device.setParameters!([{ name: "organ_model", value: "NotAModel" }]);
      assert.match(result.content[0].text, /Errors:/);
    });
  });

  describe("loadProgram", () => {
    it("loads a valid program", async () => {
      device.attach!(conn);
      const result = await device.loadProgram!(2, 10);
      assert.match(result.content[0].text, /Loaded program 2:10/);
      assert.ok(conn.programChanges.length > 0);
    });

    it("rejects an out-of-range bank", async () => {
      device.attach!(conn);
      const result = await device.loadProgram!(9, 1);
      assert.match(result.content[0].text, /Bank must be 1-5/);
    });

    it("rejects an out-of-range slot", async () => {
      device.attach!(conn);
      const result = await device.loadProgram!(1, 99);
      assert.match(result.content[0].text, /Slot must be 1-50/);
    });

    it("throws when not connected", async () => {
      await assert.rejects(async () => {
        await device.loadProgram!(1, 1);
      }, /Not connected/);
    });
  });

  describe("getSystemPrompt", () => {
    it("returns the template plus terminology note", () => {
      const text = device.getSystemPrompt!().content[0].text;
      assert.match(text, /KEYBOARD: Nord Electro 5D/);
      assert.match(text, /TERMINOLOGY/);
    });

    it("appends a backup-inventory summary when backup data is present", () => {
      device.backupData = {
        pianos: [{ name: "x" }],
        samples: [{ slot: 0 }],
        programs: [{ bank: 1, slot: 0 }],
        setLists: [{ bank: 1, slot: 0 }],
      };
      const text = device.getSystemPrompt!().content[0].text;
      assert.match(text, /BACKUP INVENTORY: 1 pianos, 1 samples, 1 programs, 1 set list songs/);
    });

    it("appends the device label when set", () => {
      device.label = "studio nord";
      const text = device.getSystemPrompt!().content[0].text;
      assert.match(text, /DEVICE LABEL: "studio nord"/);
    });
  });

  describe("listParameters", () => {
    it("lists all parameters grouped by section", () => {
      const text = device.listParameters!().content[0].text;
      assert.match(text, /##/); // at least one section header
      assert.match(text, /CC:/); // CC-addressed params
    });

    it("filters by a valid section", () => {
      const text = device.listParameters!("organ").content[0].text;
      assert.match(text, /## ORGAN/);
    });

    it("reports available sections for an unknown section", () => {
      const text = device.listParameters!("nonexistent-section").content[0].text;
      assert.match(text, /No parameters found for section "nonexistent-section"/);
      assert.match(text, /Available sections:/);
    });
  });

  describe("connection lifecycle", () => {
    it("attach then detach toggles connection state", () => {
      device.attach!(conn);
      // setParameters works while attached
      assert.doesNotThrow(() => device.setParameters!([{ name: "organ_model", value: 0 }]));
      device.detach!();
      assert.throws(() => device.setParameters!([{ name: "organ_model", value: 0 }]), /Not connected/);
    });
  });
});
