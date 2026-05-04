# keyboards-mcp

An MCP (Model Context Protocol) server for controlling MIDI keyboards. Supports pluggable keyboard models with auto-detection. Designed to be used with any MCP-compatible AI agent or assistant.

Currently supported: **Nord Electro 5D**, **Roland JUNO-X**, **Prophet-6**

## What it does

- **Connect** to a keyboard over USB MIDI (auto-detects the device model)
- **Read and change parameters** — piano type/model, organ drawbars, effects, EQ, reverb, delay, and more
- **Load programs** by bank and slot number
- **Load set list songs** by bank, slot, and part
- **Browse inventory** — list programs and songs from extracted backups with name and bank filtering
- **Extract backup files** into a structured inventory of all sounds, programs, and set lists
- **Mock device** with a model-specific web UI for development and testing without hardware
## Architecture

**Model-delegated design.** MCP tools are thin wrappers — keyboard models own all business logic.

```
AI Agent  <──MCP──>  MCP Server  <──MIDI──>  Keyboard (or Mock)
                            │
                     tools/ (thin delegates)
                            │
                     DevicePool → KeyboardDevice (1..N)
                            │
               keyboard_models/<mfr>/<model>/
```

A **KeyboardModel** is a type of keyboard (e.g., "Nord Electro 5D"). It owns shared definitions (parameter map, system prompt, backup parsing) and acts as a factory for device instances.

A **KeyboardDevice** is a specific physical unit or mock instance. Each device has its own MIDI connection, state, and backup data. Multiple devices of the same model can coexist.

### Key directories

| Path | Description |
|------|-------------|
| `src/index.ts` | MCP server entry point |
| `src/tools/` | MCP tool registrations (thin wrappers that delegate to device methods) |
| `src/shared/` | Shared interfaces: KeyboardModel, KeyboardDevice, MidiConnection, MockHandler |
| `src/keyboard_models/` | Pluggable keyboard models (`<manufacturer>/<model>/`) |
| `src/midi/` | MIDI I/O manager (implements MidiConnection) |
| `src/mock-runner/` | Thin Electron mock engine — delegates all logic to model's MockHandler |
| `docs/plans/` | Implementation plans (numbered by execution order) |

### Adding a new keyboard model

Create a directory under `src/keyboard_models/<manufacturer>/<model>/` with:

- `index.ts` — Default export implementing the `KeyboardModel` interface
- `device.ts` — Class implementing `KeyboardDevice` (owns connection, state, all tool logic)
- `midi-map.ts` — Parameter definitions with CC mappings and/or SysEx addresses
- `mock-handler.ts` — Optional `MockHandler` implementation for the mock device
- `web/` — Optional mock device web UI (HTML/CSS/JS)

The model is auto-discovered at startup. See `src/keyboard_models/nord/electro_5d/` for a CC-based reference implementation, or `src/keyboard_models/roland/juno_x/` for a model using both CC and Roland DT1/RQ1 SysEx addressing.

## Setup

### Prerequisites

- Node.js 20+
- A supported keyboard connected via USB (or use the mock device)

### Install and build

```bash
npm install
npm run build
```

### Configure in your MCP client

Add to your MCP settings (e.g. `.claude/settings.json` for Claude Code):

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

Once connected, the following tools are available:

| Tool | Description |
|------|-------------|
| `list_midi_devices` | List available MIDI ports |
| `connect_to_keyboard` | Connect to the keyboard (auto-detects model) |
| `disconnect_from_keyboard` | Disconnect from the keyboard |
| `is_connected` | Check connection status |
| `set_parameters` | Change one or more parameters by name and value |
| `get_current_state` | Get all current parameter values |
| `list_parameters` | List all controllable parameters with ranges and labels |
| `list_programs` | Browse stored programs from backup inventory (filter by name or bank) |
| `list_songs` | Browse set list songs from backup inventory (filter by name or bank) |
| `load_program` | Switch to a program by bank/slot |
| `load_song` | Load a set list song by bank/slot/part |
| `extract_backup` | Parse a backup file into a full inventory (no connection required) |
| `get_last_backup_location` | Get the path of the last extracted backup |
| `get_system_prompt` | Get the keyboard's signal path, capabilities, and sound design guidelines |

### Mock device

For development without hardware, the **Mock Runner** is an Electron app that simulates one or more keyboards as a tabbed multi-device rack with model-specific web UIs, persistent rack setups, and a built-in chat console.

```bash
npm run mock:runner     # Electron app
npm run mock:headless   # Plain Node (--model <id> required) — for tests/CI
```

See [docs/mock_runner.md](docs/mock_runner.md) for the full UI tour — tabs, labels and per-instance backups, the File menu and `.mockrack` save format, backup extraction, and the chat console.

## License

Private project.