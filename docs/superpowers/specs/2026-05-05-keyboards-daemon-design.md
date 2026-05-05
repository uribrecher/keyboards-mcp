---
status: draft
backlog: ./2026-05-05-keyboards-daemon-backlog.md
---

# keyboards-daemon — Design

## Goal

Reshape `keyboards-mcp` so that all OS resources (MIDI ports, mock-UI WebSockets, the device pool, parameter state, bridges) are owned by a single long-running OS-managed process — `keyboards-daemon` — and the MCP server becomes a thin HTTP client over a Unix domain socket. The daemon is the single source of truth for what is connected, who owns what, and what the canonical state of every connected keyboard is. Multiple agent sessions can run concurrent MCP servers without stepping on each other.

## Why a daemon

The pre-daemon architecture put the connection layer inside the MCP server process. MIDI ports, mock-UI WebSocket clients, and bridges are all OS-singleton resources, but each MCP process held its own view of them. With multiple concurrent agent sessions, two MCPs would each open the same MIDI Output, each maintain its own `StateManager`, each create its own `?client=mcp` WebSocket against a mock — and silently disagree on what the kit is doing. The mock-UI status WS bug fixed in PR #28 is a symptom of the same underlying mismatch. Solving that bug correctly required moving the singleton concerns out of the per-session MCP into a real OS-level singleton.

## Non-goals

- Multi-host coordination. The daemon listens only on a Unix domain socket. Cross-host control is out of scope; if it ever matters, add a TCP frontend later.
- Persistence of session/device state across daemon restarts. A daemon restart is a clean boot: all sessions and their devices are torn down, MCPs reconnect from scratch.
- Automatic takeover of locked devices (T2). Live conflicts are hard-rejected (T1).
- Owning mock processes. Mocks remain user-launched (`npm run mock:runner`) and continue to register themselves in the file-based mock registry. The daemon reads the registry; it does not start, monitor, or kill mocks.
- A daemon CLI tool (`keyboards-daemon-cli`) for operators. Useful but separable; lives in the backlog.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Host OS                                                                      │
│                                                                              │
│  Agent A          Agent B                                                    │
│    │ stdio          │ stdio                                                  │
│    ▼                ▼                                                        │
│  keyboards-mcp A  keyboards-mcp B   ← thin HTTP/UDS clients                  │
│    │ HTTP/UDS       │ HTTP/UDS                                               │
│    └────────┬───────┘                                                        │
│             ▼                                                                │
│   ┌──────────────────────────────────────────┐                               │
│   │ keyboards-daemon  (launchd / systemd)    │                               │
│   │                                          │                               │
│   │   sessions  • device pool  • bridges     │                               │
│   │   StateManager per device  • locks       │                               │
│   │   Endpoint per port (mock WS attached)   │                               │
│   │   PortResolver  • PID liveness watcher   │                               │
│   │                                          │                               │
│   │   reads file-backed mock-registry        │                               │
│   └──────┬─────────────┬─────────────────────┘                               │
│          │ MIDI         │ HTTP+SSE                                           │
│          ▼              ▼                                                    │
│   Real keyboards   mock-runner UI(s)   ← user-launched, unchanged for now    │
│                    + future connection-viewer subscriber                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Three process kinds:**

| Process | Role | Lifetime | Started by |
|---|---|---|---|
| `keyboards-daemon` | Owns OS resources, single source of truth, HTTP server over UDS. | Long-running. Auto-restarts via launchd / systemd. | OS at login (macOS LaunchAgent) or at boot (Linux user systemd unit) or via `docker-compose up` in CI. |
| `keyboards-mcp` | Stdio MCP server. Translates MCP tool calls into daemon HTTP calls. Owns its session ID and a local working-set pool. | Per-agent-session. | Agent host (Claude Code, etc.) as a child process. |
| `mock-runner` | Electron UI host for keyboard mocks. Independent of the daemon for now. | User-launched, long-running. | `npm run mock:runner` |

**Sole IPC channel** between MCP, daemon, mock-runner UIs (subscribers): a Unix domain socket at `${KEYBOARDS_DAEMON_SOCKET}` (default `~/.keyboards-daemon/sock`, perms `0600`). All HTTP, with `text/event-stream` SSE for push subscriptions.

## Concepts

| Name | Owned by | Role | State? | Identity |
|---|---|---|---|---|
| `Endpoint` | Daemon. Created by `Device` (primary) or `Bridge` (shadow). | A MIDI port. Opens its own status WS iff it is a registered mock. | No (the WS is just a signal channel). | OS port name. |
| `Device` | Daemon-side `Pool`. | A connected keyboard. Owns: primary `Endpoint`, optional input listener, `StateManager`, optional `Bridge` reference. | Yes (`StateManager`). | Daemon-issued opaque `deviceId` (UUID-like; non-numeric so MCPs don't accidentally collide their local indices with global IDs). |
| `Bridge` | Daemon-side `BridgeRegistry`. Held by reference from the master `Device`. | Pure software MIDI THRU. Routes `master.send → shadow.input` (outgoing tee) AND `master.input → shadow.input` (input forward). Holds the shadow `Endpoint` (and so its WS). | No (no domain state; holds OS resources). | None — collapses if either endpoint disappears. |
| `BridgeRegistry` | Daemon-singleton. | `Map<masterDeviceId, ShadowPortName>`. Owns cardinality (1-to-1), cycle detection, `isShadowTarget(portName)` queries. | Bookkeeping only. | Singleton. |
| `Session` | Daemon-side `SessionManager`. | Identifies an MCP client. Tracks owned `deviceId`s, peer PID for liveness, reattach window. | Bookkeeping. | Daemon-issued `sessionId` (UUID). |
| `Pool` (MCP-side) | Each MCP server. Per-session local concept. | The MCP's working set: 1-based local index → daemon `deviceId`. | Local mapping only. | None (per-MCP). |

**Key invariants:**

- A device has exactly one master and at most one shadow. (Cardinality A.)
- A port can be the shadow target of at most one bridge.
- A port that is currently a shadow target cannot become a primary connection (rejected at connect).
- A port that is currently a primary cannot become a shadow target (rejected at bridge creation).
- Master and shadow ports must differ (no self-shadow).
- The bridge graph is acyclic (defensive — vacuous under the current connect-only API but enforced at registry level).
- A primary port can be owned by at most one session (one device per port).
- All `StateManager` instances live in the daemon. The MCP never instantiates one.
- All `KeyboardDevice` instances live in the daemon. The MCP imports schemas only.

## Daemon HTTP API

All paths under `/v1/`. `Content-Type: application/json` for requests and responses unless noted. Errors are `{ error: <code>, message: <human>, details?: <obj> }` with appropriate HTTP status.

### Sessions

| Method | Path | Body / Headers | Response | Notes |
|---|---|---|---|---|
| `POST` | `/v1/sessions` | `{ processName?: string }` | `{ sessionId, ownerPid }` | Daemon reads peer PID via `SO_PEERCRED` (Linux) / `LOCAL_PEERPID` (macOS). |
| `POST` | `/v1/sessions/:id/attach` | (none) | `{ sessionId, ownerPid }` or `404` | Re-claim. PID must match. Available within reattach window (default 30s after PID death; spec uses 0 for live PIDs). |
| `DELETE` | `/v1/sessions/:id` | header `X-Session-Id: <self>` | `204` | Explicit teardown. Implicit on PID death. |
| `GET` | `/v1/sessions/:id/devices` | (none) | `[{ deviceId, model, port, label, shadows? }]` | Read-open. Used by MCP on attach to rebuild its local pool. |

### Devices

| Method | Path | Body / Headers | Response | Notes |
|---|---|---|---|---|
| `POST` | `/v1/devices` | `{ port, model, with_shadow?, input_port?, label?, channel?, lower_channel?, upper_channel? }` + `X-Session-Id` | `{ deviceId, model, port, label, shadows?, ... }` | All resolution and validation runs in daemon. `model` is required (MI-b). |
| `GET` | `/v1/devices` | (none) | `[{ deviceId, model, port, label, ownerSessionId, shadows? }]` | Read-open. Lists all devices across all sessions. |
| `GET` | `/v1/devices/:id` | (none) | Single device record. | Read-open. |
| `GET` | `/v1/devices/:id/state` | (none) | `{ <param>: <value>, ... }` | Read-open. Dump of the device's `StateManager`. |
| `GET` | `/v1/devices/:id/parameters` | (none) | Schema dump (parameter names, types, descriptions). | Read-open. |
| `POST` | `/v1/devices/:id/parameters` | `{ parameters: [{ key, value }], part? }` + `X-Session-Id` | `{ result, warnings: [...] }` | Owner-only. 403 otherwise. |
| `DELETE` | `/v1/devices/:id` | `X-Session-Id` | `204` | Owner-only. Tears down primary endpoint, input listener, and bridge (if any). |

### MIDI ports & introspection

| Method | Path | Response | Notes |
|---|---|---|---|
| `GET` | `/v1/midi/ports` | `{ outputs: [{ name, mockLabel?, wsPort?, ownedBy?, shadowedBy? }], inputs: [{ name }] }` | Read-open. Reflects current OS state + mock registry + daemon's session/bridge view. |
| `GET` | `/v1/schema` | `{ models: [{ id, displayName, parameters: {...} }, ...] }` | Read-open. Mostly redundant under M2 since MCP imports schemas; useful for non-MCP clients (UI, scripts). |
| `GET` | `/v1/health` | `{ ok: true, uptimeSec, sessionsActive, devicesConnected }` | No auth. |

### Events (SSE)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/events` | `Content-Type: text/event-stream`. JSON event lines. Read-open; any client (other MCPs, mock-runner connection-viewer, scripts) can subscribe. |

Event types:
- `session-created`, `session-released` — `{ sessionId, processName?, pid }`
- `device-connected`, `device-disconnected` — `{ deviceId, model, port, ownerSessionId, label, shadows? }`
- `bridge-created`, `bridge-removed` — `{ masterDeviceId, shadowPort }`
- `parameters-set` — `{ deviceId, ownerSessionId, changedParameters: [{ key, prevValue?, value }] }`
- `state-changed-from-input` — `{ deviceId, changes: [{ key, prevValue?, value }] }` (for messages received via the input listener — e.g., physical knob movements on real hw)

## Strict port resolution

Lives daemon-side. Same algorithm for `port`, `with_shadow`, `input_port`. Direction-aware.

Given a string argument `arg` and a direction (`output` for `port`/`with_shadow`, `input` for `input_port`):

1. **Mock label exact match** (output direction only): if `arg` exactly equals a mock label in the file-based registry → use that mock's `midiPort`. Mock labels resolve only for output; mocks have no OS Input port direction.
2. **OS port exact match**: if `arg` exactly equals a port name in the relevant direction's OS list → use it.
3. **Zero matches** → `400 Bad Request` with `{ error: "port-not-found", message, details: { arg, availableMockLabels: [...], availableOsPorts: [...] } }`.
4. **More than one match** (label-vs-OS-name collision, or OS duplicates — rare on macOS/Linux, but possible) → `400` with `{ error: "ambiguous-port", details: { arg, candidates: [...] } }`.
5. **OS-visibility re-check**: after resolving via mock registry, the daemon verifies the resolved OS port is currently visible to easymidi. If the mock died between registration and the call, fail with `port-not-found`.

No substring fallback. No model-pattern guessing. No fuzzy matching of any kind. The agent owns disambiguation; it has `/v1/midi/ports` to discover names.

## Connect flow

`POST /v1/devices` with `{ port, model, with_shadow?, input_port?, label?, channel?, lower_channel?, upper_channel? }` + `X-Session-Id`:

1. Verify session exists.
2. Resolve `port` (output direction). Reject if it is currently a shadow target (`409 Conflict`, `port-is-shadow`). Reject if it is currently another device's primary (`409 Conflict`, `port-already-owned`).
3. Resolve `with_shadow` (output direction) if given. Reject if it is currently a primary or another bridge's shadow target. Reject self-shadow (`port` and `with_shadow` resolve to same OS port). Run cycle detection.
4. Resolve `input_port` (input direction) if given. Reject if it's a mock label (mocks have no input direction).
5. Validate `model` is a known model identifier.
6. Construct primary `Endpoint` (opens its WS if mock).
7. Construct `Device` (StateManager, MidiManager-equivalent, optional input listener). Add to daemon's pool. Assign `deviceId`.
8. If `with_shadow`: `BridgeRegistry.add(deviceId, shadowPortName)` — constructs `Bridge`, which creates the shadow `Endpoint` (opens WS if shadow is a mock — **the bug fix lands here**), opens the forward `Output`, wires the input-listener forwarding callback.
9. Record the device under the session's ownership.
10. Emit `device-connected` and (if applicable) `bridge-created` SSE events.
11. Return the device record.

## Disconnect flow

`DELETE /v1/devices/:id` (owner-only, or implicit via session GC):

1. If the device has a `Bridge`: `Bridge.dispose()` — closes shadow `Endpoint` (which closes its WS — addresses the "shadow WS lingers" gap), closes forward `Output`, removes from `BridgeRegistry`. Emit `bridge-removed`.
2. Close primary `Endpoint` (closes WS if mock, closes primary `Output`).
3. Close input listener if any.
4. Remove from daemon's pool. Drop `deviceId` from session's owned set.
5. Emit `device-disconnected`.

## Set-parameters flow

`POST /v1/devices/:id/parameters` (owner-only):

1. Verify `X-Session-Id` matches device's owner session. 403 otherwise.
2. Resolve each parameter against the device's model schema. Type-check values.
3. For each parameter, update `StateManager` and call `MidiManager.send(...)`. The MidiManager's outgoing-tee fans to the bridge if present; the bridge sends to the shadow `Output` (no WS involvement — WS is status-only).
4. Run model-specific validation (e.g., `validateParameterBatch` for Nord — the disabled-section warnings already shipped). Collect warnings.
5. Emit `parameters-set` SSE event.
6. Return `{ result: <text>, warnings: [...] }`.

## Read flows (R1)

Any session can call:
- `GET /v1/devices`
- `GET /v1/devices/:id`
- `GET /v1/devices/:id/state`
- `GET /v1/devices/:id/parameters`
- `GET /v1/midi/ports`
- `GET /v1/sessions/:id/devices` (any session can ask about any other session's owned devices)
- `GET /v1/events`

Mutating endpoints (`POST /v1/devices`, `POST /v1/devices/:id/parameters`, `DELETE /v1/devices/:id`) require the requester's session to own the device.

## Session lifecycle

- **Create**: `POST /v1/sessions`. Daemon assigns UUID, records peer PID, processName.
- **Liveness**: daemon polls owned PIDs at 1Hz (or uses kqueue/inotify-equivalent on platforms that support it). Ten consecutive misses → mark session dead; tear down owned devices, release locks, emit `session-released`. Tunable.
- **Reattach**: `POST /v1/sessions/:id/attach`. Allowed if (a) the session is still live OR (b) the session has been marked dead within the last 30s AND the calling PID matches the original. After 30s: hard GC, attach returns 404. Tunable; 30s default balances "agent restart from a transient crash" against "stale lock retention".
- **Explicit close**: `DELETE /v1/sessions/:id` performs the same cleanup as PID-death GC, plus emits `session-released`.

## Locking & access control (R1 + T1)

- **Per-device write lock.** Owned by the session that called `POST /v1/devices`. Mutations (`POST /v1/devices/:id/parameters`, `DELETE /v1/devices/:id`, future bridge-mutating endpoints) require the requester to be the owner.
- **Read-open everything else.** Listing, state, schema, events: any session, mock-runner UI, ad-hoc curl client.
- **Hard reject on conflict** (T1): `POST /v1/devices` for a port already a primary returns `409 Conflict` with the owning session's identifier. The agent guides the user to disconnect the holder.
- **No takeover.** No force flag. No queue. The PID-liveness GC is the only way a stale lock is reclaimed.

## Code split (M2)

```
keyboards-mcp/
  src/
    shared/                       # imported by both daemon and MCP
      keyboard-model.ts            # interfaces (KeyboardModel, KeyboardDevice, MockHandler, etc.)
      types.ts                     # ParamEncoding, KeyboardParameter
      parameter-resolution.ts
      tool-result.ts
      mock-registry.ts             # file-backed; UNCHANGED
    keyboard_models/               # imported by both
      nord/electro_5d/             # daemon uses full impl + mock-handler;
      roland/juno_x/               # MCP uses only schemas (parameter map + model id)
      sequential_circuits/prophet_6/
    daemon/                       # NEW. Daemon-side runtime.
      index.ts                     # node bin entry (shebang, parses env, listens UDS)
      http/
        server.ts                  # request routing
        sessions.ts                # session endpoints
        devices.ts                 # device endpoints
        ports.ts                   # /v1/midi/ports
        events.ts                  # SSE handler
        errors.ts                  # error formatting
      pool.ts                      # daemon-owned device pool (deviceId-keyed)
      port-resolver.ts             # strict resolution
      session-manager.ts           # session lifecycle, PID liveness watcher
      endpoint.ts                  # Endpoint class
      bridge.ts                    # Bridge class
      bridge-registry.ts           # BridgeRegistry singleton
      midi-manager.ts              # MOVED + reshaped from src/midi/
      registry-watcher.ts          # fs.watch on mock-registry path
    mcp/                          # NEW. MCP-side runtime (was src/index.ts + src/tools/).
      index.ts                     # MCP stdio server bootstrap (existing entry, refactored)
      client.ts                    # daemon HTTP client over UDS
      session.ts                   # MCP-side session: session-id + reattach
      pool.ts                      # local 1-based working set: Map<localIdx, deviceId>
      tools/
        connect.ts                 # POST /v1/devices
        disconnect.ts              # DELETE /v1/devices/:id
        is-connected.ts            # local pool listing
        list-midi-devices.ts       # GET /v1/midi/ports
        list-parameters.ts         # GET /v1/devices/:id/parameters
        get-current-state.ts       # GET /v1/devices/:id/state
        list-programs.ts, list-songs.ts, load-program.ts, load-song.ts,
        extract-backup.ts, get-last-backup-location.ts, get-system-prompt.ts
        # All become thin HTTP relays.
    mock-runner/                  # UNCHANGED for now.
  package.json                    # adds bin: { keyboards-daemon: ./dist/daemon/index.js }
                                  # mcp entry: ./dist/mcp/index.js
```

Build artifacts:
- `dist/daemon/index.js` — single Node entry; the `keyboards-daemon` bin.
- `dist/mcp/index.js` — MCP stdio entry; thin HTTP client.

## Mock-registry interaction

- File location and schema: unchanged.
- Daemon reads on every relevant request (port listing, label resolution).
- Daemon also runs an `fs.watch` on the registry path to react to mock add/remove without polling — used to fire `port-list-changed` SSE events for live UIs.
- Daemon does **not** purge stale entries (that's the registry library's responsibility, called by mock-runner on its own startup). The daemon defensively re-checks OS visibility for every resolved port (the visibility re-check noted in the resolver).

## Error model

HTTP status codes:
- `200 OK` / `201 Created` / `204 No Content` for success.
- `400 Bad Request` for malformed input or strict-resolution failure (`port-not-found`, `ambiguous-port`, `unknown-model`, `invalid-parameter`).
- `403 Forbidden` for write attempts by non-owner sessions.
- `404 Not Found` for missing session, device, or attach window expired.
- `409 Conflict` for ownership conflicts (`port-already-owned`, `port-is-shadow`, `shadow-conflict`, `cycle-would-form`, `self-shadow`, `bridge-already-exists`).
- `500 Internal Server Error` for unexpected failures (with a traceable error id in the body).

Body shape: `{ error: <code-string>, message: <human-string>, details?: <obj> }`.

The MCP relays the error code into the tool's error response.

## Testing strategy

Three test layers map cleanly onto the new architecture:

**Unit tests** (run by node:test against source via tsx — same as today):
- `daemon/port-resolver.test.ts` — strict resolution. Stubs the mock registry via dependency injection (the resolver takes a `RegistryReader` interface).
- `daemon/bridge-registry.test.ts` — cardinality, cycle detection, self-shadow.
- `daemon/session-manager.test.ts` — session create / attach / GC. PID-liveness mocked via injected `LivenessChecker`.
- `daemon/endpoint.test.ts` — Endpoint with mock label opens WS to registered port; non-mock opens no WS. Uses an in-memory WebSocket server.
- `mcp/client.test.ts` — HTTP-over-UDS client against an in-memory daemon stub.
- `mcp/pool.test.ts` — local pool indexing, `resolve(device?)` semantics.

**Integration tests** (spawn real daemon process + headless mocks):
- `tests/integration/daemon-lifecycle.test.ts` — start daemon, create session, connect mock, verify state, disconnect, verify cleanup.
- `tests/integration/multi-session.test.ts` — two MCP-equivalent clients, each with its own session; verify lock isolation, R1 read-across, T1 reject on conflict.
- `tests/integration/bridge-ws.test.ts` — connect with `with_shadow`, assert the shadow mock receives `mcpConnected: true` (the original bug).
- `tests/integration/pid-liveness.test.ts` — kill a session's PID, verify daemon GCs the session within the configured window.
- `tests/integration/mock-runner.test.ts` (existing) — verify mock-runner still spawns and registers correctly; the daemon doesn't interfere.

**E2E tests** (full agent → MCP → daemon → mock):
- `tests/e2e/connect.test.ts` (rewritten) — uses new `POST /v1/devices` semantics.
- `tests/e2e/set-parameters.test.ts` (rewritten) — exercises owner-only write.
- `tests/e2e/multi-model.test.ts` (rewritten).

Tests for `auto_input`/`auto_forward`/`mock_ws_port`/`forward_port` semantics are deleted along with those args.

## Migration plan

This is a hard rewrite. The plan (separate document) sequences the work; this section names only the major waves.

1. **Daemon-side foundation.** Lift `keyboard-model.ts`, `parameter-resolution.ts`, `tool-result.ts`, the keyboard model implementations, and the existing `MidiManager` into the daemon entry point. Build `Endpoint`, `Bridge`, `BridgeRegistry`, `PortResolver`, `SessionManager`, daemon-side `Pool`. Add unit tests.
2. **Daemon HTTP server.** Implement endpoints behind feature flag. Build SSE event emitter.
3. **MCP HTTP client + thin tools.** Refactor each tool from `src/tools/` into a relay that calls the daemon. Build local pool. Build session bootstrap.
4. **End-to-end smoke** against headless mocks. Fix integration test infrastructure.
5. **OS service templates.** macOS LaunchAgent plist, Linux systemd user unit, docker-compose example. Documentation.
6. **Sibling repo update**: `sound-recreation-agent`'s system prompt + README; verify the MCP server still slots in cleanly.
7. **Delete** `auto_input`, `auto_forward`, `mock_ws_port`, `forward_port`. Delete `attachMockStatusWs`, `connectMockWs`, `setMockWsPort` from `MidiManager`.

No deprecation period; no version aliasing. Sibling repo is the only consumer.

## Backlog

See `2026-05-05-keyboards-daemon-backlog.md`.

## Notes

- **Does not address** the disabled-section warnings already shipped in PR #28; those carry into the daemon as part of `validateParameterBatch` migration. No semantic change.
- **State is per-device, not per-session.** Two sessions reading the same device see the same state.
- **The daemon's process model assumes one daemon per host.** If a second daemon binary launches against the same socket path, the second exits with `EADDRINUSE`. Document this. CI containers should each have their own socket path inside their respective ephemeral filesystem.
