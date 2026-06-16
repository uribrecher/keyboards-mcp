/**
 * Nord Electro 5D mock handler — pure param-domain logic.
 *
 * State is keyed by canonical param name with USER-domain values, organized
 * into:
 *   parts[i].params[name]            ──> per-part params (lower=0, upper=1)
 *   globalParams[name]               ──> non-perPart params
 *   presetDrawbars.{preset1|preset2} ──> per-preset drawbar registrations
 *   presetOrganToggles               ──> per-preset vibrato/percussion flags
 *   activePreset (1|2)               ──> which preset drawbar/vibrato/perc
 *                                       writes route to (driven by
 *                                       organ_preset_select user value)
 *
 * The handler doesn't speak MIDI; the codec owns wire-byte translation.
 * Routing for `set_params` refs:
 *   - scene-global names               → globalParams
 *   - drawbar_N (perPart)              → parts[part-1].params + presetDrawbars[active]
 *   - vibrato_enable / percussion      → parts[part-1].params + presetOrganToggles[active]
 *   - organ_preset_select              → updates activePreset; also stored as a perPart param
 *   - program_setlist_mode             → toggles setListMode flag
 *   - setlist_part_select              → updates currentPart and triggers set-list load
 *   - other perPart params             → parts[part-1].params
 *
 * Lower → both auto-propagate: refs with no `part` (or `part: 1`) write to
 * BOTH parts. `part: 2` writes upper only. This mirrors the prior CC
 * dispatch behavior where lower-channel CCs were treated as "global" and
 * also updated the upper channel.
 *
 * Broadcast `state.{lower|upper|global}.<name>.value` is USER-DOMAIN
 * (drawbar position 0-8, label index, etc.) — same convention as the
 * stored values. The UI consumes user-domain throughout.
 */

