/**
 * Generic mock device engine.
 *
 * Manages MIDI port creation, channel state, WebSocket broadcasting,
 * and delegates model-specific behavior to a MockHandler.
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import easymidi from "easymidi";
import type { KeyboardModel, MockHandler, MockContext } from "../shared/keyboard-model.js";
import type { KeyboardParameter } from "../shared/types.js";
import {
  midiToDrawbar,
  midiToDiscrete,
  midiToModelIndex,
} from "../shared/parameter-resolution.js";

// ── Types ──

interface ParamState {
  value: number;
  label: string;
  name: string;
  section: string;
  type: string;
  position?: number;
  index?: number;
}

export interface EngineOptions {
  lowerChannel: number;
  upperChannel: number;
  wsPort: number;
}

// ── Engine ──

export class MockEngine {
  private model: KeyboardModel;
  private handler: MockHandler | null;
  private opts: EngineOptions;

  private midiInput: easymidi.Input | null = null;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private mcpClients = new Set<WebSocket>();

  private channelState = new Map<number, Map<number, number>>();
  private ctx: MockContext;

  constructor(model: KeyboardModel, opts: EngineOptions) {
    this.model = model;
    this.handler = model.createMockHandler?.() ?? null;
    this.opts = opts;

    this.ctx = {
      channelState: this.channelState,
      lowerChannel: opts.lowerChannel,
      upperChannel: opts.upperChannel,
      parameterMap: model.parameterMap,
    };
  }

  start(): void {
    // Init channel state with defaults
    this.initChannel(this.opts.lowerChannel);
    this.initChannel(this.opts.upperChannel);

    // Init handler
    this.handler?.init(this.ctx);

    // Create virtual MIDI port
    const portName = `${this.model.info.displayName} Mock`;
    this.midiInput = new easymidi.Input(portName, true);

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
        ws.send(JSON.stringify({
          ...this.buildStateMessage(undefined, undefined, true),
          mcpConnected: this.isMcpConnected(),
        }));
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === "reload-cache") {
              this.handler?.onCacheReload?.(this.ctx);
              this.broadcast(this.buildStateMessage(undefined, undefined, true));
            }
          } catch { /* ignore */ }
        });
        ws.on("close", () => this.clients.delete(ws));
      }
    });

    // MIDI listeners
    this.midiInput.on("cc", (msg: { controller: number; value: number; channel: number }) => {
      this.handleCC(msg.controller, msg.value, msg.channel);
    });

    this.midiInput.on("program", (msg: { number: number; channel: number }) => {
      this.handleProgramChange(msg.number, msg.channel);
    });

    this.httpServer.listen(this.opts.wsPort, () => {
      console.log(`Mock ${this.model.info.displayName}`);
      console.log(`  MIDI port: "${portName}" (virtual)`);
      console.log(`  Lower channel: ${this.opts.lowerChannel}, Upper channel: ${this.opts.upperChannel}`);
      console.log(`  WebSocket: ws://localhost:${this.opts.wsPort}`);
    });
  }

  async stop(): Promise<void> {
    if (this.midiInput) {
      this.midiInput.close();
      this.midiInput = null;
    }
    // Force-close all WebSocket clients so the HTTP server can shut down
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
    this.channelState.clear();
  }

  // ── Private ──

  private initChannel(ch: number): void {
    const chState = new Map<number, number>();
    for (const param of Object.values(this.model.parameterMap.params)) {
      chState.set(param.cc, param.defaultValue);
    }
    this.channelState.set(ch, chState);
  }

  private handleCC(cc: number, value: number, channel: number): void {
    // Let the handler intercept first
    const result = this.handler?.onCC(cc, value, channel, this.ctx);
    if (result?.handled) {
      this.broadcast(this.buildStateMessage());
      return;
    }

    // Ensure channel state exists
    if (!this.channelState.has(channel)) this.initChannel(channel);

    // Update channel state
    this.channelState.get(channel)!.set(cc, value);

    // Look up param
    const entry = this.model.parameterMap.getParamByCC(cc);
    const changeKey = entry?.key;

    // Determine part and propagate per-part params
    let part = "global";
    if (entry && this.model.parameterMap.isPerPart(entry.key)) {
      if (channel === this.opts.lowerChannel) {
        // Global channel: update upper too
        if (!this.channelState.has(this.opts.upperChannel)) this.initChannel(this.opts.upperChannel);
        this.channelState.get(this.opts.upperChannel)!.set(cc, value);
        part = "upper";
      } else if (channel === this.opts.upperChannel) {
        part = "upper";
      }
    }

    this.broadcast(this.buildStateMessage(changeKey, part));

    // Log
    const desc = entry
      ? `${entry.param.name} = ${this.labelFor(entry.param, value)} (CC${cc}=${value} ch${channel} ${part})`
      : `CC${cc}=${value} ch${channel} [unmapped]`;
    console.log(`MIDI: ${desc}`);
  }

  private handleProgramChange(program: number, channel: number): void {
    this.handler?.onProgramChange(program, channel, this.ctx);
    this.broadcast(this.buildStateMessage());
  }

  private buildStateMessage(lastChangeKey?: string, lastChangePart?: string, includeInventory = false): Record<string, any> {
    const lower: Record<string, ParamState> = {};
    const upper: Record<string, ParamState> = {};
    const global: Record<string, ParamState> = {};

    for (const [key, param] of Object.entries(this.model.parameterMap.params)) {
      if (this.model.parameterMap.isPerPart(key)) {
        lower[key] = this.buildParamEntry(param, this.getChannelValue(this.opts.lowerChannel, param.cc, param.defaultValue));
        upper[key] = this.buildParamEntry(param, this.getChannelValue(this.opts.upperChannel, param.cc, param.defaultValue));
      } else {
        global[key] = this.buildParamEntry(param, this.getChannelValue(this.opts.lowerChannel, param.cc, param.defaultValue));
      }
    }

    // Get model-specific extra state
    const extra = this.handler?.getExtraState(includeInventory, this.ctx) ?? {};

    // Apply global overrides from handler (e.g., amp/rotary edge case)
    if (extra.globalOverrides) {
      for (const [key, override] of Object.entries(extra.globalOverrides as Record<string, any>)) {
        if (global[key]) {
          global[key] = { ...global[key], ...override };
        }
      }
      delete extra.globalOverrides;
    }

    const msg: Record<string, any> = { lower, upper, global, ...extra };

    if (lastChangeKey) {
      const entry = this.model.parameterMap.getParamByCC(
        this.model.parameterMap.params[lastChangeKey]?.cc,
      );
      if (entry) {
        const ch = lastChangePart === "upper" ? this.opts.upperChannel : this.opts.lowerChannel;
        const midiValue = this.getChannelValue(ch, entry.param.cc, entry.param.defaultValue);
        msg.lastChange = {
          key: lastChangeKey,
          name: entry.param.name,
          cc: entry.param.cc,
          value: midiValue,
          label: this.labelFor(entry.param, midiValue),
          part: lastChangePart,
        };
      }
    }

    return msg;
  }

  private broadcast(msg: Record<string, any>): void {
    const json = JSON.stringify({ ...msg, mcpConnected: this.isMcpConnected() });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  }

  private broadcastMcpStatus(): void {
    const json = JSON.stringify({ mcpConnected: this.isMcpConnected() });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  }

  private isMcpConnected(): boolean {
    return this.mcpClients.size > 0;
  }

  private getChannelValue(ch: number, cc: number, defaultVal: number): number {
    return this.channelState.get(ch)?.get(cc) ?? defaultVal;
  }

  private labelFor(param: KeyboardParameter, midiValue: number): string {
    if (param.encoding.kind === "drawbar") return String(midiToDrawbar(midiValue, param.encoding.positions));
    if (param.encoding.kind === "model-index") return `index ${midiToModelIndex(midiValue, param.encoding.table)}`;
    if (param.encoding.kind === "one-based") return String(midiValue + 1);
    if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
      const index = midiToDiscrete(midiValue, param.max);
      return param.labels[index] ?? String(midiValue);
    }
    return String(midiValue);
  }

  private buildParamEntry(param: KeyboardParameter, midiValue: number): ParamState {
    const entry: ParamState = {
      value: midiValue,
      label: this.labelFor(param, midiValue),
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if (param.encoding.kind === "drawbar") {
      entry.position = midiToDrawbar(midiValue, param.encoding.positions);
    }
    if ((param.type === "discrete" || param.type === "toggle") && param.labels) {
      entry.index = midiToDiscrete(midiValue, param.max);
    }
    return entry;
  }
}
