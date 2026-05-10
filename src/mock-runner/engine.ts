/**
 * Thin mock device engine.
 *
 * Owns only: MIDI virtual port, WebSocket server, broadcasting.
 * All state and logic lives in the MockHandler provided by the model.
 */

import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import type { MockHandler, MidiMessage, MockHandlerResult } from "../shared/keyboard-model.js";
import type { EncodedMessage } from "../shared/midi-codec.js";
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

export class MockEngine extends EventEmitter {
  private handler: MockHandler;
  private opts: EngineOptions;

  private midiInput: any | null = null;
  // The device's MIDI Out socket — apps listen FROM this port to receive
  // outgoing MIDI emitted by the mock. Constructed via `easymidi.Output`.
  // Task 4 wires JUNO-X RQ1 responses through here via MockHandlerResult.sysexOut.
  private midiOutput: any | null = null;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private mcpClients = new Set<WebSocket>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Actual OS-assigned MIDI port name (Core MIDI suffixes duplicates). */
  private actualPortName: string;

  constructor(handler: MockHandler, opts: EngineOptions) {
    super();
    this.handler = handler;
    this.opts = opts;
    this.actualPortName = opts.portName;
  }

  /** Identity tag for log lines: `[portName:label]`. */
  private tag(): string {
    return `[${this.actualPortName}:${this.opts.label ?? "_default"}]`;
  }

  /** Compact one-line summary of a sysex packet — head + tail bytes. */
  private static summarizeSysex(bytes: number[]): string {
    const head = bytes.slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const tail = bytes.length > 5 ? ` .. ${bytes[bytes.length - 1].toString(16).padStart(2, "0")}` : "";
    return `sysex ${bytes.length} bytes [${head}${tail}]`;
  }

  async start(): Promise<void> {
    // Init handler with channel config and per-instance backup label
    this.handler.init(this.opts.lowerChannel, this.opts.upperChannel, this.opts.label);

    // Create virtual MIDI port (skip in WS-only mode for CI/Docker)
    if (!this.opts.noMidi) {
      const easymidi = await import("easymidi");
      const before = new Set<string>(easymidi.default.getOutputs());
      this.midiInput = new easymidi.default.Input(this.opts.portName, true);
      // Capture the OS-assigned name. Core MIDI suffixes duplicates
      // ("Foo" then "Foo1") so two same-model mocks have distinct names.
      const after = easymidi.default.getOutputs();
      const newOnes = after.filter((p: string) => !before.has(p));
      if (newOnes.length === 1) this.actualPortName = newOnes[0];

      // Virtual MIDI Out port (the device's MIDI Out socket — apps listen
      // FROM it). Same OS port name as the Input — Core MIDI distinguishes
      // by direction. easymidi `Output` = OS-level MIDI source.
      this.midiOutput = new easymidi.default.Output(this.actualPortName, true);
    }

    // Bare HTTP server for WebSocket
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "/", `http://localhost:${this.opts.wsPort}`);
      const isMcp = url.searchParams.get("client") === "mcp";

