/* ─────────────────────────────────────────────────────────────────
 * Mock Runner shell — tab state, iframe routing, chat console.
 * ────────────────────────────────────────────────────────────── */

import { AgentClient, isWebSearchResult } from "@sounds-and-recreation/agent-client";
import { marked } from "marked";
import { nextUnread } from "./unread-state.js";

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
// MCB broker-liveness state — "unknown" until the first probe lands. Drives
// the blinking-amber LED state on every tab while down. Module-level so
// `renderTabButton` can apply the right class on creation.
let currentBrokerLiveness = "unknown";

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
  paintMidiDrawer(tabId ? (midiHistoryByTab.get(tabId) ?? []) : []);
  if (tabId) void api.setActiveTab?.(tabId);
}

// ── MIDI traffic monitor — drawer (todo #5 + layout overhaul) ──
//
// Per-tab ring buffer of recent MIDI events. Collapsed (default): the
// drawer shows just the latest event from the active tab. Expanded:
// shows the full buffered history (up to MIDI_HISTORY_CAP per tab) in
// a scrollable list with the newest at the bottom and the operator's
// scroll position preserved during bursts when they've scrolled up.

const MIDI_HISTORY_CAP = 50;
const STALE_AFTER_MS = 2500;
const SCROLL_PIN_THRESHOLD_PX = 10;

/** tabId → array of {ts, direction, kind, ...details}, oldest-first. */
const midiHistoryByTab = new Map();

const midiDrawerEl    = document.getElementById("midi-drawer");
const midiListEl      = document.getElementById("midi-drawer-list");
const midiCountEl     = document.getElementById("midi-drawer-count");
const midiToggleEl    = document.getElementById("midi-drawer-toggle");
let staleTimer = null;

function formatMidiTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatMidiBody(ev) {
  if (ev.kind === "cc") {
    return `CC${ev.controller}=${ev.value} ch=${ev.channel}`;
  }
  if (ev.kind === "program") {
    return `PC=${ev.number} ch=${ev.channel}`;
  }
  // sysex — emit the FULL hex string. CSS truncates the visible row
  // with text-overflow: ellipsis; the underlying text node still holds
  // every byte, so click-and-drag selection on .midi-row__body grabs
  // the complete message for copy/paste.
  const hex = ev.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return `sysex ${ev.bytes.length} bytes [${hex}]`;
}

/** Render a single <li class="midi-row"> for the given event. */
function buildMidiRow(ev) {
  const li = document.createElement("li");
  li.className = "midi-row";
  li.dataset.state = ev.direction;
  li.innerHTML =
    `<span class="midi-row__glyph" aria-hidden="true">${ev.direction === "in" ? "◂" : "▸"}</span>` +
    `<span class="midi-row__dir">${ev.direction === "in" ? "IN" : "OUT"}</span>` +
    `<span class="midi-row__time">${formatMidiTime(ev.ts)}</span>` +
    `<span class="midi-row__body"></span>`;
  // textContent (not innerHTML) for the body — sysex strings are
  // generated, but better safe than sorry against future kinds.
  li.querySelector(".midi-row__body").textContent = formatMidiBody(ev);
  return li;
}

/** Build the placeholder "— no MIDI yet —" row. */
function buildPlaceholderRow() {
  const li = document.createElement("li");
  li.className = "midi-row midi-row--placeholder";
  li.dataset.state = "idle";
  li.innerHTML =
    `<span class="midi-row__glyph" aria-hidden="true">·</span>` +
    `<span class="midi-row__dir"></span>` +
    `<span class="midi-row__time"></span>` +
    `<span class="midi-row__body">— no MIDI yet —</span>`;
  return li;
}

function isExpanded() {
  return midiDrawerEl.dataset.state === "expanded";
}

function isPinnedToBottom() {
  return (midiListEl.scrollHeight - midiListEl.scrollTop - midiListEl.clientHeight)
    <= SCROLL_PIN_THRESHOLD_PX;
}

