# Mock Runner

The Mock Runner is an Electron app that simulates one or more keyboards on your desktop so you can develop and test against the MCP server without real hardware. Each tab hosts an independent mock device on its own MIDI virtual port and its own WebSocket port, with a model-specific web UI that mirrors real-time parameter changes.

```bash
npm run mock:runner   # Electron — model picker, then per-model UI
npm run mock:headless --model nord-electro-5d   # Plain Node, for CI/E2E tests
```

![Mock Runner tour](images/mock_runner_tour.gif)

## Anatomy

```
┌──────────────────────────────────────────────────────────────────────────┐
│  MOCK RUNNER · MULTI-DEVICE TEST RACK            [tab][tab][tab][+]      │
├──────────────────────────────────────────────────────┬───────────────────┤
│                                                      │  CLAUDE line      │
│         (model UI iframe — drawbars, knobs,          │                   │
│          LEDs, engine state for the active tab)      │  > history…       │
│                                                      │                   │
│                                                      │  composer ↵       │
└──────────────────────────────────────────────────────┴───────────────────┘
```

- **Top chassis** — brand strip plus tab bar with a `+` button.
- **Slot** — the active tab's iframe. Each tab loads either the model picker (`chooser.html`) or, once a model is chosen, that model's web UI from `src/keyboard_models/<mfr>/<model>/web/`. Inactive tabs stay mounted but hidden.
- **Empty rack slot** — placeholder shown when no tabs are open.
- **Console pane** — chat with the `sound-recreation-agent` running at `http://localhost:3001`.

## Tabs and devices

The shell window is loaded once and never reloaded. Each tab owns its own `MockEngine`, MIDI virtual port, and WebSocket port (allocated sequentially from `3000`).

| Action | How |
|---|---|
| New tab | `+` on the tab bar, or **File → New Tab** (`Cmd+T`) |
| Close tab | `×` on the tab — engine shuts down, WebSocket port is freed |
| Pick a model | Click any card on the chooser screen |
| Switch active tab | Click a tab |
| Rename a tab | Double-click the tab title |

### Labels

Each loaded tab has a sanitized **label** (lowercase `[a-z0-9._-]`). It defaults to `<model-id>-1`, `<model-id>-2`, etc — collisions with other tabs of the same model are skipped automatically. The label is the cache key for that tab's per-instance backup data: it appears in `data/backups/<label>/`. Rename a tab to attach a different backup cache to it.

## Model picker

A new tab opens to the chooser, which lists every model auto-discovered under `src/keyboard_models/<manufacturer>/<model>/`. Cards show manufacturer, display name, and model id. Clicking a card spins up the engine for that tab and navigates the iframe to the model's web UI. The chooser runs inside the iframe and asks the parent shell for the catalog via `postMessage` — the preload-bridged `mockRunnerAPI` only exists on the parent.

## Model UI

Each model ships its own UI under `src/keyboard_models/<mfr>/<model>/web/`. The shell injects the per-tab `wsPort` via the URL query string; the UI opens a WebSocket back to that port and re-renders on every state broadcast. Drawbars, knobs, LEDs, and engine parameters update as MIDI messages arrive. The mock engine itself is a thin shell — virtual MIDI port plus WebSocket server plus broadcast — and all of the model behavior lives in the `MockHandler`.

## File menu — saving and restoring rack setups

Save the entire rack (all tabs, their models, labels, and full state) to a single `.mockrack` JSON file and reload it later.

