// Nord Electro 5D — Web UI Client (bi-timbral)

// Engine value to section name mapping
const ENGINE_MAP = { 0: "organ", 1: "piano", 2: "sample_synth" };

// Knob display scales for FX/AMP/Reverb/Delay/EQ knobs
const KNOB_SCALES = {
  effect1_rate: { min: 0, max: 10, unit: "", decimals: 1 },
  spkr_comp_drive: { min: 0, max: 10, unit: "", decimals: 1 },
  reverb_dry_wet: { min: 0, max: 10, unit: "", decimals: 1 },
  delay_dry_wet: { min: 0, max: 10, unit: "", decimals: 1 },
  eq_bass: { min: -15, max: 15, unit: "dB", decimals: 1 },
  eq_mid: { min: -15, max: 15, unit: "dB", decimals: 1 },
  eq_mid_freq: { min: 200, max: 8000, unit: "Hz", decimals: 0 },
  eq_treble: { min: -15, max: 15, unit: "dB", decimals: 1 },
};

// Model MIDI to index decode (matches MODEL_TO_MIDI in nord-electro-5d-map.ts)
const MODEL_MIDI_STARTS = [0, 3, 6, 8, 11, 13, 16, 18, 21];
function midiToModelIdx(midiValue) {
  for (let i = MODEL_MIDI_STARTS.length - 1; i >= 0; i--) {
    if (midiValue >= MODEL_MIDI_STARTS[i]) return i;
  }
  return 0;
}

// Piano models per type — populated dynamically from inventory via WebSocket.
// Falls back to numeric indices (e.g., "#1") when inventory is not loaded.
let PIANO_MODELS = {};

let SAMPLE_NAMES = [];

// Last resolved names for program bar display
let lastPianoName = "";
let lastSampleName = "";

function updateInventoryData(data) {
  if (data.pianoModels) PIANO_MODELS = data.pianoModels;
  if (data.sampleNames) SAMPLE_NAMES = data.sampleNames;
}

function updateProgram(program) {
  const el = document.getElementById("val-program");
  if (!el) return;
  if (!program) {
    el.textContent = "-";
    return;
  }
  const loc = `${program.bank}:${program.slot}`;
  el.textContent = program.name ? `${loc} — ${program.name}` : loc;
}

function updateSetList(setList) {
  const bar = document.getElementById("display-program");
  if (!bar) return;

  if (!setList || !setList.mode) {
    bar.classList.remove("setlist-mode");
    return;
  }

  bar.classList.add("setlist-mode");
  document.getElementById("setlist-line1").textContent = `SET LIST #${setList.listNumber}  ${setList.part}`;
  const songLabel = setList.songName
    ? `#${setList.songNumber} ${setList.songName}`
    : `#${setList.songNumber}`;
  document.getElementById("setlist-line2").textContent = songLabel;

  // Also update program display with the resolved program
  if (setList.programName) {
    const el = document.getElementById("val-program");
    if (el) el.textContent = `${setList.programBank}:${setList.programSlot} — ${setList.programName}`;
  }
}

// ── WebSocket ──

let ws = null;
let reconnectTimer = null;

function connect() {
  // When loaded via file:// (Electron), location.host is empty — use localhost:3000
  const wsUrl = location.protocol === "file:"
    ? "ws://localhost:3000"
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onclose = () => {
    // Mark MCP as unknown when we lose our own connection
    const mcpEl = document.getElementById("mcp-status");
    mcpEl.className = "status disconnected";
    mcpEl.textContent = "DISCONNECTED";
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.mcpConnected !== undefined) {
      const mcpEl = document.getElementById("mcp-status");
      if (data.mcpConnected) {
        mcpEl.className = "status connected";
        mcpEl.textContent = "MCP CONNECTED";
      } else {
        mcpEl.className = "status disconnected";
        mcpEl.textContent = "MCP DISCONNECTED";
      }
    }
    updateInventoryData(data);
    initStaticUIFromState(data);
    updateProgram(data.program);
    updateSetList(data.setList);
    updateUI(data);
  };
}

// ── Initialize selectors and static labels from incoming state ──

let staticLabelsBuilt = false;

