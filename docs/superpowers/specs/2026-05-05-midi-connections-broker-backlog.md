---
mode: backlog
parent_topic: midi-connections-broker
mvp_spec: ./2026-05-05-midi-connections-broker-mvp.md
architectural_reference: ./2026-05-05-midi-connections-broker-design.md
---

# midi-connections-broker (MCB) — Deferred Backlog

The MVP (Phase 1) ships a standalone control-plane MCB that brokers connection leases without touching MIDI or WebSockets. This backlog organizes the rest of the work into the phased migration toward the architecture in `2026-05-05-midi-connections-broker-design.md`. Each item is a stub — when picked up, run `superpowers:brainstorming` (or `mvp-brainstorm`) on it as a fresh topic.

## Phase 2 — MCP integration

Core integration shipped in PR #31 (and PID-liveness reaper in #33). Remaining open follow-ups:

- **`list_midi_devices` reading from MCB.** Today the tool reads MCP-internal pool only. Needs a new MCB endpoint `GET /v1/midi/ports` (enumerate node-midi ports + cross-reference active leases) before MCP can flip. Without it, MCP-local state hides leases held by other agent sessions.
- **Session attach + MCB-crash recovery.** `POST /v1/sessions/:id/attach` plus a re-claim path so MCPs survive an MCB restart/crash with their leases intact. Two layers: (a) MCPs detect MCB unreachable, retry, and re-claim using their cached `sessionId` + manifest (handles crash); (b) optional disk-persistence on graceful shutdown so MCB doesn't need re-claim on a clean restart. (a) is the load-bearing piece. Pairs with the cross-phase "PID-reuse guard on session attach" item below.
- **E2E harness MCB fixture.** Four e2e blocks are tagged `skip: true /* phase-2 follow-up: legacy args + MCB fixture */`: `multi-device.test.ts`, `label-discovery.test.ts`, `backup-per-instance.test.ts`, and the three-concurrent-mocks block in `multi-model.test.ts`. To un-skip, `MultiDeviceHarness` (and its callers) need to spawn an MCB instance — UDS socket setup, lifecycle wiring, teardown. Strip the dead legacy args (`mock_ws_port`, `auto_input`, `auto_forward`) inside the test bodies in the same pass.

