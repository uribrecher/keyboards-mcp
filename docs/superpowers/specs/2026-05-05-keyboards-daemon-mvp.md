---
mode: mvp
parent_topic: keyboards-daemon
backlog: ./2026-05-05-keyboards-daemon-backlog.md
architectural_reference: ./2026-05-05-keyboards-daemon-design.md
---

# keyboards-daemon — Phase 1 MVP Slice

> **Scope discipline:** This spec is intentionally a thin slice. Deferred features live in the backlog file linked above. The full architectural target lives in `2026-05-05-keyboards-daemon-design.md` — this MVP is Phase 1 of a four-phase migration. `writing-plans` should plan ONLY what is in this spec — do not pull from the design doc or the backlog.

## What this slice is

A standalone `keyboards-daemon` binary in `src/daemon/` that listens on a Unix domain socket, speaks HTTP, and implements the daemon's full **control plane** end-to-end: sessions (create/attach/delete with PID-liveness GC), an in-memory device pool, an in-memory `BridgeRegistry` (cardinality + cycle + self-shadow guards), R1 + T1 lock semantics, strict port resolution against an injectable port-list source, and SSE events.

**All MIDI operations are stubbed.** `POST /v1/devices` records a Device data structure and assigns a `deviceId`, but does not open an `easymidi.Output`. `POST /v1/devices/:id/parameters` validates ownership, records the call, and emits an SSE event, but does not send MIDI. `Bridge` is a data structure with the same lifecycle, no forward `Output`, no shadow `Endpoint` WS attachment.

Zero touches to existing files: not `src/index.ts`, not `src/tools/*`, not `src/midi/midi-manager.ts`, not `src/shared/keyboard-model.ts` or any of the model implementations under `src/keyboard_models/*`, not `src/mock-runner/*`. The daemon is a wholly new code path that imports `src/shared/mock-registry.ts` (read-only) and may import `easymidi` solely for listing OS port names.

## Why this cut

The architectural concern that drove the daemon design is "two MCP processes silently disagree about hardware state." Validating that the *control plane* (sessions, locks, bridge invariants, SSE, error responses) handles concurrent multi-session traffic correctly — without OS-resource ownership to worry about — is the smallest thing that proves the architecture is right. Phase 2 swaps stubs for real MIDI; Phases 3 and 4 wire it into the MCP and mock-runner once the daemon is trusted on its own.

## In scope

### Scaffold and entry point

- New top-level directory: `src/daemon/`.
- New build artifact: `dist/daemon/index.js`. Becomes the `keyboards-daemon` bin via `package.json`.
- `npm run daemon` script that launches the daemon for local development.
- Default socket path: `~/.keyboards-daemon/sock`. Override via `KEYBOARDS_DAEMON_SOCKET` env var. Permissions `0600`. Socket directory created if missing.

### HTTP server over Unix domain socket

- HTTP/1.1 over UDS using Node's `http` module bound to the socket path.
- All paths under `/v1/`. JSON request/response except SSE.
- Errors: HTTP status + body `{ error: <code-string>, message: <human>, details?: <obj> }`.
- All endpoints from the design doc EXCEPT those that depend on real OS resources (no `GET /v1/devices/:id/state` since there is no `StateManager`; no `GET /v1/devices/:id/parameters` since there are no model schemas in the daemon yet).

### Sessions

- `POST /v1/sessions` — body `{ processName?: string }`. Returns `{ sessionId, ownerPid }`. Daemon reads peer PID via `SO_PEERCRED` (Linux) / `LOCAL_PEERPID` (macOS).
- `POST /v1/sessions/:id/attach` — re-claim. Verifies peer PID matches recorded PID; 403 on mismatch; 404 if session is unknown or hard-GCed past the reattach window. Practical use: the same MCP process briefly drops its HTTP connection and reattaches under the same PID. MCP restart (new PID) does not match and must call `POST /v1/sessions` for a fresh session.
- `DELETE /v1/sessions/:id` — explicit teardown. Header `X-Session-Id` must match the URL id; 403 otherwise. Releases all session-owned device records and bridges. Emits SSE.
- `GET /v1/sessions/:id/devices` — read-open. Returns this session's owned device records in connection-time order.
- **PID-liveness watcher**: 1Hz `kill(pid, 0)` polling on every active session's PID. Ten consecutive misses → mark dead; emit `session-released`; release all owned records. Reattach window: 30s after marked-dead before hard GC.