function buildParamLookupFromState(data) {
  // Walk all parts of the state and return a flat key→entry map (first wins).
  const lookup = {};
  for (const source of [data.global, data.upper, data.lower]) {
    if (!source) continue;
    for (const [key, entry] of Object.entries(source)) {
      if (!lookup[key]) lookup[key] = entry;
    }
  }
  return lookup;
}

function initSelectorsFromState(paramLookup) {
  for (const [key, entry] of Object.entries(paramLookup)) {
    if (entry?.type !== "discrete" || !entry.labels) continue;
    const el = document.getElementById(`sel-${key}`);
    if (!el) continue;
    el.innerHTML = "";
    for (const [val, label] of Object.entries(entry.labels)) {
      const btn = document.createElement("div");
      btn.className = "sel-btn";
      btn.dataset.value = val;
      btn.textContent = label;
      el.appendChild(btn);
    }
  }
}

function initControlLabelsFromState(paramLookup) {
  // Override hardcoded HTML knob/control labels with displayName from the
  // midi-map. Only overrides when displayName is set — the curated HTML
  // labels are kept as the fallback so long param names don't blow out
  // narrow slots.
  for (const target of document.querySelectorAll("[data-param]")) {
    const key = target.dataset.param;
    const entry = paramLookup[key];
    if (!entry?.displayName) continue;
    const parent = target.parentElement;
    if (!parent) continue;
    const label = parent.querySelector(":scope > .knob-label");
    if (label) label.textContent = entry.displayName;
  }
}

function initStaticUIFromState(data) {
  if (staticLabelsBuilt) return;
  const lookup = buildParamLookupFromState(data);
  initSelectorsFromState(lookup);
  initControlLabelsFromState(lookup);
  staticLabelsBuilt = true;
}

// ── Update UI from state message ──

function updateUI(data) {
  // Engine params from upper part data (global channel maps to upper on mock device)
  updateEngineParams(data);

  // Per-preset organ toggles (vibrato/percussion enable)
  if (data.presetOrganToggles) {
    const t = data.presetOrganToggles;
    document.getElementById("led-pst1-vib")?.classList.toggle("on", t.pst1Vib);
    document.getElementById("led-pst1-prc")?.classList.toggle("on", t.pst1Prc);
    document.getElementById("led-pst2-vib")?.classList.toggle("on", t.pst2Vib);
    document.getElementById("led-pst2-prc")?.classList.toggle("on", t.pst2Prc);
  }

  if (data.global) updateGlobalParams(data.global);

  // Show/hide engine sections: piano and sample_synth always visible, organ based on engine select
  const lowerEngine = data.global && data.global.part_lower_engine_select;
  const upperEngine = data.global && data.global.part_upper_engine_select;
  const lowerIdx = lowerEngine ? (lowerEngine.index ?? lowerEngine.value) : 0;
  const upperIdx = upperEngine ? (upperEngine.index ?? upperEngine.value) : 0;

  // All engine sections always visible, but dim if no enabled part uses that engine
  const lowerEnabled = data.global?.part_lower_enable ? data.global.part_lower_enable.value > 0 : true;
  const upperEnabled = data.global?.part_upper_enable ? data.global.part_upper_enable.value > 0 : true;
  const activeEngines = new Set();
  if (lowerEnabled) activeEngines.add(lowerIdx);
  if (upperEnabled) activeEngines.add(upperIdx);
  for (const [idx, name] of Object.entries(ENGINE_MAP)) {
    const el = document.getElementById(`engine-${name}`);
    if (!el) continue;
    el.classList.add("active");
    el.classList.toggle("disabled", !activeEngines.has(Number(idx)));
  }

  // Dim part columns when part is disabled
  document.querySelector(".parts-col-left")?.classList.toggle("disabled", !lowerEnabled);
  document.querySelector(".parts-col-right")?.classList.toggle("disabled", !upperEnabled);

  // Update program bar sub-lines (piano/synth names, empty if disabled)
  const pianoActive = activeEngines.has(1); // 1 = piano
  const synthActive = activeEngines.has(2); // 2 = sample_synth
  const pianoSubEl = document.getElementById("val-program-piano");
  const synthSubEl = document.getElementById("val-program-synth");
  if (pianoSubEl) pianoSubEl.textContent = pianoActive ? lastPianoName : "";
  if (synthSubEl) synthSubEl.textContent = synthActive ? lastSampleName : "";

  // Update part-select indicators on effects
  const partSelectParams = [
    "effect1_part_select",
    "effect2_part_select",
    "spkr_comp_part_select",
    "delay_part_select",
    "eq_part_select",
  ];
  for (const ps of partSelectParams) {
    const indicator = document.getElementById(`pi-${ps}`);
    if (!indicator || !data.global || !data.global[ps]) continue;
    const idx = data.global[ps].index ?? data.global[ps].value;
    const labelMap = { 0: "Lower", 1: "Upper", 2: "Both" };
    const classMap = { 0: "lower", 1: "upper", 2: "both" };
    indicator.textContent = labelMap[idx] || "Both";
    const baseClass = indicator.classList.contains("part-indicator-vertical") ? "part-indicator-vertical" : "part-indicator";
    indicator.className = baseClass + " " + (classMap[idx] || "both");
  }

  // Last change
  if (data.lastChange) {
    const lc = data.lastChange;
    const partLabel = lc.part && lc.part !== "global" ? ` [${lc.part}]` : "";
    document.getElementById("last-change").textContent =
      `${lc.name} = ${lc.label} (CC${lc.cc} = ${lc.value})${partLabel}`;

    flashParam(lc.key, lc.part);
  }

  // Program change
  if (data.lastProgramChange) {
    const pc = data.lastProgramChange;
    const name = pc.name ? ` — ${pc.name}` : "";
    document.getElementById("last-change").textContent =
      `Program Change: ${pc.bank}:${pc.slot}${name}`;
  }
}

