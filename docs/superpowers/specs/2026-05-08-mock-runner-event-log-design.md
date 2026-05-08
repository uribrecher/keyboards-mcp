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

## Layout — segmented switch in the console panel

The existing `.bay` is a 2-column grid: `slot | console`. The console keeps the
same outer dimensions; internally its header gains a two-position selector
styled like a vintage rack-equipment input switch:

```
┌─ console header ─────────────────────────────────────────────┐
│  ●  [ CHAT ▸ ]  [ LOG  ]●   SID …   ▮▮▮▮▮   backup  reset    │
└──────────────────────────────────────────────────────────────┘
```

- The active label is bright (`--c-text-bright`); the inactive label is dim
  (`--c-text-dim`) with the existing brushed-metal background.
- A **single** amber lamp (`--c-amber`) sits to the left of the active label
  using the existing `.console__lamp` styling. The lamp does not duplicate per
  side; it follows the active selection.
- A second LED — the **unread indicator** — sits to the right of the inactive
  `LOG` label only when there are unread events (see *Unread LED* below).

Clicking a label switches panes. The chat scrollback, composer state, agent
status meter, SID, and `backup`/`reset` buttons are unchanged in CHAT mode. The
LOG mode swaps the body for the event log and replaces the chat-only buttons
with a single `clear` button (also keeps the SID + meter; those describe
the agent process, not the active pane).

### Why a segmented switch, not tabs or a split

- The chat panel is already cramped at the 484px lower bound (CSS comment at
  `style.css:347-351`). Splitting it vertically would reverse the user's
  earlier widening.
- A bottom drawer would steal vertical space from the model UI iframe, which is
  the most precious surface.
- The selector reads as one piece of equipment with a function selector — true
  to the existing chassis aesthetic and avoids inventing a new visual idiom.

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
- `clear` button in the header empties the pane (does not affect chat).
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
- Two new DOM containers: `#event-log` (sibling of `#chat-log`, hidden when
  CHAT is active) and an `#event-clear` button.
- Pane switch handler toggles `[hidden]` between `#chat-log` and `#event-log`,
  swaps active state on the segmented labels, swaps the header button row
  (chat: `backup` + `reset`; log: `clear`), and clears the unread LED on
  switch-to-LOG.

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
  the original floor was a chat-readability defense, but the segmented switch
  reduces chat dominance, and the splitter lets the operator pick a split per
  task.
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
  unread LED color matches expected severity when CHAT is active.

## Migration / rollout

Single PR. No flag; the chat-vs-log split is strictly better than the status
quo and there are no external consumers of `menu:console-note` outside the
shell. Backwards compat is N/A — this is internal IPC between the
mock-runner main and renderer.
