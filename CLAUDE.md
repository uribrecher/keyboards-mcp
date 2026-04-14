# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm run build          # tsc → dist/
npm run start          # MCP server (stdio transport)
npm run dev            # MCP server via tsx (no build step)
npm run mock:runner    # Electron mock device with model picker UI
```

The MCP server communicates over stdio. Claude Code connects to it via `.mcp.json`. After code changes, reload the MCP server with `/mcp` in Claude Code before using MCP tools.

## Architecture

**Model-delegated design.** MCP tools are thin wrappers — keyboard models own all business logic (parameter definitions, value encoding, state tracking, backup parsing, mock behavior).

```
Claude Code ←MCP/stdio→ MCP Server ←MIDI CC→ Keyboard (or Mock)
                              │
                     tools/ (thin delegates)
                              │
                     shared/model-holder → KeyboardModel
                              │
               keyboard_models/<mfr>/<model>/
```

### Core abstractions (`src/shared/`)

- **`keyboard-model.ts`** — `KeyboardModel` interface: every model exports a default object implementing this. Capabilities are optional (backup, programLoader, songLoader, mockHandler).
- **`types.ts`** — `KeyboardParameter` with `ParamEncoding` (raw, drawbar, model-index, one-based, custom). Parameters are CC-addressed, 7-bit (0-127).
- **`model-registry.ts`** — Discovers models from `keyboard_models/` filesystem, auto-detects from MIDI port names or backup files.
- **`model-holder.ts`** — Holds the active model + state manager. Tools call `holder.requireModel()` which throws a user-friendly error if no model is loaded.
- **`parameter-resolution.ts`** — Encodes/decodes between user values (labels, drawbar positions, indices) and MIDI 0-127.

### Tool pattern (`src/tools/`)

Every tool follows the same structure:
1. Export a `register*(server, midi, holder)` function
2. Guard with `holder.requireModel()` / `midi.isConnected()` as needed
3. Delegate to model methods (parameterMap, programLoader, etc.)
4. Return text content for the MCP response

### Adding a keyboard model

Create `src/keyboard_models/<manufacturer>/<model>/` with:
- `index.ts` — default export implementing `KeyboardModel`
- `midi-map.ts` — `createParameterMap()` with CC definitions, encodings, labels
- Optionally: state-manager, presets, backup-parser, mock-handler, `web/` UI directory

The model is auto-discovered by `model-registry.ts` scanning the filesystem.

### Mock Runner (`src/mock-runner/`)

Electron app: model picker shell → loads model's web UI in iframe. `MockEngine` creates a virtual MIDI port, listens for CC/Program Change, maintains channel state, broadcasts JSON via WebSocket (port 3000). Models provide a `MockHandler` for custom behavior (organ presets, backup-cached program names, etc.).

### Agent mode (`src/agent.ts`)

HTTP server (port 3001) bridging a chat UI to Claude API. Spawns keyboards-mcp as a child MCP process. System prompt includes backup inventory and sound design guidelines.

## Key conventions

- All user-facing numbering must match the hardware display (1-based program/bank numbers, drawbar 0-8 positions)
- Parameter values are 7-bit (0-127), non-byte-aligned in backup payloads
- Piano and Sample Synth share model/sample selection across parts (hardware limitation)
- Sample inventory is 0-based but MIDI CC is 1-based (add 1 to index)
- When changing MIDI parameters, update mock handler alongside MCP code
- Save implementation plans to `docs/plans/` before starting work
