# MCB session: drop attach, fail-fast on loss, expose via get_health

## Goal

Treat MCB as the sole source of truth for sessions and leases. The MCP and the
local pool are pure caches of MCB state. When MCB returns `session-not-found`
on a session-bearing call, we **drop our caches and surface a clear failure**
to the caller — we do not try to recover the old session, do not re-attach,
do not silently re-mint and retry.

The agent must be able to observe the MCP's current MCB session id (and whether
MCB is reachable) so it can detect drops without waiting for the next tool call
to fail.

## Background — current bug

`src/shared/mcb-client.ts` was written with intent to recover after MCB restart
via `POST /v1/sessions/:id/attach`, but the attach branch in `ensureSession()`
is gated by an `attachedThisRun` flag that is also set on the initial-create
path. After a successful initial create, `attachedThisRun=true` for the lifetime
of the MCP process, so the re-attach branch never fires — and the next claim
after an MCB restart hits MCB with a stale sessionId and gets `session-not-found`.

Reproduced today:

1. `connect_to_keyboard` → MCB minted session, lease held.
2. User restarted MCB.
3. `connect_to_keyboard` again → `Connection failed: session-not-found: Session <uuid> not found`.

Rather than patch the gate, we are removing the entire attach mechanism on the
direction that MCB is source of truth and the MCP is not allowed to force MCB
into recreating a session it has forgotten.

## Endpoint audit

Walked every route registered in `src/mcb/http/server.ts:111-118`:

| Route | Verdict | Rationale |
|---|---|---|
| `GET /v1/health` | keep | broker health, used by future `get_health` MCP tool |
| `POST /v1/sessions` | keep | minting is the only legitimate way to enter the system |
| `POST /v1/sessions/:id/attach` | **DELETE** | client-driven session re-creation contradicts "MCB is source of truth" |
| `POST /v1/devices` | keep | claim a lease |
| `GET /v1/devices` | keep | read-open list, used by `is_connected` (filter by my session) and mock-runner (per-tab lease state) |
| `DELETE /v1/devices/:id` | keep | owner-only release |
| `GET /v1/midi/ports` | keep | unified port view with mock + lease annotations |

The audit did **not** turn up other endpoints that need removal. The surface is
small and each remaining route has a single, clear purpose. Two minor hygiene
items I'm folding into this plan rather than a separate one:

- **`listMyDevices` mints a session as a side effect of a read.** A list call
  should never create state. Fix: if no cached session, return `[]`; if cached,
  filter `GET /v1/devices` by it. No `ensureSession()` on the read path.
- The `attach` test cases in `tests/unit/mcb/http.test.ts` and the attach call
  in `tests/integration/mcb/lifecycle.test.ts` go away with the endpoint.

## Behavior spec

### Session-loss detection

MCB returns `404 session-not-found` from `POST /v1/devices` (claim) and from
`GET /v1/health` when called with an `x-session-id` header referencing a
session MCB doesn't have. `DELETE /v1/devices/:id` doesn't validate the
session against the session table — it returns `404 device-not-found` if the
lease is unknown, or `403 not-owner` if the header doesn't match the lease
owner — so a session-restart-then-release sequence surfaces as
`device-not-found` (the lease is gone too), not `session-not-found`.
`GET /v1/devices` is read-open; no `x-session-id` is consulted.

### MCP response to session-not-found

When `mcb-client.ts` sees `404 session-not-found`:

1. Drop `cachedSessionId` (set to `null`).
2. Invoke a registered "session-lost" callback that tears down the local pool:
   for each `PoolEntry`, run `pool.disconnect(entry.index)` — that already calls
   `device.detach()` and then `onDispose()` (which closes MIDI output + input +
   forward bridge + mock-status WS). Bridges are torn down by virtue of being
   part of the MidiManager that disconnect() destroys.
3. Throw a typed `MCBSessionLostError extends MCBError` with
   `code = "session-lost"` and a message stating that all leases were dropped
   and how many. Distinct from `MCBError("session-not-found", ...)` so tools can
   give a clear message.
4. **Do not** mint a fresh session as part of the same failed call — let the
   next call go through `ensureSession()` naturally.

### Tool-side message

`connect_to_keyboard` (and any other tool that goes through `claimLease`/
`releaseLease`) catches `MCBSessionLostError` and returns:

```
Connection failed: session-lost: MCB returned session-not-found. Dropped N local lease(s). Retry to establish a fresh session.
```

The agent sees this and knows to retry, and it can also confirm via
`get_health` that `sessionId` has changed (or is `null` until next claim).

### Heartbeat (proactive detection)

Lazy detection — drop the cache only when the next session-bearing call
fails — has a hole: tools that don't go through MCB (`list_parameters`,
`set_parameters`, MIDI-only paths) and read-open broker calls
(`list_midi_devices`) keep operating against a phantom pool for as long as
the user avoids `connect_to_keyboard` / `disconnect_from_keyboard`. To
close that hole, mcb-client runs a 5s heartbeat.

- Endpoint: `GET /v1/health` is overloaded — when called with
  `x-session-id`, the broker validates the session is in its table and
  returns 404 `session-not-found` if not. Without the header, behavior is
  unchanged (broker liveness only).
