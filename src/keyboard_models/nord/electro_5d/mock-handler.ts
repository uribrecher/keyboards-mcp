/**
 * Nord Electro 5D mock handler (V2 — thin engine architecture).
 *
 * Owns ALL state and logic: channel state, parameter formatting,
 * CC routing, program loading, and state message building.
 * The engine is just MIDI I/O + WebSocket broadcast.
 */

import type { MockHandler, MidiMessage, MockHandlerResult } from "../../../shared/keyboard-model.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import {
  midiToDrawbar,
  midiToDiscrete,
  drawbarToMidi,
  midiToModelIndex,
  resolveValue,
} from "../../../shared/parameter-resolution.js";
import { PARAMS } from "./midi-map.js";
import type { ProgramParams } from "./backup-parser.js";
import {
  createBackupCache,
  getBackupData,
  getPianoModelsForType,
} from "./backup-cache.js";

// ── Types ──

interface ParamState {
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

// ── Factory ──

export function createNordElectro5DMockHandler(): MockHandler {
  // ── Channels ──
  let lowerChannel = 1;
  let upperChannel = 2;
  const channelState = new Map<number, Map<number, number>>();

  // ── Backup cache ──
  const backupCache = createBackupCache();
  let activeLabel: string | undefined; // resolved at init() time

  // ── Per-preset drawbar state ──
  const presetDrawbarState = new Map<string, Map<number, number>>([
    ["preset1", new Map()],
    ["preset2", new Map()],
  ]);

  // ── Per-preset organ toggles ──
  let presetOrganToggles = {
    pst1Vib: false, pst1Prc: false,
    pst2Vib: false, pst2Prc: false,
  };

  // ── Program state ──
  let currentBank = 0;
  let currentProgram = 0;
  let programLoaded = false;

  // ── Set list state ──
  let setListMode = false;
  let currentSetList = 0;
  let currentSong = 0;
  let currentPart = 0;
  const PART_LABELS = ["A", "B", "C", "D"] as const;

  // ── CC numbers for special handling ──
  const PRESET_SELECT_CC = PARAMS.organ_preset_select.cc!;
  const CC_SETLIST_MODE = PARAMS.program_setlist_mode.cc!;
  const CC_SETLIST_PART = PARAMS.setlist_part_select.cc!;
  const VIBRATO_ENABLE_CC = PARAMS.vibrato_enable.cc!;
  const PERCUSSION_CC = PARAMS.percussion.cc!;
  const CC_LOWER_ENGINE = PARAMS.part_lower_engine_select.cc!;
  const CC_UPPER_ENGINE = PARAMS.part_upper_engine_select.cc!;
  const CC_AMP_TYPE = PARAMS.spkr_comp_type.cc!;
  const AMP_ROTARY_MIDI = resolveValue(PARAMS.spkr_comp_type, 4);

  // ── Drawbar CC set ──
  const DRAWBAR_CCS = new Set<number>();
  for (const param of Object.values(PARAMS)) {
    if (param.encoding.kind === "drawbar") DRAWBAR_CCS.add(param.cc!);
  }

  // ── Inventory data ──
  let _backup = getBackupData(activeLabel);
  let _pianoModels: Record<string, string[]> | undefined;
  let _sampleNames: string[] | undefined;
  let _lastProgramChange: { bank: number; slot: number; name?: string } | undefined;

  // ── Param lookup by CC ──
  const paramByCC = new Map<number, { key: string; param: KeyboardParameter }>();
  for (const [key, param] of Object.entries(PARAMS)) {
    paramByCC.set(param.cc!, { key, param });
  }

  // ── Param per-part lookup ──
  const perPartKeys = new Set<string>();
  for (const [key, param] of Object.entries(PARAMS)) {
    if (param.perPart) perPartKeys.add(key);
  }

  // ══════════════════════════════════════════
  //  Helpers (absorbed from engine + old handler)
  // ══════════════════════════════════════════

  function initChannel(ch: number): void {
    const chState = new Map<number, number>();
    for (const param of Object.values(PARAMS)) {
      chState.set(param.cc!, param.defaultValue);
    }
    channelState.set(ch, chState);
  }

  function getChannelValue(ch: number, cc: number, defaultVal: number): number {
    return channelState.get(ch)?.get(cc) ?? defaultVal;
  }

  function getActivePreset(): string {
    const ch0 = channelState.get(lowerChannel);
    const presetVal = ch0?.get(PRESET_SELECT_CC) ?? 0;
    return presetVal >= 64 ? "preset2" : "preset1";
  }

  function isRotaryBothForced(): boolean {
    const ch = channelState.get(lowerChannel)!;
    const le = ch.get(CC_LOWER_ENGINE) ?? 0;
    const ue = ch.get(CC_UPPER_ENGINE) ?? 0;
    const at = ch.get(CC_AMP_TYPE) ?? 0;
    return le === 0 && ue === 0 && at === AMP_ROTARY_MIDI;
  }

  function labelFor(param: KeyboardParameter, midiValue: number): string {
    if (param.encoding.kind === "drawbar") return String(midiToDrawbar(midiValue, param.encoding.positions));
    if (param.encoding.kind === "model-index") return `index ${midiToModelIndex(midiValue, param.encoding.table)}`;
    if (param.encoding.kind === "one-based") return String(midiValue + 1);
    if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
      const index = midiToDiscrete(midiValue, param.max);
      return param.labels[index] ?? String(midiValue);
    }
    return String(midiValue);
  }

