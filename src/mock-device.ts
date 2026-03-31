#!/usr/bin/env tsx
/**
 * Mock Nord Electro 5D MIDI Device — Web UI version (bi-timbral)
 *
 * Creates a virtual MIDI port named "Nord Electro 5D Mock" that listens for
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
  drawbarToMidi,
  modelIndexToMidi,
  resolveValue,
  type NordParameter,
} from "./nord/nord-electro-5d-map.js";
import type { ProgramParams } from "./nord/backup-parser.js";
import { loadBackupCache, getBackupData, getPianoModelsForType } from "./nord/backup-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "web");

// Load inventory cache for piano model name resolution
loadBackupCache();
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

// Per-preset drawbar state (drawbar CCs route to active preset)
const presetDrawbarState = new Map<string, Map<number, number>>([
  ["preset1", new Map()],
  ["preset2", new Map()],
]);

// Drawbar CC numbers (16-24)
const DRAWBAR_CCS = new Set<number>();
for (const [, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
  if (param.drawbar) DRAWBAR_CCS.add(param.cc);
}

// organ_preset_select CC for checking active preset
const PRESET_SELECT_CC = NORD_ELECTRO_5D_PARAMS.organ_preset_select.cc;

function getActivePreset(): string {
  // Check channel 0 (global) for organ_preset_select value
  const ch0 = channelState.get(LOWER_CH);
  const presetVal = ch0?.get(PRESET_SELECT_CC) ?? 0;
  // preset_select max=1, so MIDI 0 = Preset 1, MIDI 127 = Preset 2
  return presetVal >= 64 ? "preset2" : "preset1";
}

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

// Per-preset organ toggles (set on program load, not via CC)
let presetOrganToggles = {
  pst1Vib: false, pst1Prc: false,
  pst2Vib: false, pst2Prc: false,
};

/**
 * Mapping from MIDI param keys → ProgramParams accessor.
 * Each entry returns a value that resolveValue() can convert to MIDI:
 *   number  → raw CC value (or passed to resolveValue for modelIndex/drawbar/discrete)
 *   string  → discrete label lookup
 *   boolean → toggle (true=127, false=0)
 *
 * To add a new parameter: add one line here. No other mapping code needed.
 */