/**
 * Repaint the drawer list from a per-tab history buffer.
 * Collapsed: render the single latest event (or placeholder if empty).
 * Expanded: render every buffered event, newest at the bottom; if the
 * caller flagged `flashLatest`, restart the flash keyframe on the
 * latest row.
 */
function paintMidiDrawer(events, opts = { flashLatest: false, isNewEvent: false }) {
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }

  const expanded = isExpanded();
  const pinnedBeforeRepaint = expanded && isPinnedToBottom();

  // Build the new row set off-DOM, then swap in.
  const frag = document.createDocumentFragment();
  if (events.length === 0) {
    frag.appendChild(buildPlaceholderRow());
  } else if (!expanded) {
    frag.appendChild(buildMidiRow(events[events.length - 1]));
  } else {
    for (const ev of events) frag.appendChild(buildMidiRow(ev));
  }
  midiListEl.replaceChildren(frag);

  // Update the header count.
  midiCountEl.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;

  // Auto-scroll to bottom only when the operator was already pinned, so a
  // mid-history scroll-up isn't yanked back during a burst.
  if (expanded && pinnedBeforeRepaint) {
    midiListEl.scrollTop = midiListEl.scrollHeight;
  }

  // Flash + stale on the latest row only.
  const latest = midiListEl.lastElementChild;
  if (latest && !latest.classList.contains("midi-row--placeholder")) {
    if (opts.flashLatest) {
      // rAF double-pump avoids a forced sync layout on every event.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        latest.classList.add("midi-row--flash");
      }));
    }
    if (opts.isNewEvent) {
      staleTimer = setTimeout(() => {
        latest.classList.add("midi-row--stale");
        staleTimer = null;
      }, STALE_AFTER_MS);
    }
  }
}

api.onMidiEvent?.((payload) => {
  // payload: { tabId, ts, direction, kind, ...details }
  let history = midiHistoryByTab.get(payload.tabId);
  if (!history) { history = []; midiHistoryByTab.set(payload.tabId, history); }
  history.push(payload);
  if (history.length > MIDI_HISTORY_CAP) history.splice(0, history.length - MIDI_HISTORY_CAP);
  if (payload.tabId === activeTabId) {
    paintMidiDrawer(history, { flashLatest: true, isNewEvent: true });
  }
});

// ── Drawer toggle handlers ──
midiToggleEl?.addEventListener("click", () => {
  const next = isExpanded() ? "collapsed" : "expanded";
  midiDrawerEl.dataset.state = next;
  midiToggleEl.setAttribute("aria-expanded", next === "expanded" ? "true" : "false");
  midiToggleEl.textContent = next === "expanded" ? "▾" : "▴";
  midiToggleEl.title = next === "expanded" ? "Collapse MIDI history" : "Show MIDI history";
  // Repaint without flashing — toggling is not a new event.
  const history = activeTabId ? (midiHistoryByTab.get(activeTabId) ?? []) : [];
  paintMidiDrawer(history);
  // After expanding, snap to the bottom so the freshest event is visible.
  if (next === "expanded") {
    requestAnimationFrame(() => { midiListEl.scrollTop = midiListEl.scrollHeight; });
  }
});

// ── Console drawer rail (combined splitter + collapse toggle) ──
//
// The rail is the only chrome between the slot and the console. Pointer
// drag → resize. Click without movement → toggle collapsed. The drag
// vs click discrimination uses a pixel threshold (DRAG_THRESHOLD_PX);
// any pointermove beyond that flips the gesture into a drag.
//
// Drag handlers live in the splitter section further down so they can
// share the persistence/clamp helpers; here we just expose the element
// + a tiny helper to update the chevron + aria.
const consoleEl       = document.getElementById("console");
const consoleLatchEl  = document.getElementById("console-latch");
const consoleLatchGlyphEl = document.getElementById("console-latch-glyph");

