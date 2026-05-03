# Label Discovery (Mock Registry)

> **Execution order: 7** — Builds on plan #6 (tabbed mock runner with per-tab labels) and plan #5 (label-keyed backup cache). Removes the duplicate-label problem the multi-tab UI surfaced.

## Problem

After plan #6, two labels exist for the "same" mock:

- The **mock-runner tab** sets a label on its `MockEngine` (used to load that label's backup cache for the mock UI).
- The **MCP `connect_to_keyboard`** tool also takes a `label` arg (used to mark the pool entry and load the cache for `device.backupData`).

These two are unrelated — connecting via MCP without a label gets `_default`, even when the mock you're connecting to already advertises itself as `gig-nord`. The MCP `list_midi_devices` shows raw port names; there's no way to see which mock is which.

## Design

The mock is the running process; **it owns the label**. Everything else reads from it.

### 1. Mock advertises itself

Each `MockEngine` writes an entry to a shared runtime registry whenever it starts, relabels, or stops:

```
data/runtime/mocks.json:
[
  {
    "midiPort":   "Nord Electro 5D Mock",
    "wsPort":     3000,
    "modelId":    "nord-electro-5d",
    "displayName":"Nord Electro 5D",
    "label":      "studio-nord",
    "pid":        12345,
    "startedAt":  "2026-05-03T16:00:00Z",
    "lastTouched":"2026-05-03T16:42:11Z"
  },
  ...
]
```

- Written by `MockEngine.start()`, updated by `MockEngine.relabel()`, removed by `MockEngine.stop()`.
- Each engine touches `lastTouched` periodically (every 30s) so consumers can detect stale entries (process killed without cleanup).
- Atomic write: write to `mocks.json.tmp` + `rename`.
- File is intentionally inside the existing `data/` root; respects `KEYBOARDS_MCP_DATA_DIR`.

### 2. MCP reads the registry

Two consumers:

**`list_midi_devices`** — for each MIDI port, look up a registry entry by exact MIDI port name. Render `label`, `wsPort`, model name, and a "stale" marker if `lastTouched` is older than ~2 minutes or if `pid` doesn't exist.

```
## MIDI Output Ports
  3: Nord Electro 5D Mock      [studio-nord]   ws:3000
  4: Nord Electro 5D Mock1     [gig-nord]      ws:3001  ← device 1
  5: Roland JUNO-X Mock        [rack-juno]     ws:3002
  6: Prophet-6 Mock            [stage-prophet] ws:3003   (stale)
  0: Nord Electro 5 MIDI Input  (real hw — no label)
```

**`connect_to_keyboard`** — when no `label` arg is given:
1. Look up the registry by the resolved primary port name.
2. If found, use `entry.label`. Set `mock_ws_port` from the entry too (so the status WS hits the right mock).
3. If not found, fall back to `_default` (current behavior).

The explicit `label` arg stays as an override.

### 3. Pool device label tracks the mock

When `connect_to_keyboard` succeeds via the registry path, store the registry entry on the pool entry. A subsequent rename in the mock-runner will update the registry; the next `list_midi_devices` / `is_connected` call re-reads the registry and shows the new label.

For real-time updates of `device.label` while connected: the `MidiManager.mockWs` already opens a status WebSocket. Wire the engine to broadcast `label` in `getFullState()` so the MCP also sees label changes via the live channel — no polling required.

### 4. Stale-entry cleanup

On every `list_midi_devices` (and on registry reads), filter out entries whose `pid` no longer exists or whose `lastTouched` is older than 5 minutes. Keep them in the file (for debugging) but mark `stale: true` in memory. The mock-runner main process can also rewrite the file on startup, dropping any stale entries it owned previously.

### What doesn't change

- `BackupCacheCapability` and label sanitization rules.
- The MCP `extract_backup` and `get_last_backup_location` resolution chain.
- The `auto_input` / `auto_forward` flags.
- The shell UI (the chooser is unaffected).

## Implementation

### Files

- **`src/shared/mock-registry.ts`** (new): read/write helpers, sanitization, stale detection.
- **`src/mock-runner/engine.ts`**: write/update/remove registry entries on `start()`, `relabel()`, `stop()`. Periodic heartbeat timer.
- **`src/mock-runner/main.ts`**: ensure stale entries from the previous process are cleared on startup.
- **`src/mock-runner/cli.ts`**: same — headless mock runner registers itself too.
- **`src/tools/list-devices.ts`**: enrich port listing with registry data.
- **`src/tools/connect.ts`**: auto-resolve label (and mock_ws_port) from the registry when not given.
- **`src/shared/keyboard-model.ts`**: add `label` to `MockHandler.getFullState()` returned shape (or the engine adds it, depending on which is cleaner).
- **`src/midi/midi-manager.ts`**: capture `label` from incoming WS state messages and surface it via a getter; expose a callback so `connect.ts` can update the pool entry's label live.

### Tests

- **`tests/unit/mock-registry.test.ts`** (new): write → read round-trip, atomic write under contention, stale-entry filtering, label sanitization.
- **`tests/integration/mock-runner.test.ts`**: extend the "two mocks run simultaneously" case to assert each mock writes its entry; after stopping one, its entry is gone.
- **`tests/e2e/multi-device.test.ts`**: extend the existing 3-mock harness to assert `connect_to_keyboard` (no `label` arg) auto-adopts the mock's label.

## Backwards compatibility

- The `label` arg on `connect_to_keyboard` is unchanged — explicit always wins.
- If the registry file is missing or unreadable, the tools degrade to current behavior (port-name only listing, `_default` label on connect).
- Real hardware (no mock) is unaffected — no registry entry, no auto-label.