| Item | Shortcut | What it does |
|---|---|---|
| New Tab | `Cmd+T` | Open a chooser tab |
| Open… | `Cmd+O` | Replace the rack with a `.mockrack` file |
| Open Recent | — | macOS recents submenu |
| Save | `Cmd+S` | Save to the current file (falls back to Save As) |
| Save As… | `Cmd+Shift+S` | Save to a new path |
| Extract Backup… | `Cmd+E` | See [Backup extraction](#backup-extraction) |

### Dirty indicator

The title bar reads `Mock Runner — <file>.mockrack` and gains a trailing `•` whenever the rack diverges from the saved file. Engine state changes are debounced (250 ms). Tab create/close, model selection, rename, active-tab change, and backup extraction all mark the rack dirty.

### Confirmation prompts

Quit (`Cmd+Q`), close window, and Open all prompt **Save / Don't Save / Cancel** when the rack is dirty.

### Auto-load

On launch, a queued `open-file` event from the OS (file association double-click, dock drop) wins. Otherwise the shell walks the recents list and auto-loads the most-recent surviving file. If neither exists, the rack starts empty.

### Restore semantics

Each tab's full state is captured via `MockHandler.getFullState(false)` and restored via `MockHandler.setFullState(snapshot)`. Models opt in incrementally — those without `setFullState` restore as model + label only, with knobs at defaults; an in-shell note explains. Unknown models in a `.mockrack` are skipped with a console note rather than failing the load.

## Backup extraction

Use the **backup** button in the console header (or **File → Extract Backup…**, `Cmd+E`) to import a backup into the active tab's cache.

- A native file picker accepts a single backup file or a programs-only folder.
- With **one** loaded tab, extraction runs against it directly.
- With **multiple** loaded tabs, a modal asks which device the backup belongs to.
- Programs-only folder extraction merges into the existing cache for that label — it requires a previously cached full backup under the same label.
- After extraction, the live engine for that model + label reloads its cache; a markdown inventory is written to `data/backups/<label>/<model_slug>_backup_inventory.md`.

## Console — talking to Claude

The right-hand pane is a thin SSE client for the sibling `sound-recreation-agent` HTTP server.

- **Composer** — `Enter` sends, `Shift+Enter` inserts a newline.
- **Status meter** — `off` (agent unreachable), `on` (probed at startup), `busy` (a request is in flight).
- **Stream events** — `text` chunks build up the assistant message, `tool_use` rows show the tool name plus a short input summary, `tool_result` rows show the first 220 chars of the result (highlighted on error).
- **Reset** — clears the on-screen log and posts `POST /reset` to the agent.
- **History** — every row is persisted to `localStorage` (`mock-runner.chat-history.v1`) and replayed on next launch.
- **Backup** — same flow as **File → Extract Backup…**.

The agent is expected at `http://localhost:3001`. Start it from the sibling repo:

```bash
cd ../sound-recreation-agent
npm run dev:full
```

## `.mockrack` file format

A small JSON envelope wrapping each tab's modelId, label, and an opaque state blob owned by the model.

```jsonc
{
  "$schema": "mockrack/v1",
  "version": 1,
  "savedAt": "2026-05-04T10:30:00.000Z",
  "appVersion": "0.1.0",
  "activeTabIndex": 0,
  "tabs": [
    {
      "modelId": "nord-electro-5d",
      "label": "studio-a",
      "state": { /* opaque, model-defined */ }
    }
  ]
}
```

Writes are atomic (`tmp` + `rename`). The format is versioned so older files can be migrated forward.

## Headless mode

For tests and CI, `mock:headless` runs the same `MockEngine` under plain Node (no Electron, no UI). It prints `MOCK_READY` on stdout once the WebSocket server is up.

```bash
npm run mock:headless -- --model nord-electro-5d --ws-port 3000
# flags: --model <id>            (required)
#        --ws-port <n>           (default 3000)
#        --lower-channel <ch>    (default 0)
#        --upper-channel <ch>    (default 1)
#        --no-midi               (skip the virtual MIDI port — useful in CI containers)
#        --label <name>          (override the per-instance label)
```

Tests use this via `tests/helpers/mock-process.ts` (headless spawn + WebSocket assertions) and `tests/helpers/test-harness.ts` (full mock + MCP client harness).

## Architecture quick reference

| Path | Role |
|---|---|
| `src/mock-runner/main.ts` | Electron main — owns tabs, engines, file menu, IPC |
| `src/mock-runner/cli.ts` | Headless entry point |
| `src/mock-runner/engine.ts` | `MockEngine` — MIDI virtual port + WebSocket server + broadcast |
| `src/mock-runner/preload.cjs` | Exposes `mockRunnerAPI` to the shell |
| `src/mock-runner/shell/index.html` | Tab bar, slot, console, backup-picker modal |
| `src/mock-runner/shell/app.js` | Tab routing, chat console, backup flow, dirty/title sync |
| `src/mock-runner/shell/chooser.html` | Model picker iframe |
| `src/shared/mockrack-format.ts` | `.mockrack` schema, parse, atomic write |
| `src/keyboard_models/<mfr>/<model>/mock-handler.ts` | Per-model state, MIDI handling, `getFullState` / `setFullState` |
| `src/keyboard_models/<mfr>/<model>/web/` | Per-model UI loaded into the tab iframe |