function updateEngineParams(data) {
  // Read engine params from the upper part data (primary, since global channel maps to upper on mock device)
  const params = data.upper;
  if (!params) return;

  // Organ model display (green panel like piano model)
  if (params.organ_model) {
    const organLabels = { 0: "B3", 1: "B3+Bass", 2: "Pipe", 3: "Vox", 4: "Farfisa" };
    const idx = params.organ_model.index ?? params.organ_model.value;
    const el = document.getElementById("val-organ_model");
    if (el) el.textContent = organLabels[idx] || "B3";
  }

  // Selectors (engine params, now global IDs)
  const engineSelectors = [
    "vibrato_type", "percussion_harmonic",
    "piano_type", "piano_kbd_touch", "sample_synth_dynamics",
  ];
  for (const param of engineSelectors) {
    const el = document.getElementById(`sel-${param}`);
    if (!el || !params[param]) continue;
    const idx = params[param].index ?? params[param].value;
    for (const btn of el.children) {
      btn.classList.toggle("active", parseInt(btn.dataset.value) === idx);
    }
  }

  // Preset active indicator
  if (params.organ_preset_select) {
    const presetIdx = params.organ_preset_select.index ?? params.organ_preset_select.value;
    const led1 = document.getElementById("led-preset1-active");
    const led2 = document.getElementById("led-preset2-active");
    if (led1) led1.classList.toggle("on", presetIdx === 0);
    if (led2) led2.classList.toggle("on", presetIdx === 1);
  }

  // Percussion speed/level display
  if (params.percussion_speed_level) {
    const percLabels = { 0: "SLOW/NORM", 1: "FAST/NORM", 2: "SLOW/SOFT", 3: "FAST/SOFT" };
    const idx = params.percussion_speed_level.index ?? params.percussion_speed_level.value;
    const valEl = document.getElementById("val-percussion_speed_level");
    if (valEl) valEl.textContent = percLabels[idx] || "S/N";
  }

  // LEDs (engine params, now global IDs)
  const engineLeds = ["organ_drawbar_live", "piano_mono", "sample_synth_filter_vel"];
  for (const id of engineLeds) {
    const el = document.getElementById(`led-${id}`);
    if (!el || !params[id]) continue;
    el.classList.toggle("on", params[id].value > 0);
  }

  // Piano Acoustics — bitmask: bit 0 = String Resonance, bit 1 = Long Release
  if (params.piano_acoustic) {
    const val = params.piano_acoustic.index ?? params.piano_acoustic.value;
    document.getElementById("led-piano_acoustic_strres")?.classList.toggle("on", (val & 1) !== 0);
    document.getElementById("led-piano_acoustic_longrel")?.classList.toggle("on", (val & 2) !== 0);
  }

  // Drawbars — per-preset data from state message
  const organModelIdx = params.organ_model ? (params.organ_model.index ?? params.organ_model.value) : 0;
  const isFarfisa = organModelIdx === 4;

  for (const preset of ["preset1", "preset2"]) {
    const rack = document.getElementById(`drawbar-rack-${preset}`);
    if (rack) rack.classList.toggle("toggle-mode", isFarfisa);

    // Use per-preset drawbar data if available
    const presetData = preset === "preset1" ? data.preset1Drawbars : data.preset2Drawbars;
    const drawbarSource = presetData || params;

    for (let i = 1; i <= 9; i++) {
      const key = `drawbar_${i}`;
      if (!drawbarSource[key]) continue;
      const pos = drawbarSource[key].position ?? 0;
      const pct = (pos / 8) * 100;
      const dbEl = document.getElementById(`drawbar-${preset}-${i}`);
      if (!dbEl) continue;
      const fill = dbEl.querySelector(".drawbar-fill");
      const cap = dbEl.querySelector(".drawbar-cap");
      const valEl = dbEl.querySelector(".drawbar-value");

      if (isFarfisa) {
        const midiVal = drawbarSource[key].value;
        const isOn = midiVal >= 64;
        dbEl.classList.toggle("toggle-on", isOn);
        if (fill) fill.style.height = isOn ? "100%" : "0%";
        if (cap) cap.style.top = "0";
        if (valEl) valEl.textContent = isOn ? "ON" : "OFF";
      } else {
        dbEl.classList.remove("toggle-on");
        // Ensure minimum visible height for non-zero values
        const fillPct = pos === 0 ? 0 : Math.max(20, pct);
        if (fill) fill.style.height = `${fillPct}%`;
        if (cap) cap.style.top = `${pos === 0 ? 0 : Math.max(0, fillPct - 12)}%`;
        if (valEl) valEl.textContent = String(pos);
      }
    }
  }

  // Piano model display (section shows #N, full name stored for program bar)
  if (params.piano_type) {
    const typeIdx = params.piano_type.index ?? params.piano_type.value;
    const models = PIANO_MODELS[typeIdx] || [];
    let modelIdx = 0;
    if (typeIdx === 4) {
      if (params.piano_model) modelIdx = midiToModelIdx(params.piano_model.value);
      const baseName = models[modelIdx] || `#${modelIdx + 1}`;
      const varIdx = params.piano_variation ? midiToModelIdx(params.piano_variation.value) : 0;
      const varLetter = "ABCD"[varIdx] || "A";
      lastPianoName = `${baseName} ${varLetter}`;
    } else {
      if (params.piano_model) modelIdx = midiToModelIdx(params.piano_model.value);
      lastPianoName = models[modelIdx] || `#${modelIdx + 1}`;
    }
    const el = document.getElementById("val-piano_model");
    if (el) el.textContent = typeIdx === 4 ? ("ABCD"[params.piano_variation ? midiToModelIdx(params.piano_variation.value) : 0] || "A") : `#${modelIdx + 1}`;
  }

  // Knobs (engine params)
  const engineKnobs = [
    "sample_synth_attack", "sample_synth_release",
  ];
  for (const param of engineKnobs) {
    const el = document.getElementById(`knob-${param}`);
    if (!el || !params[param]) continue;
    const value = params[param].value;
    updateKnob(el, value, 127);

    // Update value label
    const valEl = document.getElementById(`val-${param}`);
    if (valEl) {
      if (param === "sample_synth_attack") {
        // Interpolated from hardware measurements (cc → ms)
        const attackTable = [
          [0, 0.5], [10, 3], [20, 13], [40, 126], [64, 1020],
          [79, 3000], [93, 7300], [99, 10000], [117, 27000], [127, 45000],
        ];
        let ms = attackTable[attackTable.length - 1][1];
        for (let j = 0; j < attackTable.length - 1; j++) {
          if (value <= attackTable[j + 1][0]) {
            const [x0, y0] = attackTable[j];
            const [x1, y1] = attackTable[j + 1];
            ms = y0 + (y1 - y0) * (value - x0) / (x1 - x0);
            break;
          }
        }
        if (ms < 1000) valEl.textContent = `${ms.toFixed(1)}ms`;
        else valEl.textContent = `${(ms / 1000).toFixed(2)}s`;
      } else if (param === "sample_synth_release") {
        // Three zones: decay (0-63), sustain (64), release (65-127)
        const labelEl = document.getElementById("label-sample_synth_release");
        if (value === 64) {
          if (labelEl) labelEl.textContent = "SUSTAIN";
          valEl.textContent = "";
        } else if (value < 64) {
          if (labelEl) labelEl.textContent = "DECAY";
          const decayTable = [
            [0, 3], [10, 39], [20, 244], [41, 4610], [63, 43000],
          ];
          let ms = decayTable[decayTable.length - 1][1];
          for (let j = 0; j < decayTable.length - 1; j++) {
            if (value <= decayTable[j + 1][0]) {
              const [x0, y0] = decayTable[j];
              const [x1, y1] = decayTable[j + 1];
              ms = y0 + (y1 - y0) * (value - x0) / (x1 - x0);
              break;
            }
          }
          valEl.textContent = ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
        } else {
          if (labelEl) labelEl.textContent = "RELEASE";
          const relTable = [
            [65, 3], [80, 120], [90, 545], [100, 2210], [110, 7270], [120, 20000], [127, 39000],
          ];
          let ms = relTable[relTable.length - 1][1];
          for (let j = 0; j < relTable.length - 1; j++) {
            if (value <= relTable[j + 1][0]) {
              const [x0, y0] = relTable[j];
              const [x1, y1] = relTable[j + 1];
              ms = y0 + (y1 - y0) * (value - x0) / (x1 - x0);
              break;
            }
          }
          valEl.textContent = ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
        }
      } else {
        const scaled = (value / 127) * 100;
        valEl.textContent = `${Math.round(scaled)}%`;
      }
    }
  }

  // Sample display (section shows #N, full name stored for program bar)
  if (params.sample_synth_sample) {
    const valEl = document.getElementById("val-sample_synth_sample");
    if (valEl) {
      const slot = params.sample_synth_sample.value;
      lastSampleName = SAMPLE_NAMES[slot] || `#${slot + 1}`;
      valEl.textContent = `#${slot + 1}`;
    }
  }
}

