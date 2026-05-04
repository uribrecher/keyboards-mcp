/* ─────────────────────────────────────────────────────────────────
 * Mock Runner shell — tab state, iframe routing, chat console.
 * ────────────────────────────────────────────────────────────── */

const AGENT_URL = "http://localhost:3001";
const CHAT_HISTORY_KEY = "mock-runner.chat-history.v1";

const api = window.mockRunnerAPI;

// ── Tab state ────────────────────────────────────────────────────

/**
 * One UI tab. Starts as a "pending" model-chooser tab (no engine yet).
 * Once the user picks a model, main process spins up an engine, hands
 * back wsPort + modelUiDir, and we navigate the iframe to that UI.
 */
const tabs = []; // [{ tabId, modelInfoId|null, displayName, label, wsPort|null, iframe, button }]
let activeTabId = null;

const tabbarEl   = document.getElementById("tabbar");
const tabPlusEl  = document.getElementById("tab-new");
const slotEl     = document.getElementById("slot");
const slotEmpty  = document.getElementById("slot-empty");

function findTab(tabId) {
  return tabs.find((t) => t.tabId === tabId);
}

function setActive(tabId) {
  activeTabId = tabId;
  for (const t of tabs) {
    const isActive = t.tabId === tabId;
    t.button.classList.toggle("is-active", isActive);
    if (t.iframe) t.iframe.hidden = !isActive;
  }
  slotEmpty.hidden = tabs.length > 0;
  if (tabId) void api.setActiveTab?.(tabId);
}

function renderTabButton(tab) {
  const btn = document.createElement("button");
  btn.className = "tab" + (tab.modelInfoId ? "" : " is-pending");
  btn.dataset.tabId = tab.tabId;
  btn.setAttribute("role", "tab");

  const led = document.createElement("span");
  led.className = "tab__led";

  const title = document.createElement("span");
  title.className = "tab__title";
  title.textContent = tabTitleText(tab);
  title.title = tab.modelInfoId ? `Double-click to rename · ${tab.displayName}` : "";

  const close = document.createElement("span");
  close.className = "tab__close";
  close.textContent = "×";
  close.title = "Close tab";

  btn.append(led, title, close);

  btn.addEventListener("click", (e) => {
    if (e.target === close) {
      e.stopPropagation();
      void closeTab(tab.tabId);
      return;
    }
    setActive(tab.tabId);
  });

  // Double-click the title → inline rename. Only meaningful once the tab
  // has a model loaded (and therefore a label).
  title.addEventListener("dblclick", (e) => {
    if (!tab.modelInfoId) return;
    e.stopPropagation();
    beginRename(tab, title);
  });

  return btn;
}

function tabTitleText(tab) {
  if (!tab.modelInfoId) return "new tab";
  return tab.label || tab.displayName || "—";
}

function beginRename(tab, titleEl) {
  const original = tab.label ?? "";
  titleEl.contentEditable = "true";
  titleEl.spellcheck = false;
  titleEl.classList.add("tab__title--editing");
  titleEl.textContent = original;

  // Select all
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  titleEl.focus();

  let commitHandled = false;

  const commit = async () => {
    if (commitHandled) return;
    commitHandled = true;
    titleEl.contentEditable = "false";
    titleEl.classList.remove("tab__title--editing");
    const next = (titleEl.textContent || "").trim();
    if (!next || next === original) {
      titleEl.textContent = tabTitleText(tab);
      return;
    }
    const result = await api.renameTab(tab.tabId, next);
    if (result.ok && result.label) {
      tab.label = result.label;
      titleEl.textContent = tabTitleText(tab);
      titleEl.title = `Double-click to rename · ${tab.displayName}`;
      // Refresh iframe so the model UI re-init with the new label takes
      // effect for any header-bound state. The wsPort doesn't change.
    } else {
      titleEl.textContent = tabTitleText(tab);
      appendRow("system", `Rename failed: ${result.error ?? "(unknown)"}`);
    }
  };

  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleEl.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      commitHandled = true;
      titleEl.contentEditable = "false";
      titleEl.classList.remove("tab__title--editing");
      titleEl.textContent = tabTitleText(tab);
    }
  }, { once: false });

  titleEl.addEventListener("blur", () => { void commit(); }, { once: true });
}

async function newTab() {
  const { tabId } = await api.createTab();
  const tab = {
    tabId,
    modelInfoId: null,
    displayName: null,
    label: null,
    wsPort: null,
    iframe: null,
    button: null,
  };
  tabs.push(tab);

  const btn = renderTabButton(tab);
  tab.button = btn;
  tabbarEl.insertBefore(btn, tabPlusEl);

  // Spawn the chooser iframe inside the slot
  const iframe = document.createElement("iframe");
  iframe.src = "chooser.html";
  iframe.dataset.tabId = tabId;
  iframe.title = `Tab ${tabId} (chooser)`;
  iframe.allow = ""; // sandbox stays default — chooser only postMessages
  slotEl.appendChild(iframe);
  tab.iframe = iframe;

  setActive(tabId);
}

