#!/usr/bin/env tsx
/**
 * Mock Nord Electro 5D MIDI Device — Web UI version (bi-timbral)
 *
 * Creates a virtual MIDI port named "Nord Electro 5D" that listens for
 * incoming CC messages and serves a skeuomorphic web UI showing device state.
 * Supports per-channel state tracking for Lower (ch0) and Upper (ch1) parts.
 *
 * Usage:  npx tsx src/mock-device.ts
 * Then open http://localhost:3000
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import easymidi from "easymidi";
import {
  NORD_ELECTRO_5D_PARAMS,
  midiToDrawbar,
  midiToDiscrete,
  midiToModelIndex,
  type NordParameter,
} from "./nord/nord-electro-5d-map.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "web");
const PORT = 3000;

// ── Channel-to-part mapping ──
const LOWER_CH = parseInt(process.env.LOWER_CHANNEL ?? "0");
const UPPER_CH = parseInt(process.env.UPPER_CHANNEL ?? "1");

// ── Build reverse CC lookup ──
const ccToParam = new Map<number, { key: string; param: NordParameter }>();
for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
  ccToParam.set(param.cc, { key, param });
}

// ── Classify params ──
const PER_PART_SECTIONS = new Set(["organ", "piano", "sample_synth"]);
function isPerPart(param: NordParameter): boolean {
  return (param as any).perPart === true || PER_PART_SECTIONS.has(param.section);
}

// ── State: channel → cc → value ──
const channelState = new Map<number, Map<number, number>>();

function initChannel(ch: number): void {
  const chState = new Map<number, number>();
  for (const param of Object.values(NORD_ELECTRO_5D_PARAMS)) {
    chState.set(param.cc, param.defaultValue);
  }
  channelState.set(ch, chState);
}

// Initialize channels 0 and 1 with defaults
initChannel(LOWER_CH);
initChannel(UPPER_CH);

// ── Helpers ──

function labelFor(param: NordParameter, midiValue: number): string {
  if (param.drawbar) return String(midiToDrawbar(midiValue));
  if (param.modelIndex) return `index ${midiToModelIndex(midiValue)}`;
  if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
    const index = midiToDiscrete(midiValue, param.max);
    return param.labels[index] ?? String(midiValue);
  }
  return String(midiValue);
}

function getChannelValue(ch: number, cc: number, defaultVal: number): number {
  return channelState.get(ch)?.get(cc) ?? defaultVal;
}

interface ParamState {
  value: number;
  label: string;
  section: string;
  type: string;
  position?: number; // drawbar position 0-8
}

interface StateMessage {
  lower: Record<string, ParamState>;
  upper: Record<string, ParamState>;
  global: Record<string, ParamState>;
  lastChange?: {
    key: string;
    name: string;
    cc: number;
    value: number;
    label: string;
    part?: string; // "lower" | "upper" | "global"
  };
}

function buildParamEntry(param: NordParameter, midiValue: number): ParamState {
  const entry: ParamState = {
    value: midiValue,
    label: labelFor(param, midiValue),
    section: param.section,
    type: param.type,
  };
  if (param.drawbar) {
    entry.position = midiToDrawbar(midiValue);
  }
  return entry;
}

function buildStateMessage(lastChangeKey?: string, lastChangePart?: string): StateMessage {
  const lower: Record<string, ParamState> = {};
  const upper: Record<string, ParamState> = {};
  const global: Record<string, ParamState> = {};

  for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
    if (isPerPart(param)) {
      const lowerVal = getChannelValue(LOWER_CH, param.cc, param.defaultValue);
      lower[key] = buildParamEntry(param, lowerVal);

      const upperVal = getChannelValue(UPPER_CH, param.cc, param.defaultValue);
      upper[key] = buildParamEntry(param, upperVal);
    } else {
      const val = getChannelValue(LOWER_CH, param.cc, param.defaultValue);
      global[key] = buildParamEntry(param, val);
    }
  }

  const msg: StateMessage = { lower, upper, global };

  if (lastChangeKey) {
    const param = NORD_ELECTRO_5D_PARAMS[lastChangeKey];
    if (param) {
      const ch = lastChangePart === "upper" ? UPPER_CH : LOWER_CH;
      const midiValue = getChannelValue(ch, param.cc, param.defaultValue);
      msg.lastChange = {
        key: lastChangeKey,
        name: param.name,
        cc: param.cc,
        value: midiValue,
        label: labelFor(param, midiValue),
        part: lastChangePart,
      };
    }
  }

  return msg;
}

// ── HTTP Server ──

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let urlPath = req.url ?? "/";
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = join(WEB_DIR, urlPath);
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ── Main ──

function main(): void {
  // Virtual MIDI input (appears as output to other apps)
  const midiInput = new easymidi.Input("Nord Electro 5D", true);

  // HTTP server
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      res.writeHead(500);
      res.end("Internal error");
    });
  });

  // WebSocket server
  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    // Send current state immediately
    ws.send(JSON.stringify(buildStateMessage()));
    ws.on("close", () => clients.delete(ws));
  });

  function broadcast(msg: StateMessage): void {
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(json);
      }
    }
  }

  // MIDI listeners
  midiInput.on("cc", (msg: { controller: number; value: number; channel: number }) => {
    // Ensure channel state exists
    if (!channelState.has(msg.channel)) {
      initChannel(msg.channel);
    }
    channelState.get(msg.channel)!.set(msg.controller, msg.value);

    const entry = ccToParam.get(msg.controller);
    const changeKey = entry?.key;

    // Determine part
    let part: string = "global";
    if (entry && isPerPart(entry.param)) {
      if (msg.channel === LOWER_CH) part = "lower";
      else if (msg.channel === UPPER_CH) part = "upper";
    } else if (msg.channel === LOWER_CH) {
      part = "global";
    }

    broadcast(buildStateMessage(changeKey, part));

    const desc = entry
      ? `${entry.param.name} = ${labelFor(entry.param, msg.value)} (CC${msg.controller}=${msg.value} ch${msg.channel} ${part})`
      : `CC${msg.controller}=${msg.value} ch${msg.channel} [unmapped]`;
    console.log(`MIDI: ${desc}`);
  });

  midiInput.on("program", (msg: { number: number; channel: number }) => {
    console.log(`MIDI: Program Change #${msg.number} (ch${msg.channel})`);
    broadcast(buildStateMessage());
  });

  // Start
  server.listen(PORT, () => {
    console.log(`Mock Nord Electro 5D (bi-timbral)`);
    console.log(`  MIDI port: "Nord Electro 5D" (virtual)`);
    console.log(`  Lower channel: ${LOWER_CH}, Upper channel: ${UPPER_CH}`);
    console.log(`  Web UI:    http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to quit`);
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    midiInput.close();
    wss.close();
    server.close();
    process.exit(0);
  });
}

main();
