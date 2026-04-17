# Architecture: Model-Delegated Tool Abstraction

> **Execution order: 1 of 7** — This is the foundational plan. All other plans depend on it. No prerequisites.

## Problem

The current architecture has business logic split between MCP tools and shared framework code. Tools directly call `midi.sendCC()`, resolve values via shared `parameterMap`, and track state in a shared `GenericParameterState`. This couples everything to MIDI CC transport and prevents supporting keyboards that use different protocols (Roland SysEx DT1/RQ1, NRPN, etc.).

## Design Principle

**MCP tools are thin delegates. Models own everything.**

Each MCP tool does only three things:
1. Validate MCP input
2. Call `model.doSomething()`
3. Format and return the response

The model decides how to implement each operation internally — what transport to use, how to encode values, how to track state, how to read state back.

## Ownership Split

### Framework owns:
- MIDI port lifecycle (open/close, hand connection to model)
- Model registry (discovery, auto-detection from MIDI ports)
- MCP tool registration (thin wrappers that delegate to model)
- Backup format detection (iterate registered models, call `model.detectBackupFormat()`)
- Mock runner shell (model picker UI, Electron lifecycle)

### KeyboardModel (type) owns:
- Parameter definitions (names, ranges, sections, labels) — shared across instances
- Preset definitions — shared across instances
- System prompt template — shared across instances
- Backup format parsing — knows the binary format
- Factory methods — `createDevice()`, `createMockHandler()`

