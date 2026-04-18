# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm run build          # tsc → dist/
npm run start          # MCP server (stdio transport)
npm run dev            # MCP server via tsx (no build step)
npm run mock:runner    # Electron mock device with model picker UI
npm run mock:headless  # Headless mock (for testing), --model <id> required
```

The MCP server communicates over stdio. Claude Code connects to it via `.mcp.json`. After code changes, reload the MCP server with `/mcp` in Claude Code before using MCP tools.

## Linting

```bash
npm run lint           # ESLint (src/ + tests/)
```

ESLint config is in `eslint.config.js` (flat config). Key rules: `no-floating-promises` (src only), `no-unused-vars` (with `_` prefix exemption). JS files and `no-explicit-any` are excluded. CI runs lint as a separate job.

## Testing

```bash
npm test               # Run all layers: unit → integration → E2E
npm run test:unit      # Unit tests only (fast, no processes)
npm run test:integration  # Integration tests (spawns headless mocks)
npm run test:e2e       # E2E tests (spawns mock + MCP server)
npm run test:check     # Type-check test files (no emit)
```

Tests use `node:test` + `node:assert` (zero dependencies) and run via `tsx` from source.

### Test structure

```
tests/
  unit/
    parameter-resolution.test.ts   # Shared encoding round-trips
    model-registry.test.ts         # Model discovery + factory guards
    nord-electro-5d/               # Per-model handler + param map tests
    juno-x/
    prophet-6/
  integration/
    mock-runner.test.ts            # Headless mock spawn + WS state
  e2e/
    connect.test.ts                # MCP connect/disconnect
    set-parameters.test.ts         # MCP set params + verify
    get-state.test.ts              # MCP get state
    list-parameters.test.ts        # MCP list params
    multi-model.test.ts            # Regression: all models connect + basic tools
  helpers/
    mock-process.ts                # Headless mock child process helper
    test-harness.ts                # Full harness (mock + MCP client)
```

### Adding tests for a new keyboard model

1. Create `tests/unit/<model-name>/mock-handler.test.ts` — test state shape, CC routing, edge cases
2. Create `tests/unit/<model-name>/parameter-map.test.ts` — no duplicate CCs, labels, findParam
3. Add the model to `tests/unit/model-registry.test.ts` EXPECTED_MODELS array
4. Add the model to `tests/e2e/multi-model.test.ts` MODELS array

## Architecture

**Model-delegated design.** MCP tools are thin wrappers — keyboard devices own all business logic (parameter definitions, value encoding, state tracking, backup parsing, mock behavior).

```
Claude Code <-MCP/stdio-> MCP Server <-MIDI-> Keyboard (or Mock)
                              |
                     tools/ (thin delegates)
                              |
                     shared/model-holder -> KeyboardDevice
                              |
               keyboard_models/<mfr>/<model>/
```

### Core concepts

- **KeyboardModel** — A type of keyboard (e.g., "Nord Electro 5D"). One per model in the registry. Owns shared definitions (parameter map, system prompt template, backup parsing) and acts as a factory for device instances via `createDevice()`.
- **KeyboardDevice** — A specific physical unit or mock instance. Owns its MIDI connection, state, backup data, and all tool method implementations. Multiple devices of the same model can coexist.
- **MidiConnection** — Transport interface that devices code against. `MidiManager` implements it. Supports CC, SysEx, NRPN, and batch sends.
- **MockHandler** — Interface for mock device behavior. Owns ALL state and logic; the engine is just MIDI I/O + WebSocket relay.

### Core files (`src/shared/`)

- **`keyboard-model.ts`** — `KeyboardModel`, `KeyboardDevice`, `MockHandler` interfaces. Central contract.
- **`midi-connection.ts`** — `MidiConnection` interface (sendCC, sendSysEx, sendNRPN, onCC, onSysEx).
- **`tool-result.ts`** — `ToolResult` type returned by device methods.
- **`types.ts`** — `KeyboardParameter` with `ParamEncoding` (raw, drawbar, model-index, one-based, custom). Parameters are CC-addressed, 7-bit (0-127).
- **`model-registry.ts`** — Discovers models from `keyboard_models/` filesystem, auto-detects from MIDI port names or backup files.
- **`model-holder.ts`** — Holds the active device. Tools call `holder.requireDevice()` which throws a user-friendly error if no device is loaded.
- **`parameter-resolution.ts`** — Encodes/decodes between user values (labels, drawbar positions, indices) and MIDI 0-127.

### Tool pattern (`src/tools/`)

Every tool follows the same structure:
1. Export a `register*(server, midi, holder)` function
2. Guard with `holder.requireDevice()` / `midi.isConnected()` as needed
3. Delegate to `device.method()` — one line of business logic
4. Return the device's `ToolResult` directly

### Adding a keyboard model

Create `src/keyboard_models/<manufacturer>/<model>/` with:
- `index.ts` — default export implementing `KeyboardModel` with `createDevice()` and optionally `createMockHandler()`
- `device.ts` — class implementing `KeyboardDevice` (owns connection, state, all tool logic)
- `midi-map.ts` — `createParameterMap()` with CC definitions, encodings, labels
- `mock-handler.ts` — optional `MockHandler` implementation (owns all mock state and logic)
- Optionally: state-manager, backup-parser, backup-cache, `web/` UI directory

The model is auto-discovered by `model-registry.ts` scanning the filesystem.

### Mock Runner (`src/mock-runner/`)

Electron app: model picker shell -> loads model's web UI. The `MockEngine` is a thin shell (MIDI virtual port + WebSocket server + broadcast). All state and logic lives in the model's `MockHandler`, which receives raw MIDI messages via `onMIDI()` and returns state to broadcast.

### Agent mode (`src/agent.ts`)

HTTP server (port 3001) bridging a chat UI to Claude API. Spawns keyboards-mcp as a child MCP process. System prompt includes backup inventory and sound design guidelines.

## Key conventions

- All user-facing numbering must match the hardware display (1-based program/bank numbers, drawbar 0-8 positions)
- Parameter values are 7-bit (0-127), non-byte-aligned in backup payloads
- Piano and Sample Synth share model/sample selection across parts (hardware limitation)
- Sample inventory is 0-based but MIDI CC is 1-based (add 1 to index)
- When changing MIDI parameters, update mock handler alongside MCP code
- Save implementation plans to `docs/plans/` before starting work