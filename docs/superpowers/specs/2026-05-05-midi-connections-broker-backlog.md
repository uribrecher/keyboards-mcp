---
mode: backlog
parent_topic: midi-connections-broker
mvp_spec: ./completed/2026-05-05-midi-connections-broker-mvp.md
architectural_reference: ./2026-05-05-midi-connections-broker-design.md
---

# midi-connections-broker (MCB) — Deferred Backlog

## Drop `lease.label`

The `Lease` type carries a `label: string` field with no real consumer. Today the connect tool calls `claimLease` before the auto-adopt step that resolves the real label from the mock-registry, so MCB always stores `"default"` while the local pool device shows the auto-adopted name — confusing without delivering value.

Scope:
- Remove `label` from the `Lease` type (`src/mcb/types.ts`).
- Drop the `label` field from `POST /v1/devices` request body and from the manifest response (`src/mcb/http/devices.ts`, `Manifest` in `src/shared/mcb-client.ts`).
- Drop `lease.label` from `GET /v1/midi/ports` (`src/mcb/http/midi-ports.ts`) and from the `MidiPortsResponse` shape.
- `is_connected` falls back to `m.model + portName` for leases this MCP doesn't own, and continues to use `entry.device.label` for leases it does own.
- Update tests to drop label assertions on the MCB side; keep them on the local-pool side (`entry.device.label`).
- `connect_to_keyboard`'s `label` arg stays — it's the local pool device's label, which is load-bearing for the per-instance backup-cache path.

## Sound-recreation-agent uses an MCB-issued sessionId

Sibling-repo change in `../sound-recreation-agent`. The agent currently generates its own UUID at startup (`randomUUID()` in `src/index.ts`) and surfaces it via `/health`. Replace with an MCB-issued sessionId so the UI, logs, and connection-viewer all show the same id for a given agent run.

Scope:
- At server boot, before `/health` is wired, call `POST /v1/sessions` against MCB (or `POST /v1/sessions/:id/attach` if a cached id exists from a previous run) and use the returned `sessionId` as the agent's process identity.
- Drop the agent-side UUID generation. `/health` returns the MCB sessionId only.
- The MCP child process the agent spawns continues to claim its own sessionId from MCB (separate process, separate session — peers under MCB).
- If MCB is unreachable at startup, the agent should fail fast with a clear error.
- Agent-repo tests: `/health` echoes a UUID matching MCB's `POST /v1/sessions` response shape; MCB-unreachable produces a startup error.

## Operator dashboard

A full listing of every session/lease/bridge across the system. Resurface as Phase 4 if multi-agent rigs grow.

## Per-tab session-level info

Surface PID / processName / marked-dead state on the mock-runner tab itself. The LED is a state cue; this would add identity readout for the user.

## MCB SSE `/v1/events` stream

Push-based event stream for lease/session/bridge changes. The mock-runner LED poll covers the present need on a 2s cadence; build SSE when a second consumer needs push semantics or sub-second updates.

## SSE keepalive and resumability

Once SSE exists: heartbeat lines (`:keepalive\n\n` every ~30s) so proxies/clients don't drop long-lived connections, plus `Last-Event-Id` resumability so subscribers can recover events missed during a brief disconnect.

## OS service templates

- macOS LaunchAgent plist (`~/Library/LaunchAgents/com.uribrecher.midi-connections-broker.plist`). User-scoped agent.
- Linux systemd user unit (`~/.config/systemd/user/midi-connections-broker.service`).
- docker-compose example for CI: MCB container + headless mock-runner container, shared volume for the UDS socket.
- README addition documenting setup steps.

## MCB CLI tool (`mcb-cli`)

Standalone CLI that talks to MCB over the same UDS. Subcommands: `sessions list`, `devices list`, `events tail`, `kick <session-id>` (admin force-disconnect), `health`. Each subcommand is one HTTP call. Useful when no agent is around (debugging stuck state from a terminal).

## `LOCAL_PEERPID` for stale-socket probe

Replace the HTTP `/v1/health` round-trip in `src/mcb/socket-cleanup.ts` with a `LOCAL_PEERPID`-based liveness check that distinguishes "another MCB alive" from "stale state" without paying the request. Plus structured logging of which path the startup probe took.

## Stale mock-registry entry purge on MCB startup

Mock-runner is responsible for `purgeStale()` at its own startup. If mock-runner is offline and a mock crashed, the registry has ghost entries that MCB would surface. Add a defensive purge or a defensive filter on listing in `src/mcb/index.ts` / `src/mcb/http/midi-ports.ts`.

## PID-reuse guard on session attach

Record process start time alongside PID at session creation in `SessionManager`. On reattach via `POST /v1/sessions/:id/attach`, verify both PID *and* start time match — defends against the rare case where the original PID is reused by an unrelated process within the reattach window.

## State persistence across MCB restarts

Persist sessions/leases to disk on graceful shutdown and reload on start. Subtle: leases are of OS resources held by MCPs; on MCB restart, MCPs would normally re-establish leases anyway via the existing attach path. Defer until long-lived sessions become real and reconnect overhead bites.

## Force-takeover (T2)

`force: true` flag on `POST /v1/devices` (or a separate endpoint) that revokes another session's leases. Today's PID watcher handles the dead-session case; T2 covers the live-but-misbehaving case.

## Standalone bridge attach/detach endpoints

`POST /v1/bridges` and `DELETE /v1/bridges/:masterDeviceId`, so a shadow can be added or changed on a live lease without a release-and-reclaim cycle. The `BridgeRegistry` already enforces `self-shadow`, `shadow-conflict`, `master-port-conflict`, and `cycle-would-form` invariants, so the endpoints just expose the existing safety.

## HW-shadows-HW workflows

Bridge metadata supports it (MCB doesn't care if the shadow is a mock or another physical keyboard). No E2E coverage and no validated UX yet. Pick this up when there's a real workflow asking for it.

## `with_shadow` pointing at a connected pool entry

Currently rejected (avoid double-control of underlying state). If a workflow needs chains where every endpoint is independently addressable, design semantics for `set_parameters` when the same physical state is reachable via two devices.

## Split `port` and `with_shadow` into explicit identity args

`connect_to_keyboard`'s `port` arg accepts either an exact OS port name *or* a registered mock label, and the port-resolver tries each in turn. `with_shadow` has the same two-types-in-one-string shape. Tools should take unambiguous identity types and let the LLM pick which one to pass. Cleanup: replace each arg with two explicit args (e.g. `mock_label` *or* `os_port`, exactly one required), or take an `{ kind: "mock" | "os", value: string }` discriminated union. Defer until either (a) a real bug surfaces from the current ambiguity, or (b) we touch this code for another reason.

## Multi-host coordination (TCP frontend)

UDS is local-only. If MCB ever needs to be addressed from another host, add a TCP listener on top of the same handlers. Concerns: authentication (UDS gets it free via FS perms; TCP needs tokens), TLS, network exposure. Defer until specifically requested.

## Concurrent disconnect race

If the owning session's PID dies while it's mid-`DELETE /v1/devices/:id`, the PID-liveness reaper and the explicit DELETE handler run concurrently against the same lease. Make disconnect idempotent and re-entrant; lock around per-lease cleanup.

## Production-grade `500` handling

`formatError` in `src/mcb/http/errors.ts` returns generic 500s with a generated error id. Add: log correlation, request-id header echoed in every response, optional structured-log JSON output toggle.

## Body size limits & rate limiting

`src/mcb/http/server.ts` reads the full request body without a cap. Add a sane default (~1 MB). Rate limiting is probably overkill for a personal-rig tool but worth flagging if multi-tenant scenarios ever appear.