async function closeTab(tabId) {
  const tab = findTab(tabId);
  if (!tab) return;

  // Tear down iframe + engine
  if (tab.iframe) tab.iframe.remove();
  await api.closeTab(tabId);

  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  tab.button.remove();

  if (activeTabId === tabId) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null;
    if (next) setActive(next.tabId);
    else {
      activeTabId = null;
      slotEmpty.hidden = false;
    }
  }
}

async function selectModelForTab(tabId, modelId) {
  const tab = findTab(tabId);
  if (!tab) return;

  // No explicit label yet — main process resolves to "_default" until the
  // user renames the tab. Plan 5 storage uses that label as the cache key.
  const result = await api.selectModelForTab(tabId, modelId);

  tab.modelInfoId   = result.modelInfoId;
  tab.displayName   = result.displayName;
  tab.label         = result.label;
  tab.wsPort        = result.wsPort;

  // Re-skin the tab button. The visible title is the *label* — that's the
  // identifier the user (and the backup cache) actually cares about. Hover
  // tooltip carries the model display name + ws port.
  tab.button.classList.remove("is-pending");
  const titleEl = tab.button.querySelector(".tab__title");
  titleEl.textContent = tabTitleText(tab);
  titleEl.title = `Double-click to rename · ${result.displayName} · ws ${result.wsPort}`;
  tab.button.title = `${result.displayName} · ws:${result.wsPort} · "${result.label}"`;

  // Navigate the iframe to the model UI with the per-tab wsPort
  if (result.modelUiDir) {
    const url = `file://${result.modelUiDir}/index.html?wsPort=${result.wsPort}`;
    tab.iframe.src = url;
    tab.iframe.title = `${result.displayName} (${result.label})`;
  }

  setActive(tabId); // re-emit so any UI flags settle
}

// ── postMessage from chooser iframe ─────────────────────────────

let modelCatalogCache = null;

async function getModelCatalog() {
  if (!modelCatalogCache) modelCatalogCache = await api.getModels();
  return modelCatalogCache;
}

window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "request-models") {
    const models = await getModelCatalog();
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({ type: "models", models }, "*");
    }
    return;
  }

  if (data.type === "model-selected" && data.modelId) {
    // Find tab whose iframe sent this message
    const tab = tabs.find((t) => t.iframe?.contentWindow === event.source);
    if (tab) void selectModelForTab(tab.tabId, data.modelId);
  }
});

// ── Tab bar wiring ──────────────────────────────────────────────

tabPlusEl.addEventListener("click", () => { void newTab(); });
api.onMenuNewTab?.(() => { void newTab(); });

// Bootstrap: open one chooser tab on startup
void newTab();

// ─────────────────────────────────────────────────────────────────
// Chat console
// ─────────────────────────────────────────────────────────────────

const chatLog       = document.getElementById("chat-log");
const chatForm      = document.getElementById("chat-form");
const chatInput     = document.getElementById("chat-input");
const chatSend      = document.getElementById("chat-send");
const chatReset     = document.getElementById("chat-reset");
const chatExtract   = document.getElementById("chat-extract");
const meterEl       = document.getElementById("agent-status");

let chatBusy = false;
let agentReachable = null; // tri-state: null=unknown, true, false

function pad2(n) { return String(n).padStart(2, "0"); }

function timestamp() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function setMeter(state) {
  meterEl.dataset.state = state;
}

function appendRow(kind, text, opts = {}) {
  const row = document.createElement("div");
  row.className = "chat-row chat-row--" + kind;
  if (opts.error) row.classList.add("is-error");
  if (opts.result) row.classList.add("is-result");

  const stamp = document.createElement("span");
  stamp.className = "chat-stamp";
  stamp.textContent = opts.stamp ?? timestamp();

  const line = document.createElement("p");
  line.className = "chat-line";
  line.textContent = text;

  row.append(stamp, line);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (!opts.skipPersist) saveChatHistory();
  return line; // for streaming text appends
}

// ── History persistence ──

function saveChatHistory() {
  const entries = [];
  for (const row of chatLog.children) {
    const kind = [...row.classList].find((c) => c.startsWith("chat-row--"))
      ?.replace("chat-row--", "") ?? "system";
    const stamp = row.querySelector(".chat-stamp")?.textContent ?? "";
    const text  = row.querySelector(".chat-line")?.textContent ?? "";
    const error = row.classList.contains("is-error");
    const result = row.classList.contains("is-result");
    entries.push({ kind, stamp, text, error, result });
  }
  try { localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(entries)); } catch { /* ignore */ }
}