function updateGlobalParams(params) {
  // Global selectors
  const globalSelectors = [
    "effect1_type", "effect2_type", "spkr_comp_type", "reverb_type", "delay_feedback",
  ];
  for (const param of globalSelectors) {
    const el = document.getElementById(`sel-${param}`);
    if (!el || !params[param]) continue;
    const idx = params[param].index ?? params[param].value;
    for (const btn of el.children) {
      btn.classList.toggle("active", parseInt(btn.dataset.value) === idx);
    }
  }

  // Split point display
  const splitEnabled = params.kb_split_mode ? params.kb_split_mode.value > 0 : false;
  if (params.kb_split_point) {
    const splitLabels = { 0: "C3", 1: "F3", 2: "C4", 3: "F4", 4: "C5", 5: "F5" };
    const idx = params.kb_split_point.index ?? params.kb_split_point.value;
    const valEl = document.getElementById("val-kb_split_point");
    if (valEl) {
      valEl.textContent = splitLabels[idx] || "C4";
      const splitDisplay = valEl.closest(".display");
      if (splitDisplay) splitDisplay.classList.toggle("dimmed", !splitEnabled);
    }
  }

  // Engine select displays
  const engineLabels = { 0: "Organ", 1: "Piano", 2: "Synth" };
  for (const part of ["lower", "upper"]) {
    const key = `part_${part}_engine_select`;
    if (!params[key]) continue;
    const idx = params[key].index ?? params[key].value;
    const valEl = document.getElementById(`val-${key}`);
    if (valEl) valEl.textContent = engineLabels[idx] || "Organ";
  }

  // Global LEDs
  const globalLeds = [
    "effect1_enable", "effect1_ctrl_pedal", "effect2_enable", "effect2_deep",
    "spkr_comp_enable", "rotary_stop_mode",
    "reverb_enable", "delay_enable", "delay_ping_pong",
    "eq_enable",
    "kb_split_mode",
    "sustain_pedal_enable_lower", "sustain_pedal_enable_upper",
    "ctrl_pedal_enable_lower", "ctrl_pedal_enable_upper",
    "transpose_enable",
  ];
  for (const id of globalLeds) {
    const el = document.getElementById(`led-${id}`);
    if (!el || !params[id]) continue;
    el.classList.toggle("on", params[id].value > 0);
  }

  // Toggle disabled state on effects units based on their enable param
  for (const unit of document.querySelectorAll(".effects-unit[data-enable]")) {
    const enableKey = unit.dataset.enable;
    if (!enableKey || !params[enableKey]) continue;
    unit.classList.toggle("disabled", params[enableKey].value === 0);
  }

  // Octave shift indicators (discrete index 0-13, display = index - 7)
  for (const part of ["lower", "upper"]) {
    const key = `octave_shift_${part}`;
    if (!params[key]) continue;
    const valEl = document.getElementById(`val-${key}`);
    if (!valEl) continue;
    const idx = params[key].index ?? params[key].value;
    const shift = idx - 7;
    valEl.textContent = shift > 0 ? `+${shift}` : String(shift);
    valEl.closest(".part-octave-display")?.classList.toggle("shifted", shift !== 0);
  }

  // Transpose indicator (discrete index 0-12, display = index - 6 semitones)
  const transposeEnabled = params.transpose_enable ? params.transpose_enable.value > 0 : false;
  const transposeEl = document.getElementById("val-transpose_amount");
  if (transposeEl && params.transpose_amount) {
    const idx = params.transpose_amount.index ?? params.transpose_amount.value;
    const semitones = idx - 6;
    transposeEl.textContent = semitones > 0 ? `+${semitones}` : String(semitones);
    const transposeDisplay = transposeEl.closest(".display");
    if (transposeDisplay) transposeDisplay.classList.toggle("dimmed", !transposeEnabled);
  }

  // Global knobs
  const globalKnobs = [
    "effect1_rate", "effect2_rate",
    "spkr_comp_drive",
    "reverb_dry_wet",
    "delay_dry_wet",
    "eq_bass", "eq_mid", "eq_mid_freq", "eq_treble",
    "part_mix",
  ];
  for (const param of globalKnobs) {
    const el = document.getElementById(`knob-${param}`);
    if (!el || !params[param]) continue;
    const value = params[param].value;
    updateKnob(el, value, 127);

    // Update numeric value display
    if (param === "part_mix") {
      // 0=Lower(50/0), 64=center(50/50), 127=Upper(0/50)
      let lower, upper;
      if (value <= 64) {
        lower = 50;
        upper = (value / 64) * 50;
      } else {
        lower = ((127 - value) / 63) * 50;
        upper = 50;
      }
      const lowerEl = document.getElementById("val-part_mix_lower");
      const upperEl = document.getElementById("val-part_mix_upper");
      if (lowerEl) lowerEl.textContent = lower.toFixed(1);
      if (upperEl) upperEl.textContent = upper.toFixed(1);
    }
    const valEl = document.getElementById(`val-${param}`);
    if (valEl) {
      if (param === "effect2_rate") {
        // FX2 rate scale depends on type: Chorus 1-2 = 0-2.7Hz, others = 0-10.5Hz
        const fx2TypeIdx = params.effect2_type ? (params.effect2_type.index ?? params.effect2_type.value) : 0;
        const isChorus = fx2TypeIdx === 3 || fx2TypeIdx === 4; // CHOR1=3, CHOR2=4
        const maxHz = isChorus ? 2.7 : 10.5;
        const scaled = (value / 127) * maxHz;
        valEl.textContent = `${scaled.toFixed(1)} Hz`;
      } else if (KNOB_SCALES[param]) {
        const scale = KNOB_SCALES[param];
        const scaled = scale.min + (value / 127) * (scale.max - scale.min);
        const formatted = scaled.toFixed(scale.decimals);
        valEl.textContent = scale.unit ? `${formatted} ${scale.unit}` : formatted;
      }
    }
  }

  // Rotary — stop mode replaces slow with stop (fast still works)
  if (params.rotary_speed) {
    const fast = params.rotary_speed.value >= 64;
    const stopMode = params.rotary_stop_mode && params.rotary_stop_mode.value > 0;
    if (stopMode && !fast) {
      document.getElementById("val-rotary_speed").textContent = "STOP";
    } else {
      document.getElementById("val-rotary_speed").textContent = fast ? "FAST" : "SLOW";
    }
  }

  // Delay tempo (text display only)
  if (params.delay_tempo) {
    const valEl = document.getElementById("val-delay_tempo");
    if (valEl) valEl.textContent = String(params.delay_tempo.value);
  }

  // Master volume (gain knob)
  if (params.master_volume) {
    const vol = params.master_volume.value;
    const el = document.getElementById("knob-master_volume");
    if (el) updateKnob(el, vol, 127);
    const valEl = document.getElementById("val-master_volume");
    if (valEl) valEl.textContent = String(vol);
  }
}

