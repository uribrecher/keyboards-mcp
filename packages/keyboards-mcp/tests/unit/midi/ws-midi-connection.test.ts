/**
 * WsMidiConnection two-lane behavior (#109).
 *
 * In WS-only mode the connection SENDS inbound MIDI on lane 1 (the mock's
 * wsPort) and LISTENS for the mock's outgoing SysEx on lane 2 (wsOutPort).
 * `onSysEx` fires for every `{type:"sysex"}` arriving on the out lane and
 * returns an unsubscribe function; `close()` tears down both sockets.
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { WebSocketServer, type WebSocket } from "ws";
import { WsMidiConnection } from "../../../src/midi/ws-midi-connection.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

interface FakeServer {
  wss: WebSocketServer;
  clients: Set<WebSocket>;
  received: any[];
  broadcast: (obj: unknown) => void;
  close: () => Promise<void>;
}

function makeServer(port: number): FakeServer {
  const wss = new WebSocketServer({ port });
  const clients = new Set<WebSocket>();
  const received: any[] = [];
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("message", (raw) => { try { received.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.on("close", () => clients.delete(ws));
  });
  return {
    wss,
    clients,
    received,
    broadcast: (obj) => { const j = JSON.stringify(obj); for (const c of clients) c.send(j); },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

describe("WsMidiConnection: in lane sends, out lane receives SysEx", { concurrency: 1 }, () => {
  let laneIn: FakeServer;
  let laneOut: FakeServer;

  before(async () => {
    laneIn = makeServer(56230);
    laneOut = makeServer(56231);
    await delay(50); // let both servers bind
  });

  after(async () => {
    await laneIn.close();
    await laneOut.close();
  });

  it("sends SysEx on the in lane, fires onSysEx for SysEx on the out lane", async () => {
    const conn = await WsMidiConnection.connect("ws://localhost:56230", 0, "ws://localhost:56231");
    const got: number[][] = [];
    const unsubscribe = conn.onSysEx((bytes) => got.push(bytes));
    assert.equal(typeof unsubscribe, "function", "onSysEx must return an unsubscribe function");
    try {
      // Inbound: sendSysEx must reach the in-lane server.
      await waitFor(() => laneIn.clients.size > 0, 1000);
      conn.sendSysEx([0xf0, 0x41, 0x10, 0xf7]);
      await waitFor(() => laneIn.received.some((m) => m.type === "sysex"), 1000);
      const inMsg = laneIn.received.find((m) => m.type === "sysex");
      assert.deepEqual(inMsg.bytes, [0xf0, 0x41, 0x10, 0xf7], "in-lane server must receive the sent SysEx");

      // Outbound: a SysEx broadcast on the out lane fires onSysEx.
      await waitFor(() => laneOut.clients.size > 0, 1000);
      laneOut.broadcast({ type: "sysex", bytes: [0xf0, 0x12, 0x34, 0xf7] });
      await waitFor(() => got.length >= 1, 1000);
      assert.deepEqual(got[0], [0xf0, 0x12, 0x34, 0xf7], "onSysEx must fire with the out-lane bytes");

      // Non-sysex traffic on the out lane is ignored.
      laneOut.broadcast({ type: "state", foo: 1 });
      await delay(100);
      assert.equal(got.length, 1, "onSysEx must not fire for non-sysex out-lane messages");

      // SysEx with non-integer / out-of-range bytes is dropped at the boundary.
      laneOut.broadcast({ type: "sysex", bytes: [0xf0, "x", 999, 0xf7] });
      await delay(100);
      assert.equal(got.length, 1, "onSysEx must drop sysex with invalid bytes");

      // Unsubscribe stops further callbacks.
      unsubscribe();
      laneOut.broadcast({ type: "sysex", bytes: [0xf0, 0x55, 0xf7] });
      await delay(100);
      assert.equal(got.length, 1, "unsubscribe must stop further onSysEx callbacks");
    } finally {
      conn.close();
    }
  });

  it("tolerates a missing out lane (onSysEx simply never fires)", async () => {
    const conn = await WsMidiConnection.connect("ws://localhost:56230", 0);
    try {
      const got: number[][] = [];
      const unsubscribe = conn.onSysEx((bytes) => got.push(bytes));
      conn.sendSysEx([0xf0, 0x00, 0xf7]);
      await delay(100);
      assert.equal(got.length, 0, "no out lane → onSysEx never fires");
      unsubscribe();
    } finally {
      conn.close();
    }
  });
});
