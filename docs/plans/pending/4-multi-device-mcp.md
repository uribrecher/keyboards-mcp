# Multi-Device MCP

> **Execution order: 4 of 7** — Depends on: architecture plan (KeyboardDevice with `attach()`/`detach()`). Per-instance backup (plan 5) builds on top of this — labels are introduced here as simple device identifiers, backup keying comes later.

## Problem

The MCP server can only connect to one MIDI device at a time. The single-device assumption is baked into every layer: `ModelHolder` is a singleton, `MidiManager` holds one output, and all tools implicitly target "the" connected device.

For recreating sounds that involve multiple keyboards (e.g., organ on the Nord, pad on the Prophet-6), the agent needs to control multiple devices simultaneously.

## Design

### Device Pool

Replace the singleton `ModelHolder` + `MidiManager` pair with a **device pool** — an indexed collection of connected devices.

Each entry in the pool wraps a `KeyboardDevice` (instance) — which already owns its connection, state, and model back-reference internally. The pool adds an index and tracks the collection.

```typescript
interface PoolEntry {
  index: number;                // 1-based, stable for session lifetime
  device: KeyboardDevice;       // The instance — owns connection, state, backup data
}
```

A new `DevicePool` class replaces `ModelHolder`:

```typescript
class DevicePool {
  devices: Map<number, PoolEntry>;
  nextIndex: number;

  connect(device: KeyboardDevice): number;  // Adds to pool, returns assigned index
  disconnect(index): void;                  // Calls device.detach(), removes from pool
  get(index): PoolEntry;
  require(index): PoolEntry;               // Throws if not found
  list(): PoolEntry[];
  requireSingle(): PoolEntry;             // For backwards compat when only 1 device
}
```

### Tool Changes

Every tool that currently takes no device identifier gains an optional `device` parameter (1-based index).

**Resolution rules:**
1. If `device` param provided → use that device from the pool
2. If only one device connected → use it (backwards compatible)
3. If multiple devices connected and no `device` param → return error listing connected devices with their indices

This keeps single-device usage identical to today while requiring explicit targeting when multiple devices are present.

**Affected tools:**
- `set_parameters` — adds optional `device: number`
- `load_program` — adds optional `device: number`
- `load_song` — adds optional `device: number`
- `get_current_state` — adds optional `device: number`
- `list_parameters` — adds optional `device: number` (different models have different params)
- `list_programs` — adds optional `device: number` (queries per-instance backup inventory)
- `list_songs` — adds optional `device: number` (queries per-instance set list inventory)
- `get_system_prompt` — adds optional `device: number`

**Tools that change behavior:**
- `connect_to_keyboard` — no longer unloads previous device. Creates a `KeyboardDevice` via `model.createDevice()`, attaches the connection, adds to pool. Accepts optional `label` parameter for user-assigned instance name. Returns the assigned index in the response text.
- `disconnect_from_keyboard` — takes optional `device: number`. If omitted and multiple connected, returns error listing devices. Disconnects the specified device from the pool.
- `is_connected` — reports all connected devices with their indices, model names, labels, and connection status.

### Connection Flow

**Before (single device):**
```
connect_to_keyboard(port: "Nord") → unloads previous → loads Nord → done
```

**After (multi device):**
```
connect_to_keyboard(port: "Nord", label: "studio Nord")  → pool index 1, returns "Connected Nord Electro 5D 'studio Nord' as device 1"
connect_to_keyboard(port: "Prophet")                     → pool index 2, returns "Connected Prophet-6 as device 2"
set_parameters(device: 1, ...)                           → targets studio Nord
set_parameters(device: 2, ...)                           → targets Prophet-6
disconnect_from_keyboard(device: 1)                      → removes studio Nord, Prophet stays as device 2
```

Indices are stable for the session — disconnecting device 1 does not renumber device 2.

### HW + Mock Synced Pairs

When `connect_to_keyboard` is called with both a hardware port and a forward port (mock), this remains a **single device** in the pool. The `MidiConnection` for that device handles forwarding internally, exactly as today.

This means a user can have:
- Device 1: Real Nord + Nord Mock (synced pair)
- Device 2: Prophet-6 Mock (standalone mock)

Both are independently addressable by index.

### Architecture Changes

#### `src/shared/device-pool.ts` (new file)

Replaces `model-holder.ts`. Manages the `Map<number, PoolEntry>` with connect/disconnect/get/list/require methods. On `connect()`, adds the `KeyboardDevice` to the pool. On `disconnect()`, calls `device.detach()` and removes from pool.

#### `src/shared/model-holder.ts`

Removed. All references replaced with `DevicePool`.

#### `src/midi/midi-manager.ts`

Refactored to implement the `MidiConnection` interface from the architecture plan. Each `ConnectedDevice` in the pool gets its own instance. The class provides `sendCC()`, `sendSysEx()`, `sendNRPN()`, `sendProgramChange()`, `sendCCBatch()`, `onCC()`, `onSysEx()`.

#### `src/tools/connect.ts`

- No longer calls `holder.unload()` before connecting.
- Loads the `KeyboardModel` from registry, calls `model.createDevice()` to get a `KeyboardDevice`.
- Creates a `MidiConnection`, calls `device.attach(connection)`.
- Sets `device.label` if the user provided one.
- Calls `pool.connect(device)` to add to pool.
- Returns the assigned index in the response.

#### `src/tools/disconnect.ts`

- Accepts optional `device` parameter.
- Calls `pool.disconnect(index)` which calls `device.detach()` and removes from pool.

#### `src/tools/set-parameters.ts`, `load-program.ts`, `load-song.ts`

- Add optional `device` parameter to schema.
- Resolve device: `device` param → `pool.require(device).device`, or single-device fallback via `pool.requireSingle().device`.
- Delegate to `device.setParameters()` / `device.loadProgram()` / etc. — thin wrappers only.

#### `src/tools/get-state.ts`, `list-parameters.ts`, `list-programs.ts`, `list-songs.ts`, `get-system-prompt.ts`

- Add optional `device` parameter.
- Same resolution logic, delegate to device methods.

#### `src/tools/is-connected.ts`

- Lists all connected devices with index, model name, and connection details.
- Reports if no devices connected.

#### `src/index.ts`

- Creates `DevicePool` instead of `ModelHolder`.
- Passes `pool` to all tool registration functions instead of `holder`.
- `MidiConnection` is no longer created here — each connection creates its own.

### What Doesn't Change

- **Keyboard models** — no changes to model implementations (they already implement `KeyboardModel` with `createDevice()` factory, and `KeyboardDevice` with `attach()`/`detach()`).
- **`model-registry.ts`** — unchanged, still discovers and loads `KeyboardModel` types.
- **Mock runner / engine** — unchanged (this is about the MCP server side).
- **`agent.ts`** — unchanged, agent uses MCP tools which now support multi-device.
- **MIDI protocol** — unchanged, each MidiConnection talks to one MIDI port.

### Prerequisite

This plan assumes the **architecture plan** has been implemented first. `KeyboardModel` must provide `createDevice()`, and `KeyboardDevice` must implement `attach(connection)`, `detach()`, and all tool methods.

### System Prompt Updates

The `get_system_prompt` tool should include device index information so the agent knows how to address devices. When multiple devices are connected, the prompt should list all devices with their indices and capabilities.

### Backwards Compatibility

Single-device usage is fully backwards compatible:
- Connect one device → all tools work without `device` param (auto-resolved to the only device).
- The `device` param is optional on every tool.
- Only when 2+ devices are connected does omitting `device` produce an error.