  function buildParamEntry(param: KeyboardParameter, midiValue: number): ParamState {
    const entry: ParamState = {
      value: midiValue,
      label: labelFor(param, midiValue),
      name: param.name,
      section: param.section,
      type: param.type,
    };
    if (param.displayName) entry.displayName = param.displayName;
    if (param.encoding.kind === "drawbar") {
      entry.position = midiToDrawbar(midiValue, param.encoding.positions);
    }
    if ((param.type === "discrete" || param.type === "toggle") && param.labels) {
      entry.index = midiToDiscrete(midiValue, param.max);
    }
    if (param.type === "discrete" && param.labels) {
      entry.labels = param.labels;
    }
    return entry;
  }

  function buildPresetDrawbarEntries(presetKey: string): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.encoding.kind !== "drawbar") continue;
      const midiValue = presetDrawbarState.get(presetKey)!.get(param.cc!) ?? param.defaultValue;
      result[key] = {
        value: midiValue,
        label: String(midiToDrawbar(midiValue, param.encoding.positions)),
        section: param.section,
        type: param.type,
        position: midiToDrawbar(midiValue, param.encoding.positions),
      };
    }
    return result;
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
      if (perPartKeys.has(key)) {
        lower[key] = buildParamEntry(param, getChannelValue(lowerChannel, param.cc!, param.defaultValue));
        upper[key] = buildParamEntry(param, getChannelValue(upperChannel, param.cc!, param.defaultValue));
      } else {
        global[key] = buildParamEntry(param, getChannelValue(lowerChannel, param.cc!, param.defaultValue));
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
      // Raw set-list / program state — exposed so plan #9 setFullState can
      // round-trip without re-deriving from the cosmetic `setList` / `program`
      // blocks below.
      setListMode,
      currentSetList,
      currentSong,
      currentPart,
      currentBank,
      currentProgram,
      programLoaded,
    };

    // Program info
    if (programLoaded) {
      const bank = currentBank + 1;
      const slot = currentProgram + 1;
      const prog = _backup?.programs.find((p: any) => p.bank === bank && p.slot === currentProgram);
      msg.program = { bank, slot, name: prog?.name };
    }

    // Set list info
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

    // Inventory
    if (includeInventory) {
      msg.pianoModels = _pianoModels;
      msg.sampleNames = _sampleNames;
    }

    // Last program change notification
    if (_lastProgramChange) {
      msg.lastProgramChange = _lastProgramChange;
      _lastProgramChange = undefined;
    }

    // Last change notification
    if (lastChangeKey) {
      const cc = PARAMS[lastChangeKey]?.cc;
      const entry = cc != null ? paramByCC.get(cc) : undefined;
      if (entry) {
        const ch = lastChangePart === "upper" ? upperChannel : lowerChannel;
        const midiValue = getChannelValue(ch, entry.param.cc!, entry.param.defaultValue);
        msg.lastChange = {
          key: lastChangeKey,
          name: entry.param.name,
          cc: entry.param.cc,
          value: midiValue,
          label: labelFor(entry.param, midiValue),
          part: lastChangePart,
        };
      }
    }

    return msg;
  }

  // ── Backup/inventory helpers ──

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
    initChannel(lowerChannel);
    initChannel(upperChannel);
    for (const [, map] of presetDrawbarState) map.clear();

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
      let midiVal: number;
      if (typeof raw === "boolean") {
        midiVal = raw ? 127 : 0;
      } else if (typeof raw === "string") {
        try { midiVal = resolveValue(param, raw); } catch { continue; }
      } else {
        midiVal = resolveValue(param, raw);
      }
      channelState.get(lowerChannel)!.set(param.cc!, midiVal);
      channelState.get(upperChannel)!.set(param.cc!, midiVal);
    }

    // sample_synth_sample: write raw slot (bypass oneBased encoding)
    const sampleParam = PARAMS.sample_synth_sample;
    if (sampleParam) {
      channelState.get(lowerChannel)!.set(sampleParam.cc!, params.sampleSlot);
      channelState.get(upperChannel)!.set(sampleParam.cc!, params.sampleSlot);
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
      const param = PARAMS[`drawbar_${i + 1}`];
      if (!param) continue;
      const midiVal = drawbarToMidi(pos, 9);
      presetMap.set(param.cc!, midiVal);
      channelState.get(lowerChannel)!.set(param.cc!, midiVal);
      channelState.get(upperChannel)!.set(param.cc!, midiVal);
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

  // ══════════════════════════════════════════
  //  CC handling (absorbed from engine)
  // ══════════════════════════════════════════

  function handleCC(cc: number, value: number, channel: number): MockHandlerResult {
    // Bank Select MSB — ignore
    if (cc === 0) {
      return { log: `Bank Select MSB = ${value} (ch${channel})` };
    }

    // Bank Select LSB
    if (cc === 32) {
      if (setListMode) {
        currentSetList = value;
        return { state: buildFullState(), log: `Bank Select LSB = ${value} → Set List ${value + 1} (ch${channel})` };
      }
      currentBank = value;
      return { state: buildFullState(), log: `Bank Select LSB = ${value} → Bank ${value + 1} (ch${channel})` };
    }

    // CC48: Program/Set List mode toggle
    if (cc === CC_SETLIST_MODE) {
      setListMode = value >= 64;
      return { state: buildFullState(), log: `Mode → ${setListMode ? "Set List" : "Program"} (CC${cc}=${value})` };
    }

    // CC49: Set List part select
    if (cc === CC_SETLIST_PART && setListMode) {
      currentPart = midiToDiscrete(value, 3);
      const log = loadSetListPart(currentSetList, currentSong, currentPart);
      return { state: buildFullState(), log };
    }

    // Route drawbar CCs to active preset state
    if (DRAWBAR_CCS.has(cc)) {
      presetDrawbarState.get(getActivePreset())!.set(cc, value);
    }

    // Route vibrato/percussion enable to active preset toggles
    if (cc === VIBRATO_ENABLE_CC || cc === PERCUSSION_CC) {
      const preset = getActivePreset();
      const on = value > 0;
      if (cc === VIBRATO_ENABLE_CC) {
        if (preset === "preset1") presetOrganToggles.pst1Vib = on;
        else presetOrganToggles.pst2Vib = on;
      } else {
        if (preset === "preset1") presetOrganToggles.pst1Prc = on;
        else presetOrganToggles.pst2Prc = on;
      }
    }

    // Ensure channel state exists
    if (!channelState.has(channel)) initChannel(channel);
    channelState.get(channel)!.set(cc, value);

    // Determine part and propagate per-part params
    const entry = paramByCC.get(cc);
    const changeKey = entry?.key;
    let part = "global";

    if (entry && perPartKeys.has(entry.key)) {
      if (channel === lowerChannel) {
        // Global/lower channel: also update upper
        if (!channelState.has(upperChannel)) initChannel(upperChannel);
        channelState.get(upperChannel)!.set(cc, value);
        part = "upper";
      } else if (channel === upperChannel) {
        part = "upper";
      }
    }

    const desc = entry
      ? `${entry.param.name} = ${labelFor(entry.param, value)} (CC${cc}=${value} ch${channel} ${part})`
      : `CC${cc}=${value} ch${channel} [unmapped]`;

    return { state: buildFullState(changeKey, part), log: desc };
  }

  function handleProgramChange(program: number, channel: number): MockHandlerResult {
    if (setListMode) {
      currentSong = program;
      currentPart = 0;
      const log = loadSetListPart(currentSetList, currentSong, currentPart);
      return { state: buildFullState(), log };
    }

    currentProgram = program;
    programLoaded = true;
    const bank = currentBank + 1;
    const slot = currentProgram + 1;
    const prog = _backup?.programs.find((p: any) => p.bank === bank && p.slot === currentProgram);
    const name = prog?.name ? ` (${prog.name})` : "";

    let log: string;
    if (prog?.params) {
      applyProgramParams(prog.params);
      log = `Program ${bank}:${slot}${name} — applied ${Object.keys(prog.params).length} params (ch${channel})`;
    } else {
      log = `Program ${bank}:${slot}${name} — no cached params (ch${channel})`;
    }

    _lastProgramChange = { bank, slot, name: prog?.name };
    return { state: buildFullState(), log };
  }

  // ══════════════════════════════════════════
  //  MockHandler implementation
  // ══════════════════════════════════════════

  return {
    init(lower: number, upper: number, label?: string): void {
      lowerChannel = lower;
      upperChannel = upper;
      activeLabel = label;
      initChannel(lowerChannel);
      initChannel(upperChannel);
      backupCache.load(activeLabel);
      buildInventoryFromCache();
    },

    onMIDI(msg: MidiMessage): MockHandlerResult {
      switch (msg.type) {
        case "cc":
          return handleCC(msg.controller, msg.value, msg.channel);
        case "program":
          return handleProgramChange(msg.number, msg.channel);
        case "sysex":
          return { log: `SysEx (${msg.bytes.length} bytes) — ignored` };
      }
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
      // Best-effort tolerant restore (plan #9). Missing fields keep
      // current defaults; unknown fields are ignored. Never broadcast —
      // engine emits a single getFullState(true) after this returns.
      try {
        const restoreSection = (ch: number, section: any) => {
          if (!section || typeof section !== "object") return;
          if (!channelState.has(ch)) initChannel(ch);
          const chState = channelState.get(ch)!;
          for (const [paramKey, ps] of Object.entries<any>(section)) {
            const param = PARAMS[paramKey];
            if (!param || param.cc === undefined) continue;
            if (ps && typeof ps === "object" && typeof ps.value === "number") {
              chState.set(param.cc, ps.value);
            }
          }
        };
        restoreSection(lowerChannel, snapshot.lower);
        restoreSection(upperChannel, snapshot.upper);
        // Global params live on lowerChannel in the existing buildFullState.
        restoreSection(lowerChannel, snapshot.global);

        // Per-preset drawbars — buildFullState produces a Record keyed by
        // paramKey, with each entry holding a `value` field.
        const restorePreset = (presetKey: "preset1" | "preset2", entries: any) => {
          const map = presetDrawbarState.get(presetKey);
          if (!map) return;
          map.clear();
          if (!entries || typeof entries !== "object") return;
          for (const [paramKey, ps] of Object.entries<any>(entries)) {
            const param = PARAMS[paramKey];
            if (!param || param.cc === undefined || param.encoding.kind !== "drawbar") continue;
            if (ps && typeof ps === "object" && typeof ps.value === "number") {
              map.set(param.cc, ps.value);
            }
          }
        };
        if (snapshot.preset1Drawbars !== undefined) restorePreset("preset1", snapshot.preset1Drawbars);
        if (snapshot.preset2Drawbars !== undefined) restorePreset("preset2", snapshot.preset2Drawbars);

        // Preset organ toggles
        if (snapshot.presetOrganToggles && typeof snapshot.presetOrganToggles === "object") {
          presetOrganToggles = {
            pst1Vib: !!snapshot.presetOrganToggles.pst1Vib,
            pst1Prc: !!snapshot.presetOrganToggles.pst1Prc,
            pst2Vib: !!snapshot.presetOrganToggles.pst2Vib,
            pst2Prc: !!snapshot.presetOrganToggles.pst2Prc,
          };
        }

        // Set-list / program raw fields (only present when buildFullState
        // includes them — extension below).
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
}

// ── Program param map (shared with old handler) ──

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