### Devices (stubbed MIDI)

- `POST /v1/devices` — body `{ port, model, with_shadow?, input_port?, label?, channel?, lower_channel?, upper_channel? }` + `X-Session-Id`. Performs strict resolution + lock acquisition + bridge creation. Records a `Device` data structure (no real MIDI). Returns `{ deviceId, model, port, label, shadows? }`.
- `GET /v1/devices` — read-open. Lists all devices across all sessions, each annotated with `ownerSessionId`, `shadows?`.
- `GET /v1/devices/:id` — read-open. Single device record.
- `POST /v1/devices/:id/parameters` — owner-only (header `X-Session-Id` must match). Body `{ parameters: [{ key, value }], part? }`. Loose validation (params is an array of `{key, value}`; no per-model schema check in MVP). Records the call, emits `parameters-set` SSE event with the supplied payload. Returns `{ result: "stubbed", warnings: [] }`.
- `DELETE /v1/devices/:id` — owner-only. Removes from pool and `BridgeRegistry`. Emits `device-disconnected` and (if applicable) `bridge-removed`.

Notes on stubs:
- No `easymidi.Output` opened.
- No `Endpoint` class with WS attachment in MVP — `Endpoint` exists as a data structure (port name + isMock flag derived from registry) but does not open a WebSocket. The daemon does not connect to mocks.
- No `StateManager` instantiated. State endpoints are not served in MVP.
- No model-specific validation. `model` field is recorded as a string, not validated against a known model registry, in MVP.

### Bridges

- Created only via `POST /v1/devices` with `with_shadow`. No standalone bridge endpoints.
- `BridgeRegistry` — in-memory `Map<masterDeviceId, ShadowEndpoint>` where `ShadowEndpoint = { portName }`.
- Enforced invariants:
  - Cardinality: each master has at most one bridge; each shadow port is targeted by at most one bridge.
  - Self-shadow: master and shadow ports must differ.
  - Cycle: walking the shadow chain from `with_shadow` must not reach the new master (defensive — vacuous under the connect-only API but enforced).
  - `with_shadow` cannot be a port that is currently another device's primary.
- `BridgeRegistry.isShadowTarget(portName)` is consulted at `POST /v1/devices` to reject `port` that is currently a shadow target.

### Strict port resolution

- New module: `src/daemon/port-resolver.ts`.
- Direction-aware (`output` for `port`/`with_shadow`, `input` for `input_port`).
- Steps (per the design doc): exact mock label match (output only) → exact OS port match → zero matches → multiple matches.
- **Injectable port-list source.** The resolver takes a `PortListReader` interface; production binds it to `easymidi.getOutputs()` / `.getInputs()`; tests bind a fake list. This lets tests run without real MIDI hardware.
- **Mock registry**: read via the existing `src/shared/mock-registry.ts` (no modifications).
- OS-visibility re-check: after registry resolves a label, the resolver verifies the resolved name is in the current OS port list.
- Mock label resolution rejected for input direction (mocks have no OS Input port).

### Locking & access control

- R1: any session can `GET` any read-open endpoint. Listed earlier.
- T1: `POST /v1/devices` for a port already a primary owned by another session → `409 Conflict`, body `{ error: "port-already-owned", details: { port, owner: { sessionId, pid, processName? } } }`.
- Mutating endpoints (`POST /v1/devices/:id/parameters`, `DELETE /v1/devices/:id`) require `X-Session-Id` to match the device's owner. 403 otherwise.

### Events (SSE)

- `GET /v1/events` — `Content-Type: text/event-stream`. Read-open. Broadcast: every active subscriber receives every event (no per-client filtering, no replay).
- Event types emitted in MVP:
  - `session-created`, `session-released`
  - `device-connected`, `device-disconnected`
  - `bridge-created`, `bridge-removed`
  - `parameters-set` (stubbed payload — emits the requested parameters with no real state change)
- No keepalive, no `Last-Event-Id` resumability in MVP. Both deferred to backlog.

### Health

- `GET /v1/health` — no auth. Returns `{ ok: true, uptimeSec, sessionsActive, devicesConnected }`.

### Error catalogue (MVP)