function setConsoleCollapsed(collapsed) {
  const next = collapsed ? "true" : "false";
  consoleEl.dataset.collapsed = next;
  consoleLatchEl?.setAttribute("aria-expanded", collapsed ? "false" : "true");
  if (consoleLatchEl) {
    consoleLatchEl.title = collapsed
      ? "Click to expand · drag to resize"
      : "Drag to resize · click to collapse";
  }
  if (consoleLatchGlyphEl) consoleLatchGlyphEl.textContent = collapsed ? "◀" : "▶";
}

function renderTabButton(tab) {
  const btn = document.createElement("button");
  btn.className = "tab" + (tab.modelInfoId ? "" : " is-pending");
  btn.dataset.tabId = tab.tabId;
  btn.setAttribute("role", "tab");

  const led = document.createElement("span");
  led.className = "tab__led";
  if (currentBrokerLiveness === "down") led.classList.add("tab__led--mcb-down");

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
      appendEventRow({
        severity: "warn",
        source:   `${tab.displayName} ("${tab.label}")`,
        text:     `rename failed: ${result.error ?? "(unknown)"}`,
        ts:       Date.now(),
      });
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
  midiHistoryByTab.delete(tabId);
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
      paintMidiDrawer([]);
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
const meterEl       = document.getElementById("agent-status");
const consoleHeader = document.getElementById("tab-chat"); // tabbed-box restructure: data-state lives on the chat tab now
const sidEl         = document.getElementById("agent-sid");
const sidValueEl    = document.getElementById("agent-sid-value");
const tabChatBtn        = document.getElementById("tab-chat");
const tabLogBtn         = document.getElementById("tab-log");
const eventLog          = document.getElementById("event-log");
const eventLogUnread    = document.getElementById("event-log-unread");
const composerForm      = document.getElementById("chat-form");

let chatBusy = false;
// Agent process identity — emitted by GET /health. Stable while the
// agent runs; a change between probes means it restarted. We display
// a short prefix (8 hex chars) in the console header where the
// removed CLAUDE title used to live, full UUID stays in the title
// attribute for hover.
let agentSessionId = null;

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

// ─────────────────────────────────────────────────────────────────
// Console panes — CHAT / LOG (see spec
// docs/superpowers/specs/2026-05-08-mock-runner-event-log-design.md)
// ─────────────────────────────────────────────────────────────────

/** @type {"chat" | "log"} */
let activePane = "chat";

/** @type {"info" | "warn" | "error" | null} */
let unreadSeverity = null;

function setActivePane(pane) {
  if (pane === activePane) return;
  activePane = pane;

  const isChat = pane === "chat";
  tabChatBtn.setAttribute("aria-selected", isChat ? "true" : "false");
  tabLogBtn.setAttribute("aria-selected",  isChat ? "false" : "true");

  chatLog.hidden       = !isChat;
  composerForm.hidden  = !isChat;     // composer only makes sense in CHAT
  eventLog.hidden      = isChat;

  if (!isChat) {
    // Selecting LOG clears the unread state — by-definition read.
    unreadSeverity = null;
    renderUnreadLed();
    // When entering LOG, scroll to bottom so the operator sees the
    // most recent events without manually scrolling.
    eventLog.scrollTop = eventLog.scrollHeight;
  } else {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

function renderUnreadLed() {
  if (unreadSeverity === null) {
    eventLogUnread.hidden = true;
    eventLogUnread.removeAttribute("data-severity");
  } else {
    eventLogUnread.hidden = false;
    eventLogUnread.setAttribute("data-severity", unreadSeverity);
  }
}

tabChatBtn.addEventListener("click", () => setActivePane("chat"));
tabLogBtn.addEventListener("click",  () => setActivePane("log"));

/**
 * @param {{severity:"info"|"warn"|"error", source?:string, text:string, ts:number}} ev
 */
function appendEventRow(ev) {
  // Drop empty-state placeholder on first append.
  const empty = eventLog.querySelector(".event-log__empty");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = "event-log__row";
  row.setAttribute("data-severity", ev.severity);

  const led = document.createElement("span");
  led.className = "event-log__led";
  row.appendChild(led);

  const ts = document.createElement("span");
  ts.className = "event-log__ts";
  ts.textContent = formatHms(ev.ts);
  row.appendChild(ts);

  const body = document.createElement("div");
  if (ev.source) {
    const src = document.createElement("span");
    src.className = "event-log__source";
    src.textContent = ev.source;
    body.appendChild(src);
  }
  const text = document.createElement("span");
  text.className = "event-log__text";
  text.textContent = ev.text;
  body.appendChild(text);
  row.appendChild(body);

  // Cap scrollback at 500 rows; drop oldest first.
  while (eventLog.children.length >= 500) eventLog.firstElementChild?.remove();

  // Auto-scroll only if pinned to bottom (chat idiom).
  const pinnedToBottom =
    eventLog.scrollHeight - eventLog.scrollTop - eventLog.clientHeight < 4;

  eventLog.appendChild(row);

  if (pinnedToBottom) eventLog.scrollTop = eventLog.scrollHeight;

  // Update unread LED if CHAT is active.
  if (activePane === "chat") {
    unreadSeverity = nextUnread(unreadSeverity, ev.severity);
    renderUnreadLed();
  }
}

function formatHms(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function clearEventLog() {
  eventLog.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "event-log__empty";
  empty.textContent = "— no events —";
  eventLog.appendChild(empty);
  unreadSeverity = null;
  renderUnreadLed();
}

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

function resetChat() {
  // If a turn is mid-stream, abort it. The SDK rolls back the in-flight
  // user message automatically, so client.messages stays consistent.
  if (inFlightAbort) inFlightAbort.abort();
  agentClient.reset();
  chatLog.innerHTML = "";
  try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch { /* ignore */ }
  appendRow("system", "Conversation reset.");
}

api.onMenuChatReset?.(() => resetChat());

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
// reachability without waiting for the user to send a chat. 10s while
// healthy; backs off to 20s once we've missed three in a row, so a
// long server-down doesn't hammer the network tab. We never probe
// while a chat is in flight — the in-flight POST is itself proof of
// life and a duplicate fetch is racy.

const PROBE_INTERVAL_OK   = 10000;
const PROBE_INTERVAL_DOWN = 20000;
const PROBE_FAILURES_BEFORE_BACKOFF = 3;
let probeFailureCount = 0;

// Render the agent's MCB-issued sessionId (or absence of it) in the
// console header SID slot. Shows the first 8 hex characters as a
// short fingerprint; the full UUID lands in the title attribute for
// hover. A change in id between probes means the agent restarted —
// drop a system row so the user knows their conversation now talks
// to a fresh process. Agent builds that don't emit `sessionId` (or
// emit only the legacy `instanceId`) fall back to "—".
function applyAgentSessionId(nextId) {
  if (nextId === agentSessionId) return;
  const previousId = agentSessionId;
  agentSessionId = nextId;
  if (typeof nextId === "string" && nextId.length > 0) {
    const short = nextId.replace(/-/g, "").slice(0, 8);
    sidValueEl.textContent = short;
    sidEl.title = `Agent session id ${nextId} — changes if the agent restarts`;
  } else {
    sidValueEl.textContent = "—";
    sidEl.title = "Agent session id — server didn't supply one";
  }
  // Only annotate restarts (previous id existed AND changed). A
  // first-ever id (previousId === null) is just normal startup, no
  // need to spam the log on page load.
  if (previousId && nextId && previousId !== nextId) {
    appendRow("system", "agent restarted — new session id");
  }
}

async function probeAgent() {
  if (chatBusy) return; // skip — chat in flight is its own heartbeat
  let ok = false;
  let parsedSessionId = null;
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
      // Best-effort body parse — agent emits `sessionId` (the MCB-
      // issued id). Pre-rename builds emitted `instanceId`; accept
      // that too so a renderer ahead of an old agent still shows
      // the id. Either way, applyAgentSessionId handles missing
      // values by falling back to "—".
      try {
        const body = await res.json();
        if (body && typeof body.sessionId === "string") {
          parsedSessionId = body.sessionId;
        } else if (body && typeof body.instanceId === "string") {
          parsedSessionId = body.instanceId;
        }
      } catch { /* ignore — body wasn't JSON */ }
    }
  } catch {
    ok = false;
  }
  applyAgentSessionId(parsedSessionId);
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

// MCB broker-liveness → blinking amber on all tab LEDs while broker is down.
// State machine and polling live in mcb-client (main process); we just
// listen and toggle a CSS class on every LED. When liveness returns to "up",
// the regular lease-state poll above re-renders normal colors on its next
// tick. `currentBrokerLiveness` is declared near the top so newly-created
// tabs in `renderTabButton` can pick up the right class on creation.

function applyBrokerLivenessToLeds(state) {
  currentBrokerLiveness = state;
  const down = state === "down";
  for (const tab of tabs) {
    const led = tab.button?.querySelector(".tab__led");
    if (!led) continue;
    led.classList.toggle("tab__led--mcb-down", down);
  }
}

if (api?.getBrokerLiveness && api?.onBrokerLiveness) {
  void api.getBrokerLiveness().then((state) => {
    if (state === "up" || state === "down") applyBrokerLivenessToLeds(state);
  }).catch(() => { /* preload missing or main-process error — leave default */ });
  api.onBrokerLiveness((state) => applyBrokerLivenessToLeds(state));
}

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
    appendEventRow({
      severity: "warn",
      source:   "backup",
      text:     "No loaded mocks. Pick a model on a tab first.",
      ts:       Date.now(),
    });
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
  const tab    = tabs.find((t) => t.tabId === tabId);
  const source = tab ? `${tab.displayName} ("${tab.label}")` : "backup";
  appendEventRow({
    severity: "info",
    source,
    text:     `Extracting backup from ${filePath}…`,
    ts:       Date.now(),
  });
  const result = await api.extractBackup({ filePath, tabId });
  appendEventRow({
    severity: result.ok ? "info" : "error",
    source,
    text:     result.message,
    ts:       Date.now(),
  });
}

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

// Event-log subscriptions — non-agent lifecycle/status notes from main
// (replaces the old menu:console-note → chat path).
api.onEventLog?.((payload) => appendEventRow(payload));
api.onEventLogClear?.(() => {
  // Accelerator fires globally; ignore unless LOG is the active pane.
  if (activePane !== "log") return;
  clearEventLog();
});

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

// ─────────────────────────────────────────────────────────────────
// Console rail — combined splitter + collapse toggle
//
// One element handles two gestures:
//   • drag (pointermove > DRAG_THRESHOLD_PX) → resize the console
//   • click (no movement past threshold)     → toggle collapsed state
//
// Width persistence (localStorage), clamping to a slot floor, and
// dblclick-to-reset behave the same as the old separate-splitter setup.
// ─────────────────────────────────────────────────────────────────

const SPLITTER_STORAGE_KEY = "mock-runner:console-w";
const CONSOLE_MIN_PX = 380;
const CONSOLE_MAX_PX = 800;
const SLOT_FLOOR_PX  = 600;
const RAIL_PX        = 12;
const DRAG_THRESHOLD_PX = 4;

const bayEl = document.querySelector(".bay");

function clampConsoleWidth(px, viewportW) {
  // Hard min/max + dynamic ceiling so the slot never drops below its floor.
  const dynamicMax = Math.max(
    CONSOLE_MIN_PX,
    Math.min(CONSOLE_MAX_PX, viewportW - RAIL_PX - SLOT_FLOOR_PX),
  );
  return Math.max(CONSOLE_MIN_PX, Math.min(dynamicMax, px));
}

function applyConsoleWidth(px) {
  bayEl.style.setProperty("--console-w", `${px}px`);
}

function persistConsoleWidth(px) {
  try { localStorage.setItem(SPLITTER_STORAGE_KEY, String(px)); }
  catch { /* private mode / quota — ignore */ }
}

function clearPersistedWidth() {
  try { localStorage.removeItem(SPLITTER_STORAGE_KEY); }
  catch { /* ignore */ }
  bayEl.style.removeProperty("--console-w");
}

// Initial load — apply persisted width if present and within current bounds.
(function initRailWidth() {
  let saved;
  try { saved = localStorage.getItem(SPLITTER_STORAGE_KEY); } catch { saved = null; }
  if (!saved) return;
  const n = Number(saved);
  if (!Number.isFinite(n)) return;
  const clamped = clampConsoleWidth(n, window.innerWidth);
  applyConsoleWidth(clamped);
})();

// Drag-or-click state for the rail.
let dragStartX = 0;
let dragStartW = 0;
let didDrag    = false;

consoleLatchEl?.addEventListener("pointerdown", (e) => {
  // Ignore secondary buttons / non-primary input.
  if (e.button !== 0) return;
  consoleLatchEl.setPointerCapture(e.pointerId);
  document.body.classList.add("bay--resizing");
  dragStartX = e.clientX;
  didDrag = false;
  // If the console is collapsed when the gesture begins, the click
  // path is the operator pressing "expand" — we do nothing here. If
  // they exceed the drag threshold while still down, pointermove will
  // un-collapse and start growing the console from the rail width.
  dragStartW = consoleEl.getBoundingClientRect().width;
  e.preventDefault();
});

consoleLatchEl?.addEventListener("pointermove", (e) => {
  if (!consoleLatchEl.hasPointerCapture(e.pointerId)) return;
  const dx = e.clientX - dragStartX;
  if (!didDrag && Math.abs(dx) > DRAG_THRESHOLD_PX) {
    didDrag = true;
    if (consoleEl.dataset.collapsed === "true") {
      // Snap out of collapsed at the moment the drag is recognized so
      // the operator can sweep the console open in one motion.
      setConsoleCollapsed(false);
      dragStartW = RAIL_PX;
    }
  }
  if (didDrag) {
    // Rail sits LEFT of the console — dragging right shrinks the
    // console, dragging left grows it. Sign reversed accordingly.
    const next = clampConsoleWidth(dragStartW - dx, window.innerWidth);
    applyConsoleWidth(next);
  }
});

function endRailGesture(e, persist) {
  if (consoleLatchEl?.hasPointerCapture(e.pointerId)) {
    consoleLatchEl.releasePointerCapture(e.pointerId);
  }
  document.body.classList.remove("bay--resizing");
  if (didDrag) {
    if (persist) {
      const finalW = consoleEl.getBoundingClientRect().width;
      persistConsoleWidth(Math.round(finalW));
    }
  } else if (persist) {
    // Pure click — toggle the collapsed state. (Cancel/lost-capture
    // both pass persist=false, so an aborted gesture won't toggle.)
    setConsoleCollapsed(consoleEl.dataset.collapsed !== "true");
  }
}

consoleLatchEl?.addEventListener("pointerup",          (e) => endRailGesture(e, true));
// On cancel (OS gesture, alt-tab, focus loss) clear the resizing state
// without persisting the width or treating it as a click. Without these,
// .bay--resizing can stick on <body> leaving cursor: col-resize and
// iframe pointer-events disabled until reload.
consoleLatchEl?.addEventListener("pointercancel",      (e) => endRailGesture(e, false));
consoleLatchEl?.addEventListener("lostpointercapture", (e) => endRailGesture(e, false));

// Double-click resets to the static-CSS default. Note: dblclick fires
// after the second pointerup — by that point setConsoleCollapsed has
// already toggled twice, so we end where we started, then reset width.
consoleLatchEl?.addEventListener("dblclick", () => {
  clearPersistedWidth();
});

// Window resize — re-clamp the persisted width if it would now violate
// the slot floor under the new viewport. Don't rewrite localStorage; if
// the operator resizes back later, restore their original choice.
window.addEventListener("resize", () => {
  let saved;
  try { saved = localStorage.getItem(SPLITTER_STORAGE_KEY); } catch { saved = null; }
  if (!saved) return;
  const n = Number(saved);
  if (!Number.isFinite(n)) return;
  applyConsoleWidth(clampConsoleWidth(n, window.innerWidth));
});
