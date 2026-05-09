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
npm test                  # Run all layers: unit → integration → E2E (mcb + external)
npm run test:unit         # Unit tests only (fast, no processes)
npm run test:integration  # Integration tests (spawns headless mocks)
npm run test:e2e:mcb      # E2E tests that spin up their own MCB on a tmpdir socket
npm run test:e2e          # E2E tests that REQUIRE an external MCB at MCB_SOCKET
                          #   start one in another terminal: `npm run mcb`
npm run test:coverage     # All tests under V8 coverage; writes coverage.lcov + console summary
                          #   same external-MCB precondition as test:e2e
npm run test:check        # Type-check test files (no emit)
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
  e2e/                             # Top-level files require an external MCB (npm run mcb)
    connect.test.ts                # MCP connect/disconnect
    set-parameters.test.ts         # MCP set params + verify
    get-state.test.ts              # MCP get state
    list-parameters.test.ts        # MCP list params
    multi-model.test.ts            # Regression: all models connect + basic tools
    mcb/                           # Self-provisioning: each suite spawns its own MCB
      multi-device.test.ts         # Two-device pool isolation
      three-concurrent.test.ts     # Plan #6 — three concurrent mocks
      backup-per-instance.test.ts
      get-health.test.ts
      heartbeat.test.ts
      label-discovery.test.ts
      session-loss.test.ts
  helpers/
    mock-process.ts                # Headless mock child process helper
    test-harness.ts                # Full harness (mock + MCP client) — does NOT spawn MCB
    multi-device-harness.ts        # Multi-device harness — spawns its own MCB on a tmpdir socket
```

### Adding tests for a new keyboard model

1. Create `tests/unit/<model-name>/mock-handler.test.ts` — test state shape, CC routing, edge cases
2. Create `tests/unit/<model-name>/parameter-map.test.ts` — no duplicate CCs, labels, findParam
3. Add the model to `tests/unit/model-registry.test.ts` EXPECTED_MODELS array
4. Add the model to `tests/e2e/multi-model.test.ts` MODELS array

## Architecture

**Model-delegated design.** MCP tools are thin wrappers — keyboard devices own all business logic (parameter definitions, value encoding, backup parsing, mock behavior).

**The MCP is stateless on parameter values.** The MCP does not shadow what it has sent — there is no per-device key→value cache that persists between tool calls. The agent owns the memory of what it set; the device (real or mock) owns the ground truth. `get_current_state` is per-model: Nord and Prophet-6 cannot satisfy it (one-way MIDI) and return a "not supported" tool result; JUNO-X uses Roland RQ1 to query the device live and returns actual device values for scene-effect sections (`scene-chorus`, `scene-delay`, `scene-reverb`, `scene-drive`). See `docs/plans/completed/21-juno-x-rq1-get-state.md`, `22-mcp-sysex-receive.md`, and `23-juno-x-get-state-rq1.md` for the layered implementation across mock RQ1 protocol, MCP-side receive, and the live query.

```
Claude Code <-MCP/stdio-> MCP Server <-MIDI-> Keyboard (or Mock)
                              |
                     tools/ (thin delegates)
                              |
                     shared/device-pool -> KeyboardDevice (1..N)
                              |
               keyboard_models/<mfr>/<model>/
```

### Core concepts

- **KeyboardModel** — A type of keyboard (e.g., "Nord Electro 5D"). One per model in the registry. Owns shared definitions (parameter map, system prompt template, backup parsing) and acts as a factory for device instances via `createDevice()`.
- **KeyboardDevice** — A specific physical unit or mock instance. Owns its MIDI connection, backup data, and all tool method implementations. Multiple devices of the same model can coexist. The device does not cache parameter values it has sent — the MCP is stateless on parameter values (see Architecture).
- **MidiConnection** — Transport interface that devices code against. `MidiManager` implements it. Supports CC, SysEx, NRPN, and batch sends.
- **MockHandler** — Interface for mock device behavior. Owns ALL state and logic; the engine is just MIDI I/O + WebSocket relay.

### Core files (`src/shared/`)

- **`keyboard-model.ts`** — `KeyboardModel`, `KeyboardDevice`, `MockHandler` interfaces. Central contract.
- **`midi-connection.ts`** — `MidiConnection` interface (sendCC, sendSysEx, sendNRPN, onCC, onSysEx).
- **`tool-result.ts`** — `ToolResult` type returned by device methods.
- **`types.ts`** — `KeyboardParameter` with `ParamEncoding` (raw, drawbar, model-index, one-based, custom). Parameters are CC-addressed, 7-bit (0-127).
- **`model-registry.ts`** — Discovers models from `keyboard_models/` filesystem, auto-detects from MIDI port names or backup files.
- **`device-pool.ts`** — Indexed pool of connected `KeyboardDevice` instances. Tools call `pool.resolve(device?)` — explicit 1-based index or auto-resolve when only one device is connected; throws a user-friendly ambiguity error otherwise.
- **`parameter-resolution.ts`** — Encodes/decodes between user values (labels, drawbar positions, indices) and MIDI 0-127.

### Tool pattern (`src/tools/`)

Every tool follows the same structure:
1. Export a `register*(server, pool)` function
2. Resolve target via `pool.resolve(device?)` — accepts optional 1-based `device` arg, auto-picks when one device is connected
3. Delegate to `device.method()` — one line of business logic
4. Return the device's `ToolResult` directly

### Adding a keyboard model

Create `src/keyboard_models/<manufacturer>/<model>/` with:
- `index.ts` — default export implementing `KeyboardModel` with `createDevice()` and optionally `createMockHandler()`
- `device.ts` — class implementing `KeyboardDevice` (owns connection and all tool logic)
- `midi-map.ts` — `createParameterMap()` with CC definitions, encodings, labels
- `mock-handler.ts` — optional `MockHandler` implementation (owns all mock state and logic — the mock IS the source of truth)
- Optionally: backup-parser, backup-cache, `web/` UI directory

The model is auto-discovered by `model-registry.ts` scanning the filesystem.

### Mock Runner (`src/mock-runner/`)

Electron app: model picker shell -> loads model's web UI. The `MockEngine` is a thin shell (MIDI virtual port + WebSocket server + broadcast). All state and logic lives in the model's `MockHandler`, which receives raw MIDI messages via `onMIDI()` and returns state to broadcast.

## Key conventions

- All user-facing numbering must match the hardware display (1-based program/bank numbers, drawbar 0-8 positions)
- Parameter values are 7-bit (0-127), non-byte-aligned in backup payloads
- Piano and Sample Synth share model/sample selection across parts (hardware limitation)
- Sample inventory is 0-based but MIDI CC is 1-based (add 1 to index)
- When changing MIDI parameters, update mock handler alongside MCP code
- Save implementation plans to `docs/plans/` before starting work
- Sibling repos in the same parent directory: `sound-recreation-agent`, `audio-analysis-mcp`, `macos-packager`