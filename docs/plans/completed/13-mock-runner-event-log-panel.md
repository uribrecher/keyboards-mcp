# 13 — Mock-runner Event Log Panel + Bay Splitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull non-chat lifecycle/status events out of the chat console into a dedicated Event Log pane (selected via a tabbed CHAT/LOG strip in the console), and add a draggable splitter between the rack slot and the console.

**Architecture:** A new `menu:event-log` IPC channel carries `{severity, source?, text, ts}` payloads from main to renderer. The renderer maintains two log panes (`#chat-log`, `#event-log`) and a tab strip whose CHAT tab carries the agent identity (lamp + SID + meter) and whose LOG tab carries an unread severity-tinted LED. A pure JS module owns the unread-LED state machine. The bay grid grows a third column for a 6px draggable splitter; console width persists in `localStorage`.

**Tech Stack:** TypeScript (main), plain ESM JavaScript (renderer), CSS (existing graphite/amber chassis palette), Electron IPC, `node:test` + `node:assert` for unit tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-08-mock-runner-event-log-design.md`
**Branch:** `feat/mock-runner-event-log` (already created from `main`)

---

## File Structure

| Path | New / Modify | Responsibility |
|---|---|---|
| `src/mock-runner/event-log-ipc.ts` | **new** | Pure module: payload types + thin emit helpers wrapping `webContents.send`. Single import surface for all main-process emit sites. |
| `src/mock-runner/main.ts` | modify | Replace 6 `menu:console-note` emit sites with calls into `event-log-ipc.ts`; add `clear-event-log` accelerator. |
| `src/mock-runner/preload.cjs` | modify | Expose `onEventLog`, `onEventLogClear`. Remove `onConsoleNote`. |
| `src/mock-runner/shell/unread-state.js` | **new** | Pure ESM module: severity-rank state machine for the LOG-tab unread LED. No DOM. |
| `src/mock-runner/shell/index.html` | modify | Restructure `.console__header` → tabbed strip (CHAT + LOG); add `#event-log` pane sibling of `#chat-log`; add `.bay__splitter` element. |
| `src/mock-runner/shell/style.css` | modify | Tabbed-box styling, severity LEDs, event-log row layout, inactive-tab dim, splitter visual. |
| `src/mock-runner/shell/app.js` | modify | Pane switching, `appendEventRow`, unread-LED wiring, splitter drag + persistence, `clear-event-log` handler. Remove `onConsoleNote` consumer. |
| `tests/unit/mock-runner/event-log-ipc.test.ts` | **new** | Unit-test the emit helpers via a fake `webContents`. |
| `tests/unit/mock-runner/unread-state.test.ts` | **new** | Unit-test the unread state machine (upgrade rules, clear). |

The two new pure modules are the entire test surface. Everything else is DOM-coupled and verified via the manual smoke checklist in Task 12.

---

## Phase 1 — IPC plumbing (no UI changes)

### Task 1: Add the event-log IPC helper module + tests

**Files:**
- Create: `src/mock-runner/event-log-ipc.ts`
- Create: `tests/unit/mock-runner/event-log-ipc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/mock-runner/event-log-ipc.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { BrowserWindow } from "electron";
import {
  emitEvent,
  emitEventLogClear,
  EVENT_LOG_CHANNEL,
  EVENT_LOG_CLEAR_CHANNEL,
} from "../../../src/mock-runner/event-log-ipc.js";

interface FakeWin {
  sent: Array<{ channel: string; payload: unknown }>;
  webContents: { send(channel: string, payload?: unknown): void };
}

function fakeWin(): FakeWin {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    webContents: {
      send(channel, payload) { sent.push({ channel, payload }); },
    },
  };
}

// One cast at the call site — fakeWin's shape is structurally compatible
// with the real BrowserWindow for emitEvent's needs.
const asWin = (f: FakeWin) => f as unknown as BrowserWindow;

describe("event-log-ipc", () => {
  it("emitEvent sends to menu:event-log with full payload", () => {
    const win = fakeWin();
    emitEvent(asWin(win), { severity: "warn", source: "setup", text: "skipped tab", ts: 1000 });
    assert.equal(win.sent.length, 1);
    assert.equal(win.sent[0].channel, EVENT_LOG_CHANNEL);
    assert.equal(EVENT_LOG_CHANNEL, "menu:event-log");
    assert.deepEqual(win.sent[0].payload, {
      severity: "warn", source: "setup", text: "skipped tab", ts: 1000,
    });
  });

  it("emitEvent fills ts when omitted (uses Date.now)", () => {
    const win = fakeWin();
    const before = Date.now();
    emitEvent(win, { severity: "info", text: "hello" });
    const after = Date.now();
    const payload = win.sent[0].payload as { ts: number };
    assert.ok(payload.ts >= before && payload.ts <= after);
  });

  it("emitEvent omits source when not provided", () => {
    const win = fakeWin();
    emitEvent(asWin(win), { severity: "info", text: "hello", ts: 2000 });
    const payload = win.sent[0].payload as { source?: string };
    assert.equal(payload.source, undefined);
  });

  it("emitEvent is a no-op when win is null", () => {
    assert.doesNotThrow(() => emitEvent(null, { severity: "info", text: "hi" }));
  });

  it("emitEventLogClear sends on the clear channel", () => {
    const win = fakeWin();
    emitEventLogClear(asWin(win));
    assert.equal(win.sent.length, 1);
    assert.equal(win.sent[0].channel, EVENT_LOG_CLEAR_CHANNEL);
    assert.equal(EVENT_LOG_CLEAR_CHANNEL, "menu:event-log-clear");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `keyboards-mcp/`:
```bash
npx tsx --test tests/unit/mock-runner/event-log-ipc.test.ts
```
Expected: FAIL — `Cannot find module '.../event-log-ipc.js'`.

- [ ] **Step 3: Implement the helper**

Create `src/mock-runner/event-log-ipc.ts`:

```ts
/**
 * Event-log IPC — main-process side.
 *
 * Single emit surface for non-agent lifecycle/status notes that flow
 * from main to the renderer's Event Log pane. Replaces the old
 * `menu:console-note` channel for everything except agent dialog
 * (which doesn't go through IPC at all — it's an in-renderer fetch
 * stream).
 *
 * `import type` — no runtime import of electron, so the unit tests
 * can run under plain `tsx --test` without an Electron host.
 */

import type { BrowserWindow } from "electron";

export const EVENT_LOG_CHANNEL       = "menu:event-log";
export const EVENT_LOG_CLEAR_CHANNEL = "menu:event-log-clear";

export type EventSeverity = "info" | "warn" | "error";

export interface EventLogPayload {
  severity: EventSeverity;
  /** Optional originating subsystem or device, e.g. `${displayName} ("${label}")` or `setup`. */
  source?: string;
  /** Body line, plain text. */
  text: string;
  /** Wall-clock millis. Filled in automatically by emitEvent if omitted. */
  ts: number;
}

