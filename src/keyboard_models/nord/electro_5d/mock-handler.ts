/**
 * Nord Electro 5D mock device handler.
 *
 * Encapsulates all Nord-specific mock behavior: drawbar preset routing,
 * vibrato/percussion per-preset toggles, program param application,
 * set list handling, and inventory data.
 */

import type { MockHandler, MockContext } from "../../../shared/keyboard-model.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import {
  midiToDrawbar,
  midiToDiscrete,
  drawbarToMidi,
  resolveValue,
} from "../../../shared/parameter-resolution.js";
import { PARAMS } from "./midi-map.js";
import type { ProgramParams } from "./backup-parser.js";
import {
  createBackupCache,
  getBackupData,
  getPianoModelsForType,
} from "./backup-cache.js";

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

export function createNordElectro5DMockHandler(): MockHandler {
  // ── Closure-scoped state ──

  const backupCache = createBackupCache();

  // Per-preset drawbar state
  const presetDrawbarState = new Map<string, Map<number, number>>([
    ["preset1", new Map()],
    ["preset2", new Map()],
  ]);

  // Per-preset organ toggles
  let presetOrganToggles = {
    pst1Vib: false, pst1Prc: false,
    pst2Vib: false, pst2Prc: false,
  };

  // Program state
  let currentBank = 0;
  let currentProgram = 0;
  let programLoaded = false;

  // Set list state
  let setListMode = false;
  let currentSetList = 0;
  let currentSong = 0;
  let currentPart = 0;
  const PART_LABELS = ["A", "B", "C", "D"] as const;

  // CC numbers for special handling
  const PRESET_SELECT_CC = PARAMS.organ_preset_select.cc;
  const CC_SETLIST_MODE = PARAMS.program_setlist_mode.cc;
  const CC_SETLIST_PART = PARAMS.setlist_part_select.cc;
  const VIBRATO_ENABLE_CC = PARAMS.vibrato_enable.cc;
  const PERCUSSION_CC = PARAMS.percussion.cc;
  const CC_LOWER_ENGINE = PARAMS.part_lower_engine_select.cc;
  const CC_UPPER_ENGINE = PARAMS.part_upper_engine_select.cc;
  const CC_AMP_TYPE = PARAMS.spkr_comp_type.cc;
  const AMP_ROTARY_MIDI = resolveValue(PARAMS.spkr_comp_type, 4);

  // Drawbar CC set
  const DRAWBAR_CCS = new Set<number>();
  for (const param of Object.values(PARAMS)) {
    if (param.encoding.kind === "drawbar") DRAWBAR_CCS.add(param.cc);
  }

  // Inventory data
  let _backup = getBackupData();
  let _pianoModels: Record<string, string[]> | undefined;
  let _sampleNames: string[] | undefined;

  // Keep track of the last program change for broadcast
  let _lastProgramChange: { bank: number; slot: number; name?: string } | undefined;

  // ── Helpers ──

  function getActivePreset(ctx: MockContext): string {
    const ch0 = ctx.channelState.get(ctx.lowerChannel);
    const presetVal = ch0?.get(PRESET_SELECT_CC) ?? 0;
    return presetVal >= 64 ? "preset2" : "preset1";
  }

  function initChannel(ch: number, ctx: MockContext): void {
    const chState = new Map<number, number>();
    for (const param of Object.values(PARAMS)) {
      chState.set(param.cc, param.defaultValue);
    }
    ctx.channelState.set(ch, chState);
  }

  function isRotaryBothForced(ctx: MockContext): boolean {
    const ch = ctx.channelState.get(ctx.lowerChannel)!;
    const lowerEngine = ch.get(CC_LOWER_ENGINE) ?? 0;
    const upperEngine = ch.get(CC_UPPER_ENGINE) ?? 0;
    const ampType = ch.get(CC_AMP_TYPE) ?? 0;
    return lowerEngine === 0 && upperEngine === 0 && ampType === AMP_ROTARY_MIDI;
  }

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

  function applyProgramParams(params: ProgramParams, ctx: MockContext): void {
    initChannel(ctx.lowerChannel, ctx);
    initChannel(ctx.upperChannel, ctx);
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
      ctx.channelState.get(ctx.lowerChannel)!.set(param.cc, midiVal);
      ctx.channelState.get(ctx.upperChannel)!.set(param.cc, midiVal);
    }

    // sample_synth_sample: write raw slot (bypass oneBased encoding)
    const sampleParam = PARAMS.sample_synth_sample;
    if (sampleParam) {
      ctx.channelState.get(ctx.lowerChannel)!.set(sampleParam.cc, params.sampleSlot);
      ctx.channelState.get(ctx.upperChannel)!.set(sampleParam.cc, params.sampleSlot);
    }

    applyDrawbars("preset1", params.pst1Drawbars, ctx);
    applyDrawbars("preset2", params.pst2Drawbars, ctx);
  }

  function applyDrawbars(presetKey: string, drawbarStr: string, ctx: MockContext): void {
    if (drawbarStr === "?" || !drawbarStr) return;
    const presetMap = presetDrawbarState.get(presetKey);
    if (!presetMap) return;
    for (let i = 0; i < drawbarStr.length && i < 9; i++) {
      const pos = parseInt(drawbarStr[i], 10);
      if (isNaN(pos)) continue;
      const param = PARAMS[`drawbar_${i + 1}`];
      if (!param) continue;
      const midiVal = drawbarToMidi(pos, 9);
      presetMap.set(param.cc, midiVal);
      ctx.channelState.get(ctx.lowerChannel)!.set(param.cc, midiVal);
      ctx.channelState.get(ctx.upperChannel)!.set(param.cc, midiVal);
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

  function loadSetListPart(bankIdx: number, songIdx: number, partIdx: number, ctx: MockContext): void {
    const { prog } = resolveSetListSong(bankIdx, songIdx, partIdx);
    if (prog?.params) {
      applyProgramParams(prog.params, ctx);
      console.log(`Set List: Bank ${bankIdx + 1} Song ${songIdx + 1} Part ${PART_LABELS[partIdx]} → ${prog.name ?? "?"} (${prog.bank}:${prog.slot + 1})`);
    } else {
      console.log(`Set List: Bank ${bankIdx + 1} Song ${songIdx + 1} Part ${PART_LABELS[partIdx]} → no program found`);
    }
  }

  function buildPresetDrawbarEntries(presetKey: string): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, param] of Object.entries(PARAMS)) {
      if (param.encoding.kind !== "drawbar") continue;
      const midiValue = presetDrawbarState.get(presetKey)!.get(param.cc) ?? param.defaultValue;
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

  // ── MockHandler implementation ──

  return {
    init(ctx: MockContext): void {
      backupCache.load();
      buildInventoryFromCache();
    },

    onCC(cc: number, value: number, channel: number, ctx: MockContext): { handled?: boolean } | void {
      // Bank Select MSB — ignore
      if (cc === 0) {
        console.log(`MIDI: Bank Select MSB = ${value} (ch${channel})`);
        return { handled: true };
      }

      // Bank Select LSB — routes to bank or set list
      if (cc === 32) {
        if (setListMode) {
          currentSetList = value;
          console.log(`MIDI: Bank Select LSB = ${value} → Set List ${value + 1} (ch${channel})`);
        } else {
          currentBank = value;
          console.log(`MIDI: Bank Select LSB = ${value} → Bank ${value + 1} (ch${channel})`);
        }
        return { handled: true };
      }

      // CC48: Program/Set List mode toggle
      if (cc === CC_SETLIST_MODE) {
        setListMode = value >= 64;
        console.log(`MIDI: Mode → ${setListMode ? "Set List" : "Program"} (CC${cc}=${value})`);
        return { handled: true };
      }

      // CC49: Set List part select (A/B/C/D)
      if (cc === CC_SETLIST_PART && setListMode) {
        currentPart = midiToDiscrete(value, 3);
        loadSetListPart(currentSetList, currentSong, currentPart, ctx);
        return { handled: true };
      }

      // Route drawbar CCs to active preset state
      if (DRAWBAR_CCS.has(cc)) {
        presetDrawbarState.get(getActivePreset(ctx))!.set(cc, value);
      }

      // Route vibrato/percussion enable to active preset toggles
      if (cc === VIBRATO_ENABLE_CC || cc === PERCUSSION_CC) {
        const preset = getActivePreset(ctx);
        const on = value > 0;
        if (cc === VIBRATO_ENABLE_CC) {
          if (preset === "preset1") presetOrganToggles.pst1Vib = on;
          else presetOrganToggles.pst2Vib = on;
        } else {
          if (preset === "preset1") presetOrganToggles.pst1Prc = on;
          else presetOrganToggles.pst2Prc = on;
        }
      }

      // Let the engine handle the generic channelState update
      return;
    },

    onProgramChange(program: number, channel: number, ctx: MockContext): void {
      if (setListMode) {
        currentSong = program;
        currentPart = 0;
        loadSetListPart(currentSetList, currentSong, currentPart, ctx);
        return;
      }

      currentProgram = program;
      programLoaded = true;
      const bank = currentBank + 1;
      const slot = currentProgram + 1;
      const prog = _backup?.programs.find((p: any) => p.bank === bank && p.slot === currentProgram);
      const name = prog?.name ? ` (${prog.name})` : "";

      if (prog?.params) {
        applyProgramParams(prog.params, ctx);
        console.log(`MIDI: Program ${bank}:${slot}${name} — applied ${Object.keys(prog.params).length} params (ch${channel})`);
      } else {
        console.log(`MIDI: Program ${bank}:${slot}${name} — no cached params (ch${channel})`);
      }

      _lastProgramChange = { bank, slot, name: prog?.name };
    },

    getExtraState(includeInventory: boolean, ctx: MockContext): Record<string, any> {
      const extra: Record<string, any> = {
        preset1Drawbars: buildPresetDrawbarEntries("preset1"),
        preset2Drawbars: buildPresetDrawbarEntries("preset2"),
        presetOrganToggles,
      };

      // Amp/Rotary edge case override
      if (isRotaryBothForced(ctx)) {
        extra.globalOverrides = {
          spkr_comp_part_select: { label: "Both", index: 2 },
        };
      }

      if (programLoaded) {
        const bank = currentBank + 1;
        const slot = currentProgram + 1;
        const prog = _backup?.programs.find((p: any) => p.bank === bank && p.slot === currentProgram);
        extra.program = { bank, slot, name: prog?.name };
      }

      if (setListMode) {
        const { prog, entry } = resolveSetListSong(currentSetList, currentSong, currentPart);
        extra.setList = {
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
        extra.pianoModels = _pianoModels;
        extra.sampleNames = _sampleNames;
      }

      if (_lastProgramChange) {
        extra.lastProgramChange = _lastProgramChange;
        _lastProgramChange = undefined;
      }

      return extra;
    },

    onCacheReload(ctx: MockContext): void {
      console.log("Reloading backup cache...");
      if (backupCache.reload()) {
        buildInventoryFromCache();
        console.log(`Backup cache reloaded: ${_backup?.programs.length ?? 0} programs, ${_backup?.samples.length ?? 0} samples`);
      } else {
        console.log("No backup cache file found on disk");
      }
    },
  };
}
