/**
 * Source-aware MIDI routing in MockEngine (#24).
 *
 * The engine fans out handler-explicit emissions (`sysexOut`, `ccOut`,
 * `programOut`) to the device's virtual MIDI Out regardless of source.
 * UI-source bare `cc`/`program` messages are echoed (panel-knob analogue);
 * external-MIDI-source messages are NOT echoed (would feedback-loop on
 * bridges).
 *
 * The engine is tested with `noMidi: true` (no real virtual port) and a
 * fake `midiOutput` injected via `(engine as any).midiOutput = sink`.
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

describe("MockEngine source-aware MIDI routing (#24)", () => {
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

  it("handler-explicit ccOut is emitted regardless of source", () => {
    const handler = makeHandler({ ccOut: [{ controller: 91, value: 64, channel: 2 }] });
    const { engine, sent } = makeEngine(handler);
    (engine as any).dispatch({ type: "cc", controller: 1, value: 1, channel: 0 }, "external");
    const ccs = sent.filter(s => s.type === "cc");
    assert.equal(ccs.length, 1, "handler ccOut must be emitted even on external source");
    assert.deepEqual(ccs[0].data, { controller: 91, value: 64, channel: 2 });
  });

  it("handler-explicit sysexOut is emitted regardless of source (RQ1→DT1 path)", () => {
    const dt1 = [0xF0, 0x41, 0x10, 0x00, 0x00, 0x00, 0x00, 0x12, 0x12, 0x01, 0x50, 0x00, 0x00, 0x01, 0x2E, 0xF7];
    const handler = makeHandler({ sysexOut: [dt1] });
    const { engine, sent } = makeEngine(handler);
    (engine as any).dispatch({ type: "sysex", bytes: [0xF0, 0xF7] }, "external");
    const sx = sent.filter(s => s.type === "sysex");
    assert.equal(sx.length, 1);
    assert.deepEqual(sx[0].data, dt1);
  });

  it("handler-explicit programOut is emitted regardless of source", () => {
    const handler = makeHandler({ programOut: [{ number: 5, channel: 0 }] });
    const { engine, sent } = makeEngine(handler);
    (engine as any).dispatch({ type: "cc", controller: 1, value: 1, channel: 0 }, "external");
    const pcs = sent.filter(s => s.type === "program");
    assert.equal(pcs.length, 1);
    assert.deepEqual(pcs[0].data, { number: 5, channel: 0 });
  });

  it("UI-sourced sysex is NOT auto-echoed (handler controls re-emission via sysexOut)", () => {
    const { engine, sent } = makeEngine(makeHandler({}));
    (engine as any).dispatch({ type: "sysex", bytes: [0xF0, 0x7E, 0xF7] }, "ui");
    assert.equal(sent.length, 0, "UI-source sysex must not auto-echo — handler decides via sysexOut");
  });
});
