# Multi-Repo Split Design

> Split the keyboards-mcp monolith into four independent repositories: the existing MCP server, a new TypeScript agent, a new Python audio analysis MCP server, and a macOS packager that ships them as a single installable app.

## Background

The keyboards-mcp repo currently contains both the MCP server (keyboard control) and a standalone HTTP agent (`src/agent.ts`). A planned audio analysis MCP server (plan 7) will be written in Python. Rather than growing the monolith, we split into focused repos that communicate over the MCP protocol, with a dedicated packager repo that bundles everything into a single macOS installer.

## Workspace Layout

All four repos live as siblings under a shared parent folder:

```
~/test/sounds-and-recreation/
  keyboards-mcp/              # Existing repo (moved here from ~/test/)
  sound-recreation-agent/     # New TypeScript repo
  audio-analysis-mcp/         # New Python repo
  macos-packager/             # New build/packaging repo
```

This makes sibling discovery trivial (`../keyboards-mcp`, `../audio-analysis-mcp`) and keeps the development workflow clean. Each folder is an independent git repo.

## Architecture

The mock runner (Electron app) is the user-facing launcher. It starts everything else:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    keyboards-mcp mock runner                         │
│                        (Electron app)                                │
│                                                                      │
│  ┌──────────────┐  ┌────────────────┐  ┌─────────────────────────┐  │
│  │ Model Picker  │  │ Virtual MIDI   │  │ Chat Tab                │  │
│  │ UI            │  │ Device + WS    │  │ (HTTP client to agent)  │  │
│  └──────────────┘  └────────────────┘  └────────┬────────────────┘  │
│                                                  │                   │
│  On startup: spawns agent as child process       │                   │
│  passing --keyboards-mcp <own-path>/dist/index.js│                   │
└──────────────────────────────────────────────────┼───────────────────┘
                                                   │
                                          HTTP (localhost:3001)
                                                   │
┌──────────────────────────────────────────────────▼───────────────────┐
│                    sound-recreation-agent                              │
│                 (TypeScript / Vercel AI SDK)                           │
│                                                                       │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────────────────────────┐ │
│  │ Vercel   │  │ Conversation │  │ System Prompt                    │ │
│  │ AI       │  │ History      │  │ (recreate-sound skill +          │ │
│  │ Gateway  │  │ Manager      │  │  keyboard inventory)             │ │
│  └────┬─────┘  └──────────────┘  └─────────────────────────────────┘ │
│       │                                                               │
│       ▼                                                               │
│  streamText({ tools: [...keyboards, ...audio], ... })                 │
│       │                              │                                │
│  ┌────┴──── stdio ────┐      ┌──────┴──── stdio ─────┐              │
│  │ MCP Client #1      │      │ MCP Client #2          │              │
└──┤ (long-lived)       ├──────┤ (long-lived)           ├──────────────┘
   └────────┬───────────┘      └──────────┬─────────────┘
            │                             │
   ┌────────▼───────────┐      ┌──────────▼─────────────┐
   │  keyboards-mcp     │      │  audio-analysis-mcp    │
   │  (Node subprocess) │      │  (Python subprocess)   │
   │                    │      │                        │
   │  14 tools:         │      │  8 tools:              │
   │  set_parameters    │      │  fetch_audio           │
   │  load_program      │      │  stem_separate         │
   │  get_state         │      │  spectrum_analyze      │
   │  list_parameters   │      │  audio_compare         │
   │  connect_keyboard  │      │  audio_render          │
   │  extract_backup    │      │  inverse_synth         │
   │  get_system_prompt │      │  train_model           │
   │  ...               │      │  list_models           │
   └────────────────────┘      └────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│                     macos-packager                                     │