import type { MockHandler, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { ParamRef } from "../../../shared/midi-codec.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import { PARAMS } from "./midi-map.js";
import type { ProgramParams } from "./backup-parser.js";
import {
  createBackupCache,
  getBackupData,
  getPianoModelsForType,
} from "./backup-cache.js";
import { createNordElectro5DCodec } from "./midi-codec.js";

// ── Types ──

interface ParamState {
  /** USER-domain value (drawbar position 0-8, label index, etc.). */
  value: number;
  label: string;
  name: string;
  displayName?: string;
  section: string;
  type: string;
  position?: number;
  index?: number;
  labels?: Record<number, string>;
}

interface PartState {
  params: Record<string, number>;  // user-domain values for perPart params
}

const NORD_ENGINES = ["organ", "piano", "sample_synth"] as const;
type NordEngine = typeof NORD_ENGINES[number];

// ── Factory ──

export function createNordElectro5DMockHandler(): MockHandler {
  const codec = createNordElectro5DCodec();

  // ── Backup cache ──
  const backupCache = createBackupCache();
  let activeLabel: string | undefined;

  // ── Param-domain state ──
  let parts: [PartState, PartState] = [{ params: {} }, { params: {} }];
  let globalParams: Record<string, number> = {};
  let presetDrawbars: { preset1: Record<string, number>; preset2: Record<string, number> } = {
    preset1: {}, preset2: {},
  };
  let presetOrganToggles = {
    pst1Vib: false, pst1Prc: false,
    pst2Vib: false, pst2Prc: false,
  };
  let activePreset: 1 | 2 = 1;

  // ── Program / set-list state ──
  let currentBank = 0;
  let currentProgram = 0;
  let programLoaded = false;
  let setListMode = false;
  let currentSetList = 0;
  let currentSong = 0;
  let currentPart = 0;
  const PART_LABELS = ["A", "B", "C", "D"] as const;

  // ── Constants for routing ──
  // spkr_comp_type label index 4 = "Rotary" (see midi-map). Real-HW edge
  // case: when both engines = Organ AND amp = Rotary, the part select is
  // forced to "Both" in the broadcast.
  const AMP_ROTARY_INDEX = 4;

  const DRAWBAR_KEYS = new Set<string>();
  for (const [key, param] of Object.entries(PARAMS)) {
    if (param.encoding.kind === "drawbar") DRAWBAR_KEYS.add(key);
  }
  const PERPART_KEYS = new Set<string>();
  for (const [key, param] of Object.entries(PARAMS)) {
    if (param.perPart) PERPART_KEYS.add(key);
  }

  // ── Inventory ──
  let _backup = getBackupData(activeLabel);
  let _pianoModels: Record<string, string[]> | undefined;
  let _sampleNames: string[] | undefined;
  let _lastProgramChange: { bank: number; slot: number; name?: string } | undefined;

  // ══════════════════════════════════════════
  //  Storage helpers
  // ══════════════════════════════════════════

  function resetState(): void {
    parts = [{ params: {} }, { params: {} }];
    globalParams = {};
    presetDrawbars = { preset1: {}, preset2: {} };
    presetOrganToggles = { pst1Vib: false, pst1Prc: false, pst2Vib: false, pst2Prc: false };
    activePreset = 1;
  }

  function getUserValue(name: string, partIdx: 0 | 1): number {
    const param = PARAMS[name];
    if (!param) return 0;
    if (param.perPart) {
      const stored = parts[partIdx].params[name];
      if (stored !== undefined) return stored;
    } else {
      const stored = globalParams[name];
      if (stored !== undefined) return stored;
    }
    // Default = wire defaultValue passed through wireToUserValue.
    return codec.wireToUserValue(name, param.defaultValue);
  }

  function setUserValue(name: string, userValue: number, ref: ParamRef): void {
    const param = PARAMS[name];
    if (!param) return;

    // Drawbar: also store in active preset. Per-part: routes via auto-
    // propagate below.
    if (DRAWBAR_KEYS.has(name)) {
      presetDrawbars[activePreset === 1 ? "preset1" : "preset2"][name] = userValue;
    }

    // Vibrato / percussion: also reflect in presetOrganToggles for the
    // active preset (organ-only flags).
    if (name === "vibrato_enable" || name === "percussion") {
      const on = userValue >= 1;
      if (name === "vibrato_enable") {
        if (activePreset === 1) presetOrganToggles.pst1Vib = on;
        else presetOrganToggles.pst2Vib = on;
      } else {
        if (activePreset === 1) presetOrganToggles.pst1Prc = on;
        else presetOrganToggles.pst2Prc = on;
      }
    }

    // organ_preset_select drives the active-preset pointer (the codec
    // emits user value 0 for Preset 1, 1 for Preset 2).
    if (name === "organ_preset_select") {
      activePreset = userValue >= 1 ? 2 : 1;
    }

    // program_setlist_mode toggle
    if (name === "program_setlist_mode") {
      setListMode = userValue >= 1;
    }

    // setlist_part_select: triggers a set-list load
    if (name === "setlist_part_select" && setListMode) {
      currentPart = userValue;
      loadSetListPart(currentSetList, currentSong, currentPart);
    }

    // Storage routing
    if (param.perPart) {
      // Auto-propagate: refs with part 1 (or unspecified) write to BOTH
      // parts; part 2 writes upper only.
      const part = ref.part ?? 1;
      if (part === 2) {
        parts[1].params[name] = userValue;
      } else {
        parts[0].params[name] = userValue;
        parts[1].params[name] = userValue;
      }
    } else {
      globalParams[name] = userValue;
    }
  }

  // ══════════════════════════════════════════
  //  set_params / get_params
  // ══════════════════════════════════════════

  function applySet(refs: ParamRef[]): MockHandlerResult {
    const logLines: string[] = [];
    let lastKey: string | undefined;
    let lastPart: string | undefined;

    for (const ref of refs) {
      const param = PARAMS[ref.name];
      if (!param) {
        logLines.push(`set: unknown param "${ref.name}"`);
        continue;
      }
      let userValue: number;
      try {
        userValue = codec.normalizeUserValue(ref.name, ref.value);
      } catch (err) {
        logLines.push(`set: ${param.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      setUserValue(ref.name, userValue, ref);
      lastKey = ref.name;
      lastPart = ref.part === 2 ? "upper" : (param.perPart ? "upper" : "global");
      logLines.push(`set: ${param.name} = ${codec.formatValue(ref.name, userValue)}`);
    }

    return {
      state: buildFullState(lastKey, lastPart),
      log: logLines.join("; "),
    };
  }

  function readParams(names: string[], part?: number): Record<string, number> {
    const out: Record<string, number> = {};
    const partIdx: 0 | 1 = part === 2 ? 1 : 0;
    for (const name of names) {
      const param = PARAMS[name];
      if (!param) continue;
      out[name] = getUserValue(name, partIdx);
    }
    return out;
  }

  // ══════════════════════════════════════════
  //  Active engine
  // ══════════════════════════════════════════

  function engineFromValue(userValue: number): NordEngine {
    return NORD_ENGINES[Math.max(0, Math.min(NORD_ENGINES.length - 1, userValue))];
  }

  function getActiveEngine(part: number): string | undefined {
    const partIdx: 0 | 1 = part === 2 ? 1 : 0;
    const key = part === 2 ? "part_upper_engine_select" : "part_lower_engine_select";
    const userValue = getUserValue(key, partIdx);
    return engineFromValue(userValue);
  }

  function setActiveEngine(part: number, engine: string): MockHandlerResult {
    const idx = NORD_ENGINES.indexOf(engine as NordEngine);
    if (idx < 0) return { log: `set_active_engine: unknown engine "${engine}"` };
    const key = part === 2 ? "part_upper_engine_select" : "part_lower_engine_select";
    const userValue = idx;
    setUserValue(key, userValue, { name: key, value: userValue, part });
    return { state: buildFullState(), log: `active engine on part ${part} = ${engine}` };
  }

  // ══════════════════════════════════════════
  //  Broadcast state
  // ══════════════════════════════════════════

  function labelFor(param: KeyboardParameter, userValue: number): string {
    if (param.encoding.kind === "model-index") return `index ${userValue}`;
    if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
      return param.labels[userValue] ?? String(userValue);
    }
    return String(userValue);
  }

  function buildParamEntry(param: KeyboardParameter, userValue: number): ParamState {
    const entry: ParamState = {
      value: userValue,
      label: labelFor(param, userValue),
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if (param.displayName) entry.displayName = param.displayName;
    if (param.encoding.kind === "drawbar") {
      entry.position = userValue;
    }
    if ((param.type === "discrete" || param.type === "toggle") && param.labels) {
      entry.index = userValue;
    }
    if (param.type === "discrete" && param.labels) {
      entry.labels = param.labels;
    }
    return entry;
  }

  function buildPresetDrawbarEntries(presetKey: "preset1" | "preset2"): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.encoding.kind !== "drawbar") continue;
      const userValue = presetDrawbars[presetKey][key] ?? codec.wireToUserValue(key, param.defaultValue);
      result[key] = {
        value: userValue,
        label: String(userValue),
        section: param.section,
        type: param.type,
        position: userValue,
      };
    }
    return result;
  }

  function isRotaryBothForced(): boolean {
    const lowerEng = getUserValue("part_lower_engine_select", 0);
    const upperEng = getUserValue("part_upper_engine_select", 1);
    const ampType = globalParams["spkr_comp_type"];
    return lowerEng === 0 && upperEng === 0 && ampType === AMP_ROTARY_INDEX;
  }

  function buildFullState(
    lastChangeKey?: string,
    lastChangePart?: string,
    includeInventory = false,
  ): Record<string, any> {
    const lower: Record<string, ParamState> = {};
    const upper: Record<string, ParamState> = {};
    const global: Record<string, ParamState> = {};

    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.perPart) {
        lower[key] = buildParamEntry(param, getUserValue(key, 0));
        upper[key] = buildParamEntry(param, getUserValue(key, 1));
      } else {
        global[key] = buildParamEntry(param, getUserValue(key, 0));
      }
    }

    // Amp/Rotary edge case override
    if (isRotaryBothForced() && global.spkr_comp_part_select) {
      global.spkr_comp_part_select = {
        ...global.spkr_comp_part_select,
        label: "Both",
        index: 2,
      };
    }

    const msg: Record<string, any> = {
      lower,
      upper,
      global,
      preset1Drawbars: buildPresetDrawbarEntries("preset1"),
      preset2Drawbars: buildPresetDrawbarEntries("preset2"),
      presetOrganToggles,
      setListMode,
      currentSetList,
      currentSong,
      currentPart,
      currentBank,
      currentProgram,
      programLoaded,
    };

    if (programLoaded) {
      const bank = currentBank + 1;
      const slot = currentProgram + 1;
      const prog = _backup?.programs.find((p: any) => p.bank === bank && p.slot === currentProgram);
      msg.program = { bank, slot, name: prog?.name };
    }

    if (setListMode) {
      const { prog, entry } = resolveSetListSong(currentSetList, currentSong, currentPart);
      msg.setList = {
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

    if (includeInventory) {
      msg.pianoModels = _pianoModels;
      msg.sampleNames = _sampleNames;
    }

    if (_lastProgramChange) {
      msg.lastProgramChange = _lastProgramChange;
      _lastProgramChange = undefined;
    }

    if (lastChangeKey && PARAMS[lastChangeKey]) {
      const param = PARAMS[lastChangeKey];
      const partIdx: 0 | 1 = lastChangePart === "upper" ? 1 : 0;
      const userValue = getUserValue(lastChangeKey, partIdx);
      msg.lastChange = {
        key: lastChangeKey,
        name: param.name,
        value: userValue,
        label: labelFor(param, userValue),
        part: lastChangePart,
      };
    }

    return msg;
  }

  // ══════════════════════════════════════════
  //  Backup / inventory / programs
  // ══════════════════════════════════════════

  function buildInventoryFromCache(): void {
    _backup = getBackupData(activeLabel);
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
      const models = getPianoModelsForType(type, activeLabel);
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

  function applyProgramParams(params: ProgramParams): void {
    resetState();

    presetOrganToggles = {
      pst1Vib: params.pst1VibratoEnable,
      pst1Prc: params.pst1PercussionEnable,
      pst2Vib: params.pst2VibratoEnable,
      pst2Prc: params.pst2PercussionEnable,
    };

    for (const [key, get] of PROGRAM_PARAM_MAP) {
      const param = PARAMS[key];
      if (!param) continue;
      const raw = get(params);
      let userValue: number;
      try {
        if (typeof raw === "boolean") {
          userValue = raw ? 1 : 0;
        } else if (typeof raw === "string") {
          userValue = codec.normalizeUserValue(key, raw);
        } else {
          userValue = codec.normalizeUserValue(key, raw);
        }
      } catch {
        continue;
      }
      // Write to both parts for perPart, else global.
      if (param.perPart) {
        parts[0].params[key] = userValue;
        parts[1].params[key] = userValue;
      } else {
        globalParams[key] = userValue;
      }
    }

    // sample_synth_sample stored as raw slot (one-based encoding inverse).
    // The backup parser hands us a raw 0-based slot; user-domain for a
    // one-based encoding is wire+1, so we store slot+1 to keep round-trip.
    const sampleParam = PARAMS.sample_synth_sample;
    if (sampleParam) {
      const userValue = codec.wireToUserValue("sample_synth_sample", params.sampleSlot);
      if (sampleParam.perPart) {
        parts[0].params["sample_synth_sample"] = userValue;
        parts[1].params["sample_synth_sample"] = userValue;
      } else {
        globalParams["sample_synth_sample"] = userValue;
      }
    }

    applyDrawbars("preset1", params.pst1Drawbars);
    applyDrawbars("preset2", params.pst2Drawbars);
  }

  function applyDrawbars(presetKey: "preset1" | "preset2", drawbarStr: string): void {
    if (drawbarStr === "?" || !drawbarStr) return;
    for (let i = 0; i < drawbarStr.length && i < 9; i++) {
      const pos = parseInt(drawbarStr[i], 10);
      if (isNaN(pos)) continue;
      const key = `drawbar_${i + 1}`;
      if (!PARAMS[key]) continue;
      // Drawbar user value is the position (0-8).
      presetDrawbars[presetKey][key] = pos;
      // Also propagate to current part state so broadcast lower/upper see it.
      parts[0].params[key] = pos;
      parts[1].params[key] = pos;
    }
  }

  function resolveSetListSong(bankIdx: number, songIdx: number, partIdx: number) {
    const bank = bankIdx + 1;
    const entry = _backup?.setLists.find((s: any) => s.bank === bank && s.slot === songIdx);
    if (!entry) return { prog: undefined, entry: undefined };
    const ref = entry.programs[partIdx];
    if (!ref) return { prog: undefined, entry };
    const prog = _backup?.programs.find((p: any) => p.bank === ref.bank && p.slot === ref.slot);
    return { prog, entry };
  }

  function loadSetListPart(bankIdx: number, songIdx: number, partIdx: number): string {
    const { prog } = resolveSetListSong(bankIdx, songIdx, partIdx);
    if (prog?.params) {
      applyProgramParams(prog.params);
      return `Set List: Bank ${bankIdx + 1} Song ${songIdx + 1} Part ${PART_LABELS[partIdx]} → ${prog.name ?? "?"} (${prog.bank}:${prog.slot + 1})`;
    }
    return `Set List: Bank ${bankIdx + 1} Song ${songIdx + 1} Part ${PART_LABELS[partIdx]} → no program found`;
  }

  function loadProgram(bank: number, slot: number): MockHandlerResult {
    if (setListMode) {
      currentSong = slot;
      currentPart = 0;
      const log = loadSetListPart(currentSetList, currentSong, currentPart);
      return { state: buildFullState(), log };
    }

    currentBank = bank;
    currentProgram = slot;
    programLoaded = true;
    const bankNum = currentBank + 1;
    const slotNum = currentProgram + 1;
    const prog = _backup?.programs.find((p: any) => p.bank === bankNum && p.slot === currentProgram);
    const name = prog?.name ? ` (${prog.name})` : "";

    let log: string;
    if (prog?.params) {
      applyProgramParams(prog.params);
      log = `Program ${bankNum}:${slotNum}${name} — applied ${Object.keys(prog.params).length} params`;
    } else {
      log = `Program ${bankNum}:${slotNum}${name} — no cached params`;
    }

    _lastProgramChange = { bank: bankNum, slot: slotNum, name: prog?.name };
    return { state: buildFullState(), log };
  }

  // ══════════════════════════════════════════
  //  MockHandler implementation
  // ══════════════════════════════════════════

  const handler: MockHandler = {
    codec,
    init(_lower: number, _upper: number, label?: string): void {
      activeLabel = label;
      resetState();
      backupCache.load(activeLabel);
      buildInventoryFromCache();
    },

    set_params(refs: ParamRef[]): MockHandlerResult {
      return applySet(refs);
    },

    get_params(names: string[], part?: number): Record<string, number> {
      return readParams(names, part);
    },

    load_program(bank: number, slot: number): MockHandlerResult {
      return loadProgram(bank, slot);
    },

    get_active_engine(part: number): string | undefined {
      return getActiveEngine(part);
    },

    set_active_engine(part: number, engine: string): MockHandlerResult {
      return setActiveEngine(part, engine);
    },

    getFullState(includeInventory: boolean): Record<string, any> {
      return buildFullState(undefined, undefined, includeInventory);
    },

    onCacheReload(): void {
      console.log("Reloading backup cache...");
      if (backupCache.reload(activeLabel)) {
        buildInventoryFromCache();
        console.log(`Backup cache reloaded: ${_backup?.programs.length ?? 0} programs, ${_backup?.samples.length ?? 0} samples`);
      } else {
        console.log("No backup cache file found on disk");
      }
    },

    setFullState(snapshot: Record<string, any>): void {
      // Best-effort tolerant restore (plan #9). Inputs are user-domain
      // ParamState objects (matching what buildParamEntry emits).
      try {
        const restoreSection = (partIdx: 0 | 1 | "global", section: any) => {
          if (!section || typeof section !== "object") return;
          for (const [key, ps] of Object.entries<any>(section)) {
            const param = PARAMS[key];
            if (!param) continue;
            if (!ps || typeof ps !== "object" || typeof ps.value !== "number") continue;
            if (partIdx === "global") {
              globalParams[key] = ps.value;
            } else {
              parts[partIdx].params[key] = ps.value;
            }
          }
        };
        restoreSection(0, snapshot.lower);
        restoreSection(1, snapshot.upper);
        restoreSection("global", snapshot.global);

        // Sync the active-preset pointer from the restored organ_preset_select
        // value (perPart). Otherwise post-restore drawbar/vibrato/percussion
        // writes route to the pre-restore preset.
        const restoredPreset = parts[0].params["organ_preset_select"];
        if (restoredPreset !== undefined) {
          activePreset = restoredPreset >= 1 ? 2 : 1;
        }

        const restorePreset = (presetKey: "preset1" | "preset2", entries: any) => {
          if (!entries || typeof entries !== "object") return;
          presetDrawbars[presetKey] = {};
          for (const [key, ps] of Object.entries<any>(entries)) {
            const param = PARAMS[key];
            if (!param || param.encoding.kind !== "drawbar") continue;
            if (ps && typeof ps === "object" && typeof ps.value === "number") {
              presetDrawbars[presetKey][key] = ps.value;
            }
          }
        };
        if (snapshot.preset1Drawbars !== undefined) restorePreset("preset1", snapshot.preset1Drawbars);
        if (snapshot.preset2Drawbars !== undefined) restorePreset("preset2", snapshot.preset2Drawbars);

        if (snapshot.presetOrganToggles && typeof snapshot.presetOrganToggles === "object") {
          presetOrganToggles = {
            pst1Vib: !!snapshot.presetOrganToggles.pst1Vib,
            pst1Prc: !!snapshot.presetOrganToggles.pst1Prc,
            pst2Vib: !!snapshot.presetOrganToggles.pst2Vib,
            pst2Prc: !!snapshot.presetOrganToggles.pst2Prc,
          };
        }

        if (typeof snapshot.setListMode === "boolean") setListMode = snapshot.setListMode;
        if (typeof snapshot.currentSetList === "number") currentSetList = snapshot.currentSetList;
        if (typeof snapshot.currentSong === "number") currentSong = snapshot.currentSong;
        if (typeof snapshot.currentPart === "number") currentPart = snapshot.currentPart;
        if (typeof snapshot.currentBank === "number") currentBank = snapshot.currentBank;
        if (typeof snapshot.currentProgram === "number") currentProgram = snapshot.currentProgram;
        if (typeof snapshot.programLoaded === "boolean") programLoaded = snapshot.programLoaded;
      } catch (err) {
        console.error("Nord setFullState: partial recovery —", err);
      }
    },
  };

  // PERPART_KEYS is currently unused (perPart is read off PARAMS directly).
  // Keeping it for future routing helpers; void here to satisfy lint.
  void PERPART_KEYS;

  return handler;
}

// ── Program param map (drives applyProgramParams for cached programs) ──

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
