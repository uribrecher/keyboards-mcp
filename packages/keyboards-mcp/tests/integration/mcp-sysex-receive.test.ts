/**
 * Integration test for the MCP-side sysex receive path (#22).
 *
 * Spawns a JUNO-X mock locally, connects a MidiManager to its virtual
 * MIDI port pair (the device's MIDI In socket via easymidi.Output, and
 * the device's MIDI Out socket via easymidi.Input), sends an RQ1 via
 * `requestRolandValue`, asserts the resolved DT1 carries the expected bytes.
 *
 * Skipped in WS-only Docker mode (MOCK_WS_URL set) — real-MIDI receive is
 * what's being tested. WS-mode receive is deferred to todo #25.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MidiManager, initMidiBackend } from "../../src/midi/midi-manager.js";
import { MockProcess } from "../helpers/mock-process.js";
import {
  requestRolandValue,
  buildDT1,
  addAddresses,
} from "../../src/shared/roland-dt1.js";
import { readActive } from "../../src/shared/mock-registry.js";

const IS_DOCKER_WS_MODE = !!process.env.MOCK_WS_URL;
const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };
const SCENE_BASE = [0x01, 0x00, 0x00, 0x00];
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00];
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

let nextPort = 5610;

/** Poll the mock-registry until an entry for `wsPort` appears, up to deadline. */
async function waitForRegistryEntry(wsPort: number, deadlineMs = 2000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const entry = readActive().find((e) => e.wsPort === wsPort);
    if (entry) return entry.midiPort;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`mock at wsPort ${wsPort} did not register within ${deadlineMs}ms`);
}

describe("MCP sysex receive: RQ1 round-trip via real MIDI", { concurrency: 1, skip: IS_DOCKER_WS_MODE }, () => {
  it("sends RQ1, receives DT1 with the stored value", async () => {
    // easymidi is lazily loaded — initialize before opening any MIDI ports.
    await initMidiBackend();

    const mock = await MockProcess.start({ model: "roland-juno-x", wsPort: nextPort++ });
    try {
      // Mock has already received initial state via waitForState in start();
      // poll the registry for the actual OS port name (Core MIDI suffixes
      // duplicates).
      const portName = await waitForRegistryEntry(mock.wsPort);

      const midi = new MidiManager();
      midi.connect(portName);
      midi.connectInput(portName);

      // Pre-set chorus_switch=ON via DT1 so we have something non-default
      // to read. The wire byte 0x7F is the canonical "ON" for this max=1
      // discrete (stage-5 user-domain storage means only canonical wire
      // bytes round-trip exactly through the mock).
      const setMsg = buildDT1(JUNO_X_MODEL_ID, 0x10, CHORUS_SWITCH_ADDR, [0x7F]);
      midi.sendSysEx(setMsg);

      const data = await requestRolandValue(midi, JUNO_X_MODEL_ID, 0x10, CHORUS_SWITCH_ADDR, 1, 1000);
      assert.deepStrictEqual(data, [0x7F], "expected chorus_switch=ON (wire 0x7F) from RQ1 round-trip");

      midi.disconnect();
    } finally {
      await mock.stop();
    }
  });

  // Timeout behavior is covered by the unit test in
  // tests/unit/shared/roland-dt1.test.ts using a fake MidiConnection.
});