const PROGRAM_PARAM_MAP: Array<[key: string, get: (p: ProgramParams) => number | string | boolean]> = [
  // Part / Split
  ["kb_split_mode", p => p.splitMode],
  ["kb_split_point", p => p.splitPoint],
  ["part_lower_enable", p => p.lowerEnable],
  ["part_upper_enable", p => p.upperEnable],
  ["part_lower_engine_select", p => p.lowerEngine],
  ["part_upper_engine_select", p => p.upperEngine],
  ["octave_shift_lower", p => p.lowerOctaveShift],
  ["octave_shift_upper", p => p.upperOctaveShift],
  ["sustain_pedal_enable_lower", p => p.lowerSustainPedalEnable ? 1 : 0],
  ["sustain_pedal_enable_upper", p => p.upperSustainPedalEnable ? 1 : 0],
  ["ctrl_pedal_enable_lower", p => p.lowerCtrlPedalEnable ? 1 : 0],
  ["ctrl_pedal_enable_upper", p => p.upperCtrlPedalEnable ? 1 : 0],
  // Master
  ["transpose_enable", p => p.transposeEnable ? 1 : 0],
  ["transpose_amount", p => p.transposeAmount],
  ["part_mix", p => p.partMix],
  ["master_volume", p => p.masterGain],
  // Organ (vibrato/percussion enable are per-preset — apply preset 1 as default display)
  ["organ_model", p => p.organModel],
  ["vibrato_type", p => p.vibratoType],
  ["vibrato_enable", p => p.pst1VibratoEnable],
  ["percussion", p => p.pst1PercussionEnable],
  ["percussion_harmonic", p => p.percussionHarmonic],
  ["percussion_speed_level", p => (p.percussionSpeed === "Fast" ? 1 : 0) + (p.percussionLevel === "Soft" ? 2 : 0)],
  // Piano
  ["piano_type", p => p.pianoType],
  ["piano_model", p => p.pianoModel],
  ["piano_variation", p => "ABCD".indexOf(p.clavVariation) + 1],
  ["piano_acoustic", p => p.pianoAcoustic],
  ["piano_kbd_touch", p => p.pianoKbdTouch],
  ["piano_mono", p => p.pianoMono ? 1 : 0],
  // Sample Synth
  ["sample_synth_attack", p => p.sampleAttack],
  ["sample_synth_release", p => p.sampleDecRel],
  ["sample_synth_dynamics", p => p.sampleDynamics],
  ["sample_synth_filter_vel", p => p.sampleFilterVel],
  // FX1
  ["effect1_enable", p => p.fx1.enable],
  ["effect1_type", p => p.fx1.type],
  ["effect1_rate", p => p.fx1.rate],
  ["effect1_ctrl_pedal", p => p.fx1.controlPedal],
  ["effect1_part_select", p => p.fx1.partSelect === 1 ? "Upper" : "Lower"],
  // FX2
  ["effect2_enable", p => p.fx2.enable],
  ["effect2_type", p => p.fx2.type],
  ["effect2_rate", p => p.fx2.rate],
  ["effect2_deep", p => p.fx2.deep],
  ["effect2_part_select", p => p.fx2.partSelect === 1 ? "Upper" : "Lower"],
  // Delay
  ["delay_enable", p => p.delay.enable],
  ["delay_part_select", p => p.delay.partSelect === 1 ? "Upper" : "Lower"],
  ["delay_tempo", p => p.delay.tempo],
  ["delay_ping_pong", p => p.delay.pingPong],
  ["delay_dry_wet", p => p.delay.dryWet],
  // EQ
  ["eq_enable", p => p.eq.enable],
  ["eq_part_select", p => p.eq.partSelect],
  ["eq_treble", p => p.eq.treble],
  ["eq_mid_freq", p => p.eq.midFreq],
  ["eq_mid", p => p.eq.mid],
  ["eq_bass", p => p.eq.bass],
  // Amp/Speaker
  ["spkr_comp_enable", p => p.amp.enable],
  ["spkr_comp_part_select", p => p.amp.partSelect],
  ["spkr_comp_type", p => p.amp.type],
  ["spkr_comp_drive", p => p.amp.drive],
  // Reverb
  ["reverb_enable", p => p.reverb.enable],
  ["reverb_type", p => p.reverb.type],
  ["reverb_dry_wet", p => p.reverb.dryWet],
];

/**
 * Apply decoded ProgramParams to mock device state.
 * Resets all state to defaults, then uses PROGRAM_PARAM_MAP + resolveValue()
 * to convert each field to a MIDI CC value — the same conversion used for
 * incoming CC messages.
 */
function applyProgramParams(params: ProgramParams): void {
  // Reset to defaults
  initChannel(LOWER_CH);
  initChannel(UPPER_CH);
  for (const [, map] of presetDrawbarState) map.clear();

  // Store per-preset organ toggles
  presetOrganToggles = {
    pst1Vib: params.pst1VibratoEnable,
    pst1Prc: params.pst1PercussionEnable,
    pst2Vib: params.pst2VibratoEnable,
    pst2Prc: params.pst2PercussionEnable,
  };

  // Apply table-driven param mappings
  for (const [key, get] of PROGRAM_PARAM_MAP) {
    const param = NORD_ELECTRO_5D_PARAMS[key];
    if (!param) continue;
    const raw = get(params);
    let midiVal: number;
    if (typeof raw === "boolean") {
      midiVal = raw ? 127 : 0;
    } else if (typeof raw === "string") {
      try { midiVal = resolveValue(param, raw); } catch { continue; }
    } else {
      midiVal = resolveValue(param, raw);
    }
    // Don't clamp to 127 — mock internal state can hold values beyond MIDI CC range
    // (e.g., sample slots go up to 152)
    channelState.get(LOWER_CH)!.set(param.cc, midiVal);
    channelState.get(UPPER_CH)!.set(param.cc, midiVal);
  }

  // sample_synth_sample: write raw slot (bypass oneBased encoding)
  const sampleParam = NORD_ELECTRO_5D_PARAMS.sample_synth_sample;
  if (sampleParam) {
    channelState.get(LOWER_CH)!.set(sampleParam.cc, params.sampleSlot);
    channelState.get(UPPER_CH)!.set(sampleParam.cc, params.sampleSlot);
  }

  // Drawbars: write to preset-specific state + channel state
  applyDrawbars("preset1", params.pst1Drawbars);
  applyDrawbars("preset2", params.pst2Drawbars);
}

