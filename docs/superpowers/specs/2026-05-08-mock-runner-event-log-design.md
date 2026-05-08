# Mock-runner Event Log panel — design

**Date:** 2026-05-08
**Scope:** `keyboards-mcp` — `src/mock-runner/` (Electron main + renderer shell)
**Source backlog item:** todo #18 in `docs/plans/pending/todo-list.md`

## Problem

Today the chat console in the mock-runner shell consumes *everything* sent on the
`menu:console-note` IPC channel: agent dialog plus a stream of unrelated lifecycle
and status notes from MockHandlers and File-menu actions. After loading a multi-tab
`.mockrack` file the chat is flooded with lines like

```
Roland JUNO-X ("junio"): full state restore not yet implemented — knobs reset to defaults.
Roland JUNO-X ("jino"): full state restore not yet implemented — knobs reset to defaults.
Prophet-6 ("pro_fat"): full state restore not yet implemented — knobs reset to defaults.
```

These are not agent dialog and they belong in their own surface. This spec
defines that surface and a related quality-of-life ask the user added during
brainstorming: a draggable splitter between the rack slot and the console
panel so the operator can rebalance the bay.

## Goals

1. Pull non-chat lifecycle / status / file-menu events out of the chat log into
   a dedicated **Event Log** pane.
2. Keep the chat focused on agent dialog only.
3. Give the operator ambient awareness of new events without yanking attention
   away from the chat.
4. Let the operator rebalance horizontal space between rack slot and console.

## Non-goals

- A unified backend event-log aggregating MCB / mock-runner / MCP servers
  (covered by the future *Operator dashboard* item in the MCB backlog).
- Severity filtering UI (chips / hide-by-severity). Day-one is color-coding only.
- Per-event dismissal or actions on events.
- Persistence of log contents across mock-runner restarts. Scrollback is
  in-session only, same as chat.
- Adding new emitter sites (tab create/close/select-model lifecycle, MCB lease
  changes, MCB-unreachable). Those are Phase 2 once the surface exists.

## Layout — tabbed box, not a header

The existing `.bay` is a 2-column grid: `slot | console`. The console keeps the
same outer dimensions; internally what is currently the `.console__header`
strip is replaced by a two-tab strip. The console is now a **tabbed box**, not
a panel-with-a-header — tabs are first-class and they carry their own state.

```
CHAT active:
┌─ tabs ───────────────────────────────────────────────────────┐
│ [ ●  SID: a1b2c3   ▮▮▮▮▮  ▸ ]   [  LOG  ]                    │
└──────────────────────────────────────────────────────────────┘

LOG active (CHAT tab still shows live SID + meter, dimmed):
┌─ tabs ───────────────────────────────────────────────────────┐
│ [ ●  SID: a1b2c3   ▮▮▮▮▮    ]   [  LOG ▸ ]                   │
└──────────────────────────────────────────────────────────────┘

CHAT active, unread events accumulated on the LOG tab:
┌─ tabs ───────────────────────────────────────────────────────┐
│ [ ●  SID: a1b2c3   ▮▮▮▮▮  ▸ ]   [  LOG  ● ]                  │
└──────────────────────────────────────────────────────────────┘
```

### CHAT tab

The tab label *is* the agent identity strip:

- The agent-liveness **lamp** (existing `.console__lamp`, amber → fault hue
  driven by `data-state`).
- `SID: <value>` — the agent process id, currently rendered via
  `.console__sid`. The label `CHAT` is gone; the SID is the tab's identity.
- The 5-bar agent-status **meter** (existing `.console__meter`).

When the CHAT tab is active these elements use their current bright/lit
treatment. When the LOG tab is active the entire CHAT tab dims (text drops to
`--c-text-faint`, lamp stays at its true state but at lower glow, meter
animates at reduced opacity) so the agent state remains *ambiently visible*
without competing with the active log content. This replaces the earlier
proposal that kept the meter "global" — the dim-when-inactive treatment
preserves the same operator benefit (spotting agent loss while triaging
events) without the visual ambiguity of "is this header chrome or tab
chrome?".

### LOG tab

A short label — `LOG` — and an **unread LED** that lights inside the tab when
the LOG tab is inactive and ≥1 unread event has arrived (see *Unread LED*).
When LOG is active the LED is hidden (read by definition).

### Active-tab indicator

The active tab is signaled by:
1. Brighter foreground color (`--c-text-bright` vs `--c-text-faint`).
2. A subtle `▸` caret on the trailing edge of the active tab label (in the
   sketches above) **or** a 1px amber underline along the bottom edge of the
   active tab — pick whichever reads cleaner against the brushed-metal
   pinstripe in implementation. The two options are visually equivalent for
   the spec; the implementor chooses based on how the existing `.tab` rail
   above the bay handles active state, for consistency.

### Buttons removed from this area

`backup`, `reset`, and (the would-be) `clear` buttons do **not** live in the
tab strip. The tab strip is identity + selection only. Where these buttons
end up is deferred to the follow-up backlog item *"Re-home the chat
backup/reset and event-log clear actions"* — it's a small UX question that
deserves its own thinking pass and shouldn't gate this work.

### Why tabs, not a vertical split or a drawer

- A vertical split inside the console would shrink the chat — already cramped
  at the 484px lower bound (CSS comment at `style.css:347-351`) and recently
  widened. Splitting it would reverse that.
- A bottom drawer would steal vertical space from the model UI iframe, which
  is the most precious surface.
- Tabs reuse a metaphor the operator already sees in the rack tab rail at the
  top of the chassis — same family of control, applied to the console. No new
  visual idiom is invented; the chassis aesthetic is preserved.

## Unread LED

Rule:

| Active pane | Unread LED |
|---|---|
| **LOG**  | always off — incoming events land in a visible pane, read by definition |
| **CHAT** | lights at the severity color of the first unread event; **upgrades** to a higher severity if one arrives (`info` → `warn` → `error`); **never downgrades**; clears the instant the operator selects LOG |

Severity → color, reusing palette tokens already in `style.css`:

| Severity | CSS var | Reading |
|---|---|---|
| info  | `--c-green` / `--c-green-glow` | tab lifecycle, file-menu refusals |
| warn  | `--c-amber` / `--c-amber-glow` | "not yet implemented", skipped tabs |
| error | `--c-fault` / `--c-fault-glow` | engine start failed, file not found |

The LED uses the same milled jewel-LED treatment as `.console__lamp` and the
tab-rail LEDs — inset highlight, outer glow — so it feels native.

## Event log pane

Each row:

```
┌──────────────────────────────────────────────────────────────┐
│  ●  14:32:07   Roland JUNO-X ("junio")                        │
│                full state restore not yet implemented —       │
│                knobs reset to defaults.                       │
└──────────────────────────────────────────────────────────────┘
```

- **Severity LED** (left edge) — small jewel LED matching the unread-LED
  treatment, colored by severity.
- **Timestamp** — `HH:MM:SS`, IBM Plex Mono, `--c-paper-faint`.
- **Source** (optional, second line top) — `${displayName} ("${label}")` or a
  bare subsystem tag like `setup` for File-menu events. Style: dim
  (`--c-paper-dim`).
- **Message** — body text, `--c-paper`, IBM Plex Mono. Multiline wraps under
  the timestamp gutter.

Pane behavior:

- Scrollback: in-session only, capped at **500 rows** (drop oldest). No
  cross-launch persistence.
- Auto-scroll to bottom on new event when the pane is already pinned to bottom;
  preserve scroll position when the operator has scrolled up (same idiom as
  chat).
- **Clear**: not surfaced as a button in this work — see backlog #19 for where
  the action lands. The implementation plan adds a keyboard accelerator that
  fires `clear-event-log` when the LOG pane is active so the action is
  reachable in the meantime.
