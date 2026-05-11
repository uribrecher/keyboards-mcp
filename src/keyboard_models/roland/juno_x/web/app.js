// Roland JUNO-X — Web UI Client

// ── State ──

let activePart = 1;
let lastState = null;

// ── WebSocket ──

let ws = null;
let reconnectTimer = null;

function connect() {
  // Per-tab WS port — see Nord app.js for context.
  const wsPort = new URLSearchParams(location.search).get("wsPort") || "3000";
  const wsUrl = location.protocol === "file:"
    ? `ws://localhost:${wsPort}`
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onclose = () => {
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    handleState(JSON.parse(event.data));
  };
}

// ── State handler ──

function handleState(data) {
  lastState = data;
  // Scene display
  if (data.scene !== undefined) {
    const num = data.scene.program !== undefined ? data.scene.program + 1 : 1;
    const padded = String(num).padStart(2, "0");
    const numEl = document.getElementById("val-scene-number");
    const nameEl = document.getElementById("val-scene-name");
    if (numEl) numEl.textContent = padded;
    if (nameEl) nameEl.textContent = `Scene ${padded}`;
  }

  // Update engine selector display from active part's engine
  const partData = data["part" + activePart];
  if (partData) {
    updateEngineSelect(partData);
    updatePartParams(partData);
  }

  // Mirror scene-global FX switches into UI button states.
  if (data.params) syncFxUI(data.params);
}

// ── Scene-global FX state → UI button mirror ──

function syncFxUI(params) {
  // Chorus mode disambiguation depends on todo #11 (chorus_mode wiring);
  // for now: switch off → OFF, switch on → first non-OFF button.
  const chorusOn = (params.chorus_switch ?? 0) > 0;
  const chorusButtons = document.querySelectorAll("button.fx-chorus[data-mode]");
  let alreadyActive = false;
  for (const b of chorusButtons) {
    if (b.classList.contains("active") && b.dataset.mode !== "OFF") {
      alreadyActive = true;
      break;
    }
  }
  for (const b of chorusButtons) {
    const isOff = b.dataset.mode === "OFF";
    if (chorusOn) {
      if (alreadyActive) {
        b.classList.toggle("active", b.classList.contains("active") && !isOff);
      } else {
        b.classList.toggle("active", b.dataset.mode === "I");
      }
    } else {
      b.classList.toggle("active", isOff);
    }
  }

  // FX toggle buttons (delay/reverb/drive)
  for (const el of document.querySelectorAll("button.tog-btn[data-fx]")) {
    const fx = el.dataset.fx;
    const paramName = fx + "_switch";
    const isOn = (params[paramName] ?? 0) > 0;
    el.classList.toggle("active", isOn);
  }
}

// ── Engine selector ──

function updateEngineSelect(partData) {
  if (!partData.engine) return;
  const sel = document.getElementById("engine-select");
  if (!sel) return;
  // Only update if the value actually differs (avoid fighting user input)
  if (sel.value !== partData.engine) {
    sel.value = partData.engine;
  }
  // Show/hide panels
  for (const opt of sel.options) {
    const panelId = "panel-" + opt.value;
    const panel = document.getElementById(panelId);
    if (panel) {
      panel.classList.toggle("hidden", opt.value !== partData.engine);
    }
  }
}

// ── Slider / value display update ──

/**
 * `partData.params` is keyed by canonical param name (e.g. `cutoff`),
 * matching widget `data-param` attributes. Values are user-domain —
 * continuous params equal the slider 0-127; scaled discretes are the
 * index, not the wire byte.
 */
function updateControlLabels(partData) {
  // Override hardcoded HTML labels with displayName from the midi-map.
  // The curated HTML labels (e.g. "PW", "SAW") are the fallback when
  // displayName is absent, cached in `data-default-label`.
  const params = partData.params;
  if (!params) return;
  for (const target of document.querySelectorAll("[data-param]")) {
    const name = target.dataset.param;
    if (!name) continue;
    const slot = labelSlotFor(target);
    if (!slot) continue;
    if (slot.dataset.defaultLabel === undefined) {
      slot.dataset.defaultLabel = slot.textContent;
    }
    const entry = params[name];
    const next = entry && entry.displayName ? entry.displayName : slot.dataset.defaultLabel;
    slot.textContent = next;
  }
}

function labelSlotFor(target) {
  if (target.tagName === "BUTTON") return target;
  if (!target.id) return null;
  return document.querySelector(`label[for="${target.id}"]`);
}