function applyDrawbars(presetKey: string, drawbarStr: string): void {
  if (drawbarStr === "?" || !drawbarStr) return;
  const presetMap = presetDrawbarState.get(presetKey);
  if (!presetMap) return;
  for (let i = 0; i < drawbarStr.length && i < 9; i++) {
    const pos = parseInt(drawbarStr[i], 10);
    if (isNaN(pos)) continue;
    const param = NORD_ELECTRO_5D_PARAMS[`drawbar_${i + 1}`];
    if (!param) continue;
    const midiVal = drawbarToMidi(pos);
    presetMap.set(param.cc, midiVal);
    channelState.get(LOWER_CH)!.set(param.cc, midiVal);
    channelState.get(UPPER_CH)!.set(param.cc, midiVal);
  }
}

// ── Amp/Rotary edge case ──
// When both engines are Organ and amp type is Rotary, hardware forces part select to "Both".
const CC_LOWER_ENGINE = NORD_ELECTRO_5D_PARAMS.part_lower_engine_select.cc;  // 39
const CC_UPPER_ENGINE = NORD_ELECTRO_5D_PARAMS.part_upper_engine_select.cc;  // 40
const CC_AMP_TYPE = NORD_ELECTRO_5D_PARAMS.spkr_comp_type.cc;               // 81
const AMP_ROTARY_MIDI = resolveValue(NORD_ELECTRO_5D_PARAMS.spkr_comp_type, 4); // Rotary index

/** Check if both engines=Organ + amp=Rotary (hardware forces amp part select to "Both"). */
function isRotaryBothForced(): boolean {
  const ch = channelState.get(LOWER_CH)!;
  const lowerEngine = ch.get(CC_LOWER_ENGINE) ?? 0;
  const upperEngine = ch.get(CC_UPPER_ENGINE) ?? 0;
  const ampType = ch.get(CC_AMP_TYPE) ?? 0;
  return lowerEngine === 0 && upperEngine === 0 && ampType === AMP_ROTARY_MIDI;
}

// Program state (from Bank Select + Program Change)
let currentBank = 0;   // 0-indexed (from CC32)
let currentProgram = 0; // 0-indexed (from PC message)
let programLoaded = false; // true after first PC received

// Pre-compute inventory data once at startup (doesn't change during session)
const _backup = getBackupData();
const _pianoModels: Record<string, string[]> | undefined = (() => {
  if (!_backup) return undefined;
  const result: Record<string, string[]> = {};
  const types = [
    { key: "0", type: "Grand" }, { key: "1", type: "Upright" },
    { key: "2", type: "EP1" }, { key: "3", type: "EP2" },
    { key: "4", type: "Clav" }, { key: "5", type: "Harpsichord" },
  ];
  for (const { key, type } of types) {
    const models = getPianoModelsForType(type);
    if (models) {
      const names: string[] = [];
      for (const m of models) names[m.location - 1] = m.name;
      result[key] = names;
    }
  }
  return result;
})();
const _sampleNames: string[] | undefined = (() => {
  if (!_backup) return undefined;
  const names: string[] = [];
  for (const s of _backup.samples) names[s.slot] = s.name;
  return names;
})();

