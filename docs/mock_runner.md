# Mock Runner

The Mock Runner is an Electron app that simulates one or more keyboards on your desktop so you can develop and test against the MCP server without real hardware. Each tab hosts an independent mock device on its own MIDI virtual port and its own WebSocket port, with a model-specific web UI that mirrors real-time parameter changes.

```bash
npm run mock:runner   # Electron — model picker, then per-model UI
npm run mock:headless --model nord-electro-5d   # Plain Node, for CI/E2E tests
```

![Mock Runner tour](images/mock_runner_tour.gif)

## Anatomy

```
┌──────────────────────────────────────────────────────────────────────────┐
│  MOCK RUNNER · MULTI-DEVICE TEST RACK            [tab][tab][tab][+]      │
├──────────────────────────────────────────────────────┬───────────────────┤
│                                                      │  CLAUDE line      │
│         (model UI iframe — drawbars, knobs,          │                   │
│          LEDs, engine state for the active tab)      │  > history…       │
│                                                      │                   │
│                                                      │  composer ↵       │
└──────────────────────────────────────────────────────┴───────────────────┘
```

- **Top chassis** — brand strip plus tab bar with a `+` button.
- **Slot** — the active tab's iframe. Each tab loads either the model picker (`chooser.html`) or, once a model is chosen, that model's web UI from `src/keyboard_models/<mfr>/<model>/web/`. Inactive tabs stay mounted but hidden.
- **Empty rack slot** — placeholder shown when no tabs are open.
- **Console pane** — chat with the `sound-recreation-agent` running at `http://localhost:3001`.

## Tabs and devices

The shell window is loaded once and never reloaded. Each tab owns its own `MockEngine`, MIDI virtual port, and WebSocket port (allocated sequentially from `3000`).

| Action | How |
|---|---|
| New tab | `+` on the tab bar, or **File → New Tab** (`Cmd+T`) |
| Close tab | `×` on the tab — engine shuts down, WebSocket port is freed |
| Pick a model | Click any card on the chooser screen |
| Switch active tab | Click a tab |
| Rename a tab | Double-click the tab title |

### Labels

Each loaded tab has a sanitized **label** (lowercase `[a-z0-9._-]`). It defaults to `<model-id>-1`, `<model-id>-2`, etc — collisions with other tabs of the same model are skipped automatically. The label is the cache key for that tab's per-instance backup data: it appears in `data/backups/<label>/`. Rename a tab to attach a different backup cache to it.

## Model picker

A new tab opens to the chooser, which lists every model auto-discovered under `src/keyboard_models/<manufacturer>/<model>/`. Cards show manufacturer, display name, and model id. Clicking a card spins up the engine for that tab and navigates the iframe to the model's web UI. The chooser runs inside the iframe and asks the parent shell for the catalog via `postMessage` — the preload-bridged `mockRunnerAPI` only exists on the parent.

## Model UI

Each model ships its own UI under `src/keyboard_models/<mfr>/<model>/web/`. The shell injects the per-tab `wsPort` via the URL query string; the UI opens a WebSocket back to that port and re-renders on every state broadcast. Drawbars, knobs, LEDs, and engine parameters update as MIDI messages arrive. The mock engine itself is a thin shell — virtual MIDI port plus WebSocket server plus broadcast — and all of the model behavior lives in the `MockHandler`.

## File menu — saving and restoring rack setups

Save the entire rack (all tabs, their models, labels, and full state) to a single `.mockrack` JSON file and reload it later.

