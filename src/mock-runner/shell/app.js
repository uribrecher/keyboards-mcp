/* ─────────────────────────────────────────────────────────────────
 * Mock Runner shell — tab state, iframe routing, chat console.
 * ────────────────────────────────────────────────────────────── */

import { AgentClient, isWebSearchResult } from "@sounds-and-recreation/agent-client";
import { marked } from "marked";

// GFM gives us markdown tables (the original itch); breaks:true so a
// single \n becomes a <br> rather than being collapsed inside a paragraph,
// which matches how chat output reads more naturally.
marked.setOptions({ gfm: true, breaks: true });

// Port 2999 is reserved for the agent in plan #6 specifically to keep
// it OUT of the mock-engine WS range that starts at 3000.
const AGENT_URL = "http://localhost:2999";
const CHAT_HISTORY_KEY = "mock-runner.chat-history.v1";

// One AgentClient owns the conversation history for this renderer
// (plan #12). The SDK is the single source of truth for the wire
// protocol — the REPL in sound-recreation-agent uses the same client.
const agentClient = new AgentClient({ serverUrl: AGENT_URL });

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
const chatReset     = document.getElementById("chat-reset");
const chatExtract   = document.getElementById("chat-extract");
const meterEl       = document.getElementById("agent-status");
const consoleHeader = document.getElementById("console-header");
const sidEl         = document.getElementById("agent-sid");
const sidValueEl    = document.getElementById("agent-sid-value");

let chatBusy = false;
// Agent process identity — emitted by GET /health. Stable while the
// agent runs; a change between probes means it restarted. We display
// a short prefix (8 hex chars) in the console header where the
// removed CLAUDE title used to live, full UUID stays in the title
// attribute for hover.
let agentInstanceId = null;

// Four-state agent liveness:
//   "unknown" — page just loaded, no probe yet
//   "live"    — last probe or chat turn succeeded
//   "busy"    — chat in flight (overlays live/lost while sending)
//   "lost"    — probe or chat fetch failed (TypeError) — agent unreachable
// `lastConfirmed` is the underlying state ignoring "busy", so we know
// what to fall back to when a chat ends.
let agentState = "unknown";
let lastConfirmed = "unknown";
const PLACEHOLDER_LOST = "agent offline — start agent on :2999";

function applyAgentState(next) {
  agentState = next;
  if (next !== "busy") lastConfirmed = next;
  meterEl.dataset.state = next;
  consoleHeader.dataset.state = next;
  // Composer reflects reachability: disable the textarea when the
  // agent is unreachable so the user can't type a message that has
  // nowhere to go. Keep it enabled while the state is "unknown" — we
  // haven't proven it's down yet, and the user's first attempt is the
  // probe that flips us to "live".
  const lost = next === "lost";
  chatInput.disabled = chatBusy || lost;
  chatInput.placeholder = lost ? PLACEHOLDER_LOST : "";
}

function appendRow(kind, text, opts = {}) {
  const row = document.createElement("div");
  row.className = "chat-row chat-row--" + kind;
  if (opts.error) row.classList.add("is-error");
  if (opts.result) row.classList.add("is-result");
  if (opts.url) row.classList.add("is-url");

  // Assistant rows render as markdown so tables, code blocks, **bold**,
  // lists, etc. all render as real HTML — tables in particular benefit
  // (browser auto-sizing + horizontal scroll instead of mangled
  // pre-wrap text). All other row kinds (user, system, tool) stay
  // plain text. <div> instead of <p> because <p> can't legally contain
  // block elements like <table>.
  const useMarkdown = kind === "assistant";
  const line = document.createElement(useMarkdown ? "div" : "p");
  line.className = "chat-line";
  if (useMarkdown) {
    line.dataset.raw = text;
    line.innerHTML = renderMarkdown(text);
  } else {
    line.textContent = text;
  }

  row.append(line);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (!opts.skipPersist) saveChatHistory();
  return line; // for streaming text appends
}

