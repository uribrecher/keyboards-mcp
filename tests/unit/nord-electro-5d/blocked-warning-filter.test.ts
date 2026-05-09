import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import nordModel from "../../../src/keyboard_models/nord/electro_5d/index.js";
import type { MidiConnection } from "../../../src/shared/midi-connection.js";

class StubConnection implements MidiConnection {
  sentCCs: Array<{ cc: number; value: number }> = [];
  sendCC(cc: number, value: number): void { this.sentCCs.push({ cc, value }); }
  sendProgramChange(): void {}
  sendSysEx(): void {}
  sendNRPN(): void {}
  async sendCCBatch(): Promise<void> {}
  onCC(): void {}
}

describe("Nord Electro 5D — advisory warnings exclude blocked params", () => {
  it("does not emit the vibrato/rotary clash warning when vibrato_enable is blocked", () => {
    if (!nordModel.createDevice) throw new Error("Nord model is missing createDevice");
    const device = nordModel.createDevice();
    const conn = new StubConnection();
    device.attach(conn);

    // Set up: rotary speaker is active, both parts on Piano (organ disabled).
    // Sending vibrato_enable=on should be blocked by the organ-section gate.
    device.setParameters([
      { name: "part_lower_engine_select", value: "Piano" },
      { name: "part_upper_engine_select", value: "Piano" },
      { name: "spkr_comp_enable", value: 1 },
      { name: "spkr_comp_type", value: "Rotary" },
    ]);
    conn.sentCCs.length = 0;

    const result = device.setParameters([{ name: "vibrato_enable", value: 1 }]);
    const text = result.content[0].text;

    // The disabled-organ ERROR fires.
    assert.match(text, /^Errors:\nERROR: Organ engine is currently disabled/m);

    // The vibrato/rotary clash WARNING must NOT fire — vibrato_enable was
    // blocked, so warning the user about a clash with a change that never
    // happened would be misleading.
    assert.doesNotMatch(text, /Vibrato\/chorus and the rotary speaker/);

    // And no CC was sent.
    assert.equal(conn.sentCCs.length, 0, `expected no CCs sent, got ${conn.sentCCs.length}`);

    device.detach();
  });
});
