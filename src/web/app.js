// Nord Electro 5D — Web UI Client (bi-timbral)

// Parameter metadata (labels for selectors)
const PARAM_LABELS = {
  organ_model: { 0: "B3", 1: "Vox", 2: "Farf", 3: "Pipe" },
  vibrato_type: { 0: "V1", 1: "V2", 2: "V3", 3: "C1", 4: "C2", 5: "C3" },
  percussion_harmonic: { 0: "2nd", 1: "3rd" },
  percussion_speed_level: { 0: "F/N", 1: "F/S", 2: "S/N", 3: "S/S" },
  piano_type: { 0: "Grand", 1: "Uprght", 2: "EP1", 3: "EP2", 4: "Clav", 5: "Hpscd" },
  sample_synth_dynamics: { 0: "Off", 1: "Low", 2: "Mid", 3: "High" },
  effect1_type: { 0: "Tr1", 1: "Tr2", 2: "Tr3", 3: "Pn1", 4: "Pn2", 5: "Pn3", 6: "Wah", 7: "Ring" },
  effect2_type: { 0: "Ph1", 1: "Ph2", 2: "Flng", 3: "Ch1", 4: "Ch2", 5: "Vibe" },
  spkr_comp_type: { 0: "Small", 1: "Twin", 2: "JC", 3: "Rotary", 4: "Comp" },
  reverb_type: { 0: "Room", 1: "Stage", 2: "Hall", 3: "Stg Sft", 4: "Hll Sft" },
  part_lower_engine_select: { 0: "Organ", 1: "Piano", 2: "Samp" },
  part_upper_engine_select: { 0: "Organ", 1: "Piano", 2: "Samp" },
  kb_split_point: { 0: "C3", 1: "F3", 2: "C4", 3: "F4", 4: "C5", 5: "F5" },
};

// Engine value to section name mapping
const ENGINE_MAP = { 0: "organ", 1: "piano", 2: "sample_synth" };

// Piano models per type
const PIANO_MODELS = {
  0: ["Italian Grand", "Grand Lady D", "Studio Grand 2", "Bright Grand", "EGrand 3 Amped"],
  1: ["Grand Upright", "Mellow Upright", "Black Upright", "Queen Upright", "Romantic Upright", "Honeytonk Upright", "Saloon Upright"],
  2: ["EPiano1 Mk I", "EPiano2 Mk I", "EPiano3 MkII", "EPiano4 MkV", "EP5 Bright Tines", "EP6 Sparkle Top", "EPiano7 Mk I", "Wurlizer 1", "Wurlizer 2"],
  3: ["DX7 FullTines", "DigiGrand 1"],
  4: ["Clav D6 A", "Clav D6 B", "Clav D6 C", "Clav D6 D"],
  5: ["Ital Harpsi 1B", "French Harpsi 1D", "Ital Harpsi 1D"],
};

// ── WebSocket ──

let ws = null;
let reconnectTimer = null;

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    document.getElementById("connection-status").className = "status connected";
    document.getElementById("connection-status").textContent = "CONNECTED";
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onclose = () => {
    document.getElementById("connection-status").className = "status disconnected";
    document.getElementById("connection-status").textContent = "DISCONNECTED";
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateUI(data);
  };
}

// ── Initialize selectors (build button groups from metadata) ──

function initSelectors() {
  for (const [param, labels] of Object.entries(PARAM_LABELS)) {
    // Build for unprefixed (global) selector
    const el = document.getElementById(`sel-${param}`);
    if (el) {
      el.innerHTML = "";
      for (const [val, label] of Object.entries(labels)) {
        const btn = document.createElement("div");
        btn.className = "sel-btn";
        btn.dataset.value = val;
        btn.textContent = label;
        el.appendChild(btn);
      }
    }
    // Build for lower- and upper- prefixed selectors
    for (const part of ["lower", "upper"]) {
      const pel = document.getElementById(`sel-${part}-${param}`);
      if (!pel) continue;
      pel.innerHTML = "";
      for (const [val, label] of Object.entries(labels)) {
        const btn = document.createElement("div");
        btn.className = "sel-btn";
        btn.dataset.value = val;
        btn.textContent = label;
        pel.appendChild(btn);
      }
    }
  }
}

