# File Menu — Save / Save As / Open / Recents — Design

> **Status:** Spec for backlog item #9 in `docs/plans/pending/todo-list.md`.
> **Date:** 2026-05-04.
> **Successor of:** plan #6 (tabbed mock runner) and plan #7 (label discovery via mock registry).

## Goal

Let the user persist and restore a complete "studio rack" — every tab, label, and the per-tab mock state — through a familiar **File** menu in the Electron mock runner. Survive a quit and reload to where you were on the next launch.

## User-facing behavior

### Menu

```
File
  New Tab                    ⌘T
  Open…                      ⌘O
  Open Recent ►              [Electron role: recentDocuments]
  ─────────
  Save                       ⌘S
  Save As…                   ⌘⇧S
  ─────────
  Extract Backup…            ⌘E
  Quit                       ⌘Q
```

`Open Recent` uses the built-in `{ role: 'recentDocuments' }` menu role on macOS, which auto-populates from `app.getRecentDocuments()` and emits the `'open-file'` event on click. We do not build the submenu manually.

### Title bar

- `Mock Runner — gig-rig.mockrack` — file loaded.
- `Mock Runner — gig-rig.mockrack •` — file loaded, unsaved changes.
- `Mock Runner` — no current file (untitled session).

### Save / Save As

- **Save**: writes to `currentFilePath` if set; otherwise behaves as Save As.
- **Save As**: native save dialog. Default extension `.mockrack`. On success: set `currentFilePath`, clear `isDirty`, push `dirty-changed` event, call `app.addRecentDocument(path)` (macOS), update title.

### Open

1. If `isDirty`, show a 3-button dialog *Save / Don't Save / Cancel*. Cancel aborts. Save runs the save flow first.
2. Read + parse + version-check the file. On error: console note, abort, rack untouched.
3. Set `restoring = true` (gates dirty-event propagation).
4. Close every current tab (each `engine.stop()`; renderer drops the iframe).
5. For each saved tab, in order:
   - allocate `wsPort` via the existing `nextFreePort()`,
   - load the model from the registry,
   - create + start a MockEngine with the saved label,
   - if `state` is non-null and the handler implements `setFullState`, restore via `engine.restoreSnapshot(state)`; otherwise log a one-line console note (graceful degradation),
   - tell renderer to mount the iframe.
6. Set the active tab.
7. `restoring = false`, `currentFilePath = path`, clear `isDirty`, `addRecentDocument`, push `dirty-changed`.

### Open Recent

The macOS-managed Recent Documents list. Selecting an item fires the `'open-file'` event in main, which routes into the same Open flow. If the picked file no longer exists on disk, console note `File not found: <path>` and abort (rack untouched).

### Quit

If `isDirty`, the same Save / Don't Save / Cancel prompt; Cancel aborts the quit.

### Launch (auto-load)

Inside `app.whenReady()`, after the existing window creation:
1. Read `app.getRecentDocuments()`.
2. Iterate in order; pick the first one that `existsSync()`.
3. Run the Open flow on it (the rack is empty at launch, so the dirty prompt is skipped).
4. If none survive, fall through — empty rack (today's behavior).

### Dirty triggers

`isDirty = true` (and `dirty-changed` to renderer) when, with `!restoring`:

- `create-tab`, `close-tab`, `rename-tab`, `select-model-for-tab`, `extract-backup`, `set-active-tab` IPC handlers fire.
- Any MockEngine emits `'state-changed'` (debounced ~250ms in main to avoid IPC chatter).

Cleared on Save success and at the end of an Open.

## File format

`.mockrack` — plain JSON, custom file extension wired up via `package.json` `fileAssociations` so macOS recognises double-clicks and the dock.

```json
{
  "$schema": "mockrack/v1",
  "version": 1,
  "savedAt": "2026-05-04T18:23:00Z",
  "appVersion": "2.0.0",
  "activeTabIndex": 1,
  "tabs": [
    {
      "modelId": "nord-electro-5d",
      "label": "road-nord",
      "state": { /* opaque per-model snapshot from getFullState(false) */ }
    },
    {
      "modelId": "roland-juno-x",
      "label": "studio-juno",
      "state": null
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | `1` for now. Loader refuses higher versions. |
| `appVersion` | Informational. |
| `savedAt` | Informational. |
| `activeTabIndex` | Foregrounded tab on restore. Clamped to valid range. |
| `tabs[].modelId` | Required. Keyboard model id. |
| `tabs[].label` | Required. Per-instance backup-cache key. |
| `tabs[].state` | Per-model `getFullState(false)` snapshot (i.e., excluding the inventory), or `null` if the model doesn't yet implement `setFullState`. |

**Not in the file:** `wsPort` (re-allocated each session), backup inventory (kept on disk under `data/backups/<label>/`), `mcpConnected`, ports, anything runtime-derived.

**Atomic write** mirrors the mock-registry pattern: write to a per-process tmp file, then rename.

## Architecture

### Ownership

- **Main process** owns `currentFilePath`, `isDirty`, the canonical tab order (its `tabs: Map<tabId, …>` is insertion-ordered), and the on-disk file.
- **Renderer (shell)** owns which tab is active (drives the iframe layout). It pushes `activeTabId` changes to main via a new `set-active-tab(tabId)` IPC.
- **MockEngine** gains `restoreSnapshot(snapshot)` that delegates to `handler.setFullState?.(snapshot)`, plus a `'state-changed'` event whenever `broadcast()` is called. Main subscribes per engine.

### `MockHandler.setFullState` contract

Optional method on `MockHandler`:

```ts
export interface MockHandler {
  // ... existing members ...

  /**
   * Restore the handler's internal state from a snapshot previously
   * produced by `getFullState(false)`.
   *
   * Implementers MUST treat the input as best-effort:
   *   - missing fields → keep current defaults (don't throw)
   *   - unknown extra fields → ignore
   *   - malformed shapes → log and partially recover, never throw
   *
   * Implementers MUST NOT broadcast — the engine emits a single
   * `getFullState` broadcast after this call returns, so the UI sees
   * one consistent transition.
   */
  setFullState?(snapshot: Record<string, any>): void;
}
```

**Round-trip property** (per model): `setFullState(JSON.parse(JSON.stringify(getFullState(false))))` followed by `getFullState(false)` returns equivalent JSON. Unit-testable.

### Engine plumbing

```ts
restoreSnapshot(snapshot: Record<string, any> | null): boolean {
  if (!snapshot) return false;
  if (!this.handler.setFullState) return false;
  try { this.handler.setFullState(snapshot); }
  catch (err) { console.error("setFullState failed:", err); return false; }
  this.broadcast(this.handler.getFullState(true));
  return true;
}
```

The engine also calls `this.emit('state-changed')` from `broadcast()` so main can detect dirty transitions without subscribing to every WS broadcast.

### IPC surface

Menu actions and the `'open-file'` event are all received in the main process directly — no round-trip to the renderer. The renderer just needs to (a) push active-tab changes up so main can persist them, and (b) react to dirty-state changes for the title-bar dot, plus react to load-time tab teardown / mount commands.

In addition to plan #6's IPC:

| Direction | Channel | Payload |
|---|---|---|
| renderer → main | `set-active-tab` | `{ tabId }` |
| main → renderer | `file:dirty-changed` | `{ isDirty, currentFilePath }` |
| main → renderer | `file:close-tab` | `{ tabId }` (used by Open flow to drop a specific iframe) |
| main → renderer | `file:mount-tab` | `{ tabId, modelInfoId, displayName, label, wsPort, modelUiDir }` (used by Open flow to mount each restored tab's iframe; same shape as `select-model-for-tab`'s return) |

## Per-model implementation cost

| Model | `setFullState` ships with v1? | Notes |
|---|---|---|
| Nord Electro 5D | **Yes** | Highest-priority model with the deepest state. |
| Roland JUNO-X | No (follow-up) | Tab loads identity-only; chat console explains. |
| Sequential Prophet-6 | No (follow-up) | Same. |

JUNO-X and Prophet-6 implementations land as their own small PRs.

## Edge cases & error handling

| Scenario | Behavior |
|---|---|
| Saved `modelId` no longer registered | Skip that tab. Console note: `Skipped tab "<label>": model "<modelId>" not registered.` |
| `version` higher than supported | Refuse to load. Native error: `This setup requires Mock Runner v<N>; you're on v<M>.` |
| Malformed JSON / parse error | Console note, abort. Rack untouched. |
| Save fails (disk full / EACCES) | Native error dialog. `currentFilePath` and `isDirty` stay unchanged. |
| Recent file no longer exists at launch | Skip silently to next; if all gone, empty rack. |
| Recent file selected via menu but missing | Console note: `File not found: <path>`. Do not modify rack. |
| `tabs[]` empty | Valid. Empty rack with `currentFilePath` set; `isDirty` clear. |
| `activeTabIndex` out of range | Clamp to `[0, tabs.length - 1]` (or `0` if empty). |
| MockEngine `start()` throws (port/MIDI collision) | `nextFreePort()` already retries. If MIDI creation fails, skip the tab with a console note. |
| Two saved tabs with same `(modelId, label)` | Allowed at load time — registry is keyed by `wsPort`. The rename-collision check in the shell is a *write-time* guard. |
| State-changed event during restore | Suppressed via `restoring = true` flag in main. |

## Backwards compatibility

- The menu adds new actions; existing flows are untouched.
- `MockHandler.setFullState` is optional. Models without it work today; their tabs reload identity-only on Open.
- The mock registry, label routing, per-instance backup cache, and the existing tab IPC are unchanged.

## Test plan

**Unit (`tests/unit/`):**
- `mockrack-format.test.ts`: JSON parse + validation. Reject wrong version, missing required fields, malformed `tabs`. Accept minimal valid file.
- `nord-set-full-state.test.ts`: round-trip property — `setFullState(getFullState(false))` then `getFullState(false)` returns equivalent JSON. Cover drawbars, per-preset state, organ toggles, set-list mode, program loaded, channel CC values.

**Integration (`tests/integration/`):**
- `save-load-roundtrip.test.ts`: spawn two `MockProcess` instances on distinct ports, mutate state on each, capture their `getFullState(false)`, tear down, build a synthetic `.mockrack` payload, restore via `engine.restoreSnapshot()`, assert state matches.

**E2E:**
- The Electron menu / dialogs / dirty UI follow plan #6's policy — not auto-tested today. A manual checklist ships with the PR.

**Manual checklist:**
- [ ] Save then *Save* (no dialog) overwrites the file.
- [ ] Save As to a new path; macOS recents updates.
- [ ] Quit dirty: prompt appears; cancel aborts; *Save* saves and quits; *Don't Save* discards and quits.
- [ ] Open a `.mockrack` containing a JUNO-X tab — graceful-degradation note in the chat console.
- [ ] Launch with empty recents → empty rack.
- [ ] Delete the most-recent file off disk, then launch → falls through to the next or empty.
- [ ] Tweak a knob → title bar gets the `•`.
- [ ] After Save → `•` clears; tweak again → `•` returns.

## Out of scope (for v1)

- Auto-save on quit / on tweak.
- Schema migrations between non-trivial version bumps (the tolerance contract handles small additive changes).
- Cross-machine portability: setup files reference labels, not embedded inventories. Bringing a setup to another machine still works — the user re-extracts the backup on the new machine.
- Drag-and-drop of `.mockrack` onto the dock or onto an open window. The file association handles double-click on the dock; drag-and-drop is a small add but not required for v1.
- A "save before extract_backup" dirty-warn (extract is itself a tracked dirty trigger; users can save afterward).