// ── Helpers ──

function labelFor(param: NordParameter, midiValue: number): string {
  if (param.drawbar) return String(midiToDrawbar(midiValue));
  if (param.modelIndex) return `index ${midiToModelIndex(midiValue)}`;
  if (param.oneBased) return String(midiValue + 1);
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
  index?: number; // decoded discrete index for selector matching
}

interface StateMessage {
  lower: Record<string, ParamState>;
  upper: Record<string, ParamState>;
  global: Record<string, ParamState>;
  preset1Drawbars: Record<string, ParamState>;
  preset2Drawbars: Record<string, ParamState>;
  pianoModels?: Record<string, string[]>; // type index → model names from inventory
  sampleNames?: string[]; // sample names indexed by slot (0-based)
  program?: { bank: number; slot: number; name?: string }; // current program (1-indexed)
  lastChange?: {
    key: string;
    name: string;
    cc: number;
    value: number;
    label: string;
    part?: string; // "lower" | "upper" | "global"
  };
  presetOrganToggles?: { pst1Vib: boolean; pst1Prc: boolean; pst2Vib: boolean; pst2Prc: boolean };
  lastProgramChange?: {
    bank: number;
    slot: number;
    name?: string;
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
  if ((param.type === "discrete" || param.type === "toggle") && param.labels) {
    entry.index = midiToDiscrete(midiValue, param.max);
  }
  return entry;
}

function buildStateMessage(lastChangeKey?: string, lastChangePart?: string, includeInventory = false, lastProgramChange?: StateMessage["lastProgramChange"]): StateMessage {
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

  // Amp/Rotary edge case: both engines Organ + Rotary → force "Both"
  if (isRotaryBothForced() && global.spkr_comp_part_select) {
    global.spkr_comp_part_select = {
      ...global.spkr_comp_part_select,
      label: "Both",
      index: 2,
    };
  }

  // Build per-preset drawbar state
  const preset1Drawbars: Record<string, ParamState> = {};
  const preset2Drawbars: Record<string, ParamState> = {};
  for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
    if (!param.drawbar) continue;
    const p1Val = presetDrawbarState.get("preset1")!.get(param.cc) ?? param.defaultValue;
    preset1Drawbars[key] = buildParamEntry(param, p1Val);
    const p2Val = presetDrawbarState.get("preset2")!.get(param.cc) ?? param.defaultValue;
    preset2Drawbars[key] = buildParamEntry(param, p2Val);
  }

  // Build program info (dynamic — depends on current bank/program)
  let program: StateMessage["program"];
  if (programLoaded) {
    const bank = currentBank + 1;
    const slot = currentProgram + 1;
    const prog = _backup?.programs.find((p) => p.bank === bank && p.slot === currentProgram);
    program = { bank, slot, name: prog?.name };
  }

  const msg: StateMessage = {
    lower, upper, global, preset1Drawbars, preset2Drawbars, program,
    presetOrganToggles,
    ...(includeInventory ? { pianoModels: _pianoModels, sampleNames: _sampleNames } : {}),
    ...(lastProgramChange ? { lastProgramChange } : {}),
  };

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
  const midiInput = new easymidi.Input("Nord Electro 5D Mock", true);

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
  const mcpClients = new Set<WebSocket>();

  function isMcpConnected(): boolean {
    return mcpClients.size > 0;
  }

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const isMcp = url.searchParams.get("client") === "mcp";

