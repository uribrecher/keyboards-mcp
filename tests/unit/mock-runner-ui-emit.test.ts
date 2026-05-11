/**
 * MockTransport external-MIDI dispatch (#30 stage 5).
 *
 * Stage 5 dropped UI-source dispatch and handler.onMIDI entirely. The
 * transport now only routes EXTERNAL MIDI through codec → handler. UI
 * inputs all flow through `{type:"setParam"}` over WS (tested elsewhere).
 *
 * External MIDI is never echoed back to MIDI Out (would feedback-loop
 * on shadow bridges). Without a codec on the handler the dispatch is a
 * silent no-op.
 *
 * The transport is tested with `noMidi: true` and a fake `midiOutput`
 * injected via `(transport as any).midiOutput = sink`.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { MockTransport } from "../../src/mock-runner/transport.js";
import type { MidiMessage, MockHandler } from "../../src/shared/keyboard-model.js";

interface SentMsg { type: string; data: any }

function makeHandler(): MockHandler {
  return {
    init() {},
    getFullState: () => ({}),
  };
}

function makeTransport(handler: MockHandler): { transport: MockTransport; sent: SentMsg[] } {
  const sent: SentMsg[] = [];
  const sink = { send: (type: string, data: any) => { sent.push({ type, data }); } };
  const transport = new MockTransport(handler, {
    lowerChannel: 0, upperChannel: 1, wsPort: 0,
    portName: "x", noMidi: true, noRegistry: true,
  });
  (transport as any).midiOutput = sink;
  return { transport, sent };
}

describe("MockTransport external-MIDI dispatch", () => {
  it("external CC is NOT echoed (no feedback loop on bridges)", () => {
    const { transport, sent } = makeTransport(makeHandler());
    (transport as any).dispatch({ type: "cc", controller: 7, value: 100, channel: 0 } as MidiMessage);
    assert.equal(sent.length, 0, "external-source CC must not echo back to MIDI Out");
  });

  it("external program-change is NOT echoed", () => {
    const { transport, sent } = makeTransport(makeHandler());
    (transport as any).dispatch({ type: "program", number: 3, channel: 0 } as MidiMessage);
    assert.equal(sent.length, 0);
  });

  it("external sysex without a codec on the handler is silently ignored", () => {
    const { transport, sent } = makeTransport(makeHandler());
    (transport as any).dispatch({ type: "sysex", bytes: [0xF0, 0x42, 0xF7] } as MidiMessage);
    assert.equal(sent.length, 0, "no codec → nothing to do, no emission");
  });
});