- Empty state: a single dim line — `— no events —` — using the same
  brushed-rail empty-state idiom as `.slot__empty`.

## IPC routing

Two channels, one rule.

| Channel | Payload | Consumer |
|---|---|---|
| `menu:console-note` *(existing)* | `{ text: string }` | chat pane |
| `menu:event-log` *(new)* | `{ severity: "info" \| "warn" \| "error", source?: string, text: string, ts: number }` | event log pane |

**Routing rule** (matches todo #18):

- Anything emitted in **direct response to user agent input** → `menu:console-note`
  (chat). Today this is only the agent SDK stream; `console-note` is no longer
  used for non-agent surfaces after migration.
- Anything emitted by **File-menu actions, tab lifecycle, MockHandler
  init/restore notices, MCB lease changes** → `menu:event-log`.

After migration, every existing emitter site listed below uses `menu:event-log`.
The chat seed greeting and the agent-stream pipe remain on the chat path
(in-renderer; not via `console-note`).

### Preload + renderer

`preload.cjs` adds:

```js
onEventLog: (cb) => ipcRenderer.on("menu:event-log", (_e, p) => cb(p)),
```

`app.js`:

- Removes the `api.onConsoleNote` subscription that currently calls
  `appendRow("system", text)` (line 850).
- Adds `api.onEventLog((p) => appendEventRow(p))`.
- New `appendEventRow({severity, source, text, ts})` builds a row in the log
  pane DOM and updates the unread LED if the active pane is CHAT.
- One new DOM container: `#event-log` (sibling of `#chat-log`, hidden when
  CHAT is active). No new buttons in this surface.
- Pane switch handler toggles `[hidden]` between `#chat-log` and `#event-log`,
  toggles `aria-selected` / active styling on the two tabs, applies the
  inactive-tab dim state to whichever tab is inactive, and clears the unread
  LED when LOG becomes active.
- Keyboard accelerator handler for `clear-event-log` (registered in `main.ts`
  menu setup, only enabled when the LOG tab is active) sends a `menu:event-log-clear`
  event to the renderer, which empties `#event-log`.

## Migration table

All six current `console-note` call sites in `src/mock-runner/main.ts` migrate
to `menu:event-log`. Severity assigned per the routing rule.

| # | Line | Trigger | Message | Severity |
|---|---|---|---|---|
| 1 | 121 | `notifyEmptySaveRefused()` — save attempted via accelerator with no tabs/models | `Nothing to save — add a tab and pick a model first.` | warn |
| 2 | 262 | `.mockrack` load: tab's `modelId` not in registry | `Skipped tab "{label}": model "{modelId}" not registered.` | warn |
| 3 | 281 | `.mockrack` load: engine failed to start | `Skipped tab "{label}" ({model}): engine failed to start — {err}` | error |
| 4 | 293 | `.mockrack` load: handler can't fully restore snapshot | `{model} ("{label}"): full state restore not yet implemented — knobs reset to defaults.` | warn |
| 5 | 860 | `app.on("open-file")` — file missing on disk | `File not found: {path}` | error |
| 6 | 900 | `did-finish-load` auto-load — pending cold-launch path missing | `File not found: {path}` | warn |

Sites 4 and 5 are the two that motivated this work; sites 1–3 and 6 are
opportunistic tag-alongs.

## Bay splitter

The current `.bay` is `grid-template-columns: 1fr clamp(484px, 35vw, 616px)`.
Replace with a draggable vertical splitter between slot and console.

### DOM + CSS

- Insert a `.bay__splitter` element in `index.html` between `<section class="slot">`
  and `<aside class="console">`.
- Update `.bay` to `grid-template-columns: 1fr 6px var(--console-w, clamp(484px, 35vw, 616px))`.
- The splitter is a 6px-wide column. Visual: a single brushed-metal pinstripe
  matching the existing `.chassis__rule` treatment, with a subtle dimple at
  vertical center suggesting a screw/grip. Cursor: `col-resize`. Hover state
  brightens the pinstripe and reveals a thin amber accent line down the middle
  (1px, 30% opacity), echoing the chassis lamps without becoming a noisy seam.
- Drag updates `--console-w` on the `.bay` element via JS.

### Bounds

- Console width: **min 380px, max 800px**. Below 380 the chat composer becomes
  uncomfortable; above 800 the slot starts losing meaningful UI space on a
  ~1440px window. The lower bound is intentionally below the prior 484 floor —
  that floor was a chat-readability defense built into the static CSS, but
  with a draggable splitter the operator can pick a comfortable split per
  task. Letting the floor drop to 380 means an operator who wants a
  slot-dominant view (driving a keyboard, glancing at log entries) can have it
  without hitting an arbitrary stop.
- Slot width: implicit floor of **600px** enforced by clamping the console max
  width when the window is small. On windows where 600 + 6 + 380 > total, the
  splitter clamps to whatever console width the available space allows.

### Persistence

- Saved to `localStorage` under key `mock-runner:console-w` as a CSS pixel
  number.
- Read on shell load; if absent or out of bounds, fall back to the original
  `clamp(484px, 35vw, 616px)`.
- Window resize: if the saved width violates the slot floor under the new
  window size, transiently clamp without rewriting `localStorage` so resizing
  back restores the operator's choice.
- No cross-machine sync; this is per-installation operator preference.

### Drag behavior

- `pointerdown` on the splitter captures the pointer, sets a body class
  `bay--resizing` that disables iframe pointer events (otherwise the iframe
  swallows pointer events mid-drag) and switches the cursor body-wide.
- `pointermove` updates `--console-w`; clamped to bounds.
- `pointerup` releases capture, removes the body class, writes the final width
  to `localStorage`.
- Double-click on the splitter resets to the default `clamp(484px, 35vw, 616px)`
  (and clears the `localStorage` key).

## Out of scope (Phase 2 candidates)

- Tab create/close/select-model lifecycle events — adding new emitters.
- MCB lease change / MCB-broker liveness events.
- Severity filter chips (`INFO` / `WARN` / `ERR` toggle).
- Persistence of log contents across runs.
- Per-event copy / dismiss / pin actions.
- **Re-home the `backup` / `reset` / `clear` actions** — the tab strip is
  identity + selection only. These actions need a permanent home
  (composer-adjacent toolbar? per-pane footer? command palette?). Tracked as
  its own backlog item. Interim affordances added by this work:
  - `backup` — File → Extract Backup… (⌘E, already existed).
  - `clear` — File → Clear Event Log (⌘K, new).
  - `reset` — File → Reset Chat (no accelerator, menu only — new).

## Test surface

- **Unit / renderer:** existing renderer code is in `app.js` (no test harness today).
  Add a thin testable module for the routing + unread-LED state machine if the
  implementation plan introduces one; otherwise rely on integration coverage.
- **Integration (`tests/integration/mock-runner.test.ts`):** assert that
  loading a multi-tab `.mockrack` results in zero `chat-row--system` rows and
  N event-log rows of expected severity. The headless mock harness already
  spawns the Electron mock — extend it to capture the new IPC channel, or
  test purely at the main-process level by spying on
  `webContents.send("menu:event-log", …)`.
- **Manual smoke:** drag the splitter past both bounds, double-click reset,
  resize the window, restart the mock-runner — confirm position persists and
  clamps gracefully. Trigger each of the 6 migration sites and confirm the
  unread LED color matches expected severity when CHAT is active. Switch to
  LOG and confirm the CHAT tab dims while still showing the live SID and
  meter; trigger an agent restart from the SDK side and confirm the lamp +
  SID update remains visible from the dim CHAT tab.

## Migration / rollout

Single PR. No flag; the chat-vs-log split is strictly better than the status
quo and there are no external consumers of `menu:console-note` outside the
shell. Backwards compat is N/A — this is internal IPC between the
mock-runner main and renderer.