    if (isMcp) {
      mcpClients.add(ws);
      console.log("MCP server connected via WebSocket");
      // Broadcast updated status to UI clients
      broadcastMcpStatus();
      ws.on("close", () => {
        mcpClients.delete(ws);
        console.log("MCP server disconnected");
        broadcastMcpStatus();
      });
    } else {
      clients.add(ws);
      // Send current state + inventory data on initial connection
      ws.send(JSON.stringify({ ...buildStateMessage(undefined, undefined, true), mcpConnected: isMcpConnected() }));
      ws.on("close", () => clients.delete(ws));
    }
  });

  function broadcastMcpStatus(): void {
    const json = JSON.stringify({ mcpConnected: isMcpConnected() });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(json);
      }
    }
  }

  function broadcast(msg: StateMessage): void {
    const json = JSON.stringify({ ...msg, mcpConnected: isMcpConnected() });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(json);
      }
    }
  }

  // MIDI listeners
  midiInput.on("cc", (msg: { controller: number; value: number; channel: number }) => {
    // Bank Select: intercept before normal routing
    if (msg.controller === 0) {
      // CC0 (Bank Select MSB) — always 0 for Nord, ignore
      console.log(`MIDI: Bank Select MSB = ${msg.value} (ch${msg.channel})`);
      return;
    }
    if (msg.controller === 32) {
      // CC32 (Bank Select LSB) — store as current bank (0-indexed)
      currentBank = msg.value;
      console.log(`MIDI: Bank Select LSB = ${msg.value} → Bank ${msg.value + 1} (ch${msg.channel})`);
      return;
    }

    // Ensure channel state exists
    if (!channelState.has(msg.channel)) {
      initChannel(msg.channel);
    }

    // Route drawbar CCs to the active preset state
    if (DRAWBAR_CCS.has(msg.controller)) {
      const preset = getActivePreset();
      presetDrawbarState.get(preset)!.set(msg.controller, msg.value);
    }

    // Route vibrato/percussion enable to the active preset's toggles
    const VIBRATO_ENABLE_CC = NORD_ELECTRO_5D_PARAMS.vibrato_enable.cc;
    const PERCUSSION_CC = NORD_ELECTRO_5D_PARAMS.percussion.cc;
    if (msg.controller === VIBRATO_ENABLE_CC || msg.controller === PERCUSSION_CC) {
      const preset = getActivePreset();
      const on = msg.value > 0;
      if (msg.controller === VIBRATO_ENABLE_CC) {
        if (preset === "preset1") presetOrganToggles.pst1Vib = on;
        else presetOrganToggles.pst2Vib = on;
      } else {
        if (preset === "preset1") presetOrganToggles.pst1Prc = on;
        else presetOrganToggles.pst2Prc = on;
      }
    }

    channelState.get(msg.channel)!.set(msg.controller, msg.value);

    const entry = ccToParam.get(msg.controller);
    const changeKey = entry?.key;

    // Determine part
    // The real Nord receives all CCs on the global channel (0).
    // Per-part params on channel 0 apply to both parts (upper is primary).
    let part: string = "global";
    if (entry && isPerPart(entry.param)) {
      if (msg.channel === LOWER_CH) {
        // Global channel: update both parts, report as upper
        if (!channelState.has(UPPER_CH)) initChannel(UPPER_CH);
        channelState.get(UPPER_CH)!.set(msg.controller, msg.value);
        part = "upper";
      } else if (msg.channel === UPPER_CH) {
        part = "upper";
      }
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
    currentProgram = msg.number;
    programLoaded = true;
    const bank = currentBank + 1;
    const slot = currentProgram + 1;
    const prog = _backup?.programs.find((p) => p.bank === bank && p.slot === currentProgram);
    const name = prog?.name ? ` (${prog.name})` : "";

    // Apply the program's parameters to mock device state
    if (prog?.params) {
      applyProgramParams(prog.params);
      console.log(`MIDI: Program ${bank}:${slot}${name} — applied ${Object.keys(prog.params).length} params (ch${msg.channel})`);
    } else {
      console.log(`MIDI: Program ${bank}:${slot}${name} — no cached params (ch${msg.channel})`);
    }

    broadcast(buildStateMessage(undefined, undefined, false, { bank, slot, name: prog?.name }));
  });

  // Start
  server.listen(PORT, () => {
    console.log(`Mock Nord Electro 5D (bi-timbral)`);
    console.log(`  MIDI port: "Nord Electro 5D Mock" (virtual)`);
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
