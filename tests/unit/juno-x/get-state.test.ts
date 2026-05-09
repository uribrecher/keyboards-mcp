import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import junoModel from "../../../src/keyboard_models/roland/juno_x/index.js";
import type { MidiConnection } from "../../../src/shared/midi-connection.js";
import { buildDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };
const SCENE_BASE = [0x01, 0x00, 0x00, 0x00];
const DEVICE_ID = 0x10;

interface FakeConn extends MidiConnection {
  /** Fire a sysex into all currently-registered listeners. */
  _fireSysEx(bytes: number[]): void;
  /** Every sysex this connection has been asked to send (in order). */
  readonly _sent: number[][];
}

function makeFakeConn(): FakeConn {
  const listeners: Array<(bytes: number[]) => void> = [];
  const sent: number[][] = [];
  return {
    sendCC() {}, sendProgramChange() {}, sendNRPN() {},
    async sendCCBatch() {}, onCC() {},
    sendSysEx(bytes: number[]) { sent.push([...bytes]); },
    onSysEx(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    _fireSysEx(bytes: number[]) { for (const cb of [...listeners]) cb([...bytes]); },
    get _sent() { return sent; },
  } as FakeConn;
}

describe("JUNO-X get_current_state via RQ1", () => {
  it("returns 'not supported for this section' for unsupported sections", async () => {
    const device = junoModel.createDevice!();
    const conn = makeFakeConn();
    device.attach(conn);

    const result = await Promise.resolve(device.getState("scene-modify"));
    assert.match(result.content[0].text, /not (yet )?supported.*scene-modify/i);
  });

  it("issues an RQ1 per scene-chorus param and decodes the responses", async () => {
    const device = junoModel.createDevice!();
    const conn = makeFakeConn();
    device.attach(conn);

    // The scene-chorus section has 3 params: chorus_type @ 01:50:00:01,
    // chorus_switch @ 01:50:00:00, chorus_level @ 01:50:00:02.
    //
    // JUNO-X discrete params are encoded via `discreteToMidi(idx, max)` —
    // a SCALED encoding that maps idx 0..max → bytes 0..127 (this is the
    // round-trip the MCP sends and reads back). So "ON" (idx 1, max 1) is
    // wire byte 127, "JUNO Chorus" (idx 9, max 9) is wire byte 127.
    // Continuous params like chorus_level use raw 0..127.
    setTimeout(() => {
      const switchAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
      const typeAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x01]);
      const levelAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x02]);
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, switchAddr, [0x7F]));
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, typeAddr, [0x7F]));
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, levelAddr, [0x40]));
    }, 5);

    const result = await Promise.resolve(device.getState("scene-chorus"));
    const text = result.content[0].text;
    assert.match(text, /Chorus Switch.*ON/i);
    assert.match(text, /Chorus Type.*JUNO Chorus/);
    assert.match(text, /Chorus Level.*64/);

    // Sanity: three RQ1s went out — one per param.
    assert.equal(conn._sent.length, 3, `expected 3 RQ1s, got ${conn._sent.length}`);
  });

  it("surfaces a per-param timeout without blocking the rest of the section", async () => {
    const device = junoModel.createDevice!();
    const conn = makeFakeConn();
    device.attach(conn);

    // Fire only chorus_switch — the other two will time out.
    setTimeout(() => {
      const switchAddr = addAddresses(SCENE_BASE, [0x00, 0x50, 0x00, 0x00]);
      conn._fireSysEx(buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, switchAddr, [0x7F]));
    }, 5);

    const result = await Promise.resolve(device.getState("scene-chorus"));
    const text = result.content[0].text;
    assert.match(text, /Chorus Switch.*ON/i, "the responsive param resolves");
    assert.match(text, /timeout/i, "non-responsive params surface a timeout in the result text");
  });
});
