/**
 * WebSocket-based MidiConnection for CI/testing environments
 * where real MIDI (easymidi/ALSA) is unavailable.
 *
 * Sends CC/program/sysex as JSON over WebSocket to the mock engine,
 * which already handles these message types from WS clients.
 */

import WebSocket from "ws";
import type { MidiConnection } from "../shared/midi-connection.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WsMidiConnection implements MidiConnection {
  private ws: WebSocket;
  private channel: number;

  constructor(ws: WebSocket, channel = 0) {
    this.ws = ws;
    this.channel = channel;
  }

  static async connect(url: string, channel = 0): Promise<WsMidiConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`WsMidiConnection: timeout connecting to ${url}`));
      }, 5000);
      ws.on("open", () => {
        clearTimeout(timeout);
        resolve(new WsMidiConnection(ws, channel));
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
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
    // No-op: mock doesn't send CCs back over WS
  }

  onSysEx(_callback: (bytes: number[]) => void): void {
    // No-op: mock doesn't send SysEx back over WS
  }

  close(): void {
    this.ws.close();
  }
}