function renderMarkdown(text) {
  try {
    return marked.parse(text);
  } catch {
    // Fall back to escaped plain text on any parser error.
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

// ── History persistence ──

function saveChatHistory() {
  const entries = [];
  for (const row of chatLog.children) {
    const kind = [...row.classList].find((c) => c.startsWith("chat-row--"))
      ?.replace("chat-row--", "") ?? "system";
    const lineEl = row.querySelector(".chat-line");
    // Assistant rows render markdown; their textContent loses structural
    // info (a rendered <table> textContent has no | separators). Read
    // the raw markdown back from dataset.raw so reload re-renders the
    // same content. Other kinds are plain text — textContent is fine.
    const text  = lineEl?.dataset.raw ?? lineEl?.textContent ?? "";
    const error = row.classList.contains("is-error");
    const result = row.classList.contains("is-result");
    const url = row.classList.contains("is-url");
    entries.push({ kind, text, error, result, url });
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
        url: !!e.url,
        skipPersist: true,
      });
    }
  } catch { /* ignore */ }
}

loadChatHistory();

// ── Reset ──

let inFlightAbort = null;

chatReset.addEventListener("click", () => {
  // If a turn is mid-stream, abort it. The SDK rolls back the in-flight
  // user message automatically, so client.messages stays consistent.
  if (inFlightAbort) inFlightAbort.abort();
  agentClient.reset();
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
  chatInput.value = "";
  applyAgentState("busy");

  appendRow("user", message);

  let assistantLine = null;
  let assistantText = "";
  // The currently-streaming tool row (created on tool-input-start,
  // updated on tool-input-available). One per tool call.
  let currentToolRow = null;

  inFlightAbort = new AbortController();
  try {
    for await (const event of agentClient.send(message, { signal: inFlightAbort.signal })) {
      switch (event.type) {
        case "text-delta":
          if (!assistantLine) {
            assistantLine = appendRow("assistant", "");
            assistantText = "";
          }
          assistantText += event.delta ?? "";
          // Re-render the whole assistant message on each delta. marked
          // is fast enough at typical message lengths; the alternative
          // (snap-to-rendered only on `done`) shows raw markdown source
          // mid-stream which is uglier than a slightly noisier render.
          assistantLine.dataset.raw = assistantText;
          assistantLine.innerHTML = renderMarkdown(assistantText);
          chatLog.scrollTop = chatLog.scrollHeight;
          saveChatHistory();
          break;
        case "tool-input-start":
          // Tool calls interrupt the assistant text stream — the next
          // text-delta after a tool starts a fresh assistant line.
          assistantLine = null;
          assistantText = "";
          currentToolRow = appendRow("tool", `${event.toolName}…`);
          break;
        case "tool-input-available": {
          const summary = summarizeToolInput(event.toolName, event.input);
          if (currentToolRow) {
            currentToolRow.textContent = `${event.toolName}${summary}`;
            saveChatHistory();
          } else {
            // Defensive: SDK is supposed to emit start before available.
            appendRow("tool", `${event.toolName}${summary}`);
          }
          break;
        }
        case "tool-output-available":
          // Tick the existing tool row to signal completion.
          if (currentToolRow) {
            currentToolRow.textContent += " ✓";
            saveChatHistory();
          }
          currentToolRow = null;
          // For web_search specifically, the SDK exposes a typed
          // accessor for the visited sources. Render one row per URL
          // (URL only — no titles/snippets, per design intent). The
          // `is-result` class already gets a "↳" prefix from CSS, so
          // the row text is just the URL — no in-text arrow. Persist
          // once at the end of the loop instead of per-row, since
          // saveChatHistory() walks the entire log.
          if (isWebSearchResult(event.toolName, event.output)) {
            let appended = 0;
            for (const source of event.output.results) {
              if (source.url) {
                appendRow("tool", source.url, { result: true, url: true, skipPersist: true });
                appended++;
              }
            }
            if (appended > 0) saveChatHistory();
          }
          break;
        case "done":
          // Successful turn completion. The /health probe also flips
          // us to "live", but a `done` event is the strongest possible
          // proof of life — reset the failure counter immediately so
          // we don't sit on a stale lost-state until the next probe.
          probeFailureCount = 0;
          lastConfirmed = "live";
          break;
        case "error":
          // Mid-stream failure surfaced by the SDK (gateway 402,
          // model 5xx, tool exception, etc). The HTTP server itself
          // is fine — leave `lastConfirmed` alone (the /health probe
          // owns reachability). Tear down any in-progress assistant
          // line so the next turn starts fresh, then surface the
          // upstream message verbatim. Verbatim is the right call:
          // these errors are usually actionable (insufficient funds,
          // rate limit, malformed tool input) and translating them
          // into chassis-voice would just hide the cause.
          assistantLine = null;
          assistantText = "";
          if (currentToolRow) {
            currentToolRow.textContent += " ✗";
            currentToolRow = null;
          }
          appendRow("system", `agent error: ${event.message}`, { error: true });
          break;
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      // User clicked reset mid-stream. SDK rolled back the user
      // message; reset handler already wrote "Conversation reset."
      // No additional UI to render here.
    } else if (err instanceof TypeError && /fetch/i.test(err.message ?? "")) {
      // TypeError + "fetch" is the well-defined network-unreachable
      // signal in the browser/Electron — distinct from HTTP 5xx (the
      // server answered) or SSE-parser issues (we got a body). Treat
      // it as definitive proof the agent is down and replace the
      // verbatim message with the chassis-voice form.
      lastConfirmed = "lost";
      appendRow("system", PLACEHOLDER_LOST);
    } else {
      // HTTP 5xx, SSE parser error, etc. — server answered but the
      // exchange failed. Don't claim agent is offline; surface the
      // raw error and leave the liveness state to the probe loop.
      appendRow("system", `Chat error: ${err?.message ?? err}`);
    }
  } finally {
    inFlightAbort = null;
    chatBusy = false;
    applyAgentState(lastConfirmed);
    if (!chatInput.disabled) chatInput.focus();
  }
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

// ── Agent heartbeat ──
//
// Poll GET /health to keep the meter honest about the agent's
// reachability without waiting for the user to send a chat. 3s while
// healthy; backs off to 8s once we've missed three in a row, so a
// long server-down doesn't hammer the network tab. We never probe
// while a chat is in flight — the in-flight POST is itself proof of
// life and a duplicate fetch is racy.

const PROBE_INTERVAL_OK   = 3000;
const PROBE_INTERVAL_DOWN = 8000;
const PROBE_FAILURES_BEFORE_BACKOFF = 3;
let probeFailureCount = 0;

// Render the agent's instanceId (or absence of it) in the console
// header SID slot. Shows the first 8 hex characters as a short
// fingerprint; the full UUID lands in the title attribute for hover.
// A change in id between probes means the agent restarted — drop a
// system row so the user knows their conversation now talks to a
// fresh process. Older agent builds that don't emit `instanceId`
// fall back to "—" (the dash glyph from the initial HTML).
function applyInstanceId(nextId) {
  if (nextId === agentInstanceId) return;
  const previousId = agentInstanceId;
  agentInstanceId = nextId;
  if (typeof nextId === "string" && nextId.length > 0) {
    const short = nextId.replace(/-/g, "").slice(0, 8);
    sidValueEl.textContent = short;
    sidEl.title = `Agent process id ${nextId} — changes if the agent restarts`;
  } else {
    sidValueEl.textContent = "—";
    sidEl.title = "Agent process id — server didn't supply one";
  }
  // Only annotate restarts (previous id existed AND changed). A
  // first-ever id (previousId === null) is just normal startup, no
  // need to spam the log on page load.
  if (previousId && nextId && previousId !== nextId) {
    appendRow("system", "agent restarted — new process id");
  }
}

async function probeAgent() {
  if (chatBusy) return; // skip — chat in flight is its own heartbeat
  let ok = false;
  let parsedInstanceId = null;
  try {
    const res = await fetch(`${AGENT_URL}/health`, {
      method: "GET",
      // 2.5s budget — local roundtrip should be <50ms; anything past
      // 2.5s effectively means the server isn't listening.
      signal: AbortSignal.timeout(2500),
    });
    // Any response below 500 proves the agent server is alive — even
    // a 404 means "the process is up, it just doesn't know this
    // route". This matters when the renderer ships before the
    // companion `/health` change has reached the running agent: a
    // strict `res.ok` check would treat a healthy older server as
    // `lost` and lock the composer for no good reason. Real outage
    // signals (connection refused, DNS, timeout) come through the
    // catch block below and are correctly counted as failures.
    ok = res.status < 500;
    if (ok) {
      // Best-effort body parse — older agent builds may not return
      // JSON or may not include `instanceId`. Either way, applyInstanceId
      // handles missing values by falling back to "—".
      try {
        const body = await res.json();
        if (body && typeof body.instanceId === "string") {
          parsedInstanceId = body.instanceId;
        }
      } catch { /* ignore — body wasn't JSON */ }
    }
  } catch {
    ok = false;
  }
  applyInstanceId(parsedInstanceId);
  if (ok) {
    probeFailureCount = 0;
    if (lastConfirmed !== "live" && agentState !== "busy") applyAgentState("live");
  } else {
    probeFailureCount++;
    if (lastConfirmed !== "lost" && agentState !== "busy") applyAgentState("lost");
  }
}

function scheduleNextProbe() {
  const delay = probeFailureCount >= PROBE_FAILURES_BEFORE_BACKOFF
    ? PROBE_INTERVAL_DOWN
    : PROBE_INTERVAL_OK;
  setTimeout(async () => {
    await probeAgent();
    scheduleNextProbe();
  }, delay);
}

// Fire one probe immediately so the meter settles within ~50ms of
// page load instead of waiting a full interval.
void (async () => {
  await probeAgent();
  scheduleNextProbe();
})();

// ─────────────────────────────────────────────────────────────────
// MCB tab-LED poll (Phase 3)
// ─────────────────────────────────────────────────────────────────
//
// Each tab's LED reflects MCB's lease state for that mock's port:
//   primary → green   (an agent owns this mock directly)
//   shadow  → blue    (this mock is the shadow of a hardware master)
//   none    → amber   (no lease — the default visual)
//
// MCB unreachable collapses to "none" everywhere — by design; the mock-
// runner is not a hard dependent of MCB. 2s cadence is enough: leases
// change on connect/disconnect (rare events) and the user is staring at
// a hardware-style rail, not a real-time scope.

const MCB_POLL_INTERVAL_MS = 2000;

// Single-flight guard — if a poll is still in flight when the next tick
// fires (e.g. MCB stalled on the UDS read), skip rather than queue. Keeps
// LED updates ordered and prevents handler pile-up.
let mcbPollInFlight = false;

async function pollMcbLeaseStates() {
  if (mcbPollInFlight) return;
  mcbPollInFlight = true;
  try {
    let states;
    try { states = await api.getTabLeaseStates(); }
    catch { return; } // preload missing or main-process error — leave LEDs as-is
    for (const tab of tabs) {
      const led = tab.button?.querySelector(".tab__led");
      if (!led) continue;
      const state = states[tab.tabId];
      if (state === "primary" || state === "shadow") led.dataset.state = state;
      else delete led.dataset.state; // default amber
    }
  } finally {
    mcbPollInFlight = false;
  }
}

void pollMcbLeaseStates();
setInterval(() => { void pollMcbLeaseStates(); }, MCB_POLL_INTERVAL_MS);

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
