# Tabbed Multi-Mock Runner with Persistent Chat

> **Execution order: 6 of 7** — Depends on: architecture plan (thin engine + MockHandler), multi-device MCP plan (plan 4 — DevicePool, labels), per-instance backup plan (plan 5 — label-keyed backup storage for tab ↔ backup directory mapping).

## Problem

The agent chat UI currently lives inside the Nord model's web UI (`keyboard_models/nord/electro_5d/web/app.js`). This is wrong because:

1. Chat disappears when the model chooser is showing
2. Other keyboard models would need to duplicate the chat code
3. Chat is an agent concern, not a model concern

Additionally, the mock runner only supports one model at a time.

## Design

### Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Mock Runner Shell (always present, never reloaded)                      │
├───────────────────────────────────────────────┬──────────────────────────┤
│ [Nord Electro 5D] [Prophet-6] [+]            │                          │
├───────────────────────────────────────────────┤   Chat Panel             │
│                                               │   (agent @ :2999)        │
│   <iframe>                                    │                          │
│   Active tab's content:                       │   Independent of tabs.   │
│   - Model chooser (new tab)                   │   MCP controls all       │
│   - Model UI (after selection)                │   running mocks + real   │
│                                               │   devices.               │
│                                               │                          │
└───────────────────────────────────────────────┴──────────────────────────┘
```

### Port Assignment

| Service          | Port |
|------------------|------|
| Agent HTTP/SSE   | 2999 |
| Mock Engine tab 1| 3000 |
| Mock Engine tab 2| 3001 |
| Mock Engine tab N| 3000 + N-1 |

### Tab Lifecycle

1. **App starts:** One tab, showing model chooser in the iframe.
2. **Model selected:** Main process creates a MockEngine on the next available port (starting at 3000). Shell updates the tab label to the model display name, iframe navigates to the model's web UI with `?wsPort=<port>` query parameter.
3. **[+] clicked:** New tab added, shows model chooser. Previous tab's iframe is hidden (not destroyed) so its WebSocket connection stays alive.
4. **Tab closed (x):** Main process stops that tab's MockEngine (closes virtual MIDI port + WebSocket). Iframe destroyed. If last tab is closed, a fresh model-chooser tab appears.
5. **Tab switched:** Active iframe shown, others hidden via CSS (`display: none`).

### Engine Management

Main process maintains a `Map<tabId, { model, engine, wsPort }>`.

Each `MockEngine` instance gets its own:
- WebSocket server on its assigned port
- Virtual MIDI port named after the keyboard model
- Independent channel state

Port assignment: sequential from 3000. When a tab is closed, its port is freed and can be reused.

## Architecture Changes

### `src/mock-runner/main.ts`

**Before:** Holds a single model + engine. Calls `mainWindow.loadFile()` to swap between shell and model UI.

**After:**
- Loads shell once at startup. Never calls `loadFile()` again.
- Holds `Map<tabId, { model, engine, wsPort }>` for active tabs.
- New IPC handlers:
  - `create-tab` → returns a new `tabId`
  - `close-tab(tabId)` → stops engine, frees port, removes from map
  - `select-model-for-tab(tabId, modelId)` → loads `KeyboardModel` from registry, calls `model.createMockHandler()`, creates thin `MockEngine(port, handler)`, returns `{ wsPort, modelUiPath, displayName }`
- Removes old `select-model` handler (replaced by `select-model-for-tab`).
- `get-models` stays the same.

### `src/mock-runner/engine.ts`

**Before:** WebSocket port hardcoded to 3000. Engine contains model-specific logic (state building, CC routing, label formatting).

**After:** Per the architecture plan, the engine is a **thin shell**. Constructor accepts a `port` parameter and a `MockHandler` from the model. The engine owns only MIDI virtual port creation, WebSocket lifecycle, and broadcasting. All MIDI handling is delegated to `handler.onMIDI()`. Each tab's engine instance is fully independent.

### `src/mock-runner/shell/` (persistent host)

**Before:** Simple model picker that gets replaced on model selection.

**After:** Permanent layout host with three areas:

1. **Tab bar** — Horizontal tab strip at the top of the left panel. Each tab shows the model display name (or "New" for model chooser tabs). Close button (x) on each tab. Plus (+) button at the end.

2. **Iframe container** — Below the tab bar. Holds one `<iframe>` per tab. Only the active tab's iframe is visible (`display: none` for others). New tabs load `chooser.html`. After model selection, iframe navigates to the model's `web/index.html?wsPort=<port>`.

3. **Chat panel** — Right side, always visible. Contains the chat UI extracted from the Nord model. Connects to agent at `http://localhost:2999`. Shows agent connection status. Chat history persisted in `localStorage`.

**Shell JS responsibilities:**
- Tab state management (create, switch, close)
- IPC calls to main process for engine lifecycle
- Chat UI rendering and agent communication
- Listening for `postMessage` from model chooser iframes