- `400 Bad Request`: `port-not-found`, `ambiguous-port`, `invalid-input` (malformed JSON, missing required fields).
- `403 Forbidden`: `not-owner` (write attempt by non-owner), `pid-mismatch` (attach with wrong PID), `session-mismatch` (DELETE session id ≠ X-Session-Id).
- `404 Not Found`: `session-not-found`, `device-not-found`.
- `409 Conflict`: `port-already-owned`, `port-is-shadow`, `shadow-conflict`, `cycle-would-form`, `self-shadow`, `bridge-already-exists`.
- `500 Internal Server Error`: unexpected failures, with a traceable error id in the body.

### Testing strategy

Two layers:

**Unit tests** (run via existing `node:test` + `tsx` infrastructure):
- `tests/unit/daemon/port-resolver.test.ts` — strict resolution under exact match, zero match, multiple match. Uses an injected `PortListReader` and an injected `RegistryReader`.
- `tests/unit/daemon/bridge-registry.test.ts` — cardinality, cycle detection, self-shadow, shadow-conflict, isShadowTarget.
- `tests/unit/daemon/session-manager.test.ts` — session lifecycle. PID-liveness mocked via injected `LivenessChecker`.
- `tests/unit/daemon/pool.test.ts` — device pool add/remove, ownership tracking.
- `tests/unit/daemon/http-handlers.test.ts` — in-process handler invocation. Tests the handler functions against a request/response shape; no real socket needed for unit-level tests.

**Integration tests** (spawn the daemon binary as a child process):
- `tests/integration/daemon/lifecycle.test.ts` — start daemon, verify socket exists, create session via HTTP, register a device, verify state, disconnect, terminate daemon. The test uses a unique socket path under `os.tmpdir()` for isolation.
- `tests/integration/daemon/multi-session.test.ts` — two HTTP clients with separate sessions; one connects a device; the other reads it (R1) but cannot write to it (T1 — gets 403); attempts to claim the same port (T1 — gets 409).
- `tests/integration/daemon/sse-events.test.ts` — subscribe to `/v1/events`, perform actions on another connection, assert event sequence.
- `tests/integration/daemon/pid-liveness.test.ts` — drive the daemon as one HTTP client, kill the calling client process, verify session is GCed via the polling watcher within the configured timeout.

`npm test` should include daemon tests. New script `npm run test:daemon` runs only the daemon test layers.

### Lifecycle & operations

- Manual run only in MVP: `npm run daemon` starts the daemon in foreground; logs to stdout.
- No launchd/systemd configs in MVP. Those land in the backlog.
- Stale socket file probe-and-unlink at startup: if the socket file exists, attempt a GET /v1/health connect; if it succeeds, exit with `EADDRINUSE`-equivalent error; if it fails (no daemon running), unlink and bind. This is the minimum to make `npm run daemon` re-runnable without manual cleanup.
- Graceful shutdown: SIGTERM/SIGINT → close all SSE connections, close UDS listener, unlink socket file, exit. (Detail in plan.)

## Out of scope (see backlog)

- **Phase 2 — Real MIDI.** `easymidi.Output`/`Input` opening, real `Endpoint` with WS attachment to mocks, real `Bridge` MIDI THRU, `StateManager`, model-specific validation (`validateParameterBatch`, etc.), `GET /v1/devices/:id/state`, `GET /v1/devices/:id/parameters`, `GET /v1/schema`.
- **Phase 3 — MCP integration.** Refactoring MCP tools to call the daemon. MCP-side `Pool` (local 1-based working set). MCP-side session bootstrap. Removing existing MCP-internal `Pool`, `MidiManager`, `KeyboardDevice` instantiation.
- **Phase 4 — Mock-runner integration.** `connection-viewer` view subscribing to daemon SSE.
- OS service templates (launchd plist, systemd user unit, docker-compose example).
- Daemon CLI tool (`keyboards-daemon-cli sessions/devices/events`).
- Schema/runtime split per model.
- SSE keepalive + `Last-Event-Id` resumability.
- PID-reuse guard (process start time alongside PID).
- Force-takeover (T2), hot bridge attach/detach, HW-shadows-HW workflows, multi-host coordination, state persistence across restarts, per-port "smart pair" input resolution, per-endpoint state introspection.
- Concrete schemas for `state` and `parameters` HTTP responses.
- All other items already in `2026-05-05-keyboards-daemon-backlog.md`.

## Architecture

Phase 1 introduces these files. None of the existing repo files are modified.

