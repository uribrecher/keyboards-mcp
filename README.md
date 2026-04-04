# keyboards-mcp

An MCP (Model Context Protocol) server for controlling a **Nord Electro 5D** keyboard via USB MIDI. Designed to be used with Claude Code or any MCP-compatible AI assistant.

## What it does

- **Connect** to the Nord Electro 5D over USB MIDI (auto-detects the device)
- **Read and change parameters** — piano type/model, organ drawbars, effects, EQ, reverb, delay, and more
- **Load programs** by bank and slot number
- **Extract backup files** (`.ne5b`) into a structured inventory of all pianos, samples, programs, and set lists
- **Mock device** with a web UI for development and testing without hardware
- **Agentic mode** — an AI agent that can research songs and configure the keyboard to match

## Architecture

```
Claude Code  <──MCP──>  MCP Server  <──MIDI──>  Nord Electro 5D
                            │
                            ├── Parameter state tracking (listens to MIDI input)
                            ├── Backup parser (binary .ne5b / .ne5p decoding)
                            └── Mock device + Web UI (localhost:3000)
```

### Key directories

| Path | Description |
|------|-------------|
| `src/index.ts` | MCP server entry point |
| `src/tools/` | MCP tool implementations (connect, set_parameters, load_program, etc.) |
| `src/nord/` | Nord-specific logic: MIDI CC map, backup parser, parameter state |
| `src/midi/` | MIDI I/O manager (easymidi wrapper) |
| `src/web/` | Mock device web UI (HTML/CSS/JS) |
| `src/electron/` | Electron app wrapper — native file dialogs, same UI |
| `src/mock-device.ts` | Virtual Nord device for offline development |
| `src/agent.ts` | Agentic mode — AI-driven keyboard configuration |
| `diff-programs.ts` | CLI tool for binary-diffing two `.ne5p` program files |
| `docs/` | Hardware documentation (bit layout, MIDI CC reference) |

## Setup

### Prerequisites

- Node.js 20+
- A Nord Electro 5D connected via USB (or use the mock device)

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
    "nord-electro-5d": {
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
| `connect_to_nord` | Connect to the keyboard (auto-detects) |
| `is_connected` | Check connection status |
| `get_current_state` | Get all current parameter values |
| `set_parameters` | Change one or more parameters |
| `load_program` | Switch to a program by bank/slot |
| `list_parameters` | List all controllable parameters with ranges |
| `list_presets` | List factory and user presets |
| `extract_backup` | Parse a `.ne5b` backup into a full inventory |
| `apply_patch` | Apply a named preset patch |

### Mock device

For development without hardware:

```bash
npm run mock            # Plain Node.js — opens web UI at http://localhost:3000
npm run mock:electron   # Electron app — native file dialogs, same UI
```

Shows the virtual keyboard state — drawbars, knobs, LEDs, and all engine parameters update in real time. The Electron version adds native file/folder dialogs for backup re-extraction.

### Diff tool

Compare two `.ne5p` program files to find bit-level differences:

```bash
npx tsx diff-programs.ts before.ne5p after.ne5p
```

Useful for reverse-engineering undocumented program parameters.

### Agent mode

An AI agent that can research a song and configure the keyboard to match:

```bash
npm run agent
```

## Hardware documentation

The Nord Electro 5D uses a 137-byte bit-packed program payload. Documented fields include:

- **Part/Split** — engine selection, split mode/point
- **Piano** — type, model, variation, acoustic mode, kbd touch, mono
- **Organ** — model, drawbars (per organ model), vibrato, percussion
- **Sample Synth** — slot, attack, decay/release, dynamics, filter velocity
- **Effects** — FX1, FX2, delay, EQ, amp/speaker, reverb

See [`docs/program-bit-layout.md`](docs/program-bit-layout.md) for the full bit map.

## License

Private project.