### KeyboardDevice (instance) owns:
- MIDI connection (1:1 with a physical device or mock)
- Value resolution (user input → wire format)
- Transport encoding (CC, SysEx DT1, NRPN — internal choice)
- State tracking and retrieval
- Formatted output for all tool responses
- Backup data (this unit's programs, samples, etc.)
- User-assigned label for identification

## KeyboardModel / KeyboardDevice Split

A **KeyboardModel** is a type of keyboard (e.g., "Nord Electro 5D", "Prophet-6"). One instance per model in the registry. It owns shared definitions and acts as a factory for devices.

A **KeyboardDevice** is a specific physical unit or mock instance. Each device has its own MIDI connection, its own state, and optionally its own backup data (inventory of programs, samples, etc.). Multiple devices of the same model can coexist (e.g., 3 Prophet-5s, each with different programs loaded).

The 1:1 mapping: **one MidiConnection ↔ one KeyboardDevice**.

```typescript
// ── The type (one per model in registry) ──
interface KeyboardModel {
  info: KeyboardModelInfo;

  // Static queries (shared across all instances)
  getParameterDefinitions(): ParameterDefinition[];
  getPresetDefinitions(): PresetDefinition[];
  getSystemPromptTemplate(): string;

  // Factories
  createDevice(): KeyboardDevice;
  createMockHandler?(): MockHandler;
  mockUiDir?: string;

  // Backup parsing (knows the binary format, no connection needed)
  detectBackupFormat(filePath: string): Promise<boolean>;
  extractBackup(filePath: string, outputPath?: string): Promise<BackupData>;
}

// ── A specific instance (one per physical/mock device) ──
interface KeyboardDevice {
  model: KeyboardModel;         // Back-reference to the type
  label?: string;               // User-assigned name ("studio Nord", "gig Nord")
  backupData?: BackupData;      // THIS unit's inventory (programs, samples, etc.)

  // Connection lifecycle
  attach(connection: MidiConnection): void;
  detach(): void;

  // Tool implementations (stateful, need connection)
  listParameters(section?: string): ToolResult;
  setParameters(params: Array<{ name: string; value: number | string }>, part?: string): ToolResult;
  getState(section?: string): ToolResult;
  loadProgram(bank: number, slot: number): ToolResult | Promise<ToolResult>;
  loadSong(bank: number, slot: number, part?: string): ToolResult | Promise<ToolResult>;
  listPrograms(filter?: string): ToolResult;   // query backup inventory by name
  listSongs(filter?: string): ToolResult;      // query set list inventory by name
  getSystemPrompt(): ToolResult;
}
```

**Backup data is per-instance.** Two Nord Electro 5Ds can have different programs and samples loaded. `model.extractBackup(filePath)` parses the binary format (model concern), and the result is stored on a specific `device.backupData` (instance concern).

**Device identification:** Physical devices don't reliably expose serial numbers via MIDI. Devices are identified by a user-assigned label set at connect time. This label is used to associate backup data with the correct instance across sessions.

Where `MidiConnection` is the framework's thin wrapper around the raw MIDI port:

```typescript
interface MidiConnection {
  sendCC(controller: number, value: number, channel?: number): void;
  sendProgramChange(program: number, channel?: number): void;
  sendSysEx(bytes: number[]): void;
  sendNRPN(msb: number, lsb: number, value: number, channel?: number): void;
  sendCCBatch(messages: Array<{ controller: number; value: number; channel?: number }>): Promise<void>;
  onCC(callback: (cc: number, value: number, channel: number) => void): void;
  onSysEx?(callback: (bytes: number[]) => void): void;
}
```

## How each MCP tool changes

```typescript
// set_parameters — before (business logic in tool)
const midiValue = parameterMap.resolveValue(param, value);
midi.sendCC(param.cc, midiValue);
state.set(key, midiValue, part);

// set_parameters — after (pure delegation to device instance)
return device.setParameters(parameters, part);
```

```typescript
// get_state — before (shared state manager)
return state.format(section);

// get_state — after (device decides how to read state)
return device.getState(section);
// Nord device: reads from internal state tracker (populated by mock feedback)
// Juno-X device: sends RQ1 SysEx to query hardware directly
```

## Transport as internal device concern

Transport is NOT a framework abstraction. It's an internal implementation detail of each device (defined by its model).

```
Nord Electro 5D device (internal):
  ├── CCTransport — sends CC messages
  ├── NordParameterMap — CC numbers, encodings, labels (shared via model)
  └── NordStateTracker — tracks state from mock feedback (per-instance)

Juno-X device (internal):
  ├── DT1Transport — sends Roland SysEx with address + checksum
  ├── RQ1Reader — queries parameters via SysEx request
  ├── JunoXAddressMap — 4-byte addresses, nibble packing (shared via model)
  └── JunoXStateTracker — reads state from hardware via RQ1 (per-instance)

Prophet-6 device (internal):
  ├── CCTransport — sends CC messages (reusable utility)
  └── Prophet6ParameterMap — CC numbers, labels (shared via model)
```

Two models might share a `CCTransport` utility class, but that's their choice — the framework doesn't mandate or know about it.

## Mock Engine — Fully Delegated

The mock engine follows the same delegation principle as MCP tools: **the engine is a thin shell, the model's mock handler owns all logic**.

### Current engine responsibilities (to be removed from engine)

The current engine contains significant model-specific logic:
- `initChannel()` — iterates `parameterMap.params`, uses `param.cc` — CC-specific
- `handleCC()` — CC routing, per-part propagation, `getParamByCC()` — CC assumptions
- `buildStateMessage()` — builds lower/upper/global from CC-keyed channel state
- `labelFor()` / `buildParamEntry()` — knows about drawbar, model-index, one-based encodings

All of this should move into the model's mock handler.

### Future engine — truly thin

The engine owns only:
- MIDI virtual port creation/teardown
- WebSocket server lifecycle (UI clients + MCP client tracking)
- Broadcasting JSON to connected clients
- Console logging

```typescript
class MockEngine {
  // Lifecycle
  start(): void;   // Create MIDI port, WebSocket, call handler.init()
  stop(): Promise<void>;

  // All MIDI input goes through one call to the handler
  // Engine listens for cc, program, sysex and forwards everything
  private onMIDI(msg: MidiMessage): void {
    const result = this.handler.onMIDI(msg);
    if (result.state) this.broadcast(result.state);
    if (result.log) console.log(`MIDI: ${result.log}`);
  }
}
```

### Future MockHandler — model owns everything

```typescript
interface MidiMessage =
  | { type: "cc"; controller: number; value: number; channel: number }
  | { type: "program"; number: number; channel: number }
  | { type: "sysex"; bytes: number[] };

interface MockHandlerResult {
  state?: Record<string, any>;  // Full state message to broadcast to UI
  log?: string;                  // Console log line
}

interface MockHandler {
  init(): void;
  onMIDI(msg: MidiMessage): MockHandlerResult;
  getFullState(includeInventory: boolean): Record<string, any>;
  onCacheReload?(): void;
}
```

The handler:
- Receives raw MIDI messages (CC, Program Change, SysEx — whatever the real hardware uses)
- Maintains its own internal state (however it wants)
- Builds the complete state message for the UI (no engine involvement)
- Provides log descriptions

### Per-model mock behavior

Each `model.createMockHandler()` returns a handler that emulates that model's hardware:

```
Nord mock handler:
  Receives CCs → updates internal CC-keyed state
  Builds lower/upper/global from parameterMap (shared via model)
  Handles drawbar preset routing, organ toggles, program loading

Juno-X mock handler:
  Receives DT1 SysEx → parses address + data
  Updates internal address-keyed state
  Builds state message from address map (shared via model)

Prophet-6 mock handler:
  Receives CCs → updates internal state
  Builds flat global state (mono-timbral, no parts)
```

Mocks emulate the real hardware's full MIDI transport — a Nord mock receives CCs, a Juno-X mock receives SysEx. The engine doesn't care which. Multiple mock handlers of the same model can coexist (e.g., 3 Prophet-6 mock tabs), each with independent state.

## State reading — per device

Different keyboards have different state-reading capabilities:

| Model | How state is read |
|-------|-------------------|
| **Nord Electro 5D** | No hardware readback. State tracked internally from sent CCs. Mock reports state via WebSocket. |
| **Juno-X** | Hardware supports RQ1 — can query any parameter's current value via SysEx request/response. |
| **Prophet-6** | No hardware readback. State tracked internally from sent CCs. |

This is why `getState()` must be device-implemented — the mechanism is fundamentally different per keyboard.

## Existing precedent

`loadProgram` and `loadSong` already follow this pattern — they're device-owned multi-message operations. The Nord device's `loadProgram` sends CC0 → CC32 → PC. The `loadSong` sends CC48 → CC0 → CC32 → PC → delay → CC49. The tool just calls `device.loadProgram()`.

This architecture generalizes that same principle to all operations.

## Migration path

### Phase 1: Define interfaces and split KeyboardModel
Create the `KeyboardModel` (type) and `KeyboardDevice` (instance) interfaces. Expand `MidiConnection` with `sendSysEx()` and `onSysEx()`. No behavioral changes yet — existing CC methods still work.

### Phase 2: Refactor one tool as proof of concept
Pick `getState` or `listParameters` — move the logic into the Nord device, make the tool a thin wrapper calling `device.getState()`. Verify nothing breaks.

### Phase 3: Migrate remaining tools
Move `setParameters`, `loadProgram`, `loadSong`, `getSystemPrompt` into the device. Model provides `createDevice()` factory. Add `listPrograms` and `listSongs` (query backup inventory). Remove `applyPatch` and `listPresets` tools.

### Phase 4: Implement a DT1/RQ1 model
Build the Juno-X (or another Roland keyboard) using the new interfaces. This validates the abstraction actually works for non-CC transports.

## Design Decisions

### Shared building blocks (reuse over duplication)

Even though each model/device has full autonomy, we encourage reuse. The `shared/` folder should provide basic building blocks that make it easy to implement new models:

- **Types**: `ToolResult`, `MidiMessage`, parameter metadata types
- **Transports**: `CCTransport`, `SysExDT1Transport`, `NRPNTransport` — models pick what they need
- **State utilities**: Generic CC-keyed state tracker, label formatting helpers
- **Mock utilities**: WebSocket state broadcasting helpers, channel state management — anything currently in the engine that's genuinely reusable

Models import and compose these. Two CC-based keyboards reuse the same transport utility. A Roland keyboard uses a shared DT1 transport. But the framework doesn't mandate any of it.

### MCP tool descriptions — generic only

Tool descriptions must not contain model-specific details (no "drawbar values 0-8", no "organ presets"). They stay generic:

```
"Set one or more keyboard parameters by name and value."
```

Device-specific parameter details come from two places:
- `device.getSystemPrompt()` — signal path, engine capabilities, sound design tips (template from model, instance-specific info like backup inventory from device)
- `device.listParameters()` — all parameters with names, ranges, types, labels, descriptions (no transport details like CC numbers — just what an agent needs to set values)

The system prompt should include a **terminology glossary**: in keyboard jargon, "program", "preset", and "patch" are near-synonymous — they all refer to a stored sound configuration. Online resources use these interchangeably. In this system, stored sounds are called **programs** and are managed via `listPrograms` / `loadProgram`.

### Mock engine reusable parts

Anything genuinely generic in the current engine should move to `shared/` as composable utilities:
- WebSocket server management (client tracking, broadcast, MCP client detection)
- MIDI virtual port creation/teardown
- Console logging helpers

Models/devices compose these in their mock handlers rather than inheriting from a monolithic engine.