function loadChatHistory() {
  let saved;
  try { saved = localStorage.getItem(CHAT_HISTORY_KEY); } catch { return; }
  if (!saved) return;
  try {
    const entries = JSON.parse(saved);
    if (!Array.isArray(entries)) return;
    chatLog.innerHTML = "";
    for (const e of entries) {
      appendRow(e.kind, e.text, {
        error: !!e.error,
        result: !!e.result,
        stamp: e.stamp,
        skipPersist: true,
      });
    }
  } catch { /* ignore */ }
}

loadChatHistory();

// ── Reset ──

chatReset.addEventListener("click", async () => {
  try { await fetch(`${AGENT_URL}/reset`, { method: "POST" }); } catch { /* swallow */ }
  chatLog.innerHTML = "";
  try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch { /* ignore */ }
  appendRow("system", "Conversation reset.");
});

// ── Send ──

function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  if (name === "set_parameters" && Array.isArray(input.parameters)) {
    return ` (${input.parameters.length} params)`;
  }
  if (name === "connect_to_keyboard" && (input.label || input.port !== undefined)) {
    return input.label ? ` ("${input.label}")` : ` (port ${input.port})`;
  }
  if (input.device !== undefined) return ` (device ${input.device})`;
  return "";
}

async function sendChat() {
  const message = chatInput.value.trim();
  if (!message || chatBusy) return;

  chatBusy = true;
  chatInput.disabled = true;
  chatSend.disabled = true;
  chatInput.value = "";
  setMeter("busy");

  appendRow("user", message);

  let assistantLine = null;
  let assistantText = "";

  try {
    const res = await fetch(`${AGENT_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });

    agentReachable = true;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          event = line.slice(7).trim();
        } else if (line.startsWith("data: ") && event) {
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { event = null; continue; }

          if (event === "text") {
            if (!assistantLine) {
              assistantLine = appendRow("assistant", "");
              assistantText = "";
            }
            assistantText += data.text ?? "";
            assistantLine.textContent = assistantText;
            chatLog.scrollTop = chatLog.scrollHeight;
            saveChatHistory();
          } else if (event === "tool_use") {
            assistantLine = null;
            assistantText = "";
            const summary = summarizeToolInput(data.name, data.input);
            appendRow("tool", `${data.name}${summary}`);
          } else if (event === "tool_result") {
            const text = (data.result ?? "").length > 220
              ? (data.result ?? "").slice(0, 220) + "…"
              : (data.result ?? "");
            appendRow("tool", text, { result: true, error: !!data.isError });
          } else if (event === "error") {
            appendRow("system", `Error: ${data.error ?? "(unknown)"}`);
          }
          event = null;
        } else if (line.trim() === "") {
          event = null;
        }
      }
    }
  } catch (err) {
    agentReachable = false;
    appendRow("system", `Agent unreachable at ${AGENT_URL}. Is the agent running?`);
  }

  chatBusy = false;
  chatInput.disabled = false;
  chatSend.disabled = false;
  setMeter(agentReachable ? "on" : "off");
  chatInput.focus();
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void sendChat();
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendChat();
  }
});

// Probe the agent once at startup so the meter reflects reality
void (async () => {
  try {
    await fetch(`${AGENT_URL}/health`, { method: "GET" });
    agentReachable = true;
    setMeter("on");
  } catch {
    agentReachable = false;
    setMeter("off");
  }
})();

// ─────────────────────────────────────────────────────────────────
// Backup picker modal
// ─────────────────────────────────────────────────────────────────

const modalEl       = document.getElementById("backup-modal");
const modalList     = document.getElementById("backup-device-list");
const modalCancel   = document.getElementById("backup-cancel");
const modalCancel2  = document.getElementById("backup-cancel-2");
const modalConfirm  = document.getElementById("backup-confirm");

function openBackupModal() {
  const loaded = tabs.filter((t) => t.modelInfoId);
  if (loaded.length === 0) {
    appendRow("system", "No loaded mocks. Pick a model on a tab first.");
    return;
  }

  // If only one loaded tab, skip the modal.
  if (loaded.length === 1) {
    void runBackupExtract(loaded[0].tabId);
    return;
  }

  modalList.innerHTML = "";
  let chosenTabId = activeTabId && loaded.find((t) => t.tabId === activeTabId)
    ? activeTabId
    : loaded[0].tabId;

  for (const t of loaded) {
    const li = document.createElement("li");
    li.className = "modal__device" + (t.tabId === chosenTabId ? " is-checked" : "");
    li.innerHTML = `
      <input type="radio" name="backup-tab" value="${t.tabId}" ${t.tabId === chosenTabId ? "checked" : ""}>
      <div>
        <div class="modal__device-name">${t.displayName ?? "—"}</div>
        <div class="modal__device-meta">label · "${t.label ?? "_default"}"</div>
      </div>
      <div class="modal__device-port">ws ${t.wsPort}</div>
    `;
    li.addEventListener("click", () => {
      chosenTabId = t.tabId;
      for (const child of modalList.children) child.classList.remove("is-checked");
      li.classList.add("is-checked");
      const radio = li.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
    modalList.appendChild(li);
  }

  modalConfirm.onclick = async () => {
    closeBackupModal();
    await runBackupExtract(chosenTabId);
  };

  modalEl.hidden = false;
}

function closeBackupModal() {
  modalEl.hidden = true;
}

modalCancel.addEventListener("click", closeBackupModal);
modalCancel2.addEventListener("click", closeBackupModal);
modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeBackupModal(); });

async function runBackupExtract(tabId) {
  const filePath = await api.openBackupDialog();
  if (!filePath) return;
  appendRow("system", `Extracting backup from ${filePath}…`);
  const result = await api.extractBackup({ filePath, tabId });
  appendRow(result.ok ? "system" : "tool",
    result.message,
    { error: !result.ok });
}

chatExtract.addEventListener("click", openBackupModal);
api.onMenuExtractBackup?.(() => openBackupModal());

// ─────────────────────────────────────────────────────────────────
// Plan #9 — title-bar dirty indicator
// ─────────────────────────────────────────────────────────────────

api.onDirtyChanged?.(({ isDirty, currentFileName }) => {
  // `currentFileName` is precomputed by main via node:path.basename(),
  // so this works on Windows too (no manual `/` splitting).
  const base = "Mock Runner";
  document.title = currentFileName
    ? `${base} — ${currentFileName}${isDirty ? " •" : ""}`
    : base;
});

// Render in-shell notes from main (Open errors, graceful-degradation msgs).
api.onConsoleNote?.(({ text }) => { appendRow("system", text); });

// Open flow asks the renderer to drop a specific iframe (during teardown)
api.onCloseTab?.(({ tabId }) => {
  const tab = findTab(tabId);
  if (!tab) return;
  if (tab.iframe) tab.iframe.remove();
  tab.button.remove();
  const idx = tabs.indexOf(tab);
  if (idx >= 0) tabs.splice(idx, 1);
  if (activeTabId === tabId) {
    const next = tabs[0]?.tabId ?? null;
    activeTabId = next;
    slotEmpty.hidden = tabs.length > 0;
    for (const t of tabs) t.button.classList.toggle("is-active", t.tabId === next);
  }
});

// Open flow asks the renderer to mount each restored tab's iframe directly
// — main has already created the engine, so we skip the createTab/IPC dance.
// `info.isActive` indicates which mounted tab should be foregrounded.
api.onMountTab?.((info) => {
  const tab = {
    tabId: info.tabId,
    modelInfoId: info.modelInfoId,
    displayName: info.displayName,
    label: info.label,
    wsPort: info.wsPort,
    iframe: null,
    button: null,
  };
  tabs.push(tab);
  const btn = renderTabButton(tab);
  tab.button = btn;
  tabbarEl.insertBefore(btn, tabPlusEl);
  // Re-skin: a mounted tab is loaded, not pending
  btn.classList.remove("is-pending");
  const titleEl = btn.querySelector(".tab__title");
  if (titleEl) {
    titleEl.textContent = tab.label || tab.displayName || "—";
    titleEl.title = `Double-click to rename · ${tab.displayName} · ws ${tab.wsPort}`;
  }
  btn.title = `${tab.displayName} · ws:${tab.wsPort} · "${tab.label}"`;

  const iframe = document.createElement("iframe");
  iframe.dataset.tabId = info.tabId;
  iframe.src = info.modelUiDir
    ? `file://${info.modelUiDir}/index.html?wsPort=${info.wsPort}`
    : "chooser.html";
  iframe.hidden = !info.isActive;     // only the active tab's iframe is visible
  slotEl.appendChild(iframe);
  tab.iframe = iframe;

  // Only the tab marked active should foreground; otherwise just sync
  // the empty-rack flag and the active CSS class.
  if (info.isActive) {
    setActive(info.tabId);
  } else {
    btn.classList.remove("is-active");
    slotEmpty.hidden = tabs.length > 0;
  }
});