// ── Update UI from state message ──

function updateUI(data) {
  // New format: data.lower, data.upper, data.global
  if (data.lower) updatePartParams("lower", data.lower);
  if (data.upper) updatePartParams("upper", data.upper);
  if (data.global) updateGlobalParams(data.global);

  // Show/hide engine sections based on engine select
  for (const part of ["lower", "upper"]) {
    const engineParam = data.global && data.global[`part_${part}_engine_select`];
    const engineVal = engineParam ? engineParam.value : 0;
    const engineSection = ENGINE_MAP[engineVal] || "organ";

    for (const eng of ["organ", "piano", "sample_synth"]) {
      const sec = document.getElementById(`${part}-${eng}`);
      if (sec) {
        sec.classList.toggle("active", eng === engineSection);
      }
    }
  }

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
    const val = data.global[ps].value;
    const labelMap = { 0: "Lower", 1: "Upper", 2: "Both" };
    const classMap = { 0: "lower", 1: "upper", 2: "both" };
    indicator.textContent = labelMap[val] || "Both";
    indicator.className = "part-indicator " + (classMap[val] || "both");
  }

  // Last change
  if (data.lastChange) {
    const lc = data.lastChange;
    const partLabel = lc.part && lc.part !== "global" ? ` [${lc.part}]` : "";
    document.getElementById("last-change").textContent =
      `${lc.name} = ${lc.label} (CC${lc.cc} = ${lc.value})${partLabel}`;

    flashParam(lc.key, lc.part);
  }
}

function updatePartParams(part, params) {
  // Selectors (per-part)
  const partSelectors = [
    "organ_model", "vibrato_type", "percussion_harmonic", "percussion_speed_level",
    "piano_type", "sample_synth_dynamics",
  ];
  for (const param of partSelectors) {
    const el = document.getElementById(`sel-${part}-${param}`);
    if (!el || !params[param]) continue;
    const value = params[param].value;
    for (const btn of el.children) {
      btn.classList.toggle("active", parseInt(btn.dataset.value) === value);
    }
  }

  // LEDs (per-part)
  const partLeds = ["vibrato_enable", "percussion"];
  for (const id of partLeds) {
    const el = document.getElementById(`led-${part}-${id}`);
    if (!el || !params[id]) continue;
    el.classList.toggle("on", params[id].value > 0);
  }

  // Drawbars
  for (let i = 1; i <= 9; i++) {
    const key = `drawbar_${i}`;
    if (!params[key]) continue;
    const pos = params[key].position ?? 0;
    const pct = (pos / 8) * 100;
    const dbEl = document.getElementById(`drawbar-${part}-${i}`);
    if (!dbEl) continue;
    const fill = dbEl.querySelector(".drawbar-fill");
    const cap = dbEl.querySelector(".drawbar-cap");
    if (fill) fill.style.height = `${pct}%`;
    if (cap) cap.style.bottom = `${pct === 0 ? 0 : Math.max(0, pct - 12)}%`;
  }

  // Piano model display (name depends on piano_type + piano_model)
  if (params.piano_model && params.piano_type) {
    const typeVal = params.piano_type.value;
    const modelVal = params.piano_model.value;
    const models = PIANO_MODELS[typeVal] || [];
    const modelName = models[modelVal] || `#${modelVal}`;
    const el = document.getElementById(`val-${part}-piano_model`);
    if (el) el.textContent = modelName;
  }

  // Knobs (per-part)
  const partKnobs = [
    "piano_kbd_touch",
    "sample_synth_attack", "sample_synth_release", "sample_synth_filter_vel",
  ];
  for (const param of partKnobs) {
    const el = document.getElementById(`knob-${part}-${param}`);
    if (!el || !params[param]) continue;
    const value = params[param].value;
    const max = param === "piano_model" ? 15 : 127;
    updateKnob(el, value, max);
  }

  // Sample display
  if (params.sample_synth_sample) {
    const valEl = document.getElementById(`val-${part}-sample_synth_sample`);
    if (valEl) {
      valEl.textContent = `#${params.sample_synth_sample.value + 1}`;
    }
  }
}