function updateKnob(el, value, max) {
  const indicator = el.querySelector(".knob-indicator");
  if (!indicator) return;
  // Map 0-max to -135deg to +135deg (270 degree range)
  const angle = -135 + (value / max) * 270;
  indicator.style.transform = `translateX(-50%) rotate(${angle}deg)`;
}

function flashParam(key, part) {
  // Try global (unprefixed) IDs first for engine params
  const globalTargets = [
    document.getElementById(`knob-${key}`),
    document.getElementById(`sel-${key}`),
    document.getElementById(`led-${key}`),
  ];
  for (const el of globalTargets) {
    if (el) {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      return;
    }
  }

  // Drawbars with preset prefix (flash both presets)
  if (key.startsWith("drawbar_")) {
    const idx = key.split("_")[1];
    for (const preset of ["preset1", "preset2"]) {
      const el = document.getElementById(`drawbar-${preset}-${idx}`);
      if (el) {
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
      }
    }
    return;
  }
}

// ── Chat ──

const AGENT_URL = "http://localhost:3001";
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatReset = document.getElementById("chat-reset");
let chatBusy = false;

// ── Chat history persistence ──
function saveChatHistory() {
  const entries = [];
  for (const msg of chatMessages.children) {
    const role = msg.classList.contains("user") ? "user" : "assistant";
    const bubble = msg.querySelector(".chat-bubble");
    const tool = msg.querySelector(".chat-tool");
    if (bubble) {
      entries.push({ type: "message", role, text: bubble.textContent });
    } else if (tool) {
      entries.push({ type: "tool", error: tool.classList.contains("error"), text: tool.textContent });
    }
  }
  localStorage.setItem("nord-chat-history", JSON.stringify(entries));
}

