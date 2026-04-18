// Roland JUNO-X — Web UI Client

// ── State ──

let activePart = 1;
let firstMessage = true;

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

function updatePartParams(partData) {
  const params = partData.params;
  if (!params) return;

  for (const [key, value] of Object.entries(params)) {
    // key is like "cc3", "cc9", etc.
    if (!key.startsWith("cc")) continue;
    const cc = parseInt(key.slice(2), 10);
    if (isNaN(cc)) continue;

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

// ── Init ──

initPartButtons();
connect();
