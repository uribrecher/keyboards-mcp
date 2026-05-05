---
mode: mvp
parent_topic: midi-connections-broker
backlog: ./2026-05-05-midi-connections-broker-backlog.md
architectural_reference: ./2026-05-05-midi-connections-broker-design.md
---

# midi-connections-broker (MCB) — Phase 1 MVP Slice

> **Scope discipline:** This spec is intentionally a thin slice. Deferred features live in the backlog file linked above. The architectural target lives in `2026-05-05-midi-connections-broker-design.md`. `writing-plans` should plan ONLY what is in this spec — do not pull from the design doc or the backlog.

## What this slice is

A standalone `midi-connections-broker` binary (shorthand: **MCB**) in `src/mcb/` that listens on a Unix domain socket, speaks HTTP, and implements the broker's full control plane: sessions (create/attach/delete with PID-liveness GC), a lease registry, a bridge registry, strict port resolution, R1 + T1 lock semantics, and SSE topology events.

MCB is **purely metadata + arbitration** by design — not by stub. It doesn't open MIDI ports, doesn't open WebSockets, doesn't hold `StateManager` instances, doesn't know per-model schemas. Phase 2 (separate plan) plumbs the MCP to call MCB before opening its own connections; Phase 1 is just MCB, validated end-to-end via HTTP/UDS tests.

Zero touches to existing files: nothing in `src/index.ts`, `src/tools/*`, `src/midi/*`, `src/shared/keyboard-model.ts`, `src/keyboard_models/*`, `src/mock-runner/*`. MCB imports `src/shared/mock-registry.ts` (read-only, existing module unchanged) and `easymidi` (only for `getOutputs()`/`getInputs()` listings).

## Why this cut

Validate the architecture before integrating. If the lock semantics, lease lifecycle, bridge invariants, port resolution, and SSE topology behave correctly under concurrent multi-session traffic against a synthetic test harness, MCB is trustworthy. Phase 2 then refactors MCP `connect_to_keyboard` to consume MCB manifests — a small, low-risk change relative to a from-scratch broker.

## In scope

### Scaffold and entry point

- New top-level directory: `src/mcb/`.
- New build artifact: `dist/mcb/index.js`. Becomes the `midi-connections-broker` bin via `package.json`.
- `npm run mcb` script (`tsx src/mcb/index.ts`) launches MCB for local development.
- Default socket path: `~/.mcb/sock`. Override via `MCB_SOCKET` env. Permissions `0600`. Socket directory created on demand.

### HTTP server over Unix domain socket

