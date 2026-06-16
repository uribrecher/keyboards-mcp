# keyboards-mcp

An MCP (Model Context Protocol) server for controlling MIDI keyboards. Supports pluggable keyboard models with auto-detection. Designed to be used with any MCP-compatible AI agent or assistant.

Currently supported: **Nord Electro 5D**, **Roland JUNO-X**, **Prophet-6**

## What it does

- **Connect** to a keyboard over USB MIDI by port name and model id, with an optional mock-UI shadow port
- **Read and change parameters** — piano type/model, organ drawbars, effects, EQ, reverb, delay, and more
- **Load programs** by bank and slot number
- **Load set list songs** by bank, slot, and part
- **Browse inventory** — list programs and songs from extracted backups with name and bank filtering
- **Extract backup files** into a structured inventory of all sounds, programs, and set lists
- **Mock device** with a model-specific web UI for development and testing without hardware
- **Song Analysis workbench** — second view in the Sounds and Recreation app that imports audio, runs stem separation + structure analysis via the sibling `audio-analysis-mcp` service, and visualises live progress

## Architecture

**Model-delegated design.** MCP tools are thin wrappers — keyboard models own all business logic.

```
AI Agent  <──MCP──>  MCP Server  <──MIDI──>  Keyboard (or Mock)
                          │
                          ├──HTTP/UDS──> MCB (midi-connections-broker)
                          │              claims port leases so concurrent
                          │              agent sessions don't collide
                          │
                     tools/ (thin delegates)
                          │
                     DevicePool → KeyboardDevice (1..N)
                          │
               keyboard_models/<mfr>/<model>/
```

A **KeyboardModel** is a type of keyboard (e.g., "Nord Electro 5D"). It owns shared definitions (parameter map, system prompt, backup parsing) and acts as a factory for device instances.

A **KeyboardDevice** is a specific physical unit or mock instance. Each device has its own MIDI connection, state, and backup data. Multiple devices of the same model can coexist.

The **midi-connections-broker (MCB)** is a separate long-running process that owns MIDI port leases. The MCP server claims a lease via MCB on `connect_to_keyboard` and releases it on `disconnect_from_keyboard`, so multiple agent sessions can share a host without stepping on each other's ports. MCB also exposes the canonical port list and reaps leases held by dead processes.

### Repository layout

This repo is an **npm-workspaces monorepo** with two packages: the published `keyboards-mcp` npm
package (MCP server + shared model logic; stays on the `2.0.x` line) and the private **Sounds and
Recreation** Electron desktop app (`0.1.x`), which depends on `keyboards-mcp` (`^2`) and imports its
shared logic **by package name** (`keyboards-mcp/shared/*`).

