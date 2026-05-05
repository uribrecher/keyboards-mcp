---
mode: backlog
parent_topic: keyboards-daemon
mvp_spec: ./2026-05-05-keyboards-daemon-mvp.md
architectural_reference: ./2026-05-05-keyboards-daemon-design.md
---

# keyboards-daemon — Deferred Backlog

The MVP (Phase 1) ships a standalone control-plane daemon with stubbed MIDI. This backlog organizes everything else into the phased migration toward the full architecture in `2026-05-05-keyboards-daemon-design.md`. Each item is a stub — when picked up, run `superpowers:brainstorming` (or `mvp-brainstorm`) on it as a fresh topic.

## Phase 2 — Real MIDI in the daemon

Replace the stubs introduced in the MVP with actual OS-resource ownership inside the daemon, while still not modifying any existing MCP or mock-runner code. After this phase, the daemon is functionally a standalone replacement for the current MCP's connection layer; the existing MCP still runs unchanged in parallel.

- **Real `Endpoint` with mock WS attachment.** Endpoint constructor opens `?client=mcp` WebSocket against the resolved mock's `wsPort` from the registry. Closes WS on dispose. This is where the original mock-UI bug fix lands.
- **Real `Bridge` with MIDI THRU.** Bridge owns an `easymidi.Output` to the shadow port (forward output) plus a callback wired into the master's input listener. Routes `master.send → shadow.input` and `master.input → shadow.input`. `Bridge.dispose()` closes the shadow `Endpoint` (which closes its WS) and the forward `Output`.
- **Real `MidiManager`-equivalent in the daemon.** Owns the primary `easymidi.Output` and optional `easymidi.Input`, wires the input listener into the bridge if any.
- **`StateManager` per device.** Lifted from existing `src/shared/parameter-state.ts` shape. Owned by the daemon's Device.
- **Model-specific code in the daemon.** `KeyboardModel`, `KeyboardDevice`, `MockHandler` interfaces; per-model factories; per-model `validateParameterBatch` (the disabled-section warnings shipped in PR #28 land here).
- **`GET /v1/devices/:id/state`** — returns structured JSON state (concrete schema TBD; see backlog item below).
- **`GET /v1/devices/:id/parameters`** — returns the model's parameter schema.
- **`GET /v1/schema`** — full keyboard-model schema dump for non-MCP clients.
- **Schema/runtime split per model.** Each model directory grows `index-schema.ts` (Zod schemas, parameter map, types) and `index-runtime.ts` (mock-handler, state-manager, validation, backup-parser). The daemon imports both; future MCP imports schema-only. Avoids bloating the MCP under M2.
- **Concrete schemas for `state` and `parameters` HTTP responses.** Today the existing tools format text per section. Decide: HTTP returns structured JSON and clients format on their side. Migrate the existing per-section formatting to client-side helpers.
- **Warning shape decision.** `POST /v1/devices/:id/parameters` returns `{ result, warnings: string[] }` — warnings are structured, no longer concatenated into a single text blob. The MCP (or any client) reformats for its target consumer.
- **Model-vs-port mismatch detection.** When connecting with `model: "X"` against a port resolved through the mock registry, verify the registry's recorded model matches; reject with `model-mismatch` otherwise.

## Phase 3 — MCP integration

Refactor the existing MCP server to be a thin HTTP client over the daemon's UDS. Drop all in-MCP OS-resource ownership.

- **MCP-side HTTP/UDS client.** `src/mcp/client.ts` — wraps `http` requests against the daemon socket, retries on transient failures, surfaces structured errors.
- **MCP-side session bootstrap.** On startup: `POST /v1/sessions`. Cache `sessionId`. Send `X-Session-Id` on every subsequent call. On reattach: `POST /v1/sessions/:id/attach` (used when MCP restarts within the daemon's reattach window).
- **MCP-side `Pool` (local working set).** `Map<localIdx (1-based), deviceId>`. Repopulated on attach via `GET /v1/sessions/:id/devices`. Provides `pool.resolve(device?)` (auto-pick if one, error if many) — same ergonomics as today.
- **Tool rewrites.** Each `src/tools/*.ts` becomes a thin relay: translate args → HTTP call → format response. Drop `connect_to_keyboard`'s removed args (`forward_port`, `auto_forward`, `auto_input`, `mock_ws_port`); add `with_shadow`, require `model`.
- **Drop in-MCP infrastructure.** Delete `src/shared/device-pool.ts`, `src/shared/keyboard-model.ts`, `src/shared/base-keyboard-device.ts`, `src/midi/midi-manager.ts`, the runtime parts of every model directory. Keep schemas (per the schema/runtime split from Phase 2).
- **Reattach-window stable device order.** `GET /v1/sessions/:id/devices` returns devices in connection-time order so the MCP can re-establish 1-based indices stably across transient drops.
- **Tests rewrite.** Existing E2E tests using `forward_port`/`auto_forward`/`auto_input`/`mock_ws_port` are deleted; replacements cover synced-pair via the new `with_shadow` + `input_port` args. Coverage parity verified explicitly.
- **Sibling repo update.** `sound-recreation-agent`'s system prompt and README updated for the new tool surface; verify the MCP slots in cleanly.

## Phase 4 — Mock-runner integration

- **Connection-viewer view in mock-runner.** A new view inside the Electron shell that subscribes to the daemon's `/v1/events` SSE stream and renders, live: all sessions (PID + processName), all devices (model + owner session), all bridges (master → shadow). The architectural shape (per-mock window vs. shared global window) is its own brainstorm.
- **Mock-runner stays the registrar of mocks.** Mocks continue to register themselves via the file-backed registry; the daemon reads, never owns mocks.

## Cross-phase backlog items (not phase-specific)

### OS service templates

- macOS LaunchAgent plist (`~/Library/LaunchAgents/com.uribrecher.keyboards-daemon.plist`). User-scoped agent (not system daemon).
- Linux systemd user unit (`~/.config/systemd/user/keyboards-daemon.service`).
- docker-compose example for CI: daemon container + headless mock-runner container, shared volume for the UDS socket.
- README addition documenting setup steps for each environment.

### Daemon CLI tool (`keyboards-daemon-cli`)

A small standalone CLI that talks to the daemon over the same UDS. Subcommands: `sessions list`, `devices list`, `events tail`, `kick <session-id>` (admin force-disconnect), `health`. Each subcommand is one HTTP call. Useful when no agent is around (debugging stuck state from a terminal).

### Daemon graceful shutdown

On `SIGTERM`/`SIGINT`: stop accepting new connections, complete in-flight requests, close all SSE streams, close OS resources (MIDI ports, WS connections), unlink the UDS socket file, exit. The MVP does basic teardown; this item upgrades to production-quality drain.

### Stale UDS socket file probe-and-unlink at startup

The MVP includes a basic probe-and-unlink. Improve to: include an `LOCAL_PEERPID`-based liveness check on the existing socket if reachable (so we can distinguish "another daemon alive" from "stale state"), and always log clearly which path was taken at startup.

### Stale mock-registry entry purge on daemon startup

Mock-runner is responsible for `purgeStale()` at its own startup. If mock-runner is offline and a mock crashed, the registry has ghost entries that the daemon would surface. Add a defensive purge or a defensive filter on listing.

### SSE keepalive and resumability

Long-lived SSE connections need heartbeat lines (`:keepalive\n\n` every ~30s) or proxies/clients drop them. Add `Last-Event-Id` resumability so connection-viewer (or any subscriber) can recover events missed during a brief disconnect.

### PID-reuse guard on session attach

Record process start time alongside PID at session creation. On reattach, verify both PID *and* start time match — defends against the rare case where the original PID dies, gets reused by an unrelated process, and that process happens to attach to a stale session within the reattach window.

### State persistence across daemon restarts

A daemon restart loses session and device state. If long-lived sessions become real and reconnect overhead bites, persist `{ sessions, devices, bridges }` to disk on graceful shutdown and reload on start. Tricky parts: re-attaching to OS MIDI ports (port name might no longer exist), reconciling differences with mock registry. Defer until the failure mode bites.

### Force-takeover (T2)

The MVP+Phase 2+3 daemon's lock is reclaimed only by PID-liveness GC. If a workflow emerges where a stuck session needs immediate eviction, add `force: true` flag on `POST /v1/devices` (or a separate `POST /v1/sessions/:id/force-disconnect` endpoint) that revokes another session's locks. Today's PID watcher handles the dead-session case; T2 covers the live-but-misbehaving case.

### Standalone bridge attach/detach endpoints

The MVP creates bridges only at connect time via `with_shadow`. To add or change a shadow on an already-connected device, the user must disconnect and reconnect. If a workflow needs hot-swappable shadows, design `POST /v1/bridges` and `DELETE /v1/bridges/:masterDeviceId`. Cycle detection becomes load-bearing here (vacuous-but-defensive in the MVP).

### HW-shadows-HW workflows

The bridge supports the mechanism (the `Bridge` class doesn't care if the shadow is a mock or another physical keyboard), but no E2E coverage and no validated UX for "connect Nord-A with `with_shadow=Nord-B-port`". Pick this up when there's a real workflow asking for it.

### `with_shadow` pointing at a connected pool entry

Currently rejected (avoid double-control of underlying state). If a workflow needs chains where every endpoint is independently addressable, design how `set_parameters` should behave when the same physical state is reachable via two devices.

### Multi-host coordination (TCP frontend)

UDS is local-only. If the daemon ever needs to be addressed from another host (rare for a personal-rig tool), add a TCP listener on top of the same handlers. Concerns: authentication (UDS gets it free via FS perms; TCP needs tokens), TLS, network exposure. Defer until specifically requested.

### Per-port "smart pair" input resolution

Strict resolution requires `input_port` to be passed explicitly. A common convention pairs output `Foo MIDI Input` with input `Foo MIDI Output`. A deterministic helper `derivePairedInputPort(outputPortName)` could fill this in when exactly one paired candidate exists. Defer; do NOT introduce as auto-detection — keep it as opt-in `input_port: "auto-pair"`.

### Per-endpoint state introspection

The shadow's mock process maintains its own state independently. Currently no daemon endpoint exposes "what does the shadow think the state is?" — only the master's view. If desync debugging becomes useful, add `GET /v1/devices/:id/shadow-state` that pulls from the mock process via its WebSocket.

### Session quotas / per-session resource caps

If many sessions accumulate (long-running agents that don't always disconnect), the daemon could cap devices per session, total bridges, etc. Out of scope until observed.

### Concrete error catalogue

The MVP enumerates error codes inline. Promote to a single `errors.ts` module with exported constants and a typed error catalogue. Lands naturally during Phase 2 or 3.

### Production-grade `500` handling

The MVP returns generic 500s without stack traces. Add traceable error ids correlated with daemon-side logs. Add a request-id header echoed in every response.

### Concurrent disconnect race

If the owning session's PID dies while it's mid-`DELETE /v1/devices/:id`, two cleanup paths run concurrently. Make disconnect idempotent and re-entrant; lock around per-device cleanup.

### Connection-viewer architectural shape

Pre-design item for Phase 4: per-mock Electron window vs. shared global window vs. browser-served HTML. Resolve before implementing the connection-viewer.
