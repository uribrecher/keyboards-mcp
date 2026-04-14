# keyboards-mcp

An MCP (Model Context Protocol) server for controlling MIDI keyboards. Supports pluggable keyboard models with auto-detection. Designed to be used with Claude Code or any MCP-compatible AI assistant.

Currently supported: **Nord Electro 5D**

## What it does

- **Connect** to a keyboard over USB MIDI (auto-detects the device model)
- **Read and change parameters** — piano type/model, organ drawbars, effects, EQ, reverb, delay, and more
- **Load programs** by bank and slot number
- **Load set list songs** by bank, slot, and part
- **Extract backup files** into a structured inventory of all sounds, programs, and set lists
- **Mock device** with a model-specific web UI for development and testing without hardware
- **Agentic mode** — an AI agent that can research songs and configure the keyboard to match

## Architecture

```
Claude Code  <──MCP──>  MCP Server  <──MIDI──>  Keyboard
                            │
                            ├── Model registry (auto-detects keyboard from MIDI ports)
                            ├── Parameter state tracking (per-model MIDI map)
                            ├── Backup parser (model-specific binary decoding)
                            └── Mock Runner (Electron app with model picker)
```

### Key directories

| Path | Description |
|------|-------------|
| `src/index.ts` | MCP server entry point |
| `src/tools/` | MCP tool implementations (connect, set_parameters, load_program, etc.) |
| `src/shared/` | Shared interfaces: KeyboardModel, ParameterMap, StateManager, MockHandler |
| `src/keyboard_models/` | Pluggable keyboard models (`<manufacturer>/<model>/`) |
| `src/midi/` | MIDI I/O manager (easymidi wrapper) |
| `src/mock-runner/` | Generic Electron mock device app with model picker |
| `src/agent.ts` | Agentic mode — AI-driven keyboard configuration |
| `docs/` | Generic documentation and implementation plans |

### Adding a new keyboard model

Create a directory under `src/keyboard_models/<manufacturer>/<model>/` with:

- `index.ts` — Default export implementing the `KeyboardModel` interface
- `midi-map.ts` — Parameter definitions with CC mappings
- `web/` — Optional mock device web UI (HTML/CSS/JS)

The model is auto-discovered at startup. See `src/keyboard_models/nord/electro_5d/` for a reference implementation.

## Setup

### Prerequisites

- Node.js 20+
- A supported keyboard connected via USB (or use the mock device)

### Install and build

```bash
npm install
npm run build
```

### Configure in Claude Code

Add to your MCP settings (`.claude/settings.json` or project-level):

```json
{
  "mcpServers": {
    "keyboards-mcp": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"]
    }
  }
}
```

## Usage

### MCP tools

Once connected via Claude Code, the following tools are available:

| Tool | Description |
|------|-------------|
| `list_midi_devices` | List available MIDI ports |
| `connect_to_keyboard` | Connect to the keyboard (auto-detects model) |
| `disconnect_from_keyboard` | Disconnect from the keyboard |
| `is_connected` | Check connection status |
| `get_current_state` | Get all current parameter values |
| `set_parameters` | Change one or more parameters |
| `load_program` | Switch to a program by bank/slot |
| `load_song` | Load a set list song by bank/slot/part |
| `list_parameters` | List all controllable parameters with ranges |
| `list_presets` | List built-in presets |
| `extract_backup` | Parse a backup file into a full inventory (no connection required) |
| `get_last_backup_location` | Get the path of the last extracted backup |
| `apply_patch` | Apply a named preset patch |

### Mock device

For development without hardware:

```bash
npm run mock:runner   # Electron app — model picker, then model-specific UI
```

On launch, the app shows a model picker. After selecting a keyboard model, the model's web UI loads with real-time parameter visualization — drawbars, knobs, LEDs, and all engine parameters update as MIDI messages arrive.

### Agent mode

An AI agent that can research a song and configure the keyboard to match:

```bash
npm run agent
```

Requires `ANTHROPIC_API_KEY` environment variable.

## License

Private project.