function loadChatHistory() {
  const saved = localStorage.getItem("nord-chat-history");
  if (!saved) return;
  try {
    const entries = JSON.parse(saved);
    chatMessages.innerHTML = "";
    for (const entry of entries) {
      if (entry.type === "message") {
        addChatMessage(entry.role, entry.text, true);
      } else if (entry.type === "tool") {
        const msg = document.createElement("div");
        msg.className = "chat-msg assistant";
        const tool = document.createElement("div");
        tool.className = `chat-tool${entry.error ? " error" : ""}`;
        tool.textContent = entry.text;
        msg.appendChild(tool);
        chatMessages.appendChild(msg);
      }
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch {}
}

function addChatMessage(role, content, skipSave) {
  const msg = document.createElement("div");
  msg.className = `chat-msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = content;
  msg.appendChild(bubble);
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (!skipSave) saveChatHistory();
  return bubble;
}

function addToolCall(name, input) {
  const msg = document.createElement("div");
  msg.className = "chat-msg assistant";
  const tool = document.createElement("div");
  tool.className = "chat-tool";
  const inputSummary = summarizeToolInput(name, input);
  tool.textContent = `\u{1F527} ${name}${inputSummary}`;
  msg.appendChild(tool);
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  saveChatHistory();
}

function addToolResult(name, result, isError) {
  const msg = document.createElement("div");
  msg.className = "chat-msg assistant";
  const tool = document.createElement("div");
  tool.className = `chat-tool${isError ? " error" : ""}`;
  const text = result.length > 200 ? result.substring(0, 200) + "..." : result;
  tool.textContent = `\u{2192} ${text}`;
  msg.appendChild(tool);
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  saveChatHistory();
}

function summarizeToolInput(name, input) {
  if (name === "set_parameters" && input.parameters) {
    return ` (${input.parameters.length} params)`;
  }
  if (name === "connect_to_nord" && input.port !== undefined) {
    return ` (port ${input.port})`;
  }
  if (name === "apply_patch" && input.preset_name) {
    return ` ("${input.preset_name}")`;
  }
  return "";
}

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || chatBusy) return;

  chatBusy = true;
  chatInput.disabled = true;
  chatSend.disabled = true;
  chatInput.value = "";

  addChatMessage("user", message);

  // Create assistant bubble for streaming text
  let assistantBubble = null;
  let assistantText = "";

  try {
    const res = await fetch(`${AGENT_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ") && eventType) {
          const data = JSON.parse(line.slice(6));

          if (eventType === "text") {
            if (!assistantBubble) {
              assistantBubble = addChatMessage("assistant", "");
              assistantText = "";
            }
            assistantText += data.text;
            assistantBubble.textContent = assistantText;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (eventType === "tool_use") {
            // Reset bubble for next text block
            assistantBubble = null;
            assistantText = "";
            addToolCall(data.name, data.input);
          } else if (eventType === "tool_result") {
            addToolResult(data.name, data.result, data.isError);
          } else if (eventType === "error") {
            addChatMessage("assistant", `Error: ${data.error}`);
          }
          eventType = null;
        }
      }
    }
  } catch (err) {
    addChatMessage("assistant", `Connection error: ${err.message}. Is the agent running on port 3001?`);
  }

  saveChatHistory();
  chatBusy = false;
  chatInput.disabled = false;
  chatSend.disabled = false;
  chatInput.focus();
}