type Win   = Pick<BrowserWindow, "webContents">;
type Input = Omit<EventLogPayload, "ts"> & { ts?: number };

/**
 * Emit one event-log row to the renderer. No-op if `win` is null
 * (the renderer hasn't been created yet, e.g. during cold startup).
 */
export function emitEvent(win: Win | null | undefined, input: Input): void {
  if (!win) return;
  const payload: EventLogPayload = {
    severity: input.severity,
    text:     input.text,
    ts:       input.ts ?? Date.now(),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  win.webContents.send(EVENT_LOG_CHANNEL, payload);
}

/** Tell the renderer to empty the Event Log pane. */
export function emitEventLogClear(win: Win | null | undefined): void {
  if (!win) return;
  win.webContents.send(EVENT_LOG_CLEAR_CHANNEL);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsx --test tests/unit/mock-runner/event-log-ipc.test.ts
```
Expected: 5 tests passing.

- [ ] **Step 5: Run full unit + lint to make sure nothing regressed**

```bash
npm run test:unit
npm run lint
```
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mock-runner/event-log-ipc.ts tests/unit/mock-runner/event-log-ipc.test.ts
git commit -S -m "feat(mock-runner): add event-log IPC helper module

Single emit surface for non-agent lifecycle/status notes from main to
renderer. Replaces the menu:console-note channel for non-agent
surfaces. Pure module — no Electron import — so it can be unit-tested
with a fake webContents."
```

---

### Task 2: Migrate the 6 main.ts emit sites to the new helper

**Files:**
- Modify: `src/mock-runner/main.ts:121,262,281,293,860,900`

- [ ] **Step 1: Add the import**

At the top of `src/mock-runner/main.ts`, alongside the other local imports, add:

```ts
import { emitEvent } from "./event-log-ipc.js";
```

- [ ] **Step 2: Migrate site 1 — `notifyEmptySaveRefused()` (line ~121)**

Current code:

```ts
function notifyEmptySaveRefused(): void {
  mainWindow?.webContents.send("menu:console-note", {
    text: "Nothing to save — add a tab and pick a model first.",
  });
}
```

Replace with:

```ts
function notifyEmptySaveRefused(): void {
  emitEvent(mainWindow, {
    severity: "warn",
    source:   "setup",
    text:     "Nothing to save — add a tab and pick a model first.",
  });
}
```

- [ ] **Step 3: Migrate site 2 — model-not-registered during restore (line ~262)**

Current code:

```ts
mainWindow?.webContents.send("menu:console-note",
  { text: `Skipped tab "${t.label}": model "${t.modelId}" not registered.` });
```

Replace with:

```ts
emitEvent(mainWindow, {
  severity: "warn",
  source:   "setup",
  text:     `Skipped tab "${t.label}": model "${t.modelId}" not registered.`,
});
```

- [ ] **Step 4: Migrate site 3 — engine start failed during restore (line ~281)**

Current code:

```ts
mainWindow?.webContents.send("menu:console-note", {
  text: `Skipped tab "${t.label}" (${model.info.displayName}): engine failed to start — ${err instanceof Error ? err.message : String(err)}`,
});
```

Replace with:

```ts
emitEvent(mainWindow, {
  severity: "error",
  source:   `${model.info.displayName} ("${t.label}")`,
  text:     `engine failed to start — ${err instanceof Error ? err.message : String(err)}`,
});
```

- [ ] **Step 5: Migrate site 4 — full-state-restore-not-implemented (line ~293)**

Current code:

```ts
mainWindow?.webContents.send("menu:console-note",
  { text: `${model.info.displayName} ("${t.label}"): full state restore not yet implemented — knobs reset to defaults.` });
```

Replace with:

```ts
emitEvent(mainWindow, {
  severity: "warn",
  source:   `${model.info.displayName} ("${t.label}")`,
  text:     "full state restore not yet implemented — knobs reset to defaults.",
});
```

- [ ] **Step 6: Migrate site 5 — open-file path missing (line ~860)**

Current code:

```ts
mainWindow?.webContents.send("menu:console-note",
  { text: `File not found: ${path}` });
```

Replace with:

```ts
emitEvent(mainWindow, {
  severity: "error",
  source:   "setup",
  text:     `File not found: ${path}`,
});
```

- [ ] **Step 7: Migrate site 6 — auto-load path missing (line ~900)**

Current code:

```ts
mainWindow?.webContents.send("menu:console-note",
  { text: `File not found: ${path}` });
```

Replace with:

```ts
emitEvent(mainWindow, {
  severity: "warn",
  source:   "setup",
  text:     `File not found: ${path}`,
});
```

- [ ] **Step 8: Verify no menu:console-note references remain in main.ts**

Run:
```bash
grep -n "menu:console-note" src/mock-runner/main.ts
```
Expected: no output.

- [ ] **Step 9: Build + lint to catch typos**

```bash
npm run build
npm run lint
```
Expected: pass.

- [ ] **Step 10: Commit**

```bash
git add src/mock-runner/main.ts
git commit -S -m "feat(mock-runner): migrate console-note sites to event-log

All six existing menu:console-note emit sites now use emitEvent() with
explicit severity. Severities follow the design spec:
  warn  — site 1 (empty-save refused)
  warn  — site 2 (skipped: model not registered)
  error — site 3 (skipped: engine failed to start)
  warn  — site 4 (full-state-restore-not-implemented)
  error — site 5 (Open: file not found, user-initiated)
  warn  — site 6 (auto-load: file not found, fallback)"
```

---

### Task 3: Update preload to expose the new IPC channels

**Files:**
- Modify: `src/mock-runner/preload.cjs`

- [ ] **Step 1: Replace `onConsoleNote` with the new event-log subscriptions**

Current code in `preload.cjs:42`:

```js
onConsoleNote: (cb) => ipcRenderer.on("menu:console-note", (_e, payload) => cb(payload)),
```

Replace with:

```js
onEventLog: (cb) => ipcRenderer.on("menu:event-log", (_e, payload) => cb(payload)),
onEventLogClear: (cb) => ipcRenderer.on("menu:event-log-clear", () => cb()),
```

(These go in the same `contextBridge.exposeInMainWorld` object literal, alphabetically grouped near the other `onMenu…` entries.)

- [ ] **Step 2: Verify lint is happy**

```bash
npm run lint
```
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/mock-runner/preload.cjs
git commit -S -m "feat(mock-runner): expose event-log IPC to renderer

Drops onConsoleNote (no longer used post-migration); adds onEventLog
(for new lifecycle events) and onEventLogClear (for the clear
accelerator wired up later)."
```

---

## Phase 2 — Renderer pure logic

### Task 4: Pure unread-LED state module + tests

**Files:**
- Create: `src/mock-runner/shell/unread-state.js`
- Create: `tests/unit/mock-runner/unread-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/mock-runner/unread-state.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { nextUnread } from "../../../src/mock-runner/shell/unread-state.js";

describe("unread-state", () => {
  it("nextUnread starts at the incoming severity from null", () => {
    assert.equal(nextUnread(null, "info"), "info");
    assert.equal(nextUnread(null, "warn"), "warn");
    assert.equal(nextUnread(null, "error"), "error");
  });

  it("nextUnread upgrades to higher severity", () => {
    assert.equal(nextUnread("info", "warn"), "warn");
    assert.equal(nextUnread("info", "error"), "error");
    assert.equal(nextUnread("warn", "error"), "error");
  });

  it("nextUnread never downgrades", () => {
    assert.equal(nextUnread("error", "warn"), "error");
    assert.equal(nextUnread("error", "info"), "error");
    assert.equal(nextUnread("warn", "info"), "warn");
  });

  it("nextUnread holds equal severity", () => {
    assert.equal(nextUnread("warn", "warn"), "warn");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx --test tests/unit/mock-runner/unread-state.test.ts
```
Expected: FAIL — `Cannot find module 'unread-state.js'`.

- [ ] **Step 3: Implement the module**

Create `src/mock-runner/shell/unread-state.js`:

```js
/**
 * Pure state machine for the LOG-tab unread LED.
 *
 * Severity ranks (ascending): info < warn < error.
 *
 * The LED state never downgrades. When a new event arrives with a
 * higher severity than the current unread state, we upgrade. Equal or
 * lower severities are absorbed without changing the state.
 *
 * Selecting the LOG tab clears the state — that's just `null`,
 * applied by the caller; this module doesn't carry global state.
 */

const RANK = { info: 0, warn: 1, error: 2 };

/**
 * @param {"info" | "warn" | "error" | null} prev
 * @param {"info" | "warn" | "error"} incoming
 * @returns {"info" | "warn" | "error"}
 */
export function nextUnread(prev, incoming) {
  if (prev === null) return incoming;
  return RANK[incoming] > RANK[prev] ? incoming : prev;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsx --test tests/unit/mock-runner/unread-state.test.ts
```
Expected: 4 tests passing.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/mock-runner/shell/unread-state.js tests/unit/mock-runner/unread-state.test.ts
git commit -S -m "feat(mock-runner): pure unread-LED state machine

Severity-ranked state for the LOG tab's unread LED: starts null,
upgrades on higher severity, never downgrades. Drives the in-tab LED
color when CHAT is the active pane and events are arriving."
```

---

## Phase 3 — DOM scaffolding

### Task 5: Restructure index.html into a tabbed console box

**Files:**
- Modify: `src/mock-runner/shell/index.html`

- [ ] **Step 1: Replace the console header + chat-log block with the new tabbed structure**

Find this block (currently around `index.html:46-63`):

```html
<aside class="console" id="console">
  <div class="console__header" id="console-header" data-state="unknown">
    <span class="console__lamp"></span>
    <span class="console__sid" id="agent-sid" title="Agent process id — changes if the agent restarts">
      <span class="console__sid-label">SID</span><span class="console__sid-value" id="agent-sid-value">—</span>
    </span>
    <span class="console__meter" id="agent-status" data-state="unknown">
      <span></span><span></span><span></span><span></span><span></span>
    </span>
    <button class="console__btn" id="chat-extract" title="Extract backup (⌘E)">backup</button>
    <button class="console__btn" id="chat-reset" title="Reset conversation">reset</button>
  </div>

  <div class="console__log" id="chat-log" role="log" aria-live="polite">
    <div class="chat-row chat-row--system">
      <p class="chat-line">Bring up a model on the rack. Then ask Claude to drive it.</p>
    </div>
  </div>
```

Replace with:

```html
<aside class="console" id="console">
  <!-- Tabbed box: tabs are first-class. CHAT tab carries the agent
       identity strip (lamp + SID + meter); LOG tab carries an unread
       severity-tinted LED. The action buttons that used to live up
       here (backup / reset / clear) have been removed pending
       backlog #19. -->
  <div class="console__tabs" role="tablist" aria-label="Console panes">
    <button class="console__tab" id="tab-chat" role="tab"
            aria-selected="true" aria-controls="chat-log"
            data-state="unknown">
      <span class="console__lamp"></span>
      <span class="console__sid" id="agent-sid"
            title="Agent process id — changes if the agent restarts">
        <span class="console__sid-label">SID:</span><span
              class="console__sid-value" id="agent-sid-value">—</span>
      </span>
      <span class="console__meter" id="agent-status" data-state="unknown">
        <span></span><span></span><span></span><span></span><span></span>
      </span>
    </button>
    <button class="console__tab" id="tab-log" role="tab"
            aria-selected="false" aria-controls="event-log">
      <span class="console__tab-label">LOG</span>
      <span class="console__unread" id="event-log-unread" hidden></span>
    </button>
  </div>

  <div class="console__log" id="chat-log" role="log" aria-live="polite">
    <div class="chat-row chat-row--system">
      <p class="chat-line">Bring up a model on the rack. Then ask Claude to drive it.</p>
    </div>
  </div>

  <div class="console__log console__log--events" id="event-log"
       role="log" aria-live="polite" hidden>
    <div class="event-log__empty">— no events —</div>
  </div>
```

(The `<form class="composer" …>` block that follows is unchanged.)

Notes:
- The `data-state="unknown"` attribute moves from `#console-header` (now gone) onto `#tab-chat`. The renderer's `applyAgentState` function will be updated in Task 8 to target the new element.
- The `aria-controls` IDs (`chat-log`, `event-log`) match the corresponding pane IDs.
- `#event-log-unread` starts hidden; the renderer toggles `[hidden]` and a `data-severity` attribute.

- [ ] **Step 2: Validate the HTML by opening the mock-runner once**

```bash
npm run mock:runner
```

Expected: window opens (UI will be visually broken until the CSS in Phase 3b lands — that's OK; we're just confirming the HTML parses and the existing `app.js` doesn't immediately throw on missing DOM lookups). Close the window. Don't commit yet — the renderer will throw if you reload the chat reset/extract buttons it's trying to wire up. Move directly into Step 3.

- [ ] **Step 3: Loosen renderer references to the buttons it expects (temporary nullable lookup)**

In `src/mock-runner/shell/app.js`, the chunk currently around line 285-293 references DOM elements by ID. Update the lookups for the now-removed elements to nullable form to avoid errors during this transitional commit (they'll be removed entirely in Task 8):

Find:

```js
const chatReset     = document.getElementById("chat-reset");
const chatExtract   = document.getElementById("chat-extract");
const meterEl       = document.getElementById("agent-status");
const consoleHeader = document.getElementById("console-header");
```

Replace with:

```js
const chatReset     = document.getElementById("chat-reset"); // null until backlog #19 re-homes the button
const chatExtract   = document.getElementById("chat-extract"); // null until backlog #19 re-homes the button
const meterEl       = document.getElementById("agent-status");
const consoleHeader = document.getElementById("tab-chat"); // tabbed-box restructure: data-state lives on the chat tab now
```

And guard the button event listeners later in the file so they no-op when the buttons don't exist. Find:

```js
chatReset.addEventListener("click", () => {
```

Replace with:

```js
chatReset?.addEventListener("click", () => {
```

And find:

```js
chatExtract.addEventListener("click", openBackupModal);
```

Replace with:

```js
chatExtract?.addEventListener("click", openBackupModal);
```

- [ ] **Step 4: Verify the app still loads**

```bash
npm run mock:runner
```

Expected: window opens with the OLD `.console__header` styling completely broken (blocks not rendering as tabs because no CSS yet). Type into chat — no JS errors in DevTools console. Close.

- [ ] **Step 5: Commit**

```bash
git add src/mock-runner/shell/index.html src/mock-runner/shell/app.js
git commit -S -m "feat(mock-runner): restructure console to tabbed box (HTML)

Replaces .console__header with a two-tab strip. CHAT tab owns the
lamp + SID + agent meter; LOG tab owns the (initially hidden) unread
LED. Adds the #event-log pane sibling to #chat-log. The
backup/reset/clear buttons are removed pending backlog #19 — renderer
references switched to optional chaining so existing code paths
no-op until the buttons find a new home.

Visually unstyled until the CSS lands in the next commits."
```

---

## Phase 3b — CSS for the tabbed box

### Task 6: Tab strip styling — active/inactive, dim treatment, unread LED

**Files:**
- Modify: `src/mock-runner/shell/style.css`

- [ ] **Step 1: Replace the `.console__header` and `.console__lamp` blocks with tab-strip styling**

The existing `.console__header` block lives at `style.css:438-475` (and surrounding state-driven selectors). We're keeping the lamp, SID, and meter selectors *as is* — they work inside the new `.console__tab` element — but replacing the strip-level container.

Find:

```css
.console__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background:
    linear-gradient(180deg, var(--c-console-hi) 0%, var(--c-console) 100%);
  border-bottom: 1px solid var(--c-edge);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--c-text-dim);
}
```

Replace with:

```css
/* ── Tabbed box: tab strip ── */
.console__tabs {
  display: flex;
  align-items: stretch;
  gap: 0;
  background:
    linear-gradient(180deg, var(--c-console-hi) 0%, var(--c-console) 100%);
  border-bottom: 1px solid var(--c-edge);
}

.console__tab {
  appearance: none;
  -webkit-appearance: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: transparent;
  border: 0;
  border-right: 1px solid var(--c-edge);
  cursor: pointer;
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--c-text-dim);
  text-align: left;
}

.console__tab:focus-visible {
  outline: 1px solid var(--c-amber);
  outline-offset: -3px;
}

/* Active tab: bright text + amber underline. The 1px underline is
 * laid in via box-shadow inset so it doesn't perturb the flex
 * baseline. */
.console__tab[aria-selected="true"] {
  color: var(--c-text-bright);
  background: linear-gradient(180deg, var(--c-console) 0%, var(--c-console-hi) 100%);
  box-shadow: inset 0 -1px 0 0 var(--c-amber);
}

/* Inactive CHAT tab: ambiently visible, dimmed. Its lamp/SID/meter
 * children stay live (state still updates) but at lower glow so the
 * active LOG content reads as primary. */
.console__tab[aria-selected="false"] {
  opacity: 0.55;
}
.console__tab[aria-selected="false"]:hover {
  opacity: 0.75;
}

/* LOG tab specifics */
.console__tab-label {
  letter-spacing: 0.45em;
}

/* Unread LED — small jewel, severity-tinted, slot lives in LOG tab. */
.console__unread {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-amber);
  box-shadow:
    0 0 5px var(--c-amber-glow),
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
  transition: background .2s, box-shadow .2s;
}
.console__unread[data-severity="info"] {
  background: var(--c-green);
  box-shadow:
    0 0 5px var(--c-green-glow),
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
}
.console__unread[data-severity="warn"] {
  background: var(--c-amber);
  box-shadow:
    0 0 5px var(--c-amber-glow),
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
}
.console__unread[data-severity="error"] {
  background: var(--c-fault);
  box-shadow:
    0 0 5px var(--c-fault-glow),
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
}
```

- [ ] **Step 2: Update the existing `.console__header[data-state=…]` selectors to target the chat tab**

The agent state attribute used to live on `#console-header`. It now lives on `#tab-chat` (a `.console__tab`). Search the CSS file for `.console__header[data-state` and replace each with `.console__tab[data-state`. There are typically four such selectors (lost, unknown, busy, live or similar).

Run:
```bash
grep -n '\.console__header\[data-state' src/mock-runner/shell/style.css
```

For each match, change the prefix from `.console__header` to `.console__tab`. After this, no `.console__header` selector should remain in the file:

```bash
grep -n '\.console__header' src/mock-runner/shell/style.css
```
Expected: no output.

- [ ] **Step 3: Smoke the visuals**

```bash
npm run mock:runner
```

Expected:
- Tab strip with two tabs visible. CHAT tab shows lamp + SID + meter (bright). LOG tab shows just `LOG` (dim).
- Click the LOG tab — visual selection swaps (LOG bright + underline, CHAT dim).
- Click CHAT — back to original.
- Pane content does NOT swap yet (that's Task 8). This step is CSS only.

Close.

- [ ] **Step 4: Commit**

```bash
git add src/mock-runner/shell/style.css
git commit -S -m "feat(mock-runner): style the tabbed console strip

Tab strip with active/inactive treatment, amber underline on the
active tab, dim opacity on the inactive one. Unread LED slot in the
LOG tab supports info/warn/error tinting via data-severity. Existing
agent-state selectors retargeted from .console__header to
.console__tab."
```

---

### Task 7: Event-log row styling (severity LED, timestamp, source, body)

**Files:**
- Modify: `src/mock-runner/shell/style.css`

- [ ] **Step 1: Append event-log row styles to the bottom of the file**

Add at the end of `style.css`:

```css
/* ═════════════ Event Log pane ═════════════ */

.console__log--events {
  /* Reuse the chat-log scrollback / padding by sharing .console__log;
   * this file just adds event-row layout on top. */
  font-family: var(--font-chat);
  color: var(--c-paper);
}

.console__log--events[hidden] {
  display: none;
}

.event-log__row {
  display: grid;
  grid-template-columns: 14px 70px 1fr;
  gap: 8px;
  align-items: start;
  padding: 6px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.025);
  font-size: 12px;
  line-height: 1.4;
  color: var(--c-paper);
}

.event-log__led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 4px; /* visual centering against first text line */
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
}
.event-log__row[data-severity="info"]  .event-log__led {
  background: var(--c-green);
  box-shadow:
    0 0 4px var(--c-green-glow),
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
}
.event-log__row[data-severity="warn"]  .event-log__led {
  background: var(--c-amber);
  box-shadow:
    0 0 4px var(--c-amber-glow),
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
}
.event-log__row[data-severity="error"] .event-log__led {
  background: var(--c-fault);
  box-shadow:
    0 0 4px var(--c-fault-glow),
    inset 0 1px 0 rgba(255,255,255,0.5),
    inset 0 -1px 0 rgba(0,0,0,0.4);
}

.event-log__ts {
  color: var(--c-paper-faint);
  font-variant-numeric: tabular-nums;
}

.event-log__source {
  color: var(--c-paper-dim);
  display: block;
  margin-bottom: 2px;
}

.event-log__text {
  color: var(--c-paper);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Empty state — same dim brushed-rail vibe as .slot__empty. */
.event-log__empty {
  padding: 32px 12px;
  text-align: center;
  letter-spacing: 0.4em;
  text-transform: uppercase;
  font-size: 11px;
  color: var(--c-text-faint);
}
```

- [ ] **Step 2: Smoke**

```bash
npm run mock:runner
```

Expected: clicking LOG still does nothing functional (Task 8 wires it up), but if you manually edit the DOM via DevTools to remove `[hidden]` from `#event-log` you should see the empty-state line styled correctly. Close.

- [ ] **Step 3: Commit**

```bash
git add src/mock-runner/shell/style.css
git commit -S -m "feat(mock-runner): style event-log row layout

Row grid: severity LED | HH:MM:SS | source + text. Severity LED
colors reuse the chassis palette (green / amber / oxblood). Empty
state uses the brushed-rail empty idiom from .slot__empty."
```

---

## Phase 4 — Renderer wiring

### Task 8: Pane switching, appendEventRow, unread-LED state machine wired up

**Files:**
- Modify: `src/mock-runner/shell/app.js`

- [ ] **Step 1: Add module-level imports + DOM lookups for the new elements**

Near the existing renderer imports (top of file), add:

```js
import { nextUnread } from "./unread-state.js";
```

Then locate the chat console DOM-lookup block (around `app.js:285-293` after Task 5's edits) and **add** the following after the existing lookups:

```js
const tabChatBtn        = document.getElementById("tab-chat");
const tabLogBtn         = document.getElementById("tab-log");
const eventLog          = document.getElementById("event-log");
const eventLogUnread    = document.getElementById("event-log-unread");
const composerForm      = document.getElementById("chat-form");
```

(Keep the existing `chatLog`, `chatForm`, `chatInput`, `meterEl`, `consoleHeader`, `sidEl`, `sidValueEl` lookups untouched.)

- [ ] **Step 2: Add the pane-switch state machine**

Add a new section in `app.js` immediately after the chat-console module-level state (after `let agentState = "unknown"; let lastConfirmed = "unknown";`):

```js
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
```

- [ ] **Step 3: Add `appendEventRow` and the empty-state toggle**

Append these helpers next to the new pane state machine (just below):

```js
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
```

- [ ] **Step 4: Replace the old `onConsoleNote` subscription with the new event-log subscriptions**

Locate the current line (around `app.js:850`):

```js
// Render in-shell notes from main (Open errors, graceful-degradation msgs).
api.onConsoleNote?.(({ text }) => { appendRow("system", text); });
```

Replace with:

```js
// Event-log subscriptions — non-agent lifecycle/status notes from main
// (replaces the old menu:console-note → chat path).
api.onEventLog?.((payload) => appendEventRow(payload));
api.onEventLogClear?.(() => clearEventLog());
```

- [ ] **Step 5: Smoke the wiring end-to-end**

```bash
npm run mock:runner
```

Expected:
- Initial state: CHAT tab active, lamp/SID/meter visible, LOG tab dim with no unread LED, event-log pane hidden.
- Click LOG: CHAT tab dims, LOG tab brightens with amber underline, `#event-log` shows `— no events —`, composer disappears.
- Click CHAT: back to chat.

Now trigger an event from main:
- File menu → Save (with no tabs). Cmd-S. Expected: stays on CHAT. The unread LED on the LOG tab lights amber (warn). Click LOG: see one row with amber LED, timestamp, `setup` source, "Nothing to save — add a tab and pick a model first."
- Click CHAT: unread LED is now off (cleared on switch-to-LOG).

Close.

- [ ] **Step 6: Run tests + lint**

```bash
npm run test:unit
npm run lint
```
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/mock-runner/shell/app.js
git commit -S -m "feat(mock-runner): wire CHAT/LOG pane switching + event log

- setActivePane() toggles aria-selected, [hidden] on the two log
  panes, and the composer; clears unread on switch-to-LOG.
- appendEventRow() builds a styled row, caps scrollback at 500
  entries, auto-scrolls if pinned to bottom, and updates the unread
  LED via the pure unread-state module.
- Replaces the dropped onConsoleNote subscription with onEventLog +
  onEventLogClear."
```

---

## Phase 5 — Bay splitter

### Task 9: Splitter HTML + CSS

**Files:**
- Modify: `src/mock-runner/shell/index.html`
- Modify: `src/mock-runner/shell/style.css`

- [ ] **Step 1: Insert the splitter element between slot and console**

In `index.html`, find:

```html
<main class="bay">
  <section class="slot" id="slot">
```

Replace the `<main class="bay">` opening line (and add the splitter element after `</section>` of `.slot`). The full updated structure:

```html
<main class="bay">
  <section class="slot" id="slot">
    <!-- iframes get injected here, one per tab -->
    <div class="slot__empty" id="slot-empty">
      <div class="slot__empty-rail"></div>
      <div class="slot__empty-msg">— EMPTY RACK SLOT —</div>
      <div class="slot__empty-rail"></div>
    </div>
  </section>

  <div class="bay__splitter" id="bay-splitter"
       role="separator" aria-orientation="vertical"
       aria-label="Resize console" tabindex="0"
       title="Drag to resize · double-click to reset"></div>

  <aside class="console" id="console">
```

(The `.slot` and `.console` blocks are unchanged otherwise. Only the splitter `<div>` is new.)

- [ ] **Step 2: Update the bay grid + add splitter visual styles**

In `style.css`, find:

```css
.bay {
  display: grid;
  /* Console panel was 380px fixed — too narrow for monospaced LLM output
   * (ASCII tables, code, long URLs). Clamp lets it breathe at larger
   * window sizes while protecting the model-UI slot at the 1200px min.
   * Bumped ~10% wider (484/35vw/616) over the first iteration after the
   * user reported it still felt cramped. */
  grid-template-columns: 1fr clamp(484px, 35vw, 616px);
  gap: 0;
  min-height: 0;
  height: 100%;
  background: var(--c-shell);
}
```

Replace with:

```css
.bay {
  display: grid;
  /* Three columns: slot (flex) | 6px splitter | console (operator-set
   * width via --console-w, falling back to the original clamp default
   * if the operator hasn't dragged it yet). The slot has an implicit
   * floor of 600px enforced by the splitter drag clamp in app.js. */
  grid-template-columns: 1fr 6px var(--console-w, clamp(484px, 35vw, 616px));
  gap: 0;
  min-height: 0;
  height: 100%;
  background: var(--c-shell);
}

.bay__splitter {
  position: relative;
  cursor: col-resize;
  background:
    linear-gradient(180deg,
      rgba(255,255,255,0.02) 0%,
      rgba(255,255,255,0.06) 50%,
      rgba(255,255,255,0.02) 100%);
  border-left:  1px solid var(--c-edge);
  border-right: 1px solid var(--c-edge);
  transition: background .12s, box-shadow .12s;
}

/* Subtle dimple at vertical center — reads as a screw/grip. */
.bay__splitter::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 14px;
  margin: -7px 0 0 -1px;
  background:
    radial-gradient(circle at 50% 30%, rgba(255,255,255,0.18) 0%, transparent 70%),
    var(--c-chassis-low);
  border-radius: 1px;
  box-shadow:
    inset 0 0 0 1px rgba(0,0,0,0.4);
}

/* Hover: reveal a faint amber accent line down the middle, echoing
 * the chassis lamps without becoming a noisy seam. */
.bay__splitter:hover {
  background:
    linear-gradient(180deg,
      rgba(255,255,255,0.04) 0%,
      rgba(255,255,255,0.10) 50%,
      rgba(255,255,255,0.04) 100%);
  box-shadow: inset 0 0 0 1px rgba(240,168,48,0.30);
}

.bay__splitter:focus-visible {
  outline: 1px solid var(--c-amber);
  outline-offset: -2px;
}

/* Mid-drag: the body gets this class so iframes don't swallow
 * pointer events and the cursor stays col-resize globally. */
body.bay--resizing,
body.bay--resizing * {
  cursor: col-resize !important;
  user-select: none;
}
body.bay--resizing iframe { pointer-events: none; }
```

- [ ] **Step 3: Smoke the visual**

```bash
npm run mock:runner
```

Expected: a visible 6px brushed-metal seam between slot and console, with a small dimple at vertical center. Hover shows a faint amber edge. Close.

- [ ] **Step 4: Commit**

```bash
git add src/mock-runner/shell/index.html src/mock-runner/shell/style.css
git commit -S -m "feat(mock-runner): add bay splitter element + visual

Three-column .bay grid: slot | splitter | console. The console
column is sized via --console-w (with the original clamp as
fallback). Splitter is 6px brushed metal with a center dimple and an
amber hover accent. Drag wiring lands in the next commit."
```

---

### Task 10: Splitter drag behavior + persistence

**Files:**
- Modify: `src/mock-runner/shell/app.js`

- [ ] **Step 1: Add the splitter module at the bottom of `app.js`**

Append to the bottom of `app.js` (before any closing IIFE / module-end comment if present):

```js
// ─────────────────────────────────────────────────────────────────
// Bay splitter — operator-controlled slot/console width
// (spec: docs/superpowers/specs/2026-05-08-mock-runner-event-log-design.md)
// ─────────────────────────────────────────────────────────────────

const SPLITTER_STORAGE_KEY = "mock-runner:console-w";
const CONSOLE_MIN_PX = 380;
const CONSOLE_MAX_PX = 800;
const SLOT_FLOOR_PX  = 600;
const SPLITTER_PX    = 6;

const bayEl     = document.querySelector(".bay");
const splitter  = document.getElementById("bay-splitter");

function clampConsoleWidth(px, viewportW) {
  // Hard min/max + dynamic ceiling so the slot never drops below its floor.
  const dynamicMax = Math.max(
    CONSOLE_MIN_PX,
    Math.min(CONSOLE_MAX_PX, viewportW - SPLITTER_PX - SLOT_FLOOR_PX),
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
(function initSplitter() {
  let saved;
  try { saved = localStorage.getItem(SPLITTER_STORAGE_KEY); } catch { saved = null; }
  if (!saved) return;
  const n = Number(saved);
  if (!Number.isFinite(n)) return;
  const clamped = clampConsoleWidth(n, window.innerWidth);
  applyConsoleWidth(clamped);
})();

// Drag handlers
let dragStartX = 0;
let dragStartW = 0;

splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  document.body.classList.add("bay--resizing");
  dragStartX = e.clientX;
  // Read the current rendered width — uses --console-w if set, else
  // the clamp() default. getBoundingClientRect on the console gives
  // us the real pixel value either way.
  dragStartW = document.getElementById("console").getBoundingClientRect().width;
  e.preventDefault();
});

splitter.addEventListener("pointermove", (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  // Splitter sits to the LEFT of the console. Dragging right shrinks
  // the console; dragging left grows it. (Reverse the sign vs intuition.)
  const next = clampConsoleWidth(dragStartW - (e.clientX - dragStartX), window.innerWidth);
  applyConsoleWidth(next);
});

splitter.addEventListener("pointerup", (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  splitter.releasePointerCapture(e.pointerId);
  document.body.classList.remove("bay--resizing");
  const finalW = document.getElementById("console").getBoundingClientRect().width;
  persistConsoleWidth(Math.round(finalW));
});

// Double-click resets to the static-CSS default.
splitter.addEventListener("dblclick", () => {
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
```

- [ ] **Step 2: Smoke the drag behavior**

```bash
npm run mock:runner
```

Expected:
- Drag the splitter left → console widens (chat panel grows); right → console shrinks (slot grows).
- Cursor stays `col-resize` body-wide while dragging; iframe doesn't catch the drag.
- Drag past hard min (~380px) — the console stops shrinking.
- Drag past hard max (~800px) — the console stops growing.
- Resize the window very narrow — the console clamps so the slot keeps ≥600px.
- Double-click the splitter — width resets to the original `clamp(484px, 35vw, 616px)` default.
- Drag, release, close the mock-runner, reopen → width persists.

Close.

- [ ] **Step 3: Lint**

```bash
npm run lint
```
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/mock-runner/shell/app.js
git commit -S -m "feat(mock-runner): bay splitter drag + persistence

Pointer-capture-driven drag with bounds (380-800px console, 600px
slot floor). State persists in localStorage under
mock-runner:console-w; double-click clears it and reverts to the
static CSS default. Resize re-clamps without rewriting persisted
state, so resizing back restores the operator's choice.

A body class .bay--resizing disables iframe pointer events mid-drag
so the iframe doesn't swallow the drag stream."
```

---

## Phase 6 — Menu actions for clear-event-log and reset-chat

### Task 11: Wire up File-menu items for Clear Event Log and Reset Chat

**Files:**
- Modify: `src/mock-runner/main.ts`
- Modify: `src/mock-runner/preload.cjs`
- Modify: `src/mock-runner/shell/app.js`

- [ ] **Step 1: Add the two menu items to the File menu**

In `src/mock-runner/main.ts`, locate the `buildMenu()` function (around line 465). Find the existing "Extract Backup…" entry:

```ts
{
  label: "Extract Backup…",
  accelerator: "CmdOrCtrl+E",
  click: () => mainWindow?.webContents.send("menu:extract-backup"),
},
```

Add two new entries directly after it:

```ts
{
  label: "Extract Backup…",
  accelerator: "CmdOrCtrl+E",
  click: () => mainWindow?.webContents.send("menu:extract-backup"),
},
{
  label: "Clear Event Log",
  accelerator: "CmdOrCtrl+K",
  // Always-enabled. The renderer ignores the event when CHAT is
  // active — that's simpler than syncing menu enablement with
  // renderer pane state.
  click: () => emitEventLogClear(mainWindow),
},
{
  // No accelerator — discoverable via menu only. Backlog #19 will
  // give it a permanent home (toolbar / composer-row / palette).
  label: "Reset Chat",
  click: () => mainWindow?.webContents.send("menu:chat-reset"),
},
```

And update the import at the top of `main.ts` to bring in the helper:

```ts
import { emitEvent, emitEventLogClear } from "./event-log-ipc.js";
```

- [ ] **Step 2: Expose `onMenuChatReset` in the preload**

In `src/mock-runner/preload.cjs`, near the other `onMenu…` handlers, add:

```js
onMenuChatReset: (cb) => ipcRenderer.on("menu:chat-reset", () => cb()),
```

- [ ] **Step 3: Gate the clear handler on the active pane in renderer**

Locate the lines you added in Task 8 step 4:

```js
api.onEventLogClear?.(() => clearEventLog());
```

Replace with:

```js
api.onEventLogClear?.(() => {
  // Accelerator fires globally; ignore unless LOG is the active pane.
  if (activePane !== "log") return;
  clearEventLog();
});
```

- [ ] **Step 4: Refactor reset logic into a function and remove the dead button code**

In `src/mock-runner/shell/app.js`, find the existing reset block (currently around line 416 after Task 5's null-safe edits):

```js
chatReset?.addEventListener("click", () => {
  // If a turn is mid-stream, abort it. The SDK rolls back the in-flight
  // user message automatically, so client.messages stays consistent.
  if (inFlightAbort) inFlightAbort.abort();
  agentClient.reset();
  chatLog.innerHTML = "";
  try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch { /* ignore */ }
  appendRow("system", "Conversation reset.");
});
```

Replace with:

```js
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
```

- [ ] **Step 5: Drop the now-dead button-click handlers and DOM lookups**

The `#chat-reset` and `#chat-extract` buttons no longer exist (removed in Task 5). Their menu accelerators / new menu items provide the only entry points now. Clean up the dead code.

In `src/mock-runner/shell/app.js`, find:

```js
const chatReset     = document.getElementById("chat-reset"); // null until backlog #19 re-homes the button
const chatExtract   = document.getElementById("chat-extract"); // null until backlog #19 re-homes the button
```

Remove both lines.

Then find:

```js
chatExtract?.addEventListener("click", openBackupModal);
api.onMenuExtractBackup?.(() => openBackupModal());
```

Remove the first line; keep the second:

```js
api.onMenuExtractBackup?.(() => openBackupModal());
```

Verify there are no remaining references to `chatReset` or `chatExtract` in `app.js`:

```bash
grep -n "chatReset\|chatExtract" src/mock-runner/shell/app.js
```
Expected: no output.

- [ ] **Step 6: Smoke**

```bash
npm run mock:runner
```

Expected:
- File menu shows the new entries: "Clear Event Log ⌘K" and "Reset Chat" (no accelerator).
- With CHAT active, fire a few events (e.g. Cmd-S with no tabs, twice). Events accumulate as unread on the LOG tab. Press Cmd-K. Expected: event log NOT cleared (CHAT is active; accelerator ignored).
- Click LOG. See the events. Press Cmd-K. Expected: event log cleared, empty state returns.
- Click CHAT. Send a chat turn. File → Reset Chat. Expected: chat log cleared, "Conversation reset." appears as a system row.

Close.

- [ ] **Step 7: Build + lint**

```bash
npm run build
npm run lint
```
Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/mock-runner/main.ts src/mock-runner/preload.cjs src/mock-runner/shell/app.js
git commit -S -m "feat(mock-runner): File-menu items for Clear Event Log + Reset Chat

- Cmd-K (Clear Event Log) — fires unconditionally; renderer ignores
  when CHAT is the active pane. Simpler than syncing main-process
  menu enablement with renderer state.
- Reset Chat — no accelerator (discoverable via File menu only).
  Backlog #19 will give it a permanent home alongside Extract Backup.
- Drops the now-dead chatReset / chatExtract button-click handlers
  and DOM lookups (the buttons themselves were removed in the
  earlier tabbed-box restructure)."
```

---

## Phase 7 — Verification + cleanup

### Task 12: Final test pass + manual smoke + plan-completion housekeeping

**Files:**
- Move: `docs/plans/pending/13-mock-runner-event-log-panel.md` → `docs/plans/completed/`
- (Touch only on green.)

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected:
- `unit/mock-runner/event-log-ipc.test.ts` — 5 passing.
- `unit/mock-runner/unread-state.test.ts` — 4 passing.
- All existing unit / integration / e2e tests pass.

- [ ] **Step 2: Run lint and type-check**

```bash
npm run lint
npm run test:check  # type-check the test files only
```
Expected: no errors.

- [ ] **Step 3: Manual smoke checklist**

Bring up the mock-runner and walk through:

```bash
npm run mock:runner
```

**Tab strip + identity:**
- [ ] CHAT tab is initially active, shows live lamp + `SID: <8 hex chars>` + 5-bar meter.
- [ ] Click LOG. CHAT tab dims (opacity drops); SID + meter stay visible.
- [ ] Trigger a chat turn (or wait for the agent /health probe to flip live state). Confirm the lamp + meter on the dim CHAT tab still update.
- [ ] Click CHAT. Brightness restores.

**Event log routing — all 6 migration sites:**

(Requires an agent running — `npm run dev:full` from sibling `sound-recreation-agent` — only if you want to also trigger chat dialog. Not required for this checklist.)

- [ ] Site 1 (warn) — File menu → Save with no tabs. Or just Cmd-S. → one warn (amber LED) row in event log.
- [ ] Site 2 (warn) — Hand-edit a `.mockrack` to reference a non-existent `modelId`, then File → Open it. → warn row.
- [ ] Site 3 (error) — Force a port collision: have two mock-runners open simultaneously and load a `.mockrack` whose ports overlap. → error row (red).
- [ ] Site 4 (warn) — Load any multi-tab `.mockrack` whose handlers don't fully restore. → one warn row per affected tab (this is the noisy case the spec was triggered by).
- [ ] Site 5 (error) — Drag a deleted file path onto the dock icon. → error row.
- [ ] Site 6 (warn) — Open Recent → file that's been moved. → warn row.

**Unread LED behavior:**
- [ ] With CHAT active, fire one info event → LED green.
- [ ] Fire one warn event → LED upgrades to amber.
- [ ] Fire one info event → LED stays amber (no downgrade).
- [ ] Fire one error event → LED upgrades to red.
- [ ] Fire one warn event → stays red.
- [ ] Click LOG → LED clears (hidden).
- [ ] Click CHAT → LED stays clear (no events since last switch).

**Splitter:**
- [ ] Drag splitter left/right; console resizes smoothly; iframe doesn't catch the drag.
- [ ] Drag past hard min (380) → stops shrinking.
- [ ] Drag past hard max (800) → stops growing.
- [ ] Shrink the window until slot floor (600) takes over → console clamps appropriately.
- [ ] Double-click splitter → width returns to the original clamp default.
- [ ] Drag, release, fully close the mock-runner, reopen → drag position persists.
- [ ] Resize window very narrow then back → after resize-back the original choice is restored (not rewritten).

**Clear accelerator:**
- [ ] Cmd-K with CHAT active → no effect on event log.
- [ ] Cmd-K with LOG active → empties to `— no events —`.

**Reset Chat menu item:**
- [ ] File menu shows "Reset Chat" with no accelerator.
- [ ] Send a chat turn, then File → Reset Chat → chat log clears, "Conversation reset." system row appears, in-flight stream (if any) is aborted cleanly.

- [ ] **Step 4: Move the plan into completed/**

Once all checklist items are green:

```bash
mv docs/plans/pending/13-mock-runner-event-log-panel.md docs/plans/completed/
```

- [ ] **Step 5: Mark todo #18 in the backlog as done**

In `docs/plans/pending/todo-list.md`, update the section header for item 18 from:

```markdown
### 18. Mock-runner Event Log panel — separate non-chat events from the chat console

**Status:** Needs brainstorming — UI surface design required before planning.
```

To:

```markdown
### 18. Mock-runner Event Log panel — separate non-chat events from the chat console

**Status:** Done — see `docs/plans/completed/13-mock-runner-event-log-panel.md`.
```

(Leave the body intact for archival reference.)

- [ ] **Step 6: Final commit**

```bash
git add docs/plans/completed/13-mock-runner-event-log-panel.md docs/plans/pending/todo-list.md
git rm docs/plans/pending/13-mock-runner-event-log-panel.md 2>/dev/null || true
git commit -S -m "chore(plans): mark plan 13 (event log panel) complete

Moves the plan to completed/ and updates todo #18's status to point
at the implemented plan."
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin feat/mock-runner-event-log
gh pr create --title "Mock-runner Event Log panel + bay splitter (todo #18)" \
  --body "$(cat <<'EOF'
## Summary

Implements the design at `docs/superpowers/specs/2026-05-08-mock-runner-event-log-design.md` — splits non-chat lifecycle/status events out of the chat console into a dedicated Event Log pane behind a CHAT/LOG tab strip, and adds a draggable splitter between the rack slot and the console.

- **Tabbed console** — CHAT tab carries lamp + SID + meter; LOG tab carries an unread severity-tinted LED. Inactive tab dims so agent state stays ambiently visible while reading the log.
- **New IPC** — `menu:event-log` carries `{severity, source?, text, ts}`. All 6 existing `menu:console-note` emit sites in `main.ts` migrated. `menu:console-note` is no longer used.
- **Splitter** — 380-800px console range, 600px slot floor, persisted in `localStorage`, double-click to reset.
- **Cmd-K** clears the event log when LOG is the active pane.

Backlog item #19 (re-home backup/reset/clear buttons) is filed for follow-up; until then those actions are reachable only via keyboard accelerator.

## Test plan
- [x] All unit + integration + e2e tests pass (`npm test`).
- [x] Manual smoke per checklist in plan task 12.
EOF
)"
```

---

## Self-review — spec coverage check

| Spec section | Covered by |
|---|---|
| Layout — tabbed box | Task 5 (HTML), Task 6 (CSS) |
| CHAT tab carries lamp + SID + meter | Task 5 (HTML), Task 6 (CSS — agent-state selectors retargeted) |
| LOG tab carries label + unread LED | Task 5 (HTML), Task 6 (CSS — `.console__unread`) |
| Inactive-tab dim treatment | Task 6 (`[aria-selected="false"]` opacity rule) |
| Active-tab indicator (caret or amber underline) | Task 6 (chose amber inset box-shadow underline — consistent with the existing tab rail's amber accents) |
| Buttons removed from this area | Task 5 (HTML, with renderer null-safety) |
| Unread LED rule (off when LOG active; upgrade-only otherwise) | Task 4 (state machine) + Task 8 (`setActivePane` clears, `appendEventRow` calls `nextUnread`) |
| Severity → color (`green`/`amber`/`fault`) | Task 6 (`.console__unread[data-severity=…]`), Task 7 (`.event-log__row[data-severity=…] .event-log__led`) |
| Event log row layout (LED + ts + source + text) | Task 7 + Task 8 (`appendEventRow`) |
| 500-row scrollback cap, drop oldest | Task 8 (loop in `appendEventRow`) |
| Auto-scroll only when pinned to bottom | Task 8 (`pinnedToBottom` check) |
| Empty-state line | Task 5 (HTML), Task 7 (CSS), Task 8 (`clearEventLog`) |
| `menu:event-log` channel + payload | Task 1 |
| `console-note` retired from non-agent sites | Task 2 (migration) + Task 3 (preload drops `onConsoleNote`) |
| Migration table (6 sites with assigned severities) | Task 2 |
| Preload `onEventLog` + `onEventLogClear` | Task 3 |
| Pane-switch handler details | Task 8 (`setActivePane`) |
| Bay splitter DOM + CSS | Task 9 |
| Bay splitter bounds (380-800 console, 600 slot floor) | Task 10 (`clampConsoleWidth`) |
| Persistence (`mock-runner:console-w` localStorage key) | Task 10 |
| Drag behavior (capture, body class, double-click reset, resize re-clamp) | Task 10 |
| Keyboard accelerator for clear | Task 11 |
| Out-of-scope items | Honored — no filter chips, no MCB events, no log-content persistence, no button homing |

## Self-review — placeholder + consistency scan

- No "TBD" / "TODO" / "implement later" entries.
- All function names referenced across tasks (`emitEvent`, `emitEventLogClear`, `nextUnread`, `severityRank`, `setActivePane`, `appendEventRow`, `clearEventLog`, `clampConsoleWidth`, `applyConsoleWidth`, `persistConsoleWidth`, `formatHms`, `renderUnreadLed`) are defined exactly once and referenced consistently.
- IPC channel names (`menu:event-log`, `menu:event-log-clear`) match across `event-log-ipc.ts`, `preload.cjs`, and renderer subscriptions.
- DOM IDs (`tab-chat`, `tab-log`, `event-log`, `event-log-unread`, `bay-splitter`) match across HTML, CSS, and JS.
- `localStorage` key (`mock-runner:console-w`) appears once in code and once in the PR description; consistent.
- Severity assignments in the migration table match Task 2 step-by-step instructions.