| Item | Shortcut | What it does |
|---|---|---|
| New Tab | `Cmd+T` | Open a chooser tab |
| Open… | `Cmd+O` | Replace the rack with a `.mockrack` file |
| Open Recent | — | macOS recents submenu |
| Save | `Cmd+S` | Save to the current file (falls back to Save As) |
| Save As… | `Cmd+Shift+S` | Save to a new path |
| Extract Backup… | `Cmd+E` | See [Backup extraction](#backup-extraction) |

### Dirty indicator

The title bar reads `Mock Runner — <file>.mockrack` and gains a trailing `•` whenever the rack diverges from the saved file. Engine state changes are debounced (250 ms). Tab create/close, model selection, rename, active-tab change, and backup extraction all mark the rack dirty.

### Confirmation prompts

Quit (`Cmd+Q`), close window, and Open all prompt **Save / Don't Save / Cancel** when the rack is dirty.

### Auto-load

On launch, a queued `open-file` event from the OS (file association double-click, dock drop) wins. Otherwise the shell walks the recents list and auto-loads the most-recent surviving file. If neither exists, the rack starts empty.

### Restore semantics

Each tab's full state is captured via `MockHandler.getFullState(false)` and restored via `MockHandler.setFullState(snapshot)`. Models opt in incrementally — those without `setFullState` restore as model + label only, with knobs at defaults; an in-shell note explains. Unknown models in a `.mockrack` are skipped with a console note rather than failing the load.

## Backup extraction

Use the **backup** button in the console header (or **File → Extract Backup…**, `Cmd+E`) to import a backup into the active tab's cache.

- A native file picker accepts a single backup file or a programs-only folder.
- With **one** loaded tab, extraction runs against it directly.
- With **multiple** loaded tabs, a modal asks which device the backup belongs to.
- Programs-only folder extraction merges into the existing cache for that label — it requires a previously cached full backup under the same label.
- After extraction, the live engine for that model + label reloads its cache; a markdown inventory is written to `data/backups/<label>/<model_slug>_backup_inventory.md`.

## Console — talking to Claude

The right-hand pane is a thin SSE client for the sibling `sound-recreation-agent` HTTP server.

- **Composer** — `Enter` sends, `Shift+Enter` inserts a newline.
- **Status meter** — `off` (agent unreachable), `on` (probed at startup), `busy` (a request is in flight).
- **Stream events** — `text` chunks build up the assistant message, `tool_use` rows show the tool name plus a short input summary, `tool_result` rows show the first 220 chars of the result (highlighted on error).
- **Reset** — clears the on-screen log and posts `POST /reset` to the agent.
- **History** — every row is persisted to `localStorage` (`mock-runner.chat-history.v1`) and replayed on next launch.
- **Backup** — same flow as **File → Extract Backup…**.

The agent is expected at `http://localhost:3001`. Start it from the sibling repo:

```bash
cd ../sound-recreation-agent
npm run dev:full
```

## `.mockrack` file format

A small JSON envelope wrapping each tab's modelId, label, and an opaque state blob owned by the model.

```jsonc
{
  "$schema": "mockrack/v1",
  "version": 1,
  "savedAt": "2026-05-04T10:30:00.000Z",
  "appVersion": "0.1.0",
  "activeTabIndex": 0,
  "tabs": [
    {
      "modelId": "nord-electro-5d",
      "label": "studio-a",
      "state": { /* opaque, model-defined */ }
    }
  ]
}
```

Writes are atomic (`tmp` + `rename`). The format is versioned so older files can be migrated forward.

## Headless mode

For tests and CI, `mock:headless` runs the same `MockEngine` under plain Node (no Electron, no UI). It prints `MOCK_READY` on stdout once the WebSocket server is up.

```bash
npm run mock:headless -- --model nord-electro-5d --ws-port 3000
# flags: --model <id>            (required)
#        --ws-port <n>           (default 3000)
#        --lower-channel <ch>    (default 0)
#        --upper-channel <ch>    (default 1)
#        --no-midi               (skip the virtual MIDI port — useful in CI containers)
#        --label <name>          (override the per-instance label)
```

Tests use this via `tests/helpers/mock-process.ts` (headless spawn + WebSocket assertions) and `tests/helpers/test-harness.ts` (full mock + MCP client harness).

## Architecture quick reference

| Path | Role |
|---|---|
| `src/mock-runner/main.ts` | Electron main — owns tabs, engines, file menu, IPC |
| `src/mock-runner/cli.ts` | Headless entry point |
| `src/mock-runner/engine.ts` | `MockEngine` — MIDI virtual ports + WebSocket server + broadcast + source-aware routing |
| `src/mock-runner/preload.cjs` | Exposes `mockRunnerAPI` to the shell |
| `src/mock-runner/shell/index.html` | Tab bar, slot, console, backup-picker modal |
| `src/mock-runner/shell/app.js` | Tab routing, chat console, backup flow, dirty/title sync |
| `src/mock-runner/shell/chooser.html` | Model picker iframe |
| `src/shared/mockrack-format.ts` | `.mockrack` schema, parse, atomic write |
| `src/keyboard_models/<mfr>/<model>/mock-handler.ts` | Per-model state, MIDI handling, `onUIParam`, `getFullState` / `setFullState` |
| `src/keyboard_models/<mfr>/<model>/web/` | Per-model UI loaded into the tab iframe |

## Engine and handler — runtime contract

The mock runner has two collaborators: a **MockEngine** (transport) and a per-model **MockHandler** (logic). Knowing where the boundary is — and why the routing has the shape it does — saves a lot of head-scratching when a feature crosses both.

### Topology

Each tab spawns one `MockEngine` with one `MockHandler`. The engine owns transport; the handler owns model semantics.

```
┌────────────────────────────────────────────────────────────────────────┐
│                         MockEngine (transport)                         │
│   - WebSocket server   - Virtual MIDI ports   - Source-aware routing   │
│   - Broadcasts state   - Knows nothing about params or encoding        │
└────────────────────────────────────────────────────────────────────────┘
         ▲                                    ▲                ▲
         │ WS                                 │ MIDI In        │ MIDI Out
         │                                    │ (apps→device)  │ (device→apps)
         ▼                                    ▼                ▼
   ┌──────────┐  ┌──────────┐         ┌────────────┐    ┌────────────┐
   │ UI client│  │MCP-status│         │ External   │    │ External   │
   │ (browser)│  │ client   │         │ MIDI src   │    │ MIDI sink  │
   └──────────┘  └──────────┘         │ (MCP, real │    │ (MCP, real │
                                      │ kbd, bridge│    │ kbd, bridge│
                                      └────────────┘    └────────────┘

        engine ⇄ handler  (in-process method calls only)
                 ▼
   ┌────────────────────────────────────────────────────────────────┐
   │                   MockHandler (model logic)                    │
   │  - Owns ALL state: sceneGlobal, parts[], params, mode, etc.    │
   │  - Knows the parameter map: name → CC / sysexAddress           │
   │  - Knows encoding: chorus_switch=1 → DT1 bytes [F0..F7]        │
   │  - Returns MockHandlerResult: { state?, log?, sysexOut?,       │
   │                                  ccOut?, programOut? }         │
   └────────────────────────────────────────────────────────────────┘
```

The engine creates two virtual MIDI ports per tab (the device's MIDI In, where apps write to it; the device's MIDI Out, where apps read from it) and one WebSocket server (UI clients + an MCP-status lane).

### Responsibility split

| Concern                                | Engine | Handler |
|----------------------------------------|:------:|:-------:|
| Virtual MIDI In / Out lifecycle        |   ✓    |         |
| WebSocket server + clients             |   ✓    |         |
| Decide *whether* to emit on MIDI Out   |   ✓    |         |
| Broadcast state JSON to UI clients     |   ✓    |         |
| Parameter map (name → CC / sysex addr) |        |    ✓    |
| Encoding (value → wire bytes)          |        |    ✓    |
| State updates (sceneGlobal, parts)     |        |    ✓    |
| Decide *what* MIDI to emit             |        |    ✓    |

The engine is a dumb pipe + router. The handler is the model brain.

### Source-aware routing rule

Every inbound MIDI message has a source: a UI WS command, or external MIDI on the virtual MIDI In. Routing is keyed off that source so a real external MIDI source can drive the mock without echoing back through bridges and looping.

```
┌─────────────────────────────────────────────┐
│ engine.onMIDI(msg, source)                  │
│                                             │
│ result = handler.onMIDI(msg)                │
│                                             │
│ ALWAYS emit:  result.sysexOut/ccOut/        │
│               programOut  →  MIDI Out       │
│                                             │
│ if source === "ui":                         │
│     ALSO echo bare msg → MIDI Out           │
│ else:  /* external — never echo */          │
└─────────────────────────────────────────────┘
```

The asymmetry is deliberate. UI is a closed-loop source (the user already knows about it; echoing out so external listeners can mirror is the panel-knob analogue). External MIDI is the open loop — anything we emit could come back through a bridge and into our own MIDI In.

### The four message flows

#### Flow 1 — UI moves a CC slider

```
UI ──{type:"cc",controller,value,channel}──► engine.WS
                                              │
                                              ▼
                              engine.onMIDI(msg, source="ui")
                                              │
                                              ├──► handler.onMIDI(msg)
                                              │      └─ updates state, returns {state}
                                              │
                                              ├──► engine.broadcast(result.state) ──► UI
                                              │
                                              └──► midiOutput.send("cc", msg)  ──► External MIDI sink
                                                   (UI-source echo: panel-knob analogue)
```

#### Flow 2 — UI clicks a SysEx-addressed param button

For params with no CC (e.g. JUNO-X chorus mode, FX switches), the UI sends `{type:"param",name,value}`. The engine doesn't know how to encode named params, so it delegates:

```
UI ──{type:"param",name:"chorus_switch",value:1}──► engine.WS
                                                     │
                                                     ▼
                                       engine calls handler.onUIParam("chorus_switch", 1)
                                                     │
                                                     ├─ handler looks up param in scene-params
                                                     ├─ handler encodes value → DT1 bytes
                                                     ├─ handler.onMIDI({sysex: DT1})    ◄── self-call
                                                     │     └─ writes sceneGlobal[addr]=1
                                                     │
                                                     └─ returns { state, sysexOut: [DT1] }
                                                     │
                       ┌─────────────────────────────┘
                       ▼
       engine.broadcast(state) ──► UI       (state update visible)
       midiOutput.send("sysex", DT1) ──► External MIDI sink
                                         (handler-explicit emission)
```

The handler emits the encoded packet via `result.sysexOut`. The engine does NOT additionally echo the inbound `{type:"param"}` because there is no inbound MIDI message to echo — only a name+value pair.

#### Flow 3 — External MIDI sends a CC (must NOT echo back)

```
External MIDI src ──CC──► virtual MIDI In ──► engine.midiInput.on("cc")
                                              │
                                              ▼
                              engine.onMIDI(msg, source="external")
                                              │
                                              ├──► handler.onMIDI(msg)
                                              │      └─ updates state, returns {state}
                                              │
                                              ├──► engine.broadcast(result.state) ──► UI
                                              │
                                              └──► [skipped] no echo to midiOutput
                                                   ────── reason: feedback loop ────────
                                                   if we echoed, a bridge that fans out
                                                   would route this CC straight back into
                                                   our own MIDI In → infinite loop
```

#### Flow 4 — External RQ1 SysEx (handler explicitly chooses to respond)

```
MCP RQ1 ──sysex──► virtual MIDI In ──► engine.midiInput.on("sysex")
                                        │
                                        ▼
                        engine.onMIDI(msg, source="external")
                                        │
                                        ├──► handler.onMIDI(msg)
                                        │      └─ recognizes RQ1 → reads sceneGlobal
                                        │      └─ returns { sysexOut: [DT1 response], log }
                                        │
                                        └──► midiOutput.send("sysex", DT1) ──► External MIDI sink
                                             (handler-explicit emission — always emitted
                                              regardless of source; the handler decided
                                              to respond, so it's not an echo)
```

### Tagged debug logs

Every engine log line carries `[<actualPortName>:<label>]` and a direction tag — `WS-IN`, `MIDI-IN`, `MIDI-OUT`, or `MIDI-OUT (ui-echo)`. Sysex is summarized as `sysex N bytes [F0 41 10 .. F7]`. Two mocks sharing one stdout (e.g. a primary + shadow setup with a bridge) become readable: a UI click on the primary should produce a `MIDI-OUT` line on the primary and a corresponding `MIDI-IN` line on the shadow.

### Why the complexity, and could it be simpler?

The routing has three real cases that demand distinct handling:

1. **Inbound mirror** — UI cc/program echoed to MIDI Out so external listeners see the "panel knob".
2. **Handler-explicit emission** — handler decides to send (RQ1→DT1 reply, or onUIParam encoding a named param). Always emitted regardless of inbound source.
3. **No echo for external source** — required to prevent feedback loops over bridges.

A few simplifications have been considered and rejected:

- **Push the source flag into `handler.onMIDI(msg, source)` and let the handler return everything to emit.** Cleaner engine (one rule: emit `result.{ccOut, sysexOut, programOut}`), but every model would have to repeat "if source is ui, also include msg in ccOut" — copy-paste tax across handlers, and the engine's panel-knob mirror is a generic concept, not a per-model decision.
- **Synthesize a `MidiMessage` from `onUIParam` and route it back through `onMIDI(msg, "ui")`.** Would unify the `{type:"param"}` path with the cc/program echo path. But UI-source sysex would then auto-echo too, and we don't have a use case that needs that today — the symmetry is appealing but premature.

The current design is "small set of explicit rules at one boundary". If a future feature pushes a fourth case in, that's the moment to revisit.