      if (isMcp) {
        this.mcpClients.add(ws);
        console.log(`${this.tag()} MCP server connected via WebSocket`);
        this.broadcastMcpStatus();
        ws.on("close", () => {
          this.mcpClients.delete(ws);
          console.log(`${this.tag()} MCP server disconnected`);
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
              console.log(`${this.tag()} WS-IN reload-cache`);
              this.handler.onCacheReload?.();
              this.broadcast(this.handler.getFullState(true));
            } else if (msg.type === "cc") {
              console.log(`${this.tag()} WS-IN cc CC=${msg.controller} val=${msg.value} ch=${msg.channel ?? 0}`);
              this.dispatch({ type: "cc", controller: msg.controller, value: msg.value, channel: msg.channel ?? 0 }, "ui");
            } else if (msg.type === "program") {
              console.log(`${this.tag()} WS-IN program n=${msg.number} ch=${msg.channel ?? 0}`);
              this.dispatch({ type: "program", number: msg.number, channel: msg.channel ?? 0 }, "ui");
            } else if (msg.type === "sysex") {
              console.log(`${this.tag()} WS-IN ${MockEngine.summarizeSysex(msg.bytes ?? [])}`);
              this.dispatch({ type: "sysex", bytes: msg.bytes }, "ui");
            } else if (msg.type === "param") {
              console.log(`${this.tag()} WS-IN param ${msg.name}=${msg.value} ch=${msg.channel ?? 0}`);
              // Legacy alias for setParam — kept for backward compat with UIs
              // that haven't migrated. New code should send {type:"setParam"}.
              const result = this.handler.onUIParam
                ? this.handler.onUIParam(msg.name, msg.value, msg.channel ?? 0)
                : { log: `UI: ${msg.name} = ${msg.value} (handler has no onUIParam)` };
              this.applyHandlerResult(result, null);
            } else if (msg.type === "setParam") {
              // Default `part` to 1 once at the boundary so set_params,
              // codec.encodeParams, and the log line all see the same value.
              const part = msg.part ?? 1;
              console.log(`${this.tag()} WS-IN setParam ${msg.name}=${msg.value} part=${part}`);
              // Stage 4: engine handles emission via codec, not the handler.
              // 1. handler.set_params updates state (no emission channel).
              // 2. engine asks codec to encode and writes to MIDI Out
              //    (panel-knob analogue — UI is a closed-loop source).
              const result = this.handler.set_params
                ? this.handler.set_params([{ name: msg.name, value: msg.value, part }])
                : (this.handler.onUIParam
                    ? this.handler.onUIParam(msg.name, msg.value, part - 1)
                    : { log: `UI: ${msg.name} = ${msg.value} (handler has no set_params or onUIParam)` });
              if (result.state) this.broadcast(result.state);
              if (result.log) console.log(`${this.tag()} ${result.log}`);
              const codec = this.handler.codec;
              if (codec) {
                try {
                  const encoded = codec.encodeParams([{ name: msg.name, value: msg.value, part }]);
                  for (const enc of encoded) this.emitOne(enc);
                } catch (err) {
                  console.error(`${this.tag()} setParam emit failed:`, err);
                }
              }
            }
          } catch { /* ignore */ }
        });
        ws.on("close", () => this.clients.delete(ws));
      }
    });

    // MIDI listeners — all input goes through the handler. Source is
    // "external": handler updates state but the engine MUST NOT echo the
    // inbound message back out (would feedback-loop on bridges/shadows).
    if (this.midiInput) {
      this.midiInput.on("cc", (msg: { controller: number; value: number; channel: number }) => {
        console.log(`${this.tag()} MIDI-IN cc CC=${msg.controller} val=${msg.value} ch=${msg.channel}`);
        this.dispatch({ type: "cc", controller: msg.controller, value: msg.value, channel: msg.channel }, "external");
      });

      this.midiInput.on("program", (msg: { number: number; channel: number }) => {
        console.log(`${this.tag()} MIDI-IN program n=${msg.number} ch=${msg.channel}`);
        this.dispatch({ type: "program", number: msg.number, channel: msg.channel }, "external");
      });

      this.midiInput.on("sysex" as any, (msg: { bytes: number[] }) => {
        console.log(`${this.tag()} MIDI-IN ${MockEngine.summarizeSysex([...msg.bytes])}`);
        this.dispatch({ type: "sysex", bytes: [...msg.bytes] }, "external");
      });
    }

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(this.opts.wsPort, () => {
        console.log(`${this.tag()} Mock device ready`);
        if (this.opts.noMidi) {
          console.log(`${this.tag()}   MIDI: disabled (WS-only mode)`);
        } else {
          console.log(`${this.tag()}   MIDI port: "${this.actualPortName}" (virtual)`);
        }
        console.log(`${this.tag()}   Lower channel: ${this.opts.lowerChannel}, Upper channel: ${this.opts.upperChannel}`);
        console.log(`${this.tag()}   WebSocket: ws://localhost:${this.opts.wsPort}`);
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
      midiPort:    this.actualPortName,
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
      registry.touch(this.opts.wsPort);
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
    if (!this.opts.noRegistry) registry.relabel(this.opts.wsPort, label);
    this.broadcast(this.handler.getFullState(true));
  }

  /** Snapshot of the handler's current state. Used by Save (plan #9). */
  getFullState(includeInventory: boolean): Record<string, any> {
    return this.handler.getFullState(includeInventory);
  }

  /**
   * Restore the handler's internal state from a snapshot (plan #9).
   * Returns false when the snapshot is missing or the handler doesn't
   * implement `setFullState` (graceful-degradation path — caller logs).
   *
   * On success, broadcasts a single fresh full-state snapshot so UI
   * clients (and the MCP status WS) see one consistent transition.
   */
  restoreSnapshot(snapshot: Record<string, any> | null): boolean {
    if (!snapshot) return false;
    if (!this.handler.setFullState) return false;
    try { this.handler.setFullState(snapshot); }
    catch (err) { console.error("setFullState failed:", err); return false; }
    this.broadcast(this.handler.getFullState(true));
    return true;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.opts.noRegistry) registry.unregister(this.opts.wsPort);
    if (this.midiInput) {
      this.midiInput.close();
      this.midiInput = null;
    }
    if (this.midiOutput) {
      this.midiOutput.close?.();
      this.midiOutput = null;
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

  /**
   * Dispatch a `MidiMessage` (synthesized from a UI WS command, or read
   * from the virtual MIDI In) through the right path:
   *
   * - **External-source SysEx that's a Roland RQ1 request** is handled
   *   entirely in the engine: codec.parseRequest → handler.read_bytes →
   *   codec.buildResponse → emit. The handler doesn't see the request.
   * - Everything else goes to `handler.onMIDI(msg)` for state updates.
   *   For UI-source `cc` / `program`, the engine also echoes the inbound
   *   message to the device's MIDI Out (panel-knob analogue). External
   *   inbound is never echoed — would feedback-loop on bridges.
   */
  private dispatch(msg: MidiMessage, source: "ui" | "external"): void {
    // Stage 4: engine handles RQ1 directly via codec — no handler involvement.
    if (source === "external" && msg.type === "sysex" && this.handler.codec) {
      const codec = this.handler.codec;
      const req = codec.parseRequest({ type: "sysex", bytes: msg.bytes });
      if (req && this.handler.read_bytes) {
        const data = this.handler.read_bytes(req.address, req.size);
        const reply = codec.buildResponse(req, data);
        if (reply.type === "sysex") {
          console.log(`${this.tag()} RQ1 → DT1 ${MockEngine.summarizeSysex(reply.bytes)} (engine-handled)`);
          this.emitOne(reply);
        }
        return;
      }
    }

    const result = this.handler.onMIDI(msg);
    this.applyHandlerResult(result, source === "ui" ? msg : null);
  }

  /**
   * Apply a `MockHandlerResult`: broadcast state, log, and emit any
   * UI-source bare cc/program echo (panel-knob analogue).
   */
  private applyHandlerResult(result: MockHandlerResult, uiSource: MidiMessage | null): void {
    if (result.state) this.broadcast(result.state);
    if (result.log) console.log(`${this.tag()} ${result.log}`);
    this.emitUiEcho(uiSource);
  }

  /** Echo a UI-source bare cc/program out on MIDI Out (panel-knob analogue). */
  private emitUiEcho(uiSource: MidiMessage | null): void {
    if (!uiSource || !this.midiOutput) return;
    try {
      if (uiSource.type === "cc") {
        console.log(`${this.tag()} MIDI-OUT (ui-echo) cc CC=${uiSource.controller} val=${uiSource.value} ch=${uiSource.channel}`);
        this.midiOutput.send("cc", { controller: uiSource.controller, value: uiSource.value, channel: uiSource.channel });
      } else if (uiSource.type === "program") {
        console.log(`${this.tag()} MIDI-OUT (ui-echo) program n=${uiSource.number} ch=${uiSource.channel}`);
        this.midiOutput.send("program", { number: uiSource.number, channel: uiSource.channel });
      }
    } catch (err) { console.error(`${this.tag()} MIDI-OUT (ui-echo) send failed:`, err); }
  }

  /**
   * Send one codec-encoded message to the virtual MIDI Out.
   *
   * The codec contract is "undefined channel → use the connection's
   * configured default." On the mock side that maps to `lowerChannel`
   * from `init` — the same channel global params receive on inbound.
   * easymidi.Output has no default-channel facility, so the engine
   * resolves the default before calling `send`.
   */
  private emitOne(msg: EncodedMessage): void {
    if (!this.midiOutput) return;
    const defaultChannel = this.opts.lowerChannel;
    try {
      if (msg.type === "cc") {
        const channel = msg.channel ?? defaultChannel;
        console.log(`${this.tag()} MIDI-OUT cc CC=${msg.controller} val=${msg.value} ch=${channel}`);
        this.midiOutput.send("cc", { controller: msg.controller, value: msg.value, channel });
      } else if (msg.type === "program") {
        const channel = msg.channel ?? defaultChannel;
        console.log(`${this.tag()} MIDI-OUT program n=${msg.number} ch=${channel}`);
        this.midiOutput.send("program", { number: msg.number, channel });
      } else if (msg.type === "sysex") {
        console.log(`${this.tag()} MIDI-OUT ${MockEngine.summarizeSysex(msg.bytes)}`);
        this.midiOutput.send("sysex", msg.bytes);
      }
    } catch (err) { console.error(`${this.tag()} MIDI-OUT send failed:`, err); }
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
    // Plan #9: signal main-process listeners that something changed,
    // so they can flip the dirty flag without subscribing to WS messages.
    this.emit("state-changed");
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