chatSend.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

chatReset.addEventListener("click", async () => {
  try {
    await fetch(`${AGENT_URL}/reset`, { method: "POST" });
  } catch {}
  chatMessages.innerHTML = "";
  localStorage.removeItem("nord-chat-history");
  addChatMessage("assistant", "Conversation reset. How can I help?");
});

// ── Re-Extract ──
const reExtractBtn = document.getElementById("re-extract-btn");

async function openBackupPath() {
  // Electron: native dialog returns absolute path
  if (window.mockRunnerAPI) {
    return await window.mockRunnerAPI.openBackupDialog();
  }
  // Browser fallback: not supported (no full path access)
  addChatMessage("assistant", "File picker requires the Electron app. Run with `npm run mock:runner`.\nAlternatively, ask me in chat to extract a specific backup path.");
  return null;
}

async function doReExtract(payload) {
  reExtractBtn.classList.add("loading");
  reExtractBtn.textContent = "EXTRACTING…";
  try {
    const res = await fetch(`${AGENT_URL}/re-extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : "",
    });
    const data = await res.json();

    if (data.error === "no_path") {
      // No cached path — open native file/folder dialog
      const path = await openBackupPath();
      if (path) {
        doReExtract({ path });
      }
      return;
    }
    if (data.error) {
      addChatMessage("assistant", `Re-extract failed: ${data.message || data.error}`);
      return;
    }

    // Success — tell the mock device to reload its cache
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "reload-cache" }));
    }
    addChatMessage("assistant", `Backup re-extracted:\n${data.summary}`);
  } catch (err) {
    addChatMessage("assistant", `Re-extract error: ${err.message}. Is the agent running on port 3001?`);
  } finally {
    reExtractBtn.classList.remove("loading");
    reExtractBtn.textContent = "RE-EXTRACT";
  }
}

reExtractBtn.addEventListener("click", () => {
  if (reExtractBtn.classList.contains("loading")) return;
  doReExtract();
});

// ── Init ──
loadChatHistory();
connect();