Settled and explicitly NOT open:
- `connect_to_keyboard` arg surface — already cleaned (`auto_input`, `auto_forward`, `forward_port`, `mock_ws_port` all removed in #31). Explicit `input_port` stays — it's load-bearing for hw→shadow knob mirroring, no auto-pair sentinel planned.
- `MOCK_WS_URL` (CI / docker-compose path) — preserved as the no-MCB transport. Not deferred work.

## Phase 3 — Mock-runner connection-viewer

A new view inside the mock-runner Electron shell that subscribes to MCB's `/v1/events` SSE stream and renders, live: all sessions (PID + processName), all leases (model + owner), all bridges (master → shadow). Useful as an operator dashboard when multiple agent sessions are active. Architectural shape (per-mock window vs. shared global window vs. browser-served HTML page) is its own brainstorm.

**Minimal stepping-stone (sub-MVP):** in each existing per-mock window, augment the "MCP CONNECTED" boolean indicator with the owning session's `processName` + `pid`. Implementation: mock-runner adds an MCB client (SSE on `/v1/events`, or even just a poll of `GET /v1/devices` every few seconds) and finds the lease whose primary or shadow port matches its own midiPort. Cheaper than the full operator view; useful when you have multiple agent sessions and want to know which one is driving each mock.

## Cross-phase items (not phase-specific)

### OS service templates

- macOS LaunchAgent plist (`~/Library/LaunchAgents/com.uribrecher.midi-connections-broker.plist`). User-scoped agent.
- Linux systemd user unit (`~/.config/systemd/user/midi-connections-broker.service`).
- docker-compose example for CI: MCB container + headless mock-runner container, shared volume for the UDS socket.
- README addition documenting setup steps.

### MCB CLI tool (`mcb-cli`)

A small standalone CLI that talks to MCB over the same UDS. Subcommands: `sessions list`, `devices list`, `events tail`, `kick <session-id>` (admin force-disconnect), `health`. Each subcommand is one HTTP call. Useful when no agent is around (debugging stuck state from a terminal).

### Graceful shutdown

The MVP spec called for SIGTERM/SIGINT teardown but the shipped code in `src/mcb/index.ts` doesn't register either handler — on signal, the process exits with the UDS listener still bound and the socket file left behind. Baseline work: install handlers that close the UDS listener and unlink the socket. Follow-up upgrade: stop accepting new connections, complete in-flight requests, drain SSE streams cleanly with a final `session-released` event for live subscribers.

### Stale UDS socket file probe-and-unlink at startup

Same gap: the MVP spec called for probe-and-unlink but the shipped MCB binds the UDS path unconditionally, so an ungraceful prior shutdown leaves a stale socket and the next `npm run mcb` fails with `EADDRINUSE` until manually `rm`'d. Baseline work: at startup, if the socket file exists, attempt `GET /v1/health` against it; on success exit with "another MCB is alive"; on connect refusal, unlink and bind. Follow-up upgrade: `LOCAL_PEERPID`-based liveness check (distinguishes "another MCB alive" from "stale state"), structured logging of which path was taken at startup.

### Stale mock-registry entry purge on MCB startup

Mock-runner is responsible for `purgeStale()` at its own startup. If mock-runner is offline and a mock crashed, the registry has ghost entries that MCB would surface. Add a defensive purge or a defensive filter on listing.

### SSE keepalive and resumability

Long-lived SSE connections need heartbeat lines (`:keepalive\n\n` every ~30s) or proxies/clients drop them. Add `Last-Event-Id` resumability so connection-viewer (or any subscriber) can recover events missed during a brief disconnect.

### PID-reuse guard on session attach

Record process start time alongside PID at session creation. On reattach, verify both PID *and* start time match — defends against the rare case where the original PID is reused by an unrelated process within the reattach window.

### State persistence across MCB restarts

An MCB restart loses session and lease state. If long-lived sessions become real and reconnect overhead bites, persist to disk on graceful shutdown and reload on start. Subtle: the leases were of OS resources held by MCPs; on MCB restart, MCPs would re-establish leases (since they have lost their lease grants). Defer until the failure mode bites.

### Force-takeover (T2)

MCB's lock is reclaimed only by PID-liveness GC. If a workflow emerges where a stuck session needs immediate eviction, add `force: true` flag on `POST /v1/devices` (or a separate endpoint) that revokes another session's leases. Today's PID watcher handles the dead-session case; T2 covers the live-but-misbehaving case.

### Standalone bridge attach/detach endpoints

The MVP creates bridges only at `POST /v1/devices` time. To add or change a shadow on a live lease, the user must release and re-claim. If hot-swappable shadows become necessary, design `POST /v1/bridges` and `DELETE /v1/bridges/:masterDeviceId`. Cycle detection becomes load-bearing here.

### HW-shadows-HW workflows

The bridge metadata supports it (MCB doesn't care if the shadow is a mock or another physical keyboard). No E2E coverage and no validated UX yet. Pick this up when there's a real workflow asking for it.

### `with_shadow` pointing at a connected pool entry

Currently rejected (avoid double-control of underlying state). If a workflow needs chains where every endpoint is independently addressable, design semantics for `set_parameters` when the same physical state is reachable via two devices.

### Multi-host coordination (TCP frontend)

UDS is local-only. If MCB ever needs to be addressed from another host, add a TCP listener on top of the same handlers. Concerns: authentication (UDS gets it free via FS perms; TCP needs tokens), TLS, network exposure. Defer until specifically requested.

### Concurrent disconnect race

If the owning session's PID dies while it's mid-`DELETE /v1/devices/:id`, two cleanup paths run concurrently. Make disconnect idempotent and re-entrant; lock around per-lease cleanup.

### Production-grade `500` handling

The MVP returns generic 500s with a generated error id. Add: log correlation, request-id header echoed in every response, optional structured-log JSON output toggle.

### Connection-viewer architectural shape

Pre-design item for Phase 3: per-mock Electron window vs. shared global window vs. browser-served HTML. Resolve before implementing.

### Body size limits & rate limiting

The MVP has no body-size cap. Add a sane default (~1MB). Rate limiting is probably overkill for a personal-rig tool but worth flagging if multi-tenant scenarios ever appear.

### Typed errors instead of `formatError` substring matching

`src/mcb/http/errors.ts` currently classifies registry errors (port-already-owned, self-shadow, bridge-already-exists, shadow-conflict, etc.) by substring-matching `err.message`. This is brittle — changing the human-readable message wording silently changes the HTTP status code. Refactor: give `BridgeRegistry` and `LeaseRegistry` typed error classes with stable `code` fields (the way `PortResolutionError` already does), and have `formatError` switch on `instanceof` + `err.code` instead of substring. Touches a few files but no behavior change.
