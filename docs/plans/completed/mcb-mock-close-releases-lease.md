# MCB: release leases when a mock instance goes away

## Goal

Closing a mock-runner tab must release any MCB lease bound to that mock — without
the agent's MCP process having to die first. The MCP detects the loss lazily on
its next MCB-touching call and surfaces it as a clear "connection lost, reconnect
manually" message. No auto-reconnect.

## Background — current bug

MCB's only lease reaper is `sessions.runLivenessSweep()` (`src/mcb/index.ts:72`),
keyed on the **MCP process's PID**. Closing a mock-runner tab doesn't kill the
MCP, so the session stays alive and the lease persists indefinitely. Nothing
consults `mockRegistry.readActive()` or the OS port list when deciding whether a
lease is still live.

Reproduction:
1. `npm run mock:runner` → create a mock device.
2. Agent: `connect_to_keyboard` → lease minted in MCB.
3. Close the mock-runner tab.
4. Lease lives on. Next claim that resolves to the same `midiPort` will land on
   a successor mock with no signal to the operator that anything changed.

## Design principles

- **MCB is the source of truth for leases** (already established by
  `mcb-fail-fast-session.md`). The MCP holds a cache.
- **A lease is bound to a specific mock instance, not to a reusable name.**
  wsPort / label / midiPort can all be re-occupied by a fresh tab; the lease
  must not silently follow.
- **No automagic reconnect.** When the bound mock is gone, the MCP tears down
  the corresponding pool entry on next interaction and the user calls
  `connect_to_keyboard` again to get a fresh lease.
- **Active notification, with a passive safety net.** The tab-close path
  actively tells MCB to release. If that call is lost, MCB still catches the
  mismatch on the next lease-bearing read/claim via the instance-id cross-check.

## Behavior spec

### Mock instance identity

`MockRegistryEntry` gains `instanceId: string` — a UUID minted in
`MockTransport.start()` and written into the registry alongside the existing
fields. wsPort and midiPort stay reusable; `instanceId` is per-boot and never
recycled.

### Lease binding

`Lease` gains `mockInstanceId: string | null`. On `POST /v1/devices`:
- After `resolvePort` returns the primary port, call
  `mockRegistry.findByMidiPort(primary.portName)`.
- If a mock entry exists, copy its `instanceId` onto the new lease.
- For real-keyboard ports, store `null`.

### Active release: `DELETE /v1/mocks/:instanceId`

New MCB endpoint. No session auth — the instanceId is the capability (UUID,
not enumerable, only the tab that owns it knows it). Behavior:

- Look up all leases with `mockInstanceId === :instanceId` (typically zero or
  one — multi-device-per-mock is not a thing today, but the loop costs nothing).
- For each match: remove from `LeaseRegistry`, remove any bridges from
  `BridgeRegistry`. Remove the deviceId from the owning session's
  `ownedDeviceIds` set so PID liveness reaping isn't confused later.
- Unknown / no matches → 204.

The mock-runner calls this in `MockTransport.stop()`, right before
`registry.unregister(this.opts.wsPort)`. The call is best-effort:
network error / 5xx / MCB unreachable → log and continue. The tab is closing
and the user wants the mock gone regardless.

### Passive safety net: instance-id cross-check

The active path can fail (mock-runner crash, network hiccup, MCB restart
window). MCB enforces the invariant on every lease-bearing read:

- `GET /v1/devices` filters out leases whose `mockInstanceId` is set but does
  **not** match `mockRegistry.findByMidiPort(lease.primary.portName)?.instanceId`
  (including the case where the registry has no entry at all for that port).
  These leases are reaped at read time: removed from `LeaseRegistry` and
  `BridgeRegistry`, removed from the owning session's `ownedDeviceIds`.
- `POST /v1/devices` (claim) goes through the same reap pass before checking
  port ownership, so a stale lease can't block a fresh claim on the same port.

