// Roland JUNO-X — Web UI Client

// ── State ──

let activePart = 1;
let firstMessage = true;

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
    const mcpEl = document.getElementById("mcp-status");
    mcpEl.className = "status disconnected";
    mcpEl.textContent = "MCP DISCONNECTED";
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (firstMessage) {
      firstMessage = false;
      const footer = document.getElementById("last-change");
      if (footer && footer.textContent === "—") {
        footer.textContent = "Connected";
      }
    }
    handleState(data);
  };
}

// ── State handler ──

function handleState(data) {
  // MCP connection badge
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

function updateControlLabels(partData) {
  // Override hardcoded HTML labels with displayName from the midi-map.
  //
  // The curated HTML labels (e.g. "PW", "SAW") are the fallback when
  // displayName is absent, so we don't paste long param names like
  // "OSC PW Level" into slim columns. We cache the original text once in
  // data-default-label so we can restore it when the active part/engine
  // brings a CC into view that has no displayName (otherwise stale text
  // from a previous engine would persist).
  const params = partData.params;
  if (!params) return;
  for (const target of document.querySelectorAll("[data-cc]")) {
    const cc = parseInt(target.dataset.cc, 10);
    if (isNaN(cc)) continue;
    const slot = labelSlotFor(target);
    if (!slot) continue;
    if (slot.dataset.defaultLabel === undefined) {
      slot.dataset.defaultLabel = slot.textContent;
    }
    const entry = params["cc" + cc];
    const isObj = typeof entry === "object" && entry !== null;
    const next = isObj && entry.displayName ? entry.displayName : slot.dataset.defaultLabel;
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

  for (const [key, entry] of Object.entries(params)) {
    // key is like "cc3", "cc9", etc.
    if (!key.startsWith("cc")) continue;
    const cc = parseInt(key.slice(2), 10);
    if (isNaN(cc)) continue;

    // Entry can be a plain number (legacy/unknown CC) or an object with metadata
    const value = typeof entry === "object" && entry !== null ? entry.value : entry;

    // Update range slider
    const slider = document.querySelector(`[data-cc="${cc}"].vslider`);
    if (slider) {
      slider.value = value;
    }

    // Update select with matching data-cc (e.g. HPF, LFO waveform)
    const selectEl = document.querySelector(`select[data-cc="${cc}"]`);
    if (selectEl) {
      // Find closest option value
      let bestOpt = null;
      let bestDist = Infinity;
      for (const opt of selectEl.options) {
        const dist = Math.abs(parseInt(opt.value, 10) - value);
        if (dist < bestDist) {
          bestDist = dist;
          bestOpt = opt;
        }
      }
      if (bestOpt) selectEl.value = bestOpt.value;
    }

    // Update value display
    const valEl = document.getElementById("val-cc-" + cc);
    if (valEl) {
      valEl.textContent = value;
    }
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
    });
  }
}

// ── Outgoing controls ──

function sendCC(cc, value) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: "cc",
    controller: parseInt(cc, 10),
    value: parseInt(value, 10),
    channel: activePart - 1,
  }));
}

function setLastChange(text) {
  const el = document.getElementById("last-change");
  if (el) el.textContent = text;
}

function initSliderControls() {
  for (const el of document.querySelectorAll("input.vslider[data-cc]")) {
    el.addEventListener("input", () => {
      const cc = el.dataset.cc;
      const value = el.value;
      const valEl = document.getElementById("val-cc-" + cc);
      if (valEl) valEl.textContent = value;
      sendCC(cc, value);
      setLastChange(`CC${cc} = ${value} (Part ${activePart})`);
    });
  }
}

function initSelectControls() {
  for (const el of document.querySelectorAll("select[data-cc]")) {
    el.addEventListener("change", () => {
      const cc = el.dataset.cc;
      const value = parseInt(el.value, 10);
      const valEl = document.getElementById("val-cc-" + cc);
      if (valEl) valEl.textContent = value;
      sendCC(cc, value);
      setLastChange(`CC${cc} = ${value} (Part ${activePart})`);
    });
  }
}

function initToggleButtons() {
  for (const el of document.querySelectorAll("button.tog-btn[data-cc]")) {
    el.addEventListener("click", () => {
      el.classList.toggle("active");
      const cc = el.dataset.cc;
      const isOn = el.classList.contains("active");
      const value = isOn
        ? parseInt(el.dataset.valOn ?? "127", 10)
        : parseInt(el.dataset.valOff ?? "0", 10);
      sendCC(cc, value);
      setLastChange(`CC${cc} = ${value} (Part ${activePart})`);
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
      setLastChange(`Chorus = ${mode}`);
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
      setLastChange(`${fx} = ${isOn ? "ON" : "OFF"}`);
    });
  }
}

/** Send a named parameter value from the UI (for SysEx-addressed params that don't have CCs) */
function sendUIParam(name, value) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "param", name: name, value: value }));
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
    setLastChange(`Engine = ${value}`);
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