| Path | Description |
|------|-------------|
| `packages/keyboards-mcp/src/index.ts` | MCP server entry point |
| `packages/keyboards-mcp/src/tools/` | MCP tool registrations (thin wrappers that delegate to device methods) |
| `packages/keyboards-mcp/src/shared/` | Shared interfaces: KeyboardModel, KeyboardDevice, MidiConnection, MockHandler, mcb-client |
| `packages/keyboards-mcp/src/keyboard_models/` | Pluggable keyboard models (`<manufacturer>/<model>/`) |
| `packages/keyboards-mcp/src/midi/` | MIDI I/O manager (implements MidiConnection) |
| `packages/keyboards-mcp/src/mcb/` | midi-connections-broker — lease registry, session manager, HTTP-over-UDS API |
| `packages/sounds-and-recreation-app/src/transport.ts` | Thin Electron mock engine — virtual MIDI In/Out + WS, source-aware routing; delegates all model logic to `MockHandler` (see [docs/sounds-and-recreation.md](docs/sounds-and-recreation.md#transport-codec-handler--runtime-contract)) |
| `packages/sounds-and-recreation-app/src/audio-analysis-client/` | TypeScript HTTP+SSE client for the sibling `audio-analysis-mcp` service. Consumed by the app's [Song Analysis](docs/sounds-and-recreation.md#song-analysis) view |
| `docs/plans/` | Implementation plans, at the repo root (numbered by execution order) |

### Adding a new keyboard model

Create a directory under `packages/keyboards-mcp/src/keyboard_models/<manufacturer>/<model>/` with:

- `index.ts` — Default export implementing the `KeyboardModel` interface
- `device.ts` — Class implementing `KeyboardDevice` (owns connection, state, all tool logic)
- `midi-map.ts` — Parameter definitions with CC mappings and/or SysEx addresses
- `mock-handler.ts` — Optional `MockHandler` implementation for the mock device
- `web/` — Optional mock device web UI (HTML/CSS/JS)

The model is auto-discovered at startup. See `packages/keyboards-mcp/src/keyboard_models/nord/electro_5d/` for a CC-based reference implementation, or `packages/keyboards-mcp/src/keyboard_models/roland/juno_x/` for a model using both CC and Roland DT1/RQ1 SysEx addressing.

## Quick Start (macOS)

**Prerequisites:** macOS, Node.js 20+, and a supported keyboard connected via USB.

```bash
npm install -g keyboards-mcp     # 1. install
keyboards-mcp install            # 2. install + start the broker daemon (launchd)
```

Then add this to your MCP client config (e.g. `.mcp.json` / Claude Code settings) and restart the client:

```json
{
  "mcpServers": {
    "keyboards-mcp": {
      "command": "keyboards-mcp"
    }
  }
}
```

That's it. The **midi-connections-broker (MCB)** is now a launchd daemon that starts at login and is
kept alive automatically — you never run it by hand. Ask your agent to `connect_to_keyboard`.

- Check broker status anytime: `keyboards-mcp doctor` (logs at `~/.mcb/mcb.log`).
- Remove the daemon: `keyboards-mcp uninstall`.

> The no-hardware **Sounds and Recreation** desktop app (a visual device simulator) is packaged
> separately — see [Standalone app build (no hardware)](#standalone-app-build-no-hardware). This npm
> package targets owners of real MIDI hardware.

## Development (from source)

Install once at the repo root (npm wires up both workspaces), then build. Package scripts run
with `-w <package>` from the root, or via the root delegator scripts that mirror the
already-updated root [`CLAUDE.md`](CLAUDE.md).

```bash
npm install                                          # root install — both workspaces
npm run build                                        # root delegator: builds keyboards-mcp, then the app
# or build a single workspace:
npm run build -w keyboards-mcp                        # → packages/keyboards-mcp/dist/

node packages/keyboards-mcp/dist/cli/index.js install # run the BUILT entry so the daemon is node-runnable
                                                      # (or: keyboards-mcp install after a global link)
```

`keyboards-mcp broker` runs the broker in the foreground (the daemon's entry point), or
`npm run mcb -w keyboards-mcp` from source. The headless mock and the Electron Sounds and
Recreation app live in the app workspace — `npm run sar:headless -w sounds-and-recreation-app` /
`npm run sar -w sounds-and-recreation-app`.

## Releasing

The two packages version and publish independently via
**[Changesets](https://github.com/changesets/changesets)** — there are no manual `vX.Y.Z`
version tags. The public `keyboards-mcp` package goes to npm; the private
`sounds-and-recreation-app` only ever versions + writes its changelog (Changesets never publishes
private packages).

**On every PR that changes a package's source,** ship a changeset describing which package(s)
bumped and how:

```bash
npm run changeset        # interactive: pick package(s) + bump type, writes .changeset/*.md
```

CI enforces this — the `changeset` job runs `changeset status --since=origin/main` and fails a PR
that touches package source without one. For an intentional no-release change to package source,
record an empty changeset with `npx changeset --empty`. (README-only changes don't require one.)

**The release itself is automated** by `.github/workflows/release.yml` on every push to `main`:

1. While unconsumed changesets exist, [changesets/action](https://github.com/changesets/action)
   opens/updates a **"Version Packages"** PR that applies the bumps (`changeset version`) and
   writes each package's `CHANGELOG.md`. Nothing is published at this stage.
2. Merging that PR consumes the changesets. The workflow runs again, finds none left, and runs
   `changeset publish` — publishing **only** the public `keyboards-mcp` package.

The root scripts mirror the workflow for local use: `npm run changeset` →
`npm run changeset:version` → `npm run changeset:publish`.

Publishing uses npm **OIDC Trusted Publishing** — no stored `NPM_TOKEN` (npm write tokens expire
after 90 days); OIDC mints a short-lived per-run credential and attests build provenance
automatically. Trusted publishing is configured **per package** on npmjs.com against the
`release.yml` workflow filename, and requires **npm ≥ 11.5.1** and **Node ≥ 22.14.0** (the workflow
upgrades npm and runs on Node 22 to satisfy this).

## Usage

### MCP tools

Once connected, the following tools are available:

| Tool | Description |
|------|-------------|
| `list_midi_devices` | List available MIDI ports |
| `connect_to_keyboard` | Claim an MCB lease and connect to the keyboard (`port` + `model` required, optional `with_shadow` mock label) |
| `disconnect_from_keyboard` | Disconnect from the keyboard |
| `is_connected` | Check connection status |
| `set_parameters` | Change one or more parameters by name and value |
| `get_current_state` | Read current parameter values from the device. Per-model: Nord and Prophet-6 return "not supported" (one-way MIDI); JUNO-X uses Roland RQ1 to query the device live for scene-effect sections (chorus/delay/reverb/drive). |
| `list_parameters` | List all controllable parameters with ranges and labels |
| `list_programs` | Browse stored programs from backup inventory (filter by name or bank) |
| `list_songs` | Browse set list songs from backup inventory (filter by name or bank) |
| `load_program` | Switch to a program by bank/slot |
| `load_song` | Load a set list song by bank/slot/part |
| `extract_backup` | Parse a backup file into a full inventory (no connection required) |
| `get_last_backup_location` | Get the path of the last extracted backup |
| `get_system_prompt` | Get the keyboard's signal path, capabilities, and sound design guidelines |

### Mock device

For development without hardware, **Sounds and Recreation** is an Electron app that simulates one or more keyboards as a tabbed multi-device rack with model-specific web UIs, persistent rack setups, and a built-in chat console. The rail's **WAVE** button swaps in a second view — **Song Analysis** — that drives the sibling `audio-analysis-mcp` service for audio import, stem separation, and structure analysis.

The app is the `sounds-and-recreation-app` workspace, so run its scripts with
`-w sounds-and-recreation-app` from the repo root:

```bash
npm run sar -w sounds-and-recreation-app             # Electron app
npm run sar:headless -w sounds-and-recreation-app    # Plain Node (--model <id> required) — for tests/CI
```

The Song Analysis view needs the audio-analysis service running separately:

```bash
cd ../audio-analysis-mcp
uv run python -m audio_analysis_mcp.service
```

See [docs/sounds-and-recreation.md](docs/sounds-and-recreation.md) for the full UI tour — tabs, labels and per-instance backups, the File menu and `.mockrack` save format, backup extraction, [Song Analysis](docs/sounds-and-recreation.md#song-analysis), and the chat console.

### Standalone app build (no hardware)

Build the desktop app bundle (UI facade + in-process mock keyboards):

```bash
npm run sar:dist -w sounds-and-recreation-app    # → dist-app/mac*/Sounds and Recreation.app (unsigned)
```

Launch the `.app` and pick a model to drive a mock keyboard with no hardware. The
CHAT and Song Analysis panels light up only when the agent / audio-analysis
services are running. Signed `.dmg`/`.pkg` installers are produced separately by
the `macos-packager` repo.

## License

Licensed under the GNU General Public License v3.0 (GPL-3.0-or-later). See [LICENSE](LICENSE).