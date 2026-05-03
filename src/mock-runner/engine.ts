/**
 * Thin mock device engine.
 *
 * Owns only: MIDI virtual port, WebSocket server, broadcasting.
 * All state and logic lives in the MockHandler provided by the model.
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { MockHandler, MidiMessage } from "../shared/keyboard-model.js";
import * as registry from "../shared/mock-registry.js";

const HEARTBEAT_MS = 30_000;

export interface EngineOptions {
  lowerChannel: number;
  upperChannel: number;
  wsPort: number;
  portName: string;
  /** Model id for the runtime registry (e.g. "nord-electro-5d"). */
  modelId?: string;
  /** Display name for the runtime registry. */
  displayName?: string;
  /** Per-instance backup label this mock should load. Defaults to `_default`. */
  label?: string;
  /** Skip creating a virtual MIDI port — WS-only mode for CI/Docker */
  noMidi?: boolean;
  /** Skip writing to the runtime registry — used by tests. */
  noRegistry?: boolean;
}

export class MockEngine {
  private handler: MockHandler;
  private opts: EngineOptions;

  private midiInput: any | null = null;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private mcpClients = new Set<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(handler: MockHandler, opts: EngineOptions) {
    this.handler = handler;
    this.opts = opts;
  }

  async start(): Promise<void> {
    // Init handler with channel config and per-instance backup label
    this.handler.init(this.opts.lowerChannel, this.opts.upperChannel, this.opts.label);

    // Create virtual MIDI port (skip in WS-only mode for CI/Docker)
    if (!this.opts.noMidi) {
      const easymidi = await import("easymidi");
      this.midiInput = new easymidi.default.Input(this.opts.portName, true);
    }

    // Bare HTTP server for WebSocket
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/", `http://localhost:${this.opts.wsPort}`);
      const isMcp = url.searchParams.get("client") === "mcp";

      if (isMcp) {
        this.mcpClients.add(ws);
        console.log("MCP server connected via WebSocket");
        this.broadcastMcpStatus();
        ws.on("close", () => {
          this.mcpClients.delete(ws);
          console.log("MCP server disconnected");
          this.broadcastMcpStatus();
        });
      } else {
        this.clients.add(ws);
        // Send full state to newly connected UI client (and MCP status WS).
        ws.send(JSON.stringify({
          ...this.handler.getFullState(true),
          mcpConnected: this.isMcpConnected(),
          label: this.opts.label ?? "_default",
        }));
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === "reload-cache") {
              this.handler.onCacheReload?.();
              this.broadcast(this.handler.getFullState(true));
            } else if (msg.type === "cc") {
              // UI control → route through handler like a MIDI CC
              this.onMIDI({ type: "cc", controller: msg.controller, value: msg.value, channel: msg.channel ?? 0 });
            } else if (msg.type === "program") {
              this.onMIDI({ type: "program", number: msg.number, channel: msg.channel ?? 0 });
            } else if (msg.type === "sysex") {
              this.onMIDI({ type: "sysex", bytes: msg.bytes });
            } else if (msg.type === "param") {
              // UI named parameter (for SysEx-addressed params without CCs)
              console.log(`UI: ${msg.name} = ${msg.value}`);
            }
          } catch { /* ignore */ }
        });
        ws.on("close", () => this.clients.delete(ws));
      }
    });

    // MIDI listeners — all input goes through the handler
    if (this.midiInput) {
      this.midiInput.on("cc", (msg: { controller: number; value: number; channel: number }) => {
        this.onMIDI({ type: "cc", controller: msg.controller, value: msg.value, channel: msg.channel });
      });

      this.midiInput.on("program", (msg: { number: number; channel: number }) => {
        this.onMIDI({ type: "program", number: msg.number, channel: msg.channel });
      });

      this.midiInput.on("sysex" as any, (msg: { bytes: number[] }) => {
        this.onMIDI({ type: "sysex", bytes: [...msg.bytes] });
      });
    }

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(this.opts.wsPort, () => {
        console.log(`Mock device ready`);
        if (this.opts.noMidi) {
          console.log(`  MIDI: disabled (WS-only mode)`);
        } else {
          console.log(`  MIDI port: "${this.opts.portName}" (virtual)`);
        }
        console.log(`  Lower channel: ${this.opts.lowerChannel}, Upper channel: ${this.opts.upperChannel}`);
        console.log(`  WebSocket: ws://localhost:${this.opts.wsPort}`);
        this.publishToRegistry();
        resolve();
      });
    });
  }

  /**
   * Publish (or refresh) this engine's entry in the runtime mock registry.
   * Heartbeat timer keeps `lastTouched` fresh so consumers (`list_midi_devices`)
   * can drop stale entries left by killed processes.
   */
  private publishToRegistry(): void {
    if (this.opts.noRegistry || !this.opts.modelId) return;
    const now = new Date().toISOString();
    registry.register({
      midiPort:    this.opts.portName,
      wsPort:      this.opts.wsPort,
      modelId:     this.opts.modelId,
      displayName: this.opts.displayName ?? this.opts.modelId,
      label:       this.opts.label ?? "_default",
      pid:         process.pid,
      startedAt:   now,
      lastTouched: now,
    });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      registry.touch(this.opts.portName);
    }, HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Tell the handler to re-read its on-disk caches (e.g. after `extract_backup`)
   * and broadcast a fresh full-state snapshot to UI clients.
   */
  reloadCache(): void {
    this.handler.onCacheReload?.();
    this.broadcast(this.handler.getFullState(true));
  }

  /**
   * Re-init the handler under a new per-instance backup label without
   * tearing down the WebSocket or virtual MIDI port. The new label's
   * cache (if any) is loaded immediately.
   */
  relabel(label: string, lowerChannel: number, upperChannel: number): void {
    this.opts.label = label;
    this.handler.init(lowerChannel, upperChannel, label);
    if (!this.opts.noRegistry) registry.relabel(this.opts.portName, label);
    this.broadcast(this.handler.getFullState(true));
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.opts.noRegistry) registry.unregister(this.opts.portName);
    if (this.midiInput) {
      this.midiInput.close();
      this.midiInput = null;
    }
    for (const ws of this.clients) ws.terminate();
    for (const ws of this.mcpClients) ws.terminate();
    this.clients.clear();
    this.mcpClients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  // ── Private ──

  private onMIDI(msg: MidiMessage): void {
    const result = this.handler.onMIDI(msg);
    if (result.state) this.broadcast(result.state);
    if (result.log) console.log(`MIDI: ${result.log}`);
  }

  private broadcast(msg: Record<string, any>): void {
    // Stamp every broadcast with mcpConnected (UI status indicator) and
    // the engine's current label (consumed by MCP-side label discovery).
    const json = JSON.stringify({
      ...msg,
      mcpConnected: this.isMcpConnected(),
      label: this.opts.label ?? "_default",
    });
    // UI clients get the full state; MCP-status clients also need to see
    // label changes so they can update the pool entry's device.label live.
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
    const labelOnly = JSON.stringify({
      mcpConnected: this.isMcpConnected(),
      label: this.opts.label ?? "_default",
    });
    for (const ws of this.mcpClients) {
      if (ws.readyState === ws.OPEN) ws.send(labelOnly);
    }
  }

  private broadcastMcpStatus(): void {
    const json = JSON.stringify({
      mcpConnected: this.isMcpConnected(),
      label: this.opts.label ?? "_default",
    });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
    for (const ws of this.mcpClients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  }

  private isMcpConnected(): boolean {
    return this.mcpClients.size > 0;
  }
}