- Client: a `setInterval` (unref'd) ticks every `MCB_HEARTBEAT_MS` (default
  5000). Each tick pings `GET /v1/health` with the cached session id.
  - 200 → no-op.
  - 404 `session-not-found` → call the shared `dropSessionAndFire()`
    helper, which clears the cache, stops the heartbeat, and fires the
    `onSessionLost` callback (same path as a session-bearing call hitting
    a 404). Idempotent: a concurrent session-bearing failure won't
    double-fire the callback.
  - any other error (mcb-unreachable, 5xx, parse) → transient, no drop.
    Heartbeat keeps running; next tick may succeed when the broker comes
    back, or surface 404 if the session is genuinely gone.
- Lifecycle: starts on first session mint, stops on cache drop, restarts
  on the next mint. `resetSession()` (test-only) also stops it.
- Why piggyback on `/v1/health` instead of a dedicated session endpoint:
  the broker already exposes liveness; adding a parallel route would
  duplicate. The header-based variant keeps the broker surface minimal and
  the client's intent ("am I still known?") obvious from the call site.

### get_health MCP tool

New tool, no inputs, returns:

```json
{
  "mcbReachable": true,
  "mcbHealth": { "ok": true, "uptimeSec": 123, "sessionsActive": 2, "devicesConnected": 1 },
  "sessionId": "f813ea21-…" | null,
  "deviceCount": 1
}
```

- `mcbReachable` is `true` when the broker `GET /v1/health` returned 200.
- `mcbHealth` is the broker payload verbatim (or `null` when unreachable).
- `sessionId` is the MCP's current cached session id (`null` if it hasn't
  claimed yet, or was just dropped after `session-lost`).
- `deviceCount` is `pool.size()`.

When MCB is unreachable: `mcbReachable: false, mcbHealth: null, sessionId: <whatever the local cache says>, deviceCount: <pool.size()>`. We do **not** drop the local cache on transient broker unreachability — only on explicit `session-not-found`. (A broker bounce that comes back with our session intact should be a no-op; we'll only learn it's gone if we try to use it.)

## Implementation phases

### Phase 1 — Remove attach (broker side)

- `src/mcb/http/sessions.ts`: drop the `attach` handler.
- `src/mcb/http/server.ts`: drop the `POST /v1/sessions/:id/attach` route.
- `src/mcb/session-manager.ts`: drop `attach()` method.
- `tests/unit/mcb/http.test.ts`: remove the three `attach` tests.
- `tests/integration/mcb/lifecycle.test.ts:152`: replace the attach call with
  a `POST /v1/sessions` mint (the test is verifying post-restart behavior,
  which under the new model means "client must mint a fresh session").

### Phase 2 — Remove attach (MCP side) and add session-loss handling

- `src/shared/mcb-client.ts`:
  - Drop `attachSession`, `attachedThisRun`, the cached-attach branch in
    `ensureSession()`.
  - Refactor `listMyDevices()` to not call `ensureSession()` — return `[]`
    when `cachedSessionId === null`.
  - Add `MCBSessionLostError` (subclass of `MCBError`).
  - Add a module-level `onSessionLost` registration: `setOnSessionLost(cb)`.
  - Wrap `call()` (for status-bearing requests) so that a 404
    `session-not-found` clears `cachedSessionId`, fires `onSessionLost`, and
    rethrows as `MCBSessionLostError(droppedLeaseCount, ...)`.
  - `releaseLease` propagates `MCBSessionLostError` (the same
    `callWithSessionGuard` wrap clears the cache and fires the callback);
    `disconnect_from_keyboard` catches it and surfaces a
    `(session-lost: dropped N local lease(s))` note instead of the usual
    `(lease ... released)` note.
- `src/index.ts`: wire `setOnSessionLost(() => tearDownPool(pool))`. Helper
  iterates `pool.list()` and calls `pool.disconnect(entry.index)` for each;
  swallows individual disposer errors.
- `src/tools/connect.ts`: catch `MCBSessionLostError` and return the
  user-facing message specified above.
- `src/tools/disconnect.ts`: same.

### Phase 3 — `get_health` tool

- `src/shared/mcb-client.ts`: export `getCachedSessionId(): string | null`
  and `getMcbHealth(): Promise<...|null>` (returns `null` on unreachable).
- New `src/tools/get-health.ts`: registers `get_health`, no input schema,
  returns the JSON shape above.
- `src/index.ts`: wire `registerGetHealth(server, pool)`.

### Phase 4 — Tests

- `tests/unit/shared/mcb-client.test.ts`:
  - Cover: `session-not-found` from `claimLease` clears cache, fires
    `onSessionLost`, throws `MCBSessionLostError`.
  - Cover: `listMyDevices` returns `[]` when no cached session (no broker call).
- `tests/unit/mcb/http.test.ts`: remove attach tests (Phase 1).
- New `tests/e2e/session-loss.test.ts`: spawn MCP + MCB, claim a lease, kill
  MCB, restart MCB (fresh state), call `connect_to_keyboard` again, expect
  `session-lost` error message and `pool.size() === 0` afterward via
  `is_connected`.
- New `tests/e2e/get-health.test.ts`: smoke — pre-claim returns
  `sessionId: null`; post-claim returns a UUID; after MCB restart + first
  failed claim, returns `sessionId: null` again.

## Out of scope

- Persisting sessions across MCB restarts. Explicitly not on the backlog
  per user direction. (Was previously handled by the attach endpoint we are
  removing; if persistence is ever desired, it would be a server-side
  concern, not a client-driven re-attach.)
- Auto-reconnect on transient broker unreachability. Failure surfaces to
  the caller; the caller decides whether to retry.
- Changing `GET /v1/devices` to require/respect `x-session-id`. The mixed
  read-open-with-client-side-filter pattern is intentional (mock-runner
  needs cross-session visibility) and the audit didn't find it harmful.