function updateGlobalParams(params) {
  // Global selectors
  const globalSelectors = [
    "effect1_type", "effect2_type", "spkr_comp_type", "reverb_type",
    "part_lower_engine_select", "part_upper_engine_select", "kb_split_point",
  ];
  for (const param of globalSelectors) {
    const el = document.getElementById(`sel-${param}`);
    if (!el || !params[param]) continue;
    const value = params[param].value;
    for (const btn of el.children) {
      btn.classList.toggle("active", parseInt(btn.dataset.value) === value);
    }
  }

  // Global LEDs
  const globalLeds = [
    "effect1_enable", "effect2_enable", "effect2_deep",
    "spkr_comp_enable", "rotary_stop_mode",
    "reverb_enable", "delay_enable", "delay_ping_pong",
    "eq_enable",
    "part_lower_enable", "part_upper_enable",
    "kb_split_mode",
  ];
  for (const id of globalLeds) {
    const el = document.getElementById(`led-${id}`);
    if (!el || !params[id]) continue;
    el.classList.toggle("on", params[id].value > 0);
  }

  // Global knobs
  const globalKnobs = [
    "effect1_rate", "effect2_rate",
    "spkr_comp_drive",
    "reverb_dry_wet",
    "delay_tempo", "delay_dry_wet", "delay_feedback",
    "eq_bass", "eq_mid", "eq_mid_freq", "eq_treble",
    "part_mix",
  ];
  for (const param of globalKnobs) {
    const el = document.getElementById(`knob-${param}`);
    if (!el || !params[param]) continue;
    const value = params[param].value;
    updateKnob(el, value, 127);
  }

  // Rotary
  if (params.rotary_speed) {
    const fast = params.rotary_speed.value >= 64;
    const icon = document.getElementById("rotary-icon");
    icon.className = "rotary-icon " + (fast ? "spinning" : "slow");
    document.getElementById("val-rotary_speed").textContent = fast ? "FAST" : "SLOW";
  }

  // Master volume
  if (params.master_volume) {
    const vol = params.master_volume.value;
    document.getElementById("master-fill").style.width = `${(vol / 127) * 100}%`;
    document.getElementById("val-master_volume").textContent = vol;
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
  // Try part-prefixed IDs first if we have a part
  if (part && part !== "global") {
    const partTargets = [
      document.getElementById(`knob-${part}-${key}`),
      document.getElementById(`sel-${part}-${key}`),
      document.getElementById(`led-${part}-${key}`),
    ];
    for (const el of partTargets) {
      if (el) {
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
        return;
      }
    }
    // Drawbars with part prefix
    if (key.startsWith("drawbar_")) {
      const idx = key.split("_")[1];
      const el = document.getElementById(`drawbar-${part}-${idx}`);
      if (el) {
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
        return;
      }
    }
  }

  // Fall back to global (unprefixed) IDs
  const targets = [
    document.getElementById(`knob-${key}`),
    document.getElementById(`sel-${key}`),
    document.getElementById(`led-${key}`),
  ];
  for (const el of targets) {
    if (el) {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      return;
    }
  }

  // Drawbars (global fallback)
  if (key.startsWith("drawbar_")) {
    const idx = key.split("_")[1];
    const el = document.getElementById(`drawbar-${idx}`);
    if (el) {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }
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

// ── Init ──
initSelectors();
loadChatHistory();
connect();
