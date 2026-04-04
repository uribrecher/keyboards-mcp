/**
 * Electron main process for the Nord Electro 5D Mock Device.
 *
 * Replaces the HTTP static file server from mock-device.ts with an Electron
 * BrowserWindow. Everything else (MIDI, WebSocket, state management) is
 * identical to the plain Node.js version.
 *
 * Usage: npm run mock:electron
 */

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import easymidi from "easymidi";
import {
  NORD_ELECTRO_5D_PARAMS,
  midiToDrawbar,
  midiToDiscrete,
  midiToModelIndex,
  drawbarToMidi,
  resolveValue,
  type NordParameter,
} from "../nord/nord-electro-5d-map.js";
import type { ProgramParams } from "../nord/backup-parser.js";
import { loadBackupCache, reloadBackupCache, getBackupData, getPianoModelsForType } from "../nord/backup-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "..", "..", "src", "web");
const WS_PORT = 3000;

// Load inventory cache
loadBackupCache();

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

const presetDrawbarState = new Map<string, Map<number, number>>([
  ["preset1", new Map()],
  ["preset2", new Map()],
]);

const DRAWBAR_CCS = new Set<number>();
for (const [, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
  if (param.drawbar) DRAWBAR_CCS.add(param.cc);
}

const PRESET_SELECT_CC = NORD_ELECTRO_5D_PARAMS.organ_preset_select.cc;

function getActivePreset(): string {
  const ch0 = channelState.get(LOWER_CH);
  const presetVal = ch0?.get(PRESET_SELECT_CC) ?? 0;
  return presetVal >= 64 ? "preset2" : "preset1";
}

function initChannel(ch: number): void {
  const chState = new Map<number, number>();
  for (const param of Object.values(NORD_ELECTRO_5D_PARAMS)) {
    chState.set(param.cc, param.defaultValue);
  }
  channelState.set(ch, chState);
}

initChannel(LOWER_CH);
initChannel(UPPER_CH);

let presetOrganToggles = {
  pst1Vib: false, pst1Prc: false,
  pst2Vib: false, pst2Prc: false,
};

const PROGRAM_PARAM_MAP: Array<[key: string, get: (p: ProgramParams) => number | string | boolean]> = [
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
  ["transpose_enable", p => p.transposeEnable ? 1 : 0],
  ["transpose_amount", p => p.transposeAmount],
  ["part_mix", p => p.partMix],
  ["master_volume", p => p.masterGain],
  ["organ_model", p => p.organModel],
  ["vibrato_type", p => p.vibratoType],
  ["vibrato_enable", p => p.pst1VibratoEnable],
  ["percussion", p => p.pst1PercussionEnable],
  ["percussion_harmonic", p => p.percussionHarmonic],
  ["percussion_speed_level", p => (p.percussionSpeed === "Fast" ? 1 : 0) + (p.percussionLevel === "Soft" ? 2 : 0)],
  ["piano_type", p => p.pianoType],
  ["piano_model", p => p.pianoModel],
  ["piano_variation", p => "ABCD".indexOf(p.clavVariation) + 1],
  ["piano_acoustic", p => p.pianoAcoustic],
  ["piano_kbd_touch", p => p.pianoKbdTouch],
  ["piano_mono", p => p.pianoMono ? 1 : 0],
  ["sample_synth_attack", p => p.sampleAttack],
  ["sample_synth_release", p => p.sampleDecRel],
  ["sample_synth_dynamics", p => p.sampleDynamics],
  ["sample_synth_filter_vel", p => p.sampleFilterVel],
  ["effect1_enable", p => p.fx1.enable],
  ["effect1_type", p => p.fx1.type],
  ["effect1_rate", p => p.fx1.rate],
  ["effect1_ctrl_pedal", p => p.fx1.controlPedal],
  ["effect1_part_select", p => p.fx1.partSelect === 1 ? "Upper" : "Lower"],
  ["effect2_enable", p => p.fx2.enable],
  ["effect2_type", p => p.fx2.type],
  ["effect2_rate", p => p.fx2.rate],
  ["effect2_deep", p => p.fx2.deep],
  ["effect2_part_select", p => p.fx2.partSelect === 1 ? "Upper" : "Lower"],
  ["delay_enable", p => p.delay.enable],
  ["delay_part_select", p => p.delay.partSelect === 1 ? "Upper" : "Lower"],
  ["delay_tempo", p => p.delay.tempo],
  ["delay_ping_pong", p => p.delay.pingPong],
  ["delay_dry_wet", p => p.delay.dryWet],
  ["eq_enable", p => p.eq.enable],
  ["eq_part_select", p => p.eq.partSelect],
  ["eq_treble", p => p.eq.treble],
  ["eq_mid_freq", p => p.eq.midFreq],
  ["eq_mid", p => p.eq.mid],
  ["eq_bass", p => p.eq.bass],
  ["spkr_comp_enable", p => p.amp.enable],
  ["spkr_comp_part_select", p => p.amp.partSelect],
  ["spkr_comp_type", p => p.amp.type],
  ["spkr_comp_drive", p => p.amp.drive],
  ["reverb_enable", p => p.reverb.enable],
  ["reverb_type", p => p.reverb.type],
  ["reverb_dry_wet", p => p.reverb.dryWet],
];

function applyProgramParams(params: ProgramParams): void {
  initChannel(LOWER_CH);
  initChannel(UPPER_CH);
  for (const [, map] of presetDrawbarState) map.clear();

  presetOrganToggles = {
    pst1Vib: params.pst1VibratoEnable,
    pst1Prc: params.pst1PercussionEnable,
    pst2Vib: params.pst2VibratoEnable,
    pst2Prc: params.pst2PercussionEnable,
  };

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
    channelState.get(LOWER_CH)!.set(param.cc, midiVal);
    channelState.get(UPPER_CH)!.set(param.cc, midiVal);
  }

  const sampleParam = NORD_ELECTRO_5D_PARAMS.sample_synth_sample;
  if (sampleParam) {
    channelState.get(LOWER_CH)!.set(sampleParam.cc, params.sampleSlot);
    channelState.get(UPPER_CH)!.set(sampleParam.cc, params.sampleSlot);
  }

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
const CC_LOWER_ENGINE = NORD_ELECTRO_5D_PARAMS.part_lower_engine_select.cc;
const CC_UPPER_ENGINE = NORD_ELECTRO_5D_PARAMS.part_upper_engine_select.cc;
const CC_AMP_TYPE = NORD_ELECTRO_5D_PARAMS.spkr_comp_type.cc;
const AMP_ROTARY_MIDI = resolveValue(NORD_ELECTRO_5D_PARAMS.spkr_comp_type, 4);

function isRotaryBothForced(): boolean {
  const ch = channelState.get(LOWER_CH)!;
  const lowerEngine = ch.get(CC_LOWER_ENGINE) ?? 0;
  const upperEngine = ch.get(CC_UPPER_ENGINE) ?? 0;
  const ampType = ch.get(CC_AMP_TYPE) ?? 0;
  return lowerEngine === 0 && upperEngine === 0 && ampType === AMP_ROTARY_MIDI;
}

let currentBank = 0;
let currentProgram = 0;
let programLoaded = false;

// Set List state
let setListMode = false;
let currentSetList = 0;
let currentSong = 0;
let currentPart = 0;
const PART_LABELS = ["A", "B", "C", "D"] as const;

const CC_SETLIST_MODE = NORD_ELECTRO_5D_PARAMS.program_setlist_mode.cc;
const CC_SETLIST_PART = NORD_ELECTRO_5D_PARAMS.setlist_part_select.cc;

// Inventory data
let _backup = getBackupData();
let _pianoModels: Record<string, string[]> | undefined;
let _sampleNames: string[] | undefined;

function buildInventoryFromCache(): void {
  _backup = getBackupData();
  if (!_backup) {
    _pianoModels = undefined;
    _sampleNames = undefined;
    return;
  }
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
  _pianoModels = result;
  const snames: string[] = [];
  for (const s of _backup.samples) snames[s.slot] = s.name;
  _sampleNames = snames;
}
buildInventoryFromCache();

function resolveSetListSong(bankIdx: number, songIdx: number, partIdx: number) {
  const bank = bankIdx + 1;
  const entry = _backup?.setLists.find(s => s.bank === bank && s.slot === songIdx);
  if (!entry) return { prog: undefined, entry: undefined };
  const ref = entry.programs[partIdx];
  if (!ref) return { prog: undefined, entry };
  const prog = _backup?.programs.find(p => p.bank === ref.bank && p.slot === ref.slot);
  return { prog, entry };
}

function loadSetListPart(bankIdx: number, songIdx: number, partIdx: number): void {
  const { prog, entry } = resolveSetListSong(bankIdx, songIdx, partIdx);
  if (prog?.params) {
    applyProgramParams(prog.params);
    console.log(`Set List: Bank ${bankIdx + 1} Song ${songIdx + 1} Part ${PART_LABELS[partIdx]} → ${prog.name ?? "?"} (${prog.bank}:${prog.slot + 1})`);
  } else {
    console.log(`Set List: Bank ${bankIdx + 1} Song ${songIdx + 1} Part ${PART_LABELS[partIdx]} → no program found`);
  }
}

// ── State message building (identical to mock-device.ts) ──

interface ParamState {
  value: number;
  label: string;
  section: string;
  type: string;
  position?: number;
  index?: number;
}

interface StateMessage {
  lower: Record<string, ParamState>;
  upper: Record<string, ParamState>;
  global: Record<string, ParamState>;
  preset1Drawbars: Record<string, ParamState>;
  preset2Drawbars: Record<string, ParamState>;
  pianoModels?: Record<string, string[]>;
  sampleNames?: string[];
  program?: { bank: number; slot: number; name?: string };
  lastChange?: { key: string; name: string; cc: number; value: number; label: string; part?: string };
  presetOrganToggles?: { pst1Vib: boolean; pst1Prc: boolean; pst2Vib: boolean; pst2Prc: boolean };
  lastProgramChange?: { bank: number; slot: number; name?: string };
  setList?: {
    mode: boolean;
    listNumber: number;
    listName?: string;
    songNumber: number;
    songName?: string;
    part: string;
    programBank: number;
    programSlot: number;
    programName?: string;
  };
}

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

function buildParamEntry(param: NordParameter, midiValue: number): ParamState {
  const entry: ParamState = {
    value: midiValue,
    label: labelFor(param, midiValue),
    section: param.section,
    type: param.type,
  };
  if (param.drawbar) entry.position = midiToDrawbar(midiValue);
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
      lower[key] = buildParamEntry(param, getChannelValue(LOWER_CH, param.cc, param.defaultValue));
      upper[key] = buildParamEntry(param, getChannelValue(UPPER_CH, param.cc, param.defaultValue));
    } else {
      global[key] = buildParamEntry(param, getChannelValue(LOWER_CH, param.cc, param.defaultValue));
    }
  }

  if (isRotaryBothForced() && global.spkr_comp_part_select) {
    global.spkr_comp_part_select = { ...global.spkr_comp_part_select, label: "Both", index: 2 };
  }

  const preset1Drawbars: Record<string, ParamState> = {};
  const preset2Drawbars: Record<string, ParamState> = {};
  for (const [key, param] of Object.entries(NORD_ELECTRO_5D_PARAMS)) {
    if (!param.drawbar) continue;
    preset1Drawbars[key] = buildParamEntry(param, presetDrawbarState.get("preset1")!.get(param.cc) ?? param.defaultValue);
    preset2Drawbars[key] = buildParamEntry(param, presetDrawbarState.get("preset2")!.get(param.cc) ?? param.defaultValue);
  }

  let program: StateMessage["program"];
  if (programLoaded) {
    const bank = currentBank + 1;
    const slot = currentProgram + 1;
    const prog = _backup?.programs.find((p) => p.bank === bank && p.slot === currentProgram);
    program = { bank, slot, name: prog?.name };
  }

  let setListInfo: StateMessage["setList"];
  if (setListMode) {
    const { prog, entry } = resolveSetListSong(currentSetList, currentSong, currentPart);
    setListInfo = {
      mode: true,
      listNumber: currentSetList + 1,
      listName: undefined,
      songNumber: currentSong + 1,
      songName: entry?.name,
      part: PART_LABELS[currentPart],
      programBank: prog?.bank ?? 0,
      programSlot: (prog?.slot ?? -1) + 1,
      programName: prog?.name,
    };
  }

  const msg: StateMessage = {
    lower, upper, global, preset1Drawbars, preset2Drawbars, program,
    presetOrganToggles,
    ...(setListInfo ? { setList: setListInfo } : {}),
    ...(includeInventory ? { pianoModels: _pianoModels, sampleNames: _sampleNames } : {}),
    ...(lastProgramChange ? { lastProgramChange } : {}),
  };

  if (lastChangeKey) {
    const param = NORD_ELECTRO_5D_PARAMS[lastChangeKey];
    if (param) {
      const ch = lastChangePart === "upper" ? UPPER_CH : LOWER_CH;
      const midiValue = getChannelValue(ch, param.cc, param.defaultValue);
      msg.lastChange = { key: lastChangeKey, name: param.name, cc: param.cc, value: midiValue, label: labelFor(param, midiValue), part: lastChangePart };
    }
  }

  return msg;
}

