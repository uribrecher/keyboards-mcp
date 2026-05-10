// Prophet-6 Mock Device UI

const SECTION_LABELS = {
  oscillator_1: "Oscillator 1",
  oscillator_2: "Oscillator 2",
  mixer: "Mixer",
  lowpass_filter: "Low-Pass Filter",
  highpass_filter: "High-Pass Filter",
  filter_envelope: "Filter Envelope",
  amplifier: "Amplifier",
  effects: "Effects",
  arpeggiator: "Arpeggiator",
  performance: "Performance",
};

const SECTION_ORDER = Object.keys(SECTION_LABELS);

let ws = null;
const paramElements = {};

function buildUI(params) {
  const main = document.getElementById("sections");
  main.innerHTML = "";

  // Group by section
  const sections = {};
  for (const [key, p] of Object.entries(params)) {
    if (!sections[p.section]) sections[p.section] = [];
    sections[p.section].push({ key, ...p });
  }

  for (const sectionKey of SECTION_ORDER) {
    const items = sections[sectionKey];
    if (!items) continue;

    const div = document.createElement("div");
    div.className = "section";

    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = SECTION_LABELS[sectionKey] || sectionKey;
    div.appendChild(title);

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "param-row";
      row.dataset.key = item.key;

      const name = document.createElement("span");
      name.className = "param-name";
      name.textContent = item.displayName ?? item.name;
      row.appendChild(name);

      if (item.type === "toggle") {
        const toggle = document.createElement("span");
        toggle.className = "param-toggle off";
        toggle.textContent = "Off";
        row.appendChild(toggle);
        paramElements[item.key] = { row, toggle };
      } else if (item.type === "discrete" && item.labels) {
        const selector = document.createElement("div");
        selector.className = "param-selector";
        selector.id = `sel-${item.key}`;
        for (const [val, label] of Object.entries(item.labels)) {
          const btn = document.createElement("button");
          btn.dataset.value = val;
          btn.textContent = label;
          selector.appendChild(btn);
        }
        row.appendChild(selector);
        paramElements[item.key] = { row, selector };
      } else {
        const barContainer = document.createElement("div");
        barContainer.className = "param-bar-container";
        const bar = document.createElement("div");
        bar.className = "param-bar";
        bar.style.width = "0%";
        barContainer.appendChild(bar);
        row.appendChild(barContainer);

        const val = document.createElement("span");
        val.className = "param-value";
        val.textContent = "0";
        row.appendChild(val);
        paramElements[item.key] = { row, bar, val };
      }

      div.appendChild(row);
    }

    main.appendChild(div);
  }
}

function updateUI(state) {
  // Prophet-6 is mono-timbral, all params are global
  const params = state.global || {};

  for (const [key, p] of Object.entries(params)) {
    const el = paramElements[key];
    if (!el) continue;

    if (el.toggle) {
      const on = p.label === "On" || p.value > 0;
      el.toggle.className = `param-toggle ${on ? "on" : "off"}`;
      el.toggle.textContent = on ? "On" : "Off";
    } else if (el.selector) {
      const idx = p.index ?? p.value;
      for (const btn of el.selector.children) {
        btn.classList.toggle("active", parseInt(btn.dataset.value) === idx);
      }
    } else {
      const pct = Math.round((p.value / 127) * 100);
      el.bar.style.width = `${pct}%`;
      el.val.textContent = p.label ?? String(p.value);
    }
  }

  // Last change flash
  if (state.lastChange) {
    const el = paramElements[state.lastChange.key];
    if (el) {
      el.row.classList.add("flash");
      setTimeout(() => el.row.classList.remove("flash"), 300);
    }
    document.getElementById("last-change").textContent =
      `${state.lastChange.name} = ${state.lastChange.label}`;
  }
}

function connect() {
  const wsPort = new URLSearchParams(location.search).get("wsPort") || "3000";
  ws = new WebSocket(`ws://localhost:${wsPort}`);

  ws.onopen = () => {};

  ws.onclose = () => {
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {};

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // Build UI from first state message if not yet built
    if (data.global && Object.keys(paramElements).length === 0) {
      buildUI(data.global);
    }


    updateUI(data);
  };
}

connect();