│              (build scripts + packaging config)                        │
│                                                                       │
│  Pulls all 3 repos → builds each → bundles into .pkg/.dmg             │
│  Installs to fixed paths → all components find each other              │
└───────────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- Four fully independent repos (no monorepo, no submodules)
- Components communicate over MCP protocol (stdio) and HTTP — never via shared imports
- Mock runner is the user-facing launcher: spawns the agent, hosts the chat tab (HTTP client)
- Agent spawns both MCP servers as long-lived child processes
- Chat UI in mock runner talks to agent over HTTP — agent is NOT embedded in Electron
- macOS packager bundles everything into a single .pkg/.dmg with fixed install paths, eliminating runtime path discovery
- MCP client uses official `@modelcontextprotocol/sdk` (stable `StdioClientTransport`, not Vercel's experimental wrapper)
- LLM calls go through Vercel AI Gateway

## Repo 1: `sound-recreation-agent` (new)

TypeScript agent built fresh on Vercel AI SDK. Does not migrate the existing `agent.ts` — starts clean with the redesigned architecture.

### Structure

```
sound-recreation-agent/
  src/
    index.ts                 # Entry point — HTTP server (port 3001)
    agent.ts                 # Core: streamText() with merged tools, conversation history
    mcp-manager.ts           # Long-lived MCP client lifecycle (connect, cache tools, shutdown)
    mcp-tool-adapter.ts      # MCP tools → AI SDK tool format (utility function)
    conversation.ts          # Conversation history manager (append, trim, serialize)
    system-prompt.ts         # Assembles system prompt (skill + inventory + model context)
    config.ts                # Agent config (MCP paths, LLM provider, model, port)

  prompts/
    recreate-sound.md        # Moved from keyboards-mcp/docs/recreate-sound.md

  tests/
    unit/
      mcp-tool-adapter.test.ts   # Tool mapping round-trip (placeholder initially)
      conversation.test.ts       # History management (placeholder)
    e2e/
      agent-startup.test.ts      # Agent connects to keyboards-mcp (placeholder)

  .github/workflows/ci.yml
  eslint.config.js           # Flat config, typescript-eslint (same style as keyboards-mcp)
  package.json
  tsconfig.json
  .env.example
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `ai` | Vercel AI SDK core (`streamText`, `tool`, `jsonSchema`) |
| `@ai-sdk/gateway` | Vercel AI Gateway (LLM provider — needs API surface verification) |
| `@modelcontextprotocol/sdk` | Official MCP client + `StdioClientTransport` |

### MCP Client Lifecycle

```
Agent startup:
  1. Read config (env vars / CLI flags / sibling detection)
  2. Connect to keyboards-mcp via StdioClientTransport (if path configured)
  3. Connect to audio-analysis-mcp via StdioClientTransport (if path configured)
     - Use Promise.allSettled — partial failures don't block the other server
  4. Fetch and cache tool definitions from each connected server
  5. Merge tools into a single AI SDK tool set
  6. Fetch system prompt context (get_system_prompt from keyboards-mcp)
  7. Start HTTP server on configured port

Per message:
  1. Append user message to conversation history
  2. Call streamText() with merged tools, conversation history, system prompt
  3. Stream response to client
  4. Append assistant response + tool results to history
  5. Trim history if over token budget

Agent shutdown:
  1. Close all MCP transports (kills child processes)
  2. Close HTTP server
```

### LLM Provider

Vercel AI Gateway with the user's existing API key. Model ID configured via env var (default: `anthropic/claude-sonnet-4-20250514`). Provider swap is a config change, no code change.

**Note:** The `@ai-sdk/gateway` package was flagged as "needs verification" in the agent-redesign research doc. This must be verified against actual npm registry and Vercel docs before implementation. If it doesn't exist, fall back to direct `@ai-sdk/anthropic` provider.

## Repo 2: `audio-analysis-mcp` (new)

Pure Python MCP server, as specified in plan 7. Launched via `python -m audio_analysis_mcp`.

### Structure

```
audio-analysis-mcp/
  src/audio_analysis_mcp/
    __init__.py
    __main__.py              # Entry: python -m audio_analysis_mcp
    server.py                # MCP server (stdio_server transport)
    tools/
      fetch_audio.py         # YouTube/file download via yt-dlp
      stem_separate.py       # Demucs 4-way split
      spectrum_analyze.py    # Spectral features, harmonic profile, synth hints
      audio_compare.py       # A/B spectral diff
      audio_render.py        # System audio capture (sounddevice)
      inverse_synth.py       # ML parameter prediction
      train_model.py         # Dataset generation + model training
      list_models.py         # Trained model inventory
    models/
      architecture.py        # ResNet-18 backbone + per-param MLP heads
      dataset.py             # Synthetic training data generation
      synth_renderers/       # Per-synthesis-type audio renderers

  models/                    # Trained model weights (gitignored)
  data/                      # Audio cache, stems, datasets (gitignored)

  tests/
    unit/
      test_server.py         # MCP server starts (placeholder)
    integration/
      test_fetch_audio.py    # (placeholder)

  .github/workflows/ci.yml
  pyproject.toml             # Dependencies: torch, demucs, librosa, mcp, yt-dlp, sounddevice
  .python-version
```

### CI

```yaml
Jobs:
  lint:     mypy (strict mode)
  test:     pytest
```

## Repo 3: `keyboards-mcp` (existing — changes)

Sheds agent responsibilities, becomes a pure MCP server + mock device simulator.

### Removed

- `src/agent.ts` — replaced by `sound-recreation-agent` (delete once agent repo can connect to keyboards-mcp and stream a response)
- `docs/recreate-sound.md` — moved to agent repo's `prompts/`
- `docs/plans/pending/agent-redesign-research.md` — agent design lives in agent repo
- `openai` npm dependency

### Mock Runner: Agent Integration

The mock runner (Electron app) gains the ability to launch and connect to the agent:

**Launch flow:**
1. On startup, check stored config for agent binary path
2. If configured: spawn agent as child process, passing `--keyboards-mcp <own-repo-path>/dist/index.js` as a CLI flag (mock runner knows its own install location)
3. If not configured or path invalid: show modal dialog — "Sound Recreation Agent not found. Browse to select the agent directory, or skip to use mock runner without chat."
4. Store selected path in Electron user config for future launches
5. Audio-analysis-mcp path: agent handles this separately (its own config/env)

**Chat tab:**
- Pure HTTP/WebSocket client connecting to agent at `localhost:3001`
- No code dependency on agent repo — runtime connection only
- If agent is unavailable, chat tab shows "Agent not connected" state

## Repo 4: `macos-packager` (new)

Build scripts and packaging config that pulls all three component repos, builds each, and bundles them into a single macOS `.pkg` or `.dmg` installer. The installer places components at fixed paths, eliminating all runtime path discovery.

### Install Layout

```
/Applications/Sound Recreation.app/          # Electron mock runner (launcher)
  Contents/
    MacOS/Sound Recreation                    # Electron binary
    Resources/
      keyboards-mcp/                          # Built Node MCP server (dist/)
      sound-recreation-agent/                 # Built Node agent (dist/)
      audio-analysis-mcp/                     # Python venv + source
```

All paths are relative to the app bundle. The mock runner knows exactly where the agent is (`../Resources/sound-recreation-agent/`). The agent knows where both MCP servers are (`../keyboards-mcp/`, `../audio-analysis-mcp/`). No env vars, no sibling detection, no setup dialogs needed when running from the installed app.

### Structure

```
macos-packager/
  scripts/
    build-all.sh             # Clone/pull + build each component repo
    package.sh               # Create .pkg or .dmg from built artifacts
    sign-and-notarize.sh     # macOS code signing + notarization
  config/
    entitlements.plist       # App sandbox entitlements (MIDI, network, audio)
    Info.plist               # App metadata
  .github/workflows/
    release.yml              # Triggered by tag — builds + packages + uploads artifact
  README.md
```

### Build Pipeline

```
1. Clone/pull keyboards-mcp, sound-recreation-agent, audio-analysis-mcp
2. Build keyboards-mcp:           npm ci && npm run build
3. Build sound-recreation-agent:  npm ci && npm run build
4. Build audio-analysis-mcp:      uv sync (creates .venv with all deps)
5. Build mock runner:             npm ci && npm run build:electron (in keyboards-mcp)
6. Assemble:                      Copy built artifacts into .app bundle at fixed paths
7. Sign + notarize:               codesign + xcrun notarytool
8. Package:                       Create .dmg or .pkg
```

### Entitlements

The app needs macOS permissions for:
- MIDI device access (CoreMIDI)
- Network (agent HTTP server, Vercel AI Gateway API calls, YouTube downloads)
- Audio input/output (sounddevice for audio capture/render)
- File system (backup files, audio cache)

## Runtime Configuration

### Two modes: installed app vs development

**Installed app (from .pkg/.dmg):**
All paths are fixed relative to the app bundle. No configuration needed. The mock runner launches the agent with hardcoded relative paths:
```
agent binary:       ./Resources/sound-recreation-agent/dist/index.js
--keyboards-mcp:    ./Resources/keyboards-mcp/dist/index.js
--audio-mcp:        ./Resources/audio-analysis-mcp/.venv/bin/python
```

Only user-provided config: Vercel AI Gateway API key (stored in macOS Keychain or prompted on first launch).

**Development mode (running from source):**

Agent config (`sound-recreation-agent/.env`):
```bash
# Required
VERCEL_AI_GATEWAY_KEY=vag_...

# MCP server paths (auto-detected if siblings, else required)
KEYBOARDS_MCP_PATH=../keyboards-mcp/dist/index.js
AUDIO_ANALYSIS_MCP_PATH=../audio-analysis-mcp/.venv/bin/python

# Optional
AGENT_PORT=3001
LLM_MODEL=anthropic/claude-sonnet-4-20250514
MAX_HISTORY_MESSAGES=40
```

Discovery logic (dev mode only):
1. CLI flags take precedence (e.g., `--keyboards-mcp /path/to/dist/index.js`)
2. Then env vars (`KEYBOARDS_MCP_PATH`, `AUDIO_ANALYSIS_MCP_PATH`)
3. Then sibling directory detection (`../keyboards-mcp`, `../audio-analysis-mcp`)
4. If a server path is missing, agent starts with available servers only (graceful degradation)

Mock runner → agent discovery (dev mode only):
1. Check Electron user config for stored agent path
2. Try sibling directory (`../sound-recreation-agent`)
3. If not found → modal dialog asking for path (or skip)
4. Mock runner passes `--keyboards-mcp` flag when spawning agent (it knows its own path)

## Dependency Graph

```
                    macos-packager
                    (build-time only)
                         │
          ┌──────────────┼──────────────────┐
          ▼              ▼                  ▼
   keyboards-mcp   sound-recreation   audio-analysis
                      -agent              -mcp
                         │
          ┌──────────────┼──────────────────┐
          │ spawns       │ spawns            │
          ▼ (stdio)      │                  ▼ (stdio)
   keyboards-mcp        │           audio-analysis-mcp
                         │
                         ▼
keyboards-mcp mock-runner (Electron)
  └── spawns + connects (HTTP) ──→ sound-recreation-agent

Runtime process tree (launched from installed app):
  Mock Runner (Electron)
    └── spawns: sound-recreation-agent (Node)
         ├── spawns: keyboards-mcp (Node, stdio)
         └── spawns: audio-analysis-mcp (Python, stdio)
```

No circular build dependencies. The mock runner → agent link is runtime HTTP only. The packager is build-time only — it pulls, builds, and bundles but is not present at runtime.

## Development Workflow

Typical dev session (running from source):

```bash
# Terminal 1: keyboards-mcp mock runner (spawns agent automatically if configured)
cd keyboards-mcp && npm run mock:runner

# Or run components individually:
# Terminal 1: keyboards-mcp MCP server (standalone)
cd keyboards-mcp && npm run dev

# Terminal 2: audio-analysis-mcp
cd audio-analysis-mcp && uv run python -m audio_analysis_mcp

# Terminal 3: sound-recreation-agent
cd sound-recreation-agent && npm run dev
```

Release build:
```bash
cd macos-packager && ./scripts/build-all.sh && ./scripts/package.sh
```

## CI Summary

| Repo | Lint | Test | Build |
|------|------|------|-------|
| keyboards-mcp | ESLint (existing) | node:test + tsx (existing) | tsc → dist/ |
| sound-recreation-agent | ESLint (typescript-eslint, flat config) | node:test + tsx (placeholders initially) | tsc → dist/ |
| audio-analysis-mcp | mypy (strict) | pytest (placeholders initially) | n/a (Python) |
| macos-packager | shellcheck (bash scripts) | dry-run build (placeholders initially) | .pkg/.dmg |

All repos have `.github/workflows/ci.yml` from day one. The packager also has a `release.yml` workflow triggered by git tags.

## Implementation: 4 Separate Plans

This spec is implemented via 4 independent plans, one per repo. Each plan lives in its own repo's `docs/plans/` and can be executed in its own Claude Code session.

| Plan | Repo | Scope |
|------|------|-------|
| 1. keyboards-mcp cleanup | `keyboards-mcp/` | Move repo to parent folder. Remove `agent.ts`, `openai` dep, `recreate-sound.md`. Adapt mock runner for external agent launch (agent path config, chat tab as HTTP client). Update CLAUDE.md and plans. |
| 2. sound-recreation-agent scaffold | `sound-recreation-agent/` | New repo from scratch: Vercel AI SDK, MCP manager, tool adapter, conversation history, system prompt assembly, config/CLI flags, ESLint, CI, placeholder tests. |
| 3. audio-analysis-mcp scaffold | `audio-analysis-mcp/` | New Python repo: MCP server skeleton with stdio transport, stub tools, mypy, pytest, CI. (Tool implementations are covered by existing plan 7.) |
| 4. macos-packager scaffold | `macos-packager/` | New repo: build-all script, package script, entitlements, install layout, CI with release workflow, shellcheck. |

**Execution order:** Plan 1 (keyboards-mcp cleanup) first — it creates the parent folder and moves the repo. Plans 2-4 can then run in parallel since they're independent new repos.

## What This Spec Does NOT Cover

- The Vercel AI SDK implementation details (conversation management, streaming, tool execution) — that's the agent's internal design, to be planned when implementing the agent repo
- Audio-analysis-mcp tool implementations — covered by plan 7
- Mock runner tabbed UI with chat panel — covered by plan 6
- Multi-device MCP support — covered by plan 4
- macOS code signing certificates and notarization setup — that's operational, not architectural