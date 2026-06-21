/**
 * WebSocket-based MidiConnection for CI/testing where real MIDI is
 * unavailable. Sends CC/program/sysex on the in lane (`url`); when an out
 * lane (`outUrl`, #109) is supplied, listens there for `{type:"sysex"}` and
 * fires `onSysEx` (the WS-mode RQ1→DT1 receive path).
 */

import WebSocket from "ws";
import type { MidiConnection } from "../shared/midi-connection.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WsMidiConnection implements MidiConnection {
  private ws: WebSocket;
  private wsOut: WebSocket | null;
  private channel: number;
  private onSysExCallbacks: Array<(bytes: number[]) => void> = [];

  constructor(ws: WebSocket, channel = 0, wsOut: WebSocket | null = null) {
    this.ws = ws;
    this.channel = channel;
    this.wsOut = wsOut;
    if (wsOut) this.wireOutLane(wsOut);
  }

  /** Open a WS and resolve once it's connected (or reject on timeout/error). */
  private static openSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`WsMidiConnection: timeout connecting to ${url}`));
      }, 5000);
      ws.on("open", () => {
        clearTimeout(timeout);
        resolve(ws);
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Subscribe the out-lane socket: every `{type:"sysex"}` message fires the
   * registered `onSysEx` callbacks. The out lane is receive-only — we never
   * send on it, so this connection cannot create a MIDI feedback loop.
   */
  private wireOutLane(wsOut: WebSocket): void {
    // Swallow post-open errors — the out lane is best-effort signalling.
    wsOut.on("error", () => { /* ignore */ });
    wsOut.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg && msg.type === "sysex" && Array.isArray(msg.bytes)) {
          // Trust boundary: drop the message unless every byte is a 0..255 int.
          const bytes: number[] = [];
          let ok = true;
          for (const b of msg.bytes) {
            const n = Number(b);
            if (!Number.isInteger(n) || n < 0 || n > 255) { ok = false; break; }
            bytes.push(n);
          }
          // Iterate a copy so a callback can unsubscribe mid-dispatch.
          if (ok) for (const cb of [...this.onSysExCallbacks]) cb(bytes.slice());
        }
      } catch { /* non-JSON / non-sysex — ignore */ }
    });
  }

  static async connect(url: string, channel = 0, outUrl?: string): Promise<WsMidiConnection> {
    const ws = await WsMidiConnection.openSocket(url);
    let wsOut: WebSocket | null = null;
    if (outUrl) {
      try {
        wsOut = await WsMidiConnection.openSocket(outUrl);
      } catch (err) {
        ws.close();
        throw err;
      }
    }
    return new WsMidiConnection(ws, channel, wsOut);
  }

  sendCC(controller: number, value: number, channel?: number): void {
    this.ws.send(JSON.stringify({
      type: "cc",
      controller,
      value: Math.max(0, Math.min(127, Math.round(value))),
      channel: channel ?? this.channel,
    }));
  }

  sendProgramChange(program: number, channel?: number): void {
    this.ws.send(JSON.stringify({
      type: "program",
      number: program,
      channel: channel ?? this.channel,
    }));
  }

  sendSysEx(bytes: number[]): void {
    this.ws.send(JSON.stringify({
      type: "sysex",
      bytes,
    }));
  }

  sendNRPN(msb: number, lsb: number, value: number, channel?: number): void {
    const ch = channel ?? this.channel;
    this.sendCC(99, msb, ch);
    this.sendCC(98, lsb, ch);
    this.sendCC(6, (value >> 7) & 0x7f, ch);
    this.sendCC(38, value & 0x7f, ch);
  }

  async sendCCBatch(
    messages: Array<{ controller: number; value: number; channel?: number }>,
    delayMs = 5,
  ): Promise<void> {
    for (const msg of messages) {
      this.sendCC(msg.controller, msg.value, msg.channel);
      if (delayMs > 0) await delay(delayMs);
    }
  }

  onCC(_callback: (cc: number, value: number, channel: number) => void): void {
    // No-op: the mock doesn't send CCs back over WS — the out lane carries
    // only the SysEx (RQ1→DT1) response stream.
  }

  /**
   * Register a SysEx listener. Fires for every `{type:"sysex"}` arriving on
   * the out lane. Returns an unsubscribe function. When no out lane was
   * supplied, the callback is held but never invoked (one-way mode).
   */
  onSysEx(callback: (bytes: number[]) => void): () => void {
    this.onSysExCallbacks.push(callback);
    return () => {
      const idx = this.onSysExCallbacks.indexOf(callback);
      if (idx >= 0) this.onSysExCallbacks.splice(idx, 1);
    };
  }

  close(): void {
    this.ws.close();
    this.wsOut?.close();
    this.wsOut = null;
  }
}
