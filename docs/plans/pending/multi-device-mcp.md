# Multi-Device MCP

## Problem

The MCP server can only connect to one MIDI device at a time. The single-device assumption is baked into every layer: `ModelHolder` is a singleton, `MidiManager` holds one output, and all tools implicitly target "the" connected device.

For recreating sounds that involve multiple keyboards (e.g., organ on the Nord, pad on the Prophet-6), the agent needs to control multiple devices simultaneously.

## Design

### Device Pool

Replace the singleton `ModelHolder` + `MidiManager` pair with a **device pool** — an indexed collection of connected devices.

Each device in the pool is a self-contained unit:

```typescript
interface ConnectedDevice {
  index: number;                // 1-based, assigned on connect
  model: KeyboardModel;
  stateManager: StateManager;
  midi: MidiManager;            // Own output + optional forward
  displayName: string;          // e.g., "Nord Electro 5D"
}
```

A new `DevicePool` class replaces `ModelHolder`:

```typescript
class DevicePool {
  devices: Map<number, ConnectedDevice>;
  nextIndex: number;

  connect(model, midi): number;       // Returns assigned index
  disconnect(index): void;
  get(index): ConnectedDevice;
  require(index): ConnectedDevice;    // Throws if not found
  list(): ConnectedDevice[];
  requireSingle(): ConnectedDevice;   // For backwards compat when only 1 device
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
- `apply_patch` — adds optional `device: number`
- `load_program` — adds optional `device: number`
- `load_song` — adds optional `device: number`
- `get_current_state` — adds optional `device: number`
- `list_parameters` — adds optional `device: number` (different models have different params)
- `list_presets` — adds optional `device: number`
- `get_system_prompt` — adds optional `device: number`

**Tools that change behavior:**
- `connect_to_keyboard` — no longer unloads previous device. Adds to pool. Returns the assigned index in the response text.
- `disconnect_from_keyboard` — takes optional `device: number`. If omitted and multiple connected, returns error listing devices. Disconnects the specified device from the pool.
- `is_connected` — reports all connected devices with their indices, models, and connection status.

### Connection Flow

**Before (single device):**
```
connect_to_keyboard(port: "Nord") → unloads previous → loads Nord → done
```

**After (multi device):**
```
connect_to_keyboard(port: "Nord")     → pool index 1, returns "Connected Nord Electro 5D as device 1"
connect_to_keyboard(port: "Prophet")  → pool index 2, returns "Connected Prophet-6 as device 2"
set_parameters(device: 1, ...)        → targets Nord
set_parameters(device: 2, ...)        → targets Prophet-6
disconnect_from_keyboard(device: 1)   → removes Nord, Prophet stays as device 2
```

Indices are stable for the session — disconnecting device 1 does not renumber device 2.

### HW + Mock Synced Pairs

When `connect_to_keyboard` is called with both a hardware port and a forward port (mock), this remains a **single device** in the pool. The `MidiManager` for that device handles forwarding internally, exactly as today.

This means a user can have:
- Device 1: Real Nord + Nord Mock (synced pair)
- Device 2: Prophet-6 Mock (standalone mock)

Both are independently addressable by index.

### Architecture Changes

#### `src/shared/device-pool.ts` (new file)

Replaces `model-holder.ts`. Manages the `Map<number, ConnectedDevice>` with connect/disconnect/get/list/require methods.

#### `src/shared/model-holder.ts`

Removed. All references replaced with `DevicePool`.

#### `src/midi/midi-manager.ts`

No structural changes. Each `ConnectedDevice` in the pool gets its own `MidiManager` instance. The class itself stays the same — one output, optional forward, channel config.

#### `src/tools/connect.ts`

- No longer calls `holder.unload()` before connecting.
- Creates a new `MidiManager` instance for the new connection.
- Calls `pool.connect(model, midi)` to add to pool.
- Returns the assigned index in the response.

#### `src/tools/disconnect.ts`

- Accepts optional `device` parameter.
- Calls `pool.disconnect(index)` which stops the MIDI manager and cleans up.

#### `src/tools/set-parameters.ts`, `apply-patch.ts`, `load-program.ts`, `load-song.ts`

- Add optional `device` parameter to schema.
- Resolve device: `device` param → `pool.require(device)`, or single-device fallback via `pool.requireSingle()`.
- Use the resolved device's `model`, `stateManager`, and `midi` instead of the global singleton.

#### `src/tools/get-state.ts`, `list-parameters.ts`, `list-presets.ts`, `get-system-prompt.ts`

- Add optional `device` parameter.
- Same resolution logic.

#### `src/tools/is-connected.ts`

- Lists all connected devices with index, model name, and connection details.
- Reports if no devices connected.

#### `src/index.ts`

- Creates `DevicePool` instead of `ModelHolder`.
- Passes `pool` to all tool registration functions instead of `holder`.
- `MidiManager` is no longer created here — each connection creates its own.

### What Doesn't Change

- **Keyboard models** — no changes to any model implementation.
- **`model-registry.ts`** — unchanged, still discovers and loads models.
- **`parameter-resolution.ts`** — unchanged, works per-parameter.
- **`parameter-state.ts`** — unchanged, each device gets its own instance.
- **Mock runner / engine** — unchanged (this is about the MCP server side).
- **`agent.ts`** — unchanged, agent uses MCP tools which now support multi-device.
- **MIDI protocol** — unchanged, each MidiManager talks to one MIDI port.

### System Prompt Updates

The `get_system_prompt` tool should include device index information so the agent knows how to address devices. When multiple devices are connected, the prompt should list all devices with their indices and capabilities.

### Backwards Compatibility

Single-device usage is fully backwards compatible:
- Connect one device → all tools work without `device` param (auto-resolved to the only device).
- The `device` param is optional on every tool.
- Only when 2+ devices are connected does omitting `device` produce an error.