Real-keyboard leases (`mockInstanceId === null`) are unaffected by this check —
the only liveness signal for hardware is the existing PID sweep plus the OS
port list (`resolvePort` already rejects ports that aren't visible).

### MCP-side lazy detection: `device-not-found`

`mcb-client.ts` currently handles `session-not-found` as session-lost. Add a
parallel path for `device-not-found` (single device, not the whole session):

- Wrap session-bearing calls so a 404 `device-not-found` clears the matching
  pool entry by deviceId (via a registered `onDeviceLost(deviceId)` callback,
  set from `src/index.ts` and pointing at `pool.disconnectByDeviceId`).
- Throw `MCBDeviceLostError extends MCBError` with `code = "device-lost"`.
- Tool handlers (`connect_to_keyboard`, `disconnect_from_keyboard`, any future
  device-targeting tool) catch it and return:

  ```
  Connection lost: the bound mock instance is gone. The local lease has been
  dropped. Use connect_to_keyboard to re-establish.
  ```

The session itself is not dropped — only the one pool entry. Other devices on
the same session remain intact.

### Race-scenario walkthrough

The exact case the user flagged:

| Step | Mock-runner | MCB | MCP pool |
|---|---|---|---|
| Tab A starts | `instanceId = A1`, port `"Mock 1"`, wsPort 8500 | — | — |
| Agent connects | — | Lease `L1 { deviceId=D1, mockInstanceId=A1, portName="Mock 1" }` | `[D1 → portName "Mock 1"]` |
| Tab A closed | `DELETE /v1/mocks/A1` (best-effort) → unregister | `L1` reaped | unchanged |
| Tab B opened (immediate) | `instanceId = A2`, same port, same wsPort | — | unchanged |
| MCP next tool call on `D1` | — | `L1` not found → 404 `device-not-found` | `D1` evicted; `MCBDeviceLostError` |
| Agent reads error, retries | — | — | — |
| Agent `connect_to_keyboard` | — | Fresh lease `L2 { deviceId=D2, mockInstanceId=A2, … }` | `[D2 → portName "Mock 1"]` |

If the DELETE call in step 3 is lost, step 5 hits the passive safety net:
`GET /v1/devices` (used inside the next claim path) sees `L1.mockInstanceId=A1`
≠ registry's current `A2`, reaps `L1` at read time, and the claim proceeds.

## Implementation phases

### Phase 1 — Registry instance id

- `src/shared/mock-registry.ts`:
  - Add `instanceId: string` to `MockRegistryEntry`.
  - Validate it in `readAll()`'s type-guard filter.
  - No changes to `register()` / `touch()` / `relabel()` signatures — the
    caller supplies `instanceId` as part of the entry, just like `pid`.
- `src/mock-runner/transport.ts`:
  - In `start()`, mint `this.instanceId = randomUUID()` once.
  - Include it in the `registry.register(...)` call.
  - Expose `getInstanceId()` for the stop() path.
- `src/mcb/types.ts`: add `instanceId` to the MCB-local `MockRegistryEntry`
  shape, plumb it through `MockRegistryReader.findByMidiPort` / `findByLabel`
  / `list` / `listAllWithStale` (these already alias the shared type — verify
  re-export is automatic).
- Tests:
  - Update `tests/unit/shared/mock-registry.test.ts` (if it exists; add fields
    to fixtures).
  - Update any harness helper that mints registry entries (`tests/helpers/`).

### Phase 2 — Lease carries instanceId

- `src/mcb/types.ts`: `Lease.mockInstanceId: string | null`.
- `src/mcb/http/devices.ts` (POST handler):
  - After resolving primary port, look up the mock entry by midiPort. If
    present, set `mockInstanceId = entry.instanceId`; else `null`.
  - Persist on the new lease.
- `tests/unit/mcb/http.test.ts`: assert claim against a mock port populates
  `mockInstanceId`; claim against a non-mock port leaves it `null`.

### Phase 3 — Passive safety net (reap on read)

- `src/mcb/lease-registry.ts`: add `reapMismatched(check: (lease) => boolean)`
  that removes leases where `check` returns true and returns the removed list.
- `src/mcb/http/devices.ts`:
  - Before the existing logic in both `GET /v1/devices` and `POST /v1/devices`,
    walk leases with non-null `mockInstanceId` and reap any whose
    `mockRegistry.findByMidiPort(primary.portName)?.instanceId` differs (or is
    undefined). Also remove the deviceId from its owning session's
    `ownedDeviceIds` and from `BridgeRegistry`.
  - Extract this into a `reapStaleMockLeases(deps)` helper so it stays unit-
    testable and so both endpoints share one implementation.
- Tests: `tests/unit/mcb/devices.test.ts` (new or existing) — claim leases
  with mockInstanceId=A1, mutate the registry to A2, hit `GET /v1/devices`,
  assert the lease is gone and absent from the response.

### Phase 4 — Active release endpoint

- `src/mcb/http/mocks.ts` (new): `DELETE /v1/mocks/:instanceId` handler.
  - `leases.listAll().filter((l) => l.mockInstanceId === instanceId)` →
    remove each, drop bridges, drop from owning session's `ownedDeviceIds`.
  - 204 on success and on no-match.
- `src/mcb/http/server.ts`: wire the route.
- `src/shared/mcb-client.ts`: export `releaseMockInstance(instanceId)`. No
  session header needed; best-effort, swallow errors.
- `src/mock-runner/transport.ts`: in `stop()`, before
  `registry.unregister(...)`, call `mcbClient.releaseMockInstance(this.instanceId)`.
  Wrap in try/catch — log via `console.warn` and continue.
- Tests:
  - `tests/unit/mcb/http.test.ts`: DELETE /v1/mocks/:instanceId releases a
    matching lease; unknown instanceId → 204.

### Phase 5 — MCP-side device-lost handling

- `src/shared/mcb-client.ts`:
  - Add `MCBDeviceLostError extends MCBError`.
  - Add `setOnDeviceLost((deviceId) => void)`.
  - In the `callWithSessionGuard` wrap (or a parallel `callWithDeviceGuard`
    wrap around `claimLease` / `releaseLease`), translate 404
    `device-not-found` → fire `onDeviceLost(deviceId)` → throw
    `MCBDeviceLostError`.
- `src/shared/device-pool.ts`: add `disconnectByDeviceId(deviceId)` —
  finds the matching entry, calls the existing `disconnect(index)` path,
  no-op if not present.
- `src/index.ts`: wire `setOnDeviceLost((id) => pool.disconnectByDeviceId(id))`.
- `src/tools/connect.ts`, `src/tools/disconnect.ts`: catch
  `MCBDeviceLostError` and return the user-facing message above.

### Phase 5.5 — Surface identity in `list_midi_devices`

Once a `MCBDeviceLostError` fires, the agent needs a way to confirm *why* —
"is my mock gone, or replaced by a different instance under the same label?".
The `list_midi_devices` tool is the natural diagnostic surface, so it must
expose the same identity fields that the lease and registry now carry.

- `src/mcb/http/midi-ports.ts`:
  - `MockAnnotation` gains `instanceId: string`. Populate from
    `mockRegistry.listAllWithStale()` (Phase 1 already added it there).
  - `LeaseAnnotation` gains `mockInstanceId: string | null`. Populate from
    the lease (Phase 2 already stored it).
- `src/tools/list-devices.ts`:
  - `MockRegistrySchema`: add `instanceId: z.string()`.
  - `LeaseSchema`: add `mockInstanceId: z.string().nullable()`.
  - No tool-handler logic change — the field flows through as part of the
    structured response.
- Update the tool description to mention `mock.instanceId` and
  `lease.mockInstanceId` so the agent knows it can correlate identity across
  a reconnect: a deviceId/lease pointing at an `instanceId` that no longer
  appears on the matching port means the mock was replaced; a port whose
  `mock` annotation is absent or `stale: true` means the mock is gone.
- Tests: extend `tests/e2e/list-parameters.test.ts` (or wherever `list_midi_devices`
  is exercised) to assert both fields appear in the structured output.

### Phase 6 — E2E

- `tests/e2e/mcb/mock-close-releases-lease.test.ts` (new, MCB-self-provisioning
  harness — see `tests/e2e/mcb/` siblings for the pattern):
  - Spawn MCB on a tmpdir socket.
  - Spawn a headless mock, claim it via the MCP client.
  - Kill the mock cleanly (the harness should drive `stop()` so the DELETE
    fires).
  - Assert `GET /v1/devices` no longer includes the lease.
  - Re-spawn a mock with the same model (different `instanceId` automatically).
  - Call `connect_to_keyboard` from the same MCP session → expect
    `MCBDeviceLostError`-style message first, then on second call a fresh
    lease that succeeds.
- `tests/e2e/mcb/mock-close-active-path-fails.test.ts` (optional, may fold
  into the above): simulate the DELETE call failing (env flag in mcb-client
  to force the call to throw), confirm the passive safety net still reaps on
  the next `GET /v1/devices`.

### Phase 7 — Shadow-side instance binding + MCB terminal logs

Originally treated as an out-of-scope follow-up, then folded back into the
same PR after live-testing on a real hardware shadow showed the asymmetry:
when a hardware-primary lease shadows to a mock, closing the shadow mock's
tab leaves the lease intact because only the primary's mock binding was
recorded.

- `Lease` gains `shadowMockInstanceId: string | null`. Populated in
  `POST /v1/devices` from `mockRegistry.findByMidiPort(shadow.portName)`.
- `reapStaleMockLeases` checks **both** sides — a mismatch (or registry
  miss) on either `mockInstanceId` (primary) or `shadowMockInstanceId`
  (shadow) reaps the lease. Reason string in the log includes which side
  fired.
- `DELETE /v1/mocks/:instanceId` matches leases where the id appears on
  either side and logs the matched side.
- `midi-ports.ts`: the shadow-port lease annotation now reports
  `lease.shadowMockInstanceId` (was incorrectly reusing the primary's id).
- MCB terminal now logs each lifecycle event with short ids and port
  names: session minted, lease claimed, lease released (by owner),
  mock closed (active path, primary or shadow), reaped stale mock lease
  (passive net, with reason), reaped session (existing PID sweep). The
  short-id helper trims to the first 8 hex chars to keep lines scannable.

Tests:
- `reapStaleMockLeases` unit suite gets a shadow-mismatch case and a
  both-sides-match-no-reap case.
- `http.test.ts` asserts `shadowMockInstanceId` populates on claim and
  that `DELETE /v1/mocks/:instanceId` reaps shadow-side bindings.
- `tests/e2e/mcb/mock-close-releases-lease.test.ts` adds a second
  `describe` block: primary=mockA, shadow=mockB, stop mockB, assert
  lease reaped.

## Out of scope

- Active push notification from MCB to the MCP when a device is reaped (the
  pull-on-next-call pattern is what the user explicitly chose).
- Re-binding a lease across mock instances. Explicitly forbidden.
- Hardware unplug detection. Real keyboards remain governed by the existing
  PID sweep + `resolvePort` OS-visibility check; this plan does not change
  that path.
- Mock-runner UI affordance for "your tab close failed to release in MCB."
  The passive net handles it on the next call.