function updatePartParams(partData) {
  updateControlLabels(partData);
  const params = partData.params;
  if (!params) return;

  for (const [name, entry] of Object.entries(params)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry.value;

    const slider = document.querySelector(`[data-param="${name}"].vslider`);
    if (slider) slider.value = value;

    const selectEl = document.querySelector(`select[data-param="${name}"]`);
    if (selectEl) {
      let bestOpt = null;
      let bestDist = Infinity;
      for (const opt of selectEl.options) {
        const dist = Math.abs(parseInt(opt.value, 10) - value);
        if (dist < bestDist) { bestDist = dist; bestOpt = opt; }
      }
      if (bestOpt) selectEl.value = bestOpt.value;
    }

    const valEl = document.getElementById("val-" + name);
    if (valEl) valEl.textContent = value;
  }
}

// ── Part button switching ──

function initPartButtons() {
  for (const btn of document.querySelectorAll("button.part-btn[data-part]")) {
    btn.addEventListener("click", () => {
      activePart = parseInt(btn.dataset.part, 10);
      // Update active button styling
      for (const b of document.querySelectorAll("button.part-btn[data-part]")) {
        b.classList.toggle("active", b === btn);
      }
      // Re-render from the last known state so sliders/labels reflect the
      // newly-selected part immediately, without waiting for a fresh broadcast.
      if (lastState) {
        const partData = lastState["part" + activePart];
        if (partData) {
          updateEngineSelect(partData);
          updatePartParams(partData);
        }
      }
    });
  }
}

// ── Outgoing controls ──

function initSliderControls() {
  for (const el of document.querySelectorAll("input.vslider[data-param]")) {
    el.addEventListener("input", () => {
      const name = el.dataset.param;
      const value = parseInt(el.value, 10);
      const valEl = document.getElementById("val-" + name);
      if (valEl) valEl.textContent = value;
      sendUIParam(name, value);
    });
  }
}

function initSelectControls() {
  for (const el of document.querySelectorAll("select[data-param]")) {
    el.addEventListener("change", () => {
      const name = el.dataset.param;
      const value = parseInt(el.value, 10);
      const valEl = document.getElementById("val-" + name);
      if (valEl) valEl.textContent = value;
      sendUIParam(name, value);
    });
  }
}

function initToggleButtons() {
  for (const el of document.querySelectorAll("button.tog-btn[data-param]")) {
    el.addEventListener("click", () => {
      el.classList.toggle("active");
      const name = el.dataset.param;
      const isOn = el.classList.contains("active");
      // Toggles use 0/1 user-domain values; the codec scales to wire bytes.
      const value = isOn ? 1 : 0;
      sendUIParam(name, value);
    });
  }
}

function initChorusButtons() {
  // Chorus mode values for JUNO Chorus (type 09):
  // OFF=switch off, I/II/I+II = switch on + mode
  const CHORUS_MODES = { "OFF": 0, "I": 1, "II": 2, "I+II": 3 };
  const buttons = document.querySelectorAll("button.fx-chorus[data-mode]");
  for (const el of buttons) {
    el.addEventListener("click", () => {
      for (const b of buttons) b.classList.remove("active");
      el.classList.add("active");
      const mode = el.dataset.mode;
      // Send chorus switch + mode as a UI param message
      sendUIParam("chorus_switch", mode === "OFF" ? 0 : 1);
      if (mode !== "OFF") {
        sendUIParam("chorus_mode", CHORUS_MODES[mode] ?? 1);
      }
    });
  }
}

function initFxButtons() {
  // Map FX button data-fx to scene param names
  const FX_PARAMS = { delay: "delay_switch", reverb: "reverb_switch", drive: "drive_switch" };
  for (const el of document.querySelectorAll("button.tog-btn[data-fx]")) {
    el.addEventListener("click", () => {
      el.classList.toggle("active");
      const fx = el.dataset.fx;
      const isOn = el.classList.contains("active");
      const paramName = FX_PARAMS[fx];
      if (paramName) {
        sendUIParam(paramName, isOn ? 1 : 0);
      }
    });
  }
}

/** Send a named parameter value from the UI. */
function sendUIParam(name, value) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "setParam", name, value, part: activePart }));
}

function initEngineSwitch() {
  const sel = document.getElementById("engine-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const value = sel.value;
    for (const panel of document.querySelectorAll(".synth-panel")) {
      panel.classList.add("hidden");
    }
    const target = document.getElementById("panel-" + value);
    if (target) target.classList.remove("hidden");
  });
}

// ── Init ──

initPartButtons();
connect();
initSliderControls();
initSelectControls();
initToggleButtons();
initChorusButtons();
initFxButtons();
initEngineSwitch();
