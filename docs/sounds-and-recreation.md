# Sounds and Recreation

Sounds and Recreation is an Electron desktop app — the UI facade over the MCP servers and agent. It simulates one or more keyboards on your desktop so you can develop and test against the MCP server without real hardware. Each tab hosts an independent mock device on its own MIDI virtual port and its own WebSocket port, with a model-specific web UI that mirrors real-time parameter changes.

```bash
npm run sar   # Electron — model picker, then per-model UI
npm run sar:headless -- --model nord-electro-5d   # Plain Node, for CI/E2E tests
```

![Sounds and Recreation tour](images/mock_runner_tour.gif)

## Anatomy

The shell is a three-column layout: the **rack column** on the left (host to one of two view-switchable panels — MIDI or SONG ANALYSIS), the **rail** in the middle (full window height; vertical selector cluster + splitter), and the **console drawer** on the right.

The two rack-column views own the entire column when active — including the top chassis bar. Each view has its own brushed-metal chassis (the MIDI view's is the `SOUNDS AND RECREATION` tab strip; the SONG ANALYSIS view's is its own `SONG ANALYSIS · JOBS · STEMS · STRUCTURE` bar with a service-health chip). The inactive panel stays mounted (`visibility: hidden`) so model iframes keep their WebSocket sessions while the operator peeks at the other view.

**MIDI view** (default) — the workspace operators spend most of their time in: model picker / mock UIs + MIDI monitor at the bottom.

```
┌─────────────────────────────────────────────────────┬──┬──────────────────┐
│ SOUNDS AND RECREATION · [●tab][●tab][●tab][+]       │MI│ [CHAT●] [LOG●]   │
├─────────────────────────────────────────────────────┤DI├──────────────────┤
│                                                     │──│ SID:abc12345 ▮▮▮ │
│         (model UI iframe — drawbars, knobs,         │WV│                  │
│          LEDs, parameter state for active tab)      │  │  > history…      │
│                                                     │◀▶│                  │
│                                                     │  │                  │
├─────────────────────────────────────────────────────┤  │                  │
│ MIDI MONITOR                              0 events ▴│  │  › composer ↵    │
└─────────────────────────────────────────────────────┴──┴──────────────────┘
```

**SONG ANALYSIS view** — jobs explorer + per-job analyze workbench. See [Song Analysis](#song-analysis).

```
┌─────────────────────────────────────────────────────┬──┬──────────────────┐
│ SONG ANALYSIS · JOBS · STEMS · STRUCTURE  ●up      │MI│ [CHAT●] [LOG●]   │
├─────────────────────────────────────────────────────┤DI├──────────────────┤
│ ┌─ JOBS ──────────┐ ┌─ JOB DETAIL ─────────────────┐│──│ SID:abc12345 ▮▮▮ │
│ │ ● Kind Of Blue   │ │ Kind Of Blue                ││WV│                  │
│ │   3:42 · 44.1k · │ │ kind-of-blue · /.../jobs/…  ││  │  > history…      │
│ │ ○ get-lucky      │ │                              ││◀▶│                  │
│ │   5:08 · 44.1k · │ │ [ ANALYZE ]                  ││  │                  │
│ │                  │ │ STEMS     [████░░░] 52%      ││  │                  │
│ │ [+ NEW JOB…]     │ │ STRUCTURE [██████░] 71%      ││  │  › composer ↵   │
│ └──────────────────┘ └──────────────────────────────┘│  │                  │
└─────────────────────────────────────────────────────┴──┴──────────────────┘
```

- **Chassis** — brand strip plus tab bar with a `+` button (MIDI view) or the SONG ANALYSIS title + service-health chip (analysis view). Each view's chassis lives inside its own panel — neither spans across the rail.
- **Rack panels** — two stacked panels share the rack column. Rail selectors pick which is visible; the inactive one stays mounted. Tab LEDs are still meaningful in MIDI view (see [Tab LEDs](#tab-leds-and-mcb)).
- **Slot** (MIDI view) — the active tab's iframe. Loads `chooser.html` until a model is picked, then that model's UI from `src/keyboard_models/<mfr>/<model>/web/`. Inactive tabs stay mounted but hidden.
- **Empty rack slot** — placeholder shown when no tabs are open.
- **MIDI monitor drawer** — collapsible strip at the bottom of the MIDI view showing the active tab's recent MIDI traffic (see [MIDI monitor](#midi-monitor)).
- **Rail** — full-height vertical strip (34px) on the slot-facing edge of the console. Top-to-bottom: **selector cluster** (MIDI / WAVE buttons, click-only, jewel-LED active state); **splitter** (fills the rest of the rail, drag to resize the console, click to collapse, chevron at the top under the buttons).
- **Console drawer** — tabbed pane on the right with **CHAT** (talk to the agent) and **LOG** (mock-runner event log). See [Console](#console--chat-and-event-log).

## Tabs and devices

The shell window is loaded once and never reloaded. Each tab owns its own `MockTransport`, MIDI virtual port, and WebSocket port (allocated sequentially from `3000`).

| Action | How |
|---|---|
| New tab | `+` on the tab bar, or **File → New Tab** (`Cmd+T`) |
| Close tab | `×` on the tab — transport shuts down, WebSocket port is freed |
| Pick a model | Click any card on the chooser screen |
| Switch active tab | Click a tab |
| Rename a tab | Double-click the tab title |

### Labels

Each loaded tab has a sanitized **label** (lowercase `[a-z0-9._-]`). It defaults to `<model-id>-1`, `<model-id>-2`, etc — collisions with other tabs of the same model are skipped automatically. The label is the cache key for that tab's per-instance backup data: it appears in `data/backups/<label>/`. Rename a tab to attach a different backup cache to it.

### Tab LEDs and MCB

The dot at the start of each tab title is a status LED reflecting that mock's role in [midi-connections-broker (MCB)](../README.md) leases:

| LED | Meaning |
|---|---|
| Amber (steady) | No active lease against this mock's WebSocket port — the default resting state. |
| Green | An MCP session holds this mock as the **primary** device. |
| Blue | Held as the **shadow** of another device (mirror destination — typical hw + mock pair). |
| Blinking amber (all tabs) | MCB is unreachable; the broker-liveness state pushes "down" to every tab until it comes back. With the broker down, the lease-state poll collapses every tab to "none" (amber) and the blink pulses opacity on top of that. |

The shell polls MCB every 2 s for lease state, and registers a broker-liveness subscriber so the "down" / "up" transitions arrive as push notifications (no polling on the renderer side). MCB lives in `src/shared/mcb-client.ts`; the mock-runner is not a hard dependent — if MCB is down, mocks still run, the LEDs just collapse to "none".

### MIDI monitor

The drawer pinned to the bottom of the rack column shows the active tab's recent MIDI traffic.

- **Collapsed** (default): a single row with the latest event from the active tab's ring buffer.
- **Expanded** (click the chevron `▴`): a scrollable list of all buffered events for that tab, newest at the bottom. The operator's scroll position is preserved during MIDI bursts.
- Ring buffer cap: **50 events per tab**.
- Format is generic — no model-specific interpretation. Sysex shows the full hex string (the row truncates visually but the underlying text node carries every byte so you can select-and-copy).

```
▸ OUT 14:32:08.512  CC93=32 ch=0
◂ IN  14:32:08.514  sysex 17 bytes [F0 41 10 00 00 00 12 11 01 50 00 01 01 00 00 5C F7]
▸ OUT 14:32:08.520  PC=12 ch=2
```

Events arrive from each tab's `MockTransport` via the `midi-event` EventEmitter signal, relayed through Electron IPC. The transport itself does no model-specific interpretation. The drawer receives the **full** byte array for every event (so select-and-copy works on long sysex); stdout's `MIDI-IN` / `MIDI-OUT` log lines summarize long sysex packets as `[<first 4 bytes> .. <last byte>]` for readability.

## Model picker

A new tab opens to the chooser, which lists every model auto-discovered under `src/keyboard_models/<manufacturer>/<model>/`. Cards show manufacturer, display name, and model id. Clicking a card spins up the transport for that tab and navigates the iframe to the model's web UI. The chooser runs inside the iframe and asks the parent shell for the catalog via `postMessage` — the preload-bridged `mockRunnerAPI` only exists on the parent.

## Model UI

Each model ships its own UI under `src/keyboard_models/<mfr>/<model>/web/`. The shell injects the per-tab `wsPort` via the URL query string; the UI opens a WebSocket back to that port and re-renders on every full-state broadcast it receives. Drawbars, knobs, LEDs, and parameter values update both when external MIDI arrives on the virtual port and when another client (the agent via MCP, a real keyboard via a bridge) writes to the mock.

Model UIs speak the **param domain only** — never raw MIDI. To change a parameter, the UI sends `{type:"setParam", name, value, part?}` over the WebSocket; the transport calls `handler.set_params([...])` for state and then asks the codec to encode the same write to MIDI Out bytes (the panel-knob analogue, so external listeners see the change). To change the active engine on a part (JUNO-X), the UI sends `{type:"setActiveEngine", engine, part?}`. To request a cache reload after a backup extract, `{type:"reload-cache"}`.

The transport is a thin shell (virtual MIDI port + WebSocket server + broadcast + small protocol-state glue). All model semantics live in the per-model `MockHandler` (state) and `MidiCodec` (param ↔ MIDI translation). See [Transport, codec, handler — runtime contract](#transport-codec-handler--runtime-contract) for the boundary and [`src/sounds-and-recreation-app/transport.md`](../src/sounds-and-recreation-app/transport.md) for the transport file walkthrough.

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

The title bar reads `Sounds and Recreation — <file>.mockrack` and gains a trailing `•` whenever the rack diverges from the saved file. Engine state changes are debounced (250 ms). Tab create/close, model selection, rename, active-tab change, and backup extraction all mark the rack dirty.

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
- After extraction, the live transport for that model + label reloads its cache; a markdown inventory is written to `data/backups/<label>/<model_slug>_backup_inventory.md`.

## Song Analysis

The second rack-column view, behind the **WAVE** rail button. Drives the sibling `audio-analysis-mcp` FastAPI service via the in-repo `audio-analysis-client` (`src/audio-analysis-client/`).

### Prerequisite — running the service

Sounds and Recreation does **not** spawn the audio-analysis service. Start it in another terminal before clicking ANALYZE:

```bash
cd ../audio-analysis-mcp
uv run python -m audio_analysis_mcp.service
```

Defaults: listens on `http://127.0.0.1:8765`, workspace at `~/.audio-analysis-mcp/workspace`. Both are overridable:

| Env var | Default | What it controls |
|---|---|---|
| `AUDIO_ANALYSIS_SERVICE_URL` | `http://127.0.0.1:8765` | Where the renderer's `AudioAnalysisClient` POSTs |
| `AUDIO_ANALYSIS_WORKSPACE` | `~/.audio-analysis-mcp/workspace` | Root the panel scans for `jobs/<name>/` |
| `AUDIO_ANALYSIS_SERVICE_PORT` | `8765` | Read by the FastAPI service itself (set on **both** sides if changed) |

The service-health chip in the panel's chassis bar polls `/healthz` every 10 s. **Green** = service up; **red** = down (ANALYZE is disabled, the chip explains why).

### Jobs explorer

The left pane lists everything under `<workspace>/jobs/`. Rows are populated by a debounced `fs.watch` in the Electron main process — drop a directory into the workspace by any means (the service's `import_audio`, manual copy, git checkout) and the row appears within ~1 s without a manual refresh.

| Row state (LED) | Meaning |
|---|---|
| Amber, solid | `source.wav` exists but no analysis on disk yet — ready for ANALYZE |
| Green | At least one `stems/` or `song_structure/` result on disk |
| Amber, pulsing | Import in flight from this Sounds and Recreation session |
| Matte (off) | `source.wav` missing — broken or partial import |

Per-row metadata (`3:42 · 44.1k · mono`) is parsed from the WAV header on the fly; no decoding is done, just RIFF chunk walking.

### Display name vs slug

The `audio-analysis-mcp` service sanitizes the imported filename into a slug (`Kind Of Blue.mp3` → `kind-of-blue`) and uses it as the job directory. To preserve the original title Sounds and Recreation writes a sidecar `<job_path>/.mock-runner.json` right after a successful import:

```json
{
  "displayName": "Kind Of Blue",
  "originalFilename": "Kind Of Blue.mp3",
  "importedAt": "2026-05-12T15:32:18.412Z"
}
```

Jobs with this sidecar render the title in Fraunces (song-title typography). Jobs without it — manually created directories, jobs imported through other tooling — fall back to the slug in Roboto Mono. The slug is always visible in the job-detail header for grep/`ls` parity.

The sidecar lives in the job dir, not in the service, so it survives `git clean` of `node_modules`, Electron upgrades, etc. — anything that doesn't touch the workspace.

### Analyze

The **ANALYZE** button fires `separateStems` and `analyzeStructure` in parallel against the active job's `source.wav`. Each is an async iterable of typed SSE events from the audio-analysis service:

```
progress { stage, fraction, detail } → 0..N times
result   { result }                  → terminal
error    { errorType, message }      → terminal (instead of result)
```

The two progress bars update independently. A 1 Hz amber carrier-wave sweeps behind the bars while either job is running. On `result` the row's LED flips amber → green and the RESULTS section below the bars populates with the stems list and structure segments. On `error` the bar fills with the oxblood fault color and the stage line shows the message.

Cached re-runs (the service detects existing output on disk) come back in milliseconds with `cached: true` on the `result` event — the bars jump straight to 100% and the stage line reads `done · cached`.

### Out of scope (current)

- **Service lifecycle from Electron.** Start `audio_analysis_mcp.service` yourself; the chip surfaces "down" if it isn't running.
- **Cancel / abort during ANALYZE.** The `AbortController` plumbing is in place but no UI cancel button yet.
- **Waveform / spectrum visualization.** Results are surfaced as lists; richer viz lives in a follow-up plan.
- **Rename or delete jobs from the UI.** Jobs are filesystem dirs — manage externally.

## Console — chat and event log

The right-hand pane is a tabbed drawer with two panes that share one strip of chrome and one composer:

- **CHAT** — talk to the sibling `sound-recreation-agent`. Uses the `@sounds-and-recreation/agent-client` SDK over SSE.
- **LOG** — mock-runner event log. Lifecycle and status notes from the main process appear here (backup extracted, snapshot restore notes, etc.) instead of polluting the chat.

The drawer collapses by clicking the rail between rack and console; the rail is also a drag handle to resize the console (width persists across launches).

### CHAT pane

The chat tab's header strip carries a status meter and the agent's session id:

- **Lamp + meter** — four states:
  - `unknown` — page just loaded, no probe yet
  - `live` — last probe or chat turn succeeded
  - `busy` — chat in flight (overlays `live`/`lost` while sending)
  - `lost` — probe or fetch failed; the agent is unreachable
- **SID** — the agent's MCB-issued sessionId, shown as the first 8 hex chars (full UUID in the title attribute). Changes if the agent restarts. Sourced from the agent's `GET /health` response.
- **Composer** — `Enter` sends, `Shift+Enter` inserts a newline.
- **Stream events** — `text` chunks build up the assistant message; `tool_use` rows show the tool name plus a short input summary; `tool_result` rows show the first 220 chars of the result (highlighted on error). Web-search source URLs are rendered as links.
- **Reset** — **File → Reset Chat** clears the on-screen log and posts `POST /reset` to the agent.
- **History** — every row is persisted to `localStorage` (`mock-runner.chat-history.v1`) and replayed on next launch.

The agent is expected at `http://localhost:2999`. Port 2999 is reserved for the agent so it doesn't collide with mock WebSocket ports (which start at 3000 and count up). Start it from the sibling repo:

```bash
cd ../sound-recreation-agent
npm run dev:full
```

### LOG pane

Mock-runner lifecycle events tagged by severity (`info` / `warn` / `error`). Events arrive from the main process via `event-log-ipc.ts`. When the LOG tab is inactive, an unread LED appears on its tab; the LED's color matches the highest unread severity. Selecting the tab clears the unread state.

**File → Clear Event Log** (`Cmd+K`) clears the log when LOG is active (no-op when CHAT is active).

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

For tests and CI, `sar:headless` runs the same `MockTransport` under plain Node (no Electron, no UI). It prints `MOCK_READY` on stdout once the WebSocket server is up.

```bash
npm run sar:headless -- --model nord-electro-5d --ws-port 3000
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
| `src/sounds-and-recreation-app/main.ts` | Electron main — owns tabs, transports, file menu, IPC (incl. audio-analysis workspace scan, fs.watch, file dialog, job-metadata write) |
| `src/sounds-and-recreation-app/cli.ts` | Headless entry point |
| `src/sounds-and-recreation-app/transport.ts` | `MockTransport` — MIDI virtual ports + WebSocket server + broadcast + routing glue |
| `src/sounds-and-recreation-app/transport.md` | File-level walkthrough of `transport.ts` |
| `src/sounds-and-recreation-app/preload.cjs` | Exposes `mockRunnerAPI` to the shell |
| `src/sounds-and-recreation-app/event-log-ipc.ts` | Main → renderer event log channel |
| `src/sounds-and-recreation-app/shell/index.html` | Tab bar, slot, MIDI drawer, console drawer, rail (MIDI/WAVE selectors + splitter), SONG ANALYSIS panel scaffold, backup picker |
| `src/sounds-and-recreation-app/shell/app.js` | Tab routing, MIDI drawer, chat + event log, MCB LED polling, splitter, rack-view switching, dirty/title sync |
| `src/sounds-and-recreation-app/shell/panel-analysis.js` | SONG ANALYSIS panel — lazy-imported; owns jobs list, import + analyze flows, health probe |
| `src/sounds-and-recreation-app/shell/chooser.html` | Model picker iframe |
| `src/audio-analysis-client/` | TypeScript client for the sibling `audio-analysis-mcp` service (HTTP + SSE) — see [its README](../src/audio-analysis-client/README.md) |
| `src/shared/midi-codec.ts` | `MidiCodec` interface — param ↔ MIDI translation, shared by mock + MCP |
| `src/shared/mcb-client.ts` | HTTP-over-UDS client for midi-connections-broker (lease queries + broker-liveness) |
| `src/shared/mock-registry.ts` | At-rest index of running mocks, written by each `MockTransport` |
| `src/shared/mockrack-format.ts` | `.mockrack` schema, parse, atomic write |
| `src/keyboard_models/<mfr>/<model>/mock-handler.ts` | Per-model state — `set_params` / `get_params` / `getFullState` / `setFullState` |
| `src/keyboard_models/<mfr>/<model>/midi-codec.ts` | Per-model codec implementation |
| `src/keyboard_models/<mfr>/<model>/web/` | Per-model UI loaded into the tab iframe |

## Transport, codec, handler — runtime contract

The mock runner has three collaborators per tab: a **MockTransport** (transport), a per-model **MidiCodec** (param ↔ MIDI translation), and a per-model **MockHandler** (state). The boundary is plan #30 stage 5 (#74–#79): the handler is **purely param-domain** — no MIDI bytes, no addresses, no protocol awareness. The transport and codec own everything wire-related.

### Topology

```
┌────────────────────────────────────────────────────────────────────────┐
│                    MockTransport (transport)                           │
│   - WebSocket server   - Virtual MIDI ports   - Routing glue           │
│   - Broadcasts state   - Bank-select accumulator   - RQ1 fulfillment   │
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

      ↕ in-process method calls (no MIDI here)
   ┌────────────────────────┐    ┌────────────────────────────────┐
   │   MidiCodec (model)    │    │      MockHandler (model)       │
   │  - encodeParams        │    │  - set_params / get_params     │
   │  - encodeBytes         │    │  - load_program                │
   │  - decode              │    │  - get_active_engine /         │
   │  - paramsAtAddress     │    │    set_active_engine           │
   │  - parseRequest        │    │  - getFullState /              │
   │  - buildResponse       │    │    setFullState                │
   └────────────────────────┘    │  - state: parts[], scene, etc. │
                                 └────────────────────────────────┘
```

The transport creates two virtual MIDI ports per tab (the device's MIDI In, where apps write to it; the device's MIDI Out, where apps read from it) and one WebSocket server. UI clients receive full state snapshots; a separate "MCP-status" WebSocket client receives a label-only payload (used by MCP-side label discovery — see `mcb-client.ts`).

### Responsibility split

| Concern                                       | Transport | Codec | Handler |
|-----------------------------------------------|:---------:|:-----:|:-------:|
| Virtual MIDI In / Out lifecycle               |     ✓     |       |         |
| WebSocket server + clients + broadcasts       |     ✓     |       |         |
| Bank-select CC 0/32 accumulator               |     ✓     |       |         |
| RQ1 fulfillment orchestration                 |     ✓     |       |         |
| Default-channel resolution on emit            |     ✓     |       |         |
| Parameter map (name → CC / sysex addr)        |           |   ✓   |         |
| Encoding (user-domain value → wire bytes)     |           |   ✓   |         |
| Decoding (wire bytes → user-domain refs)      |           |   ✓   |         |
| RQ1 address ↔ param lookup                    |           |   ✓   |         |
| State updates (parts, scene, etc.)            |           |       |    ✓    |
| Per-part active-engine selection              |           |       |    ✓    |
| Snapshot save/restore                         |           |       |    ✓    |

The transport is a dumb pipe + small protocol glue. The codec is the model's translator. The handler is the model brain — pure param domain.

### Inbound message flows

Two groups, seven flows total. From the wire: UI `setParam`, external MIDI param write (CC or non-request sysex), external bank-select + Program Change (transport accumulates MSB/LSB), and codec-recognized request sysex (today: Roland RQ1, but the mechanism is generic). From the host: WebSocket client connect (with the partial-broadcast MCP-status quirk), tab relabel + cache reload, and `.mockrack` save/restore. Each is documented with diagrams in [`src/sounds-and-recreation-app/transport.md`](../src/sounds-and-recreation-app/transport.md#inbound-message-flows) alongside the transport's other internals.

### See also

- [`src/sounds-and-recreation-app/transport.md`](../src/sounds-and-recreation-app/transport.md) — file-level walkthrough of `transport.ts` (every entry point, every protocol-state bit).
- [`src/shared/midi-codec.ts`](../src/shared/midi-codec.ts) — the `MidiCodec` interface contract.
- [`src/shared/keyboard-model.ts`](../src/shared/keyboard-model.ts) — the `MockHandler` interface contract.