### `src/mock-runner/shell/chooser.html` (new file)

The model chooser extracted into a standalone page loadable in an iframe. On model selection, sends `window.parent.postMessage({ type: 'model-selected', modelId })` to the shell.

### `src/keyboard_models/nord/electro_5d/web/`

**Chat code and extract-backup button removed** from `app.js` and `index.html`. The model UI becomes purely the mock hardware display — no workflow actions, no agent communication. These move to the shell (see below).

**WebSocket connection** updated to read port from URL query parameter:
```js
const wsPort = new URLSearchParams(location.search).get('wsPort') || '3000';
const ws = new WebSocket(`ws://localhost:${wsPort}`);
```

### `src/agent.ts`

Default port changed from 3001 to 2999. No other changes — the agent is fully independent and MCP tools address devices by MIDI port name, not by tab.

### `src/mock-runner/preload.cjs`

Updated IPC bridge to expose the new tab-oriented methods:
- `createTab()` → IPC `create-tab`
- `closeTab(tabId)` → IPC `close-tab`
- `selectModelForTab(tabId, modelId)` → IPC `select-model-for-tab`
- `getModels()` → unchanged
- `openBackupDialog()` → unchanged

## What Doesn't Change

- **MCP tools** — unchanged, they work via MIDI port names
- **KeyboardModel / KeyboardDevice implementations** — unchanged (except Nord losing chat code). Models already provide `createMockHandler()` per the architecture plan.
- **`model-registry.ts`** — unchanged
- **`agent.ts` behavior** — unchanged (just default port)

### Prerequisite

This plan assumes the **architecture plan** has been implemented first. The engine must already be the thin shell that delegates to `MockHandler` instances created via `KeyboardModel.createMockHandler()`.

## Chat Panel Details

The chat panel extracted from the Nord UI into the shell includes:

- Chat message history (rendered as formatted bubbles)
- Input area with send button
- Agent connection status indicator
- Reset conversation button
- Extract backup button (opens device picker modal, see below)
- SSE streaming for agent responses (text, tool_use, tool_result events)
- `localStorage` persistence for chat history

The chat connects to `http://localhost:2999` and is fully independent of which tab is active or which mocks are running.

## Backup Extraction — Moved to Shell

The extract-backup button is currently in the Nord model's web UI (`app.js`). This is a framework/workflow concern, not a model display concern. It moves to the shell, accessible from two entry points:

1. **Shell menu** (File → Extract Backup...)
2. **Chat panel** — "Extract backup" button

Both trigger the same flow — a **device picker modal**:

1. Modal opens showing a list of all open tabs: label + model name. The currently active tab is pre-selected.
2. User confirms or picks a different device.
3. File picker opens → user selects backup file.
4. IPC to main process: `extract-backup(filePath, label)`
5. Backup cache stored under `data/backups/<label>/` (per Plan 3).
6. Mock handler for that tab reloads cache via `onCacheReload()`.
7. If MCP is connected to this device, `device.backupData` is updated too.

If only one tab is open, the modal can be skipped (single device, no ambiguity). If no tabs are open (model chooser showing), the button is disabled.

The Nord model UI (`web/app.js`) loses the backup button entirely — it becomes a pure hardware display.

## Window Size

Increase default window size from 1400x900 to accommodate the persistent chat panel alongside model UIs. Exact dimensions TBD during implementation, but likely ~1600x950 or wider.

## Test Coverage

### Unit tests

No new unit tests — the tab lifecycle is Electron UI logic (IPC + DOM) which unit tests can't meaningfully exercise. The underlying engine and handler code is unchanged and already covered.

### Integration tests

**`tests/integration/mock-runner.test.ts`** — add:
- **Multiple engines on different ports:** Spawn three `MockProcess` instances with different models and ports (simulating three tabs). Verify each produces independent state via its own WebSocket. Stop one, verify the other two continue broadcasting.
- **Port reuse after stop:** Spawn on port 3000, stop it, spawn a new mock on port 3000. Verify the new instance works correctly (simulates tab close + reopen).

### E2E tests

**`tests/e2e/multi-model.test.ts`** — extend:
- **Three concurrent models:** Start Nord, JUNO-X, and Prophet-6 mocks simultaneously. Connect to all three via MCP (using plan 4's multi-device). Run `set_parameters` + `get_current_state` on each. Verify complete isolation — setting a param on device 1 doesn't affect devices 2 or 3.
- **Connect/disconnect cycle:** Connect all three, disconnect one, reconnect a new model on a different port. Verify the pool state is correct throughout.

> **Note:** The Electron shell UI (tab bar, iframe management, chat panel) is not covered by automated tests. Tab lifecycle IPC handlers (`create-tab`, `close-tab`, `select-model-for-tab`) should be manually verified. If Electron testing becomes a priority, consider Playwright with Electron support in a future plan.