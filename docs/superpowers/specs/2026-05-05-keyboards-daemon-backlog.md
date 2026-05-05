---
mode: backlog
parent_topic: keyboards-daemon
mvp_spec: ./2026-05-05-keyboards-daemon-mvp.md
architectural_reference: ./2026-05-05-keyboards-daemon-design.md
---

# keyboards-daemon — Deferred Backlog

The MVP (Phase 1) ships a standalone control-plane daemon that brokers connection leases without touching MIDI or WebSockets. This backlog organizes the rest of the work into the phased migration toward the architecture in `2026-05-05-keyboards-daemon-design.md`. Each item is a stub — when picked up, run `superpowers:brainstorming` (or `mvp-brainstorm`) on it as a fresh topic.

## Phase 2 — MCP integration

Refactor the MCP to consume daemon-managed leases for connection establishment. The MCP's existing internal machinery (`MidiManager`, `StateManager`, `KeyboardDevice`, per-model schemas, validation, `validateParameterBatch`) stays in place — only the connection-establishment path changes.

- **Session bootstrap on MCP startup.** Before the first tool call, MCP `POST /v1/sessions`. Cache `sessionId` for the process lifetime. On reattach scenarios (transient HTTP drop on the same PID), `POST /v1/sessions/:id/attach`.
- **Daemon HTTP/UDS client in MCP.** New module `src/mcp-client/daemon-client.ts` (or similar — exact location decided in plan). Wraps `http` requests against the daemon socket; surfaces structured errors.
- **Refactor `connect_to_keyboard`.**
  - Drop existing args: `forward_port`, `auto_forward`, `auto_input`, `mock_ws_port`.
  - Add: `with_shadow`, require `model`.
  - Flow: tool layer collects user args → claim lease via `POST /v1/devices` → consume returned manifest → existing `MidiManager` opens MIDI/WS using the manifest → existing `KeyboardDevice` instantiation continues as today.
  - The bug fix lands here: `MidiManager` opens its mock-status WebSocket against the wsPort the daemon hands back, eliminating the wrong-port default.
- **`MidiManager` reads from manifest.** Drop the `mockWsPort`/`MOCK_WS_PORT` env fallback. Remove `setMockWsPort`, `attachMockStatusWs`, the connectMockWs side-effect inside `connectForward`. The manifest is the single source of truth for what to open.
- **Refactor `disconnect_from_keyboard`.** Tool calls `DELETE /v1/devices/:id` after closing local resources — or daemon's PID-liveness GC handles it if MCP exits without an explicit disconnect.
- **Refactor `is_connected` and `list_midi_devices`.** Read from daemon (`GET /v1/devices`, `GET /v1/midi/ports`) rather than from MCP-internal state. The MCP's local pool stays for ergonomic 1-based addressing of its own devices.
- **`set_parameters`, `get_current_state`, `list_parameters`, `extract_backup`, `load_program`, `load_song`, etc. — unchanged.** They continue operating on the MCP's local `KeyboardDevice` and `StateManager`. Daemon never sees them.
- **Update sibling repo.** `sound-recreation-agent`'s system prompt + README updated for the new tool surface (no more `forward_port`, `auto_forward`, etc.).
- **E2E tests.** Synced-pair workflow via the new `with_shadow` arg. Coverage parity verified against the deleted-args tests.

## Phase 3 — Mock-runner connection-viewer

A new view inside the mock-runner Electron shell that subscribes to the daemon's `/v1/events` SSE stream and renders, live: all sessions (PID + processName), all leases (model + owner), all bridges (master → shadow). Useful as an operator dashboard when multiple agent sessions are active. Architectural shape (per-mock window vs. shared global window vs. browser-served HTML page) is its own brainstorm.

## Cross-phase items (not phase-specific)

### OS service templates

- macOS LaunchAgent plist (`~/Library/LaunchAgents/com.uribrecher.keyboards-daemon.plist`). User-scoped agent.
- Linux systemd user unit (`~/.config/systemd/user/keyboards-daemon.service`).
- docker-compose example for CI: daemon container + headless mock-runner container, shared volume for the UDS socket.
- README addition documenting setup steps.

### Daemon CLI tool (`keyboards-daemon-cli`)

A small standalone CLI that talks to the daemon over the same UDS. Subcommands: `sessions list`, `devices list`, `events tail`, `kick <session-id>` (admin force-disconnect), `health`. Each subcommand is one HTTP call. Useful when no agent is around (debugging stuck state from a terminal).

### Daemon graceful shutdown

The MVP does basic teardown on SIGTERM/SIGINT. Upgrade to: stop accepting new connections, complete in-flight requests, drain SSE streams cleanly with a final `session-released` event for live subscribers, unlink socket file, exit.

### Stale UDS socket file probe-and-unlink at startup (production-grade)

The MVP includes basic probe-and-unlink. Improve to: `LOCAL_PEERPID`-based liveness check on the existing socket if reachable (distinguishes "another daemon alive" from "stale state"), structured logging of which path was taken at startup.

### Stale mock-registry entry purge on daemon startup

Mock-runner is responsible for `purgeStale()` at its own startup. If mock-runner is offline and a mock crashed, the registry has ghost entries that the daemon would surface. Add a defensive purge or a defensive filter on listing.

### SSE keepalive and resumability

Long-lived SSE connections need heartbeat lines (`:keepalive\n\n` every ~30s) or proxies/clients drop them. Add `Last-Event-Id` resumability so connection-viewer (or any subscriber) can recover events missed during a brief disconnect.

### PID-reuse guard on session attach

Record process start time alongside PID at session creation. On reattach, verify both PID *and* start time match — defends against the rare case where the original PID is reused by an unrelated process within the reattach window.

### State persistence across daemon restarts

A daemon restart loses session and lease state. If long-lived sessions become real and reconnect overhead bites, persist to disk on graceful shutdown and reload on start. Subtle: the leases were of OS resources held by MCPs; on daemon restart, MCPs would re-establish leases (since they have lost their lease grants). Defer until the failure mode bites.

### Force-takeover (T2)

The daemon's lock is reclaimed only by PID-liveness GC. If a workflow emerges where a stuck session needs immediate eviction, add `force: true` flag on `POST /v1/devices` (or a separate endpoint) that revokes another session's leases. Today's PID watcher handles the dead-session case; T2 covers the live-but-misbehaving case.

### Standalone bridge attach/detach endpoints

The MVP creates bridges only at `POST /v1/devices` time. To add or change a shadow on a live lease, the user must release and re-claim. If hot-swappable shadows become necessary, design `POST /v1/bridges` and `DELETE /v1/bridges/:masterDeviceId`. Cycle detection becomes load-bearing here.

### HW-shadows-HW workflows

The bridge metadata supports it (the daemon doesn't care if the shadow is a mock or another physical keyboard). No E2E coverage and no validated UX yet. Pick this up when there's a real workflow asking for it.

### `with_shadow` pointing at a connected pool entry

Currently rejected (avoid double-control of underlying state). If a workflow needs chains where every endpoint is independently addressable, design semantics for `set_parameters` when the same physical state is reachable via two devices.

### Multi-host coordination (TCP frontend)

UDS is local-only. If the daemon ever needs to be addressed from another host, add a TCP listener on top of the same handlers. Concerns: authentication (UDS gets it free via FS perms; TCP needs tokens), TLS, network exposure. Defer until specifically requested.

### Per-port "smart pair" input resolution

Strict resolution requires `input_port` to be passed explicitly. A common convention pairs output `Foo MIDI Input` with input `Foo MIDI Output`. A deterministic helper `derivePairedInputPort(outputPortName)` could fill this in when exactly one paired candidate exists. Defer; do NOT introduce as auto-detection — keep it as opt-in `input_port: "auto-pair"`.

### Concurrent disconnect race

If the owning session's PID dies while it's mid-`DELETE /v1/devices/:id`, two cleanup paths run concurrently. Make disconnect idempotent and re-entrant; lock around per-lease cleanup.

### Production-grade `500` handling

The MVP returns generic 500s with a generated error id. Add: log correlation, request-id header echoed in every response, optional structured-log JSON output toggle.

### Connection-viewer architectural shape

Pre-design item for Phase 3: per-mock Electron window vs. shared global window vs. browser-served HTML. Resolve before implementing.

### Body size limits & rate limiting

The MVP has no body-size cap. Add a sane default (~1MB). Rate limiting is probably overkill for a personal-rig tool but worth flagging if multi-tenant scenarios ever appear.
