import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { BrowserWindow } from "electron";
import {
  emitEvent,
  emitEventLogClear,
  EVENT_LOG_CHANNEL,
  EVENT_LOG_CLEAR_CHANNEL,
} from "../../../src/sounds-and-recreation-app/event-log-ipc.js";

interface FakeWin {
  sent: Array<{ channel: string; payload: unknown }>;
  webContents: { send(channel: string, payload?: unknown): void };
}

function fakeWin(): FakeWin {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    webContents: {
      send(channel, payload) { sent.push({ channel, payload }); },
    },
  };
}

// One cast at the call site — fakeWin's shape is structurally compatible
// with the real BrowserWindow for emitEvent's needs.
const asWin = (f: FakeWin) => f as unknown as BrowserWindow;

describe("event-log-ipc", () => {
  it("emitEvent sends to menu:event-log with full payload", () => {
    const win = fakeWin();
    emitEvent(asWin(win), { severity: "warn", source: "setup", text: "skipped tab", ts: 1000 });
    assert.equal(win.sent.length, 1);
    assert.equal(win.sent[0].channel, EVENT_LOG_CHANNEL);
    assert.equal(EVENT_LOG_CHANNEL, "menu:event-log");
    assert.deepEqual(win.sent[0].payload, {
      severity: "warn", source: "setup", text: "skipped tab", ts: 1000,
    });
  });

  it("emitEvent fills ts when omitted (uses Date.now)", () => {
    const win = fakeWin();
    const before = Date.now();
    emitEvent(asWin(win), { severity: "info", text: "hello" });
    const after = Date.now();
    const payload = win.sent[0].payload as { ts: number };
    assert.ok(payload.ts >= before && payload.ts <= after);
  });

  it("emitEvent omits source when not provided", () => {
    const win = fakeWin();
    emitEvent(asWin(win), { severity: "info", text: "hello", ts: 2000 });
    const payload = win.sent[0].payload as { source?: string };
    assert.equal(payload.source, undefined);
  });

  it("emitEvent is a no-op when win is null", () => {
    assert.doesNotThrow(() => emitEvent(null, { severity: "info", text: "hi" }));
  });

  it("emitEventLogClear sends on the clear channel", () => {
    const win = fakeWin();
    emitEventLogClear(asWin(win));
    assert.equal(win.sent.length, 1);
    assert.equal(win.sent[0].channel, EVENT_LOG_CLEAR_CHANNEL);
    assert.equal(EVENT_LOG_CLEAR_CHANNEL, "menu:event-log-clear");
  });
});