```
src/daemon/
  index.ts                    # bin entry: parse env, set up server, listen
  http/
    server.ts                 # request routing
    sessions.ts               # session endpoints
    devices.ts                # device endpoints
    events.ts                 # SSE handler
    health.ts
    errors.ts                 # error formatting
  pool.ts                     # in-memory Pool: Map<deviceId, Device>
  bridge-registry.ts          # in-memory BridgeRegistry
  port-resolver.ts            # strict resolution + injectable PortListReader
  session-manager.ts          # session lifecycle, PID-liveness watcher
  types.ts                    # daemon-internal types: Device, ShadowEndpoint, Session

tests/unit/daemon/            # unit tests (in-process)
tests/integration/daemon/     # integration tests (spawn daemon child process)
```

`package.json` additions:
- `bin: { "keyboards-daemon": "./dist/daemon/index.js" }`
- `scripts.daemon: "tsx src/daemon/index.ts"`
- `scripts.test:daemon: "tsx --test tests/unit/daemon/**/*.test.ts tests/integration/daemon/**/*.test.ts"`

The daemon imports only:
- Node built-ins (`http`, `net`, `fs`, `path`, `os`, `crypto`, `events`).
- `src/shared/mock-registry.ts` (read-only — existing module, unchanged).
- `easymidi` for listing OS port names (read-only, no port opening).

It does NOT import:
- `src/shared/keyboard-model.ts`, `src/shared/parameter-resolution.ts`, `src/shared/types.ts`, `src/shared/parameter-state.ts`, `src/shared/base-keyboard-device.ts`, `src/shared/device-pool.ts`, `src/shared/tool-result.ts`.
- Any file in `src/keyboard_models/`.
- Any file in `src/midi/`.
- Any file in `src/tools/`.
- Any file in `src/mock-runner/`.

This boundary is enforced by the directory layout — Phase 1 stays in its sandbox.

## Data flow (stubbed)

**Connect (with shadow):**
1. `POST /v1/devices` arrives.
2. Verify `X-Session-Id` corresponds to a live session.
3. `port-resolver` resolves `port` (output direction). Reject if `port-already-owned` or `port-is-shadow`.
4. Resolve `with_shadow` if given. Reject on `shadow-conflict`, `cycle-would-form`, `self-shadow`, or "shadow target is a primary".
5. Resolve `input_port` if given. Direction-aware.
6. Generate `deviceId` (UUIDv4).
7. Insert into pool with metadata.
8. If `with_shadow`: `BridgeRegistry.add(deviceId, shadowPortName)`.
9. Emit `device-connected` and (if applicable) `bridge-created` SSE events.
10. Return device record.

**Set parameters (stubbed):**
1. `POST /v1/devices/:id/parameters` arrives.
2. Verify session ownership (X-Session-Id == device.ownerSessionId, else 403).
3. Loose-validate request body shape.
4. Emit `parameters-set` event with `{ deviceId, ownerSessionId, requestedParameters: [...] }`.
5. Return `{ result: "stubbed", warnings: [] }`.

**Disconnect:**
1. `DELETE /v1/devices/:id` arrives.
2. Verify session ownership (else 403).
3. If device has a bridge: `BridgeRegistry.remove(deviceId)`. Emit `bridge-removed`.
4. Remove from pool. Drop from session's owned set.
5. Emit `device-disconnected`.
6. Return 204.

**Session GC (PID death):**
1. PID-liveness watcher detects PID gone.
2. After 10 consecutive misses (10s), mark session dead. Start 30s reattach window.
3. After window, hard GC: tear down all owned devices (same logic as DELETE per device), release locks, emit `session-released`.

## Error handling

- All daemon-internal errors go through a single `formatError(err)` helper that produces the structured response body.
- Unhandled exceptions in handlers return `500` with a generated error id (correlated with a daemon stderr log line) — no stack traces in the response body.
- The daemon never crashes on a bad request; bad requests return 400.

## Notes for implementers

- Keep handlers small. The skill in this MVP is hygiene: one concept per file, one responsibility per function.
- The PID-liveness watcher is a long-running thing — ensure tests can inject a fast-tick variant or directly invoke the GC path.
- `crypto.randomUUID()` is fine for `sessionId` and `deviceId`. No need for opaque IDs of a specific form.
- Tests should clean up daemon child processes deterministically (afterEach) so a flaky test doesn't leak a UDS socket.
