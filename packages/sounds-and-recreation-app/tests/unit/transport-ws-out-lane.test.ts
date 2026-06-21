/**
 * MockTransport WS-mode SysEx receive (#109).
 *
 * In WS-only mode (no virtual MIDI) the transport stands up a second WS
 * server — the "out lane" — dedicated to outgoing-from-mock MIDI. The MCP's
 * WsMidiConnection sends inbound MIDI on lane 1 (wsPort) and listens for the
 * mock's outgoing sysex on lane 2 (wsOutPort).
 *
 * The critical invariant verified here: external MIDI input updates state but
 * is NEVER echoed back out. Only a Roland RQ1 (a request) produces an outgoing
 * DT1 (its response). An inbound CC or DT1-write changes state and stops there —
 * otherwise an echo could feed a MIDI loop on bridges/shadows.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import WebSocket from "ws";
import { MockTransport } from "../../src/transport.js";
import { loadModelById } from "keyboards-mcp/shared/model-registry";
import { buildDT1, buildRQ1, parseDT1, addAddresses } from "keyboards-mcp/shared/roland-dt1";

const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] };
const DEVICE_ID = 0x10;
const SCENE_BASE = [0x01, 0x00, 0x00, 0x00];
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00];
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.close(); reject(new Error(`timeout opening ${url}`)); }, 3000);
    ws.on("open", () => { clearTimeout(t); resolve(ws); });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await delay(20);
  }
}

async function makeTransport(wsPort: number, wsOutPort: number): Promise<MockTransport> {
  const model = await loadModelById("roland-juno-x");
  const handler = model.createMockHandler!();
  const transport = new MockTransport(handler, {
    lowerChannel: 0,
    upperChannel: 1,
    wsPort,
    wsOutPort,
    portName: "Roland JUNO-X Mock",
    noMidi: true,
    noRegistry: true,
  });
  await transport.start();
  return transport;
}

describe("MockTransport WS out lane: RQ1 round-trip + no-echo", { concurrency: 1 }, () => {
  it("answers an inbound RQ1 with a DT1 on the dedicated out lane", async () => {
    const transport = await makeTransport(56120, 56121);
    let laneIn: WebSocket | undefined;
    let laneOut: WebSocket | undefined;
    try {
      laneIn = await openWs("ws://localhost:56120");
      laneOut = await openWs("ws://localhost:56121");
      const out: number[][] = [];
      laneOut.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "sysex") out.push(msg.bytes);
      });
      // Pre-set chorus_switch=ON via a DT1 write on lane 1.
      laneIn.send(JSON.stringify({ type: "sysex", bytes: buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x7F]) }));
      await delay(100);

      // Send an RQ1 for chorus_switch; expect exactly one DT1 on the out lane.
      laneIn.send(JSON.stringify({ type: "sysex", bytes: buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0, 0, 0, 1]) }));
      await waitFor(() => out.length >= 1, 1500);
      await delay(100); // settle — make sure no extra messages arrive

      assert.equal(out.length, 1, "expected exactly one DT1 response on the out lane");
      const dt1 = parseDT1(out[0], JUNO_X_MODEL_ID);
      assert.ok(dt1, "out-lane message must be a valid DT1");
      assert.deepEqual(dt1!.data, [0x7F], "DT1 must carry the value written via the inbound DT1");
    } finally {
      laneIn?.close();
      laneOut?.close();
      await transport.stop();
    }
  });

  it("does not echo inbound CC or DT1 writes to the out lane (no MIDI feedback loop)", async () => {
    const transport = await makeTransport(56122, 56123);
    let laneIn: WebSocket | undefined;
    let laneOut: WebSocket | undefined;
    try {
      laneIn = await openWs("ws://localhost:56122");
      laneOut = await openWs("ws://localhost:56123");
      const out: number[][] = [];
      laneOut.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "sysex") out.push(msg.bytes);
      });
      // A real keyboard sends a CC; the mock must update state and stop —
      // never re-emit it (would feed a loop on a bridge).
      laneIn.send(JSON.stringify({ type: "cc", controller: 74, value: 100, channel: 0 }));
      // A DT1 write also changes state but must not echo.
      laneIn.send(JSON.stringify({ type: "sysex", bytes: buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x7F]) }));
      await delay(250);

      assert.equal(out.length, 0, "inbound CC + DT1-write must NOT echo to the out lane");

      // Prove the DT1 write was actually applied (not silently dropped): an
      // RQ1 reads the value back, and is the ONLY thing that emits on the lane.
      laneIn.send(JSON.stringify({ type: "sysex", bytes: buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0, 0, 0, 1]) }));
      await waitFor(() => out.length >= 1, 1500);
      await delay(100);

      assert.equal(out.length, 1, "only the RQ1 should have produced an out-lane message");
      const dt1 = parseDT1(out[0], JUNO_X_MODEL_ID);
      assert.deepEqual(dt1!.data, [0x7F], "RQ1 readback proves the inbound DT1 write changed state");
    } finally {
      laneIn?.close();
      laneOut?.close();
      await transport.stop();
    }
  });
});
