/**
 * Source-aware MIDI routing in MockEngine (#24, updated for #30 stage 4).
 *
 * Stage 4 dropped MockHandlerResult.{ccOut, sysexOut, programOut}. The
 * engine now handles emission directly:
 *
 * - UI-source bare cc/program is echoed to MIDI Out (panel-knob analogue)
 * - External-source MIDI is never echoed (would feedback-loop on bridges)
 * - RQ1 → DT1 is handled in the engine via codec.parseRequest +
 *   handler.read_bytes + codec.buildResponse → emit
 * - UI-source setParam (separate WS path) is encoded via codec and
 *   emitted (tested elsewhere, end-to-end)
 *
 * The engine is tested with `noMidi: true` and a fake `midiOutput`
 * injected via `(engine as any).midiOutput = sink`.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MockEngine } from "../../src/mock-runner/engine.js";
import type { MidiMessage, MockHandler, MockHandlerResult } from "../../src/shared/keyboard-model.js";

interface SentMsg { type: string; data: any }

function makeHandler(canned: MockHandlerResult = {}): MockHandler {
  return {
    init() {},
    onMIDI: () => canned,
    getFullState: () => ({}),
  };
}

function makeEngine(handler: MockHandler): { engine: MockEngine; sent: SentMsg[] } {
  const sent: SentMsg[] = [];
  const sink = { send: (type: string, data: any) => { sent.push({ type, data }); } };
  const engine = new MockEngine(handler, {
    lowerChannel: 0, upperChannel: 1, wsPort: 0,
    portName: "x", noMidi: true, noRegistry: true,
  });
  (engine as any).midiOutput = sink;
  return { engine, sent };
}

describe("MockEngine source-aware MIDI routing", () => {
  it("UI-sourced CC is echoed to MIDI Out", () => {
    const { engine, sent } = makeEngine(makeHandler({}));
    const msg: MidiMessage = { type: "cc", controller: 7, value: 100, channel: 0 };
    (engine as any).dispatch(msg, "ui");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "cc");
    assert.deepEqual(sent[0].data, { controller: 7, value: 100, channel: 0 });
  });

  it("UI-sourced program-change is echoed to MIDI Out", () => {
    const { engine, sent } = makeEngine(makeHandler({}));
    (engine as any).dispatch({ type: "program", number: 3, channel: 1 }, "ui");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "program");
    assert.deepEqual(sent[0].data, { number: 3, channel: 1 });
  });

  it("external-MIDI-sourced CC is NOT echoed (no feedback loop)", () => {
    const { engine, sent } = makeEngine(makeHandler({}));
    (engine as any).dispatch({ type: "cc", controller: 7, value: 100, channel: 0 }, "external");
    assert.equal(sent.length, 0, "external-source CC must not echo back to MIDI Out");
  });

  it("external-MIDI-sourced program-change is NOT echoed", () => {
    const { engine, sent } = makeEngine(makeHandler({}));
    (engine as any).dispatch({ type: "program", number: 3, channel: 0 }, "external");
    assert.equal(sent.length, 0);
  });

  it("UI-sourced sysex is NOT auto-echoed (engine handles emission via codec for setParam)", () => {
    const { engine, sent } = makeEngine(makeHandler({}));
    (engine as any).dispatch({ type: "sysex", bytes: [0xF0, 0x7E, 0xF7] }, "ui");
    assert.equal(sent.length, 0, "UI-source sysex must not auto-echo");
  });

  it("external sysex without codec falls through to handler.onMIDI (no engine RQ1 handling)", () => {
    // Without a codec on the handler, the engine can't recognize RQ1 and
    // simply hands the message to handler.onMIDI for state updates.
    let receivedBytes: number[] | undefined;
    const handler: MockHandler = {
      init() {},
      onMIDI: (msg) => {
        if (msg.type === "sysex") receivedBytes = msg.bytes;
        return {};
      },
      getFullState: () => ({}),
    };
    const { engine, sent } = makeEngine(handler);
    (engine as any).dispatch({ type: "sysex", bytes: [0xF0, 0x42, 0xF7] }, "external");
    assert.deepEqual(receivedBytes, [0xF0, 0x42, 0xF7], "handler.onMIDI must receive the sysex");
    assert.equal(sent.length, 0, "no auto-emission for external sysex");
  });
});