// ── IPC Handlers ──

ipcMain.handle("open-backup-dialog", async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;

  const result = await dialog.showOpenDialog(win, {
    title: "Select Nord Backup",
    properties: ["openFile", "openDirectory"],
    filters: [
      { name: "Nord Backup", extensions: ["ne5b"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── Electron App ──

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Nord Electro 5D — Mock Device",
    webPreferences: {
      preload: join(__dirname, "..", "..", "src", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(join(WEB_DIR, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // ── MIDI ──
  const midiInput = new easymidi.Input("Nord Electro 5D Mock", true);

  // ── WebSocket server (standalone, not attached to HTTP) ──
  // Needed for MCP client connections and UI state updates when loaded via file://
  const httpServer = createServer(); // bare HTTP server, no request handler
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Set<WebSocket>();
  const mcpClients = new Set<WebSocket>();

  function isMcpConnected(): boolean {
    return mcpClients.size > 0;
  }

  function broadcastMcpStatus(): void {
    const json = JSON.stringify({ mcpConnected: isMcpConnected() });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  }

  function broadcast(msg: StateMessage): void {
    const json = JSON.stringify({ ...msg, mcpConnected: isMcpConnected() });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  }

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", `http://localhost:${WS_PORT}`);
    const isMcp = url.searchParams.get("client") === "mcp";

    if (isMcp) {
      mcpClients.add(ws);
      console.log("MCP server connected via WebSocket");
      broadcastMcpStatus();
      ws.on("close", () => {
        mcpClients.delete(ws);
        console.log("MCP server disconnected");
        broadcastMcpStatus();
      });
    } else {
      clients.add(ws);
      ws.send(JSON.stringify({ ...buildStateMessage(undefined, undefined, true), mcpConnected: isMcpConnected() }));
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "reload-cache") {
            console.log("Reloading backup cache...");
            if (reloadBackupCache()) {
              buildInventoryFromCache();
              console.log(`Backup cache reloaded: ${_backup?.programs.length ?? 0} programs, ${_backup?.samples.length ?? 0} samples`);
              broadcast(buildStateMessage(undefined, undefined, true));
            } else {
              console.log("No backup cache file found on disk");
            }
          }
        } catch { /* ignore non-JSON messages */ }
      });
      ws.on("close", () => clients.delete(ws));
    }
  });

  // ── MIDI listeners ──
  midiInput.on("cc", (msg: { controller: number; value: number; channel: number }) => {
    if (msg.controller === 0) {
      console.log(`MIDI: Bank Select MSB = ${msg.value} (ch${msg.channel})`);
      return;
    }
    if (msg.controller === 32) {
      if (setListMode) {
        currentSetList = msg.value;
        console.log(`MIDI: Bank Select LSB = ${msg.value} → Set List ${msg.value + 1} (ch${msg.channel})`);
      } else {
        currentBank = msg.value;
        console.log(`MIDI: Bank Select LSB = ${msg.value} → Bank ${msg.value + 1} (ch${msg.channel})`);
      }
      return;
    }

    // CC48: Program/Set List mode toggle
    if (msg.controller === CC_SETLIST_MODE) {
      setListMode = msg.value >= 64;
      console.log(`MIDI: Mode → ${setListMode ? "Set List" : "Program"} (CC${msg.controller}=${msg.value})`);
      broadcast(buildStateMessage());
      return;
    }

    // CC49: Set List part select (A/B/C/D)
    if (msg.controller === CC_SETLIST_PART && setListMode) {
      currentPart = midiToDiscrete(msg.value, 3);
      loadSetListPart(currentSetList, currentSong, currentPart);
      broadcast(buildStateMessage());
      return;
    }

    if (!channelState.has(msg.channel)) initChannel(msg.channel);

    if (DRAWBAR_CCS.has(msg.controller)) {
      presetDrawbarState.get(getActivePreset())!.set(msg.controller, msg.value);
    }

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

    let part = "global";
    if (entry && isPerPart(entry.param)) {
      if (msg.channel === LOWER_CH) {
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
    if (setListMode) {
      currentSong = msg.number;
      currentPart = 0;
      loadSetListPart(currentSetList, currentSong, currentPart);
      broadcast(buildStateMessage());
      return;
    }

    currentProgram = msg.number;
    programLoaded = true;
    const bank = currentBank + 1;
    const slot = currentProgram + 1;
    const prog = _backup?.programs.find((p) => p.bank === bank && p.slot === currentProgram);
    const name = prog?.name ? ` (${prog.name})` : "";

    if (prog?.params) {
      applyProgramParams(prog.params);
      console.log(`MIDI: Program ${bank}:${slot}${name} — applied ${Object.keys(prog.params).length} params (ch${msg.channel})`);
    } else {
      console.log(`MIDI: Program ${bank}:${slot}${name} — no cached params (ch${msg.channel})`);
    }

    broadcast(buildStateMessage(undefined, undefined, false, { bank, slot, name: prog?.name }));
  });

  // Start WebSocket server
  httpServer.listen(WS_PORT, () => {
    console.log(`Mock Nord Electro 5D (Electron)`);
    console.log(`  MIDI port: "Nord Electro 5D Mock" (virtual)`);
    console.log(`  Lower channel: ${LOWER_CH}, Upper channel: ${UPPER_CH}`);
    console.log(`  WebSocket: ws://localhost:${WS_PORT}`);
  });

  // Create window
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    console.log("\nShutting down...");
    midiInput.close();
    wss.close();
    httpServer.close();
    app.quit();
  });
});