- HTTP/1.1 over UDS (Node's `http` module bound to the socket path).
- All paths under `/v1/`. JSON request/response except SSE.
- Errors: HTTP status + body `{ error: <code-string>, message: <human>, details?: <obj> }`.

### Sessions

- `POST /v1/sessions` — body `{ processName?: string }`. Returns `{ sessionId, ownerPid }`. MCB reads peer PID via `SO_PEERCRED` (Linux) / `LOCAL_PEERPID` (macOS).
- `POST /v1/sessions/:id/attach` — re-claim. Verifies peer PID matches; 403 on mismatch; 404 if unknown or hard-GCed past the reattach window. Practical use: same MCP process briefly drops its HTTP connection and reattaches under the same PID. MCP restart with a new PID does not match and must call `POST /v1/sessions` for a fresh session.
- `DELETE /v1/sessions/:id` — explicit teardown. Header `X-Session-Id` must match the URL id; 403 otherwise. Releases all session-owned leases and bridges. Emits SSE.
- `GET /v1/sessions/:id/devices` — read-open. Returns this session's leases in connection-time order.
- **PID-liveness watcher**: 1Hz `kill(pid, 0)` polling per active session. Ten consecutive misses → mark dead; emit `session-released`; release all owned leases. Reattach window: 30s after marked-dead before hard GC.

### Leases (devices)

- `POST /v1/devices` — body `{ port, model, with_shadow?, input_port?, label?, channel?, lower_channel?, upper_channel? }` + `X-Session-Id`. Performs strict resolution + lock checks + bridge registration. Returns the **endpoint manifest** (shape below).
- `GET /v1/devices` — read-open. Lists all leases across all sessions.
- `GET /v1/devices/:id` — read-open. Single lease.
- `DELETE /v1/devices/:id` — owner-only. Releases the lease and the bridge edge if any. Emits `device-disconnected` and (if applicable) `bridge-removed`.

**No `POST /v1/devices/:id/parameters`. No `GET /v1/devices/:id/state`. No `GET /v1/devices/:id/parameters`. No `GET /v1/schema`.** MCB never proxies parameter writes, never holds state, never knows schemas. These all stay MCP-internal in Phase 2 onward.

### Endpoint manifest (response shape for `POST /v1/devices`, items in `GET /v1/devices`, etc.)

```jsonc
{
  "deviceId": "<uuid>",
  "ownerSessionId": "<uuid>",
  "model": "<as supplied; not validated against any registry in MVP>",
  "primary": {
    "portName": "<resolved OS output port name>",
    "wsPort": 3002      // present (number) if primary is a registered mock; null otherwise
  },
  "input": {            // present only if input_port supplied
    "portName": "<resolved OS input port name>"
  },
  "shadow": {           // present only if with_shadow supplied
    "portName": "<resolved OS output port name>",
    "wsPort": 3002      // present if shadow is a registered mock; null otherwise
  },
  "label": "<as supplied or default>",
  "channel": 1,
  "lowerChannel": 2,
  "upperChannel": 3
}
```

The manifest is what Phase 2's MCP will consume to open its own MIDI/WS connections. The MVP just produces and returns it; tests assert its shape and consistency.

### Bridges

- Created only via `POST /v1/devices` with `with_shadow`. No standalone bridge endpoints.
- `BridgeRegistry` — in-memory `Map<masterDeviceId, ShadowEndpoint>` where `ShadowEndpoint = { portName }`.
- Enforced invariants:
  - **Cardinality**: each master has at most one bridge; each shadow port is targeted by at most one bridge.
  - **Self-shadow**: master and shadow ports must differ.
  - **Cycle**: walking the shadow chain from `with_shadow` must not reach the new master (defensive — vacuous under the connect-only API but enforced).
  - **Shadow-not-primary**: `with_shadow` cannot be a port that is currently another lease's primary.
- `BridgeRegistry.isShadowTarget(portName)` is consulted at `POST /v1/devices` to reject `port` that is currently a shadow target.

### Strict port resolution

- New module: `src/mcb/port-resolver.ts`.
- Direction-aware (`output` for `port`/`with_shadow`, `input` for `input_port`).
- Steps: exact mock label match (output only) → exact OS port match → zero matches → multiple matches.
- **Injectable port-list source.** The resolver takes a `PortListReader` interface; production binds it to `easymidi.getOutputs()` / `.getInputs()`; tests bind a fake list.
- **Mock registry**: read via the existing `src/shared/mock-registry.ts` (no modifications).
- **OS-visibility re-check**: after registry resolves a label, the resolver verifies the resolved name is currently in the OS port list.
- Mock label resolution rejected for input direction (mocks have no OS Input port).

### Locking & access control

- **R1**: any session can `GET` any read-open endpoint.
- **T1**: `POST /v1/devices` for a port already leased by another session → `409 Conflict`, body `{ error: "port-already-owned", details: { port, owner: { sessionId, pid, processName? } } }`.
- Mutating endpoints (`DELETE /v1/devices/:id`, `DELETE /v1/sessions/:id`) require `X-Session-Id` to match the lease's owner / the session being deleted. 403 otherwise.

### MIDI port listing

- `GET /v1/midi/ports` — read-open. Returns the current OS port list (output and input directions) with annotations:
  - `mockLabel`, `wsPort` if the port is in the mock registry.
  - `ownedBy: { sessionId, deviceId }` if the port is currently a lease's primary.
  - `shadowedBy: { sessionId, deviceId }` if the port is currently a bridge's shadow.

### Events (SSE)

- `GET /v1/events` — `Content-Type: text/event-stream`. Read-open. Broadcast: every active subscriber receives every event (no per-client filtering, no replay).
- Event types emitted in MVP:
  - `session-created`, `session-released`
  - `device-connected`, `device-disconnected`
  - `bridge-created`, `bridge-removed`
- No `parameters-set`, no `state-changed-from-input` — MCB doesn't see those events.
- No keepalive, no `Last-Event-Id` resumability in MVP. Both deferred.

### Health

- `GET /v1/health` — no auth. Returns `{ ok: true, uptimeSec, sessionsActive, devicesConnected }`.

### Error catalogue (MVP)

- `400 Bad Request`: `port-not-found`, `ambiguous-port`, `invalid-input` (malformed JSON, missing required fields).
- `403 Forbidden`: `not-owner` (write attempt by non-owner), `pid-mismatch` (attach with wrong PID), `session-mismatch` (DELETE session id ≠ X-Session-Id).
- `404 Not Found`: `session-not-found`, `device-not-found`.
- `409 Conflict`: `port-already-owned`, `port-is-shadow`, `shadow-conflict`, `cycle-would-form`, `self-shadow`, `bridge-already-exists`, `shadow-target-is-primary`.
- `500 Internal Server Error`: unexpected failures, traceable error id in body.

### Testing strategy

Two layers:

**Unit tests** (run via existing `node:test` + `tsx`):
- `tests/unit/mcb/port-resolver.test.ts` — strict resolution under exact match, zero match, multiple match. Injects `PortListReader` and a stubbed `RegistryReader`.
- `tests/unit/mcb/bridge-registry.test.ts` — cardinality, cycle detection, self-shadow, shadow-conflict, isShadowTarget, shadow-target-is-primary.
- `tests/unit/mcb/session-manager.test.ts` — session lifecycle. PID-liveness mocked via injected `LivenessChecker`.
- `tests/unit/mcb/lease-registry.test.ts` — lease add/remove, ownership tracking, manifest shape correctness.
- `tests/unit/mcb/http-handlers.test.ts` — in-process handler invocation against synthetic request/response objects.

**Integration tests** (spawn the MCB binary as a child process):
- `tests/integration/mcb/lifecycle.test.ts` — start MCB, verify socket exists, create session via HTTP, claim a lease, verify manifest, release, terminate. Unique socket path under `os.tmpdir()` per test.
- `tests/integration/mcb/multi-session.test.ts` — two HTTP clients with separate sessions; one claims a lease; the other reads it (R1) but cannot release it (T1, 403); attempts to claim the same port (T1, 409).
- `tests/integration/mcb/bridge-invariants.test.ts` — create master+shadow lease; verify shadow appears in `GET /v1/midi/ports` with `shadowedBy`; another session cannot claim the shadow port; cycle detection if forced.
- `tests/integration/mcb/sse-events.test.ts` — subscribe to `/v1/events`, perform actions on another connection, assert event sequence.
- `tests/integration/mcb/pid-liveness.test.ts` — drive MCB as one HTTP client, kill the calling client process, verify session is GCed within the configured timeout.

`npm test` should include MCB tests. New script `npm run test:mcb: "tsx --test tests/unit/mcb/**/*.test.ts tests/integration/mcb/**/*.test.ts"`.

### Lifecycle & operations

- Manual run only in MVP: `npm run mcb` starts MCB in foreground; logs to stdout.
- No launchd/systemd configs in MVP.
- **Stale socket file probe-and-unlink** at startup: if the socket file exists, attempt a connect to `GET /v1/health`; on success, exit (another MCB is alive); on connect refusal, unlink and bind. Makes `npm run mcb` re-runnable without manual cleanup.
- **Graceful shutdown** on SIGTERM/SIGINT: close all SSE streams, close UDS listener, unlink socket file, exit. Detail in plan.

## Out of scope (see backlog)

- **Phase 2 — MCP integration.** Refactor `connect_to_keyboard` to claim a lease via MCB and consume the manifest. Drop `auto_input`/`auto_forward`/`mock_ws_port`/`forward_port`. Add `with_shadow`, require `model`. The bug fix lands here.
- **Phase 3 — Mock-runner connection-viewer** subscribing to MCB SSE.
- OS service templates (launchd plist, systemd user unit, docker-compose example).
- MCB CLI tool (`mcb-cli`).
- SSE keepalive + `Last-Event-Id` resumability.
- PID-reuse guard (process start time alongside PID).
- Force-takeover (T2), hot bridge attach/detach, HW-shadows-HW workflows, multi-host coordination, persistence, smart-pair input resolution.
- All other items in `2026-05-05-midi-connections-broker-backlog.md`.

## Architecture

Phase 1 introduces these files. None of the existing repo files are modified.

```
src/mcb/
  index.ts                  # bin entry: parse env, set up server, listen
  http/
    server.ts               # request routing
    sessions.ts             # session endpoints
    devices.ts              # lease endpoints (POST/GET/DELETE /v1/devices...)
    midi-ports.ts           # GET /v1/midi/ports
    events.ts               # SSE handler
    health.ts
    errors.ts               # error formatting
  lease-registry.ts         # in-memory: Map<deviceId, Lease>; isPrimary(portName)
  bridge-registry.ts        # in-memory: Map<masterDeviceId, ShadowEndpoint>
  port-resolver.ts          # strict resolution + injectable PortListReader
  session-manager.ts        # session lifecycle, PID-liveness watcher
  types.ts                  # MCB-internal types: Lease, ShadowEndpoint, Session, Manifest

tests/unit/mcb/             # in-process unit tests
tests/integration/mcb/      # spawn-MCB integration tests
```

`package.json` additions:
- `bin: { "midi-connections-broker": "./dist/mcb/index.js" }`
- `scripts.mcb: "tsx src/mcb/index.ts"`
- `scripts.test:mcb: "tsx --test tests/unit/mcb/**/*.test.ts tests/integration/mcb/**/*.test.ts"`

MCB imports only:
- Node built-ins (`http`, `net`, `fs`, `path`, `os`, `crypto`, `events`).
- `src/shared/mock-registry.ts` (read-only).
- `easymidi` (for `getOutputs()`/`getInputs()` only — no port opening).

It does NOT import:
- `src/shared/keyboard-model.ts`, `src/shared/parameter-resolution.ts`, `src/shared/types.ts`, `src/shared/parameter-state.ts`, `src/shared/base-keyboard-device.ts`, `src/shared/device-pool.ts`, `src/shared/tool-result.ts`.
- Any file in `src/keyboard_models/`, `src/midi/`, `src/tools/`, `src/mock-runner/`.

This boundary is enforced by the directory layout — Phase 1 stays in its sandbox.

## Data flow

The MVP MCB never opens a MIDI port and never opens a WebSocket. Every interaction is metadata-only. Tests verify:
- Manifest shape correctness for each kind of lease (solo hw, solo mock, hw+mock shadow, hw+hw shadow).
- Bridge invariants under direct / forced inputs.
- Lock semantics (R1 reads succeed for non-owners; T1 conflict returns 409 with structured owner info).
- Session GC under PID death.
- SSE event sequence under a known scenario.

When Phase 2 lands and the MCP starts consuming the manifest to open MIDI/WS, MCB doesn't need to change.

**Connect (with shadow):**
1. `POST /v1/devices` arrives.
2. Verify `X-Session-Id` corresponds to a live session.
3. `port-resolver` resolves `port` (output direction). Reject if `port-already-owned` or `port-is-shadow`.
4. Resolve `with_shadow` if given. Reject on `shadow-conflict`, `cycle-would-form`, `self-shadow`, or `shadow-target-is-primary`.
5. Resolve `input_port` if given. Direction-aware.
6. Generate `deviceId` (UUIDv4).
7. Insert lease into the lease registry.
8. If `with_shadow`: `BridgeRegistry.add(deviceId, shadowPortName)`.
9. Emit `device-connected` and (if applicable) `bridge-created` SSE events.
10. Return the endpoint manifest.

**Disconnect:**
1. `DELETE /v1/devices/:id` arrives.
2. Verify session ownership (else 403).
3. If lease has a bridge: `BridgeRegistry.remove(deviceId)`. Emit `bridge-removed`.
4. Remove from lease registry. Drop from session's owned set.
5. Emit `device-disconnected`.
6. Return 204.

**Session GC (PID death):**
1. PID-liveness watcher detects PID gone.
2. After 10 consecutive misses (10s), mark session dead. Start 30s reattach window.
3. After window, hard GC: tear down all owned leases (same logic as DELETE per lease), emit `session-released`.

## Error handling

- All MCB-internal errors go through a single `formatError(err)` helper that produces the structured response body.
- Unhandled exceptions in handlers return `500` with a generated error id (correlated with an MCB stderr log line) — no stack traces in the body.
- MCB never crashes on a bad request; bad requests return 400.

## Notes for implementers

- Keep handlers small. One concept per file, one responsibility per function.
- The PID-liveness watcher is long-running — ensure tests can inject a fast-tick variant or directly invoke the GC path.
- `crypto.randomUUID()` is fine for `sessionId` and `deviceId`.
- Tests must clean up MCB child processes deterministically (afterEach) so a flaky test doesn't leak a UDS socket file.
