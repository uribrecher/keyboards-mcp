---
mode: backlog
parent_topic: midi-connections-broker
mvp_spec: ./completed/2026-05-05-midi-connections-broker-mvp.md
architectural_reference: ./2026-05-05-midi-connections-broker-design.md
---

# midi-connections-broker (MCB) — Deferred Backlog

The MVP (Phase 1) shipped a standalone control-plane MCB. Phase 2 (MCP integration) and Phase 3 (mock-runner tab LEDs) are also shipped; the bridge cycle walker, graceful shutdown, stale-socket probe, typed errors, e2e harness fixture, and session-attach recovery all landed in the top-5 sweep (PRs #42, #44, #45, #46, #47). What's left is below — every item here is genuinely open.

## Phase 3 — MCB-aware tab LEDs (open follow-ups)

The LED state machine itself shipped in PRs #38 and #41. Open follow-ups:

- **Operator dashboard.** A full listing of every session/lease/bridge across the system. Resurface as Phase 4 if multi-agent rigs grow.
- **Per-tab session-level info.** Surface PID / processName / marked-dead state on the tab itself (the LED is a state cue, not an identity readout).
- **MCB SSE `/v1/events` stream.** Polling is enough for the LEDs; revisit when another consumer needs push semantics.

## Cross-phase items (not phase-specific)

### Drop `lease.label`

The `Lease` type carries a `label: string` field that has only one consumer left worth listing: rendering a human-readable name in `is_connected` and `list_midi_devices` for leases held by other MCP sessions. Today the field defaults to `"default"` (because `connect_to_keyboard` calls `claimLease` before the auto-adopt step that resolves the real label from the mock-registry). The result is two views disagreeing: the local pool device shows the auto-adopted label (e.g. `"junio"`) while MCB shows `"default"` — confusing without delivering value.

Decision: drop the field for the MVP. The lease's `deviceId` is already a stable identifier; cross-session displays can fall back to `model + portName` (and `entry.device.label` when the local MCP owns the lease). If a later use case ever needs cross-session human-readable identity, reintroduce it with the auto-adopt fix already in place.

Scope:
- Remove `label` from the `Lease` type (`src/mcb/types.ts`).
- Drop the `label` field from `POST /v1/devices` request body and from the manifest response (`src/mcb/http/devices.ts`, `Manifest` in `src/shared/mcb-client.ts`).
- Drop `lease.label` from `GET /v1/midi/ports` (`src/mcb/http/midi-ports.ts`) and from the `MidiPortsResponse` shape.
- `is_connected` falls back to `m.model + portName` for leases this MCP doesn't own, and continues to use `entry.device.label` for the ones it does.
- Update tests to drop label assertions on the MCB side; keep them on the local-pool side (`entry.device.label`).
- `connect_to_keyboard`'s `label` arg stays — it's the local pool device's label, which is still load-bearing for the per-instance backup-cache path.

### Sound-recreation-agent uses an MCB-issued sessionId

`sound-recreation-agent` currently generates its own UUID at startup (used for log correlation, surfaced via `/health` to the agent UI). It's a parallel identity to the MCB sessionId the MCP claims later, and the two never align. Replace the self-generated UUID with the MCB-issued sessionId so the UI, logs, MCB, and connection-viewer all show the same id for a given agent run.

Scope (in `sound-recreation-agent`):
- At server boot, before `/health` is wired, call `POST /v1/sessions` against MCB (or `POST /v1/sessions/:id/attach` if a cached id exists from a previous run) and use the returned `sessionId` as the agent's process identity.
- Drop the agent-side UUID generation. `/health` returns the MCB sessionId only.
- The MCP child process the agent spawns continues to claim its own sessionId from MCB (separate process, separate session). No coupling between the two — they're peers under MCB.
- If MCB is unreachable at startup, the agent should fail fast with a clear error (`/health` is the wrong place to surface a partial state).
- Tests in the agent repo: assert `/health` echoes a UUID matching MCB's `POST /v1/sessions` response shape; assert MCB-unreachable produces a startup error.

Cross-repo consideration: this is a sibling-repo change in `../sound-recreation-agent`, but it depends on MCB's existing `POST /v1/sessions` (already shipped) and `POST /v1/sessions/:id/attach` (shipped in PR #47). No MCB-side changes needed.

### OS service templates

- macOS LaunchAgent plist (`~/Library/LaunchAgents/com.uribrecher.midi-connections-broker.plist`). User-scoped agent.
- Linux systemd user unit (`~/.config/systemd/user/midi-connections-broker.service`).
- docker-compose example for CI: MCB container + headless mock-runner container, shared volume for the UDS socket.
- README addition documenting setup steps.

### MCB CLI tool (`mcb-cli`)

A small standalone CLI that talks to MCB over the same UDS. Subcommands: `sessions list`, `devices list`, `events tail`, `kick <session-id>` (admin force-disconnect), `health`. Each subcommand is one HTTP call. Useful when no agent is around (debugging stuck state from a terminal).

### Graceful shutdown — drain in-flight work cleanly

Baseline shipped in PR #44 (SIGTERM/SIGINT handlers in `src/mcb/index.ts`, unlink before awaiting `server.stop()`). Follow-up upgrade still open: stop accepting new connections immediately, complete in-flight requests, drain SSE streams cleanly with a final `session-released` event for live subscribers. Pick up when SSE consumers actually exist (the LEDs poll today).

### Stale UDS socket startup probe — `LOCAL_PEERPID` upgrade

Baseline shipped in PR #44 (`src/mcb/socket-cleanup.ts` HTTP-probes `/v1/health` and unlinks on connect-refused, refuses to delete non-socket files via `lstat()`). Follow-up upgrade still open: `LOCAL_PEERPID`-based liveness check that distinguishes "another MCB alive" from "stale state" without paying the HTTP round-trip; structured logging of which path was taken at startup.

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

The MVP creates bridges only at `POST /v1/devices` time. To add or change a shadow on a live lease, the user must release and re-claim. If hot-swappable shadows become necessary, design `POST /v1/bridges` and `DELETE /v1/bridges/:masterDeviceId`. The bridge cycle walker (see *Next up* at the top) is a hard prerequisite — these endpoints make multi-hop chains reachable, so the walker must land first.

### HW-shadows-HW workflows

The bridge metadata supports it (MCB doesn't care if the shadow is a mock or another physical keyboard). No E2E coverage and no validated UX yet. Pick this up when there's a real workflow asking for it.

### `with_shadow` pointing at a connected pool entry

Currently rejected (avoid double-control of underlying state). If a workflow needs chains where every endpoint is independently addressable, design semantics for `set_parameters` when the same physical state is reachable via two devices.

### Split `port` and `with_shadow` into explicit identity args

`connect_to_keyboard`'s `port` arg accepts either an exact OS port name *or* a registered mock label, and the port-resolver tries each in turn. `with_shadow` has the same two-types-in-one-string shape. The resolution is strict (no substring/fuzzy match) and fails fast on ambiguity, but it's still a "smart" surface that violates the simple-deterministic-tools principle: tools should take unambiguous identity types and let the LLM pick which one to pass. Cleanup: replace each arg with two explicit args (e.g. `mock_label` *or* `os_port`, exactly one required), or take an `{ kind: "mock" | "os", value: string }` discriminated union. Defer until either (a) a real bug surfaces from the current ambiguity, or (b) we touch this code for another reason.

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

### Mock-runner shows a black UI when MCB is down (suspected bug)

Observed: starting `npm run mock:runner` while MCB is unreachable yields a black/empty UI instead of the model picker. The mock-runner shouldn't be a hard dependent of MCB — MCB brokers MCP↔keyboard leases, not mock-window rendering. Investigate the failure path (likely an unhandled promise rejection or a synchronous fetch in the renderer that aborts the page load) and either render normally with MCB-features degraded, or surface a clear "MCB unreachable" overlay with a retry. Repro before fixing.
