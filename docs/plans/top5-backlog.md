# Top 5 Backlog — Most Load-Bearing Items

> Curated cross-backlog priority list. Snapshot taken 2026-05-06. Re-rank when items ship or new ones land.
>
> Sources:
> - `docs/superpowers/specs/2026-05-05-midi-connections-broker-backlog.md`
> - `docs/superpowers/specs/2026-05-05-disabled-section-warnings-backlog.md`
> - `docs/plans/pending/todo-list.md`
>
> Ranking criterion: **load-bearing-ness** — items that block other work, prevent silent failures / data loss / test gaps, or that the system can't broaden in scope without.

## 1. Bridge cycle walker

**Source:** MCB backlog — *⭐ Next up* section.

Locks in the no-cycle invariant in `BridgeRegistry.add()` *before* any code path can violate it. Standalone bridge attach/detach endpoints, hot-swappable shadows, and HW-shadows-HW workflows all become safe to design once this lands. Cheap, well-scoped, prerequisite for three other MCB backlog items.

## 2. Graceful shutdown **+** stale UDS socket probe-and-unlink

**Source:** MCB backlog — *Cross-phase* (two adjacent items; really one fix).

Every ungraceful MCB exit today leaves the UDS bound and the socket file orphaned, so the next `npm run mcb` fails with `EADDRINUSE` until the user manually `rm`s it. That's friction on every dev loop and a hard blocker for any LaunchAgent / systemd / docker-compose deployment we add later — the *OS service templates* item literally can't ship reliably without this. Same code area in `src/mcb/index.ts`; land them together.

## 3. E2E harness MCB fixture (un-skip 4 e2e blocks)

**Source:** MCB backlog — *Phase 2*.

`multi-device.test.ts`, `label-discovery.test.ts`, `backup-per-instance.test.ts`, and the three-concurrent-mocks block in `multi-model.test.ts` are all currently `skip: true`. CI is silent on multi-device, shadow, and concurrent-session regressions — exactly the scenarios MCB exists to defend. Every other MCB change ships with a diminished safety net until this is back. Bonus cleanup: strip the dead legacy args (`mock_ws_port`, `auto_input`, `auto_forward`) from those test bodies in the same pass.

## 4. Typed errors instead of `formatError` substring matching

**Source:** MCB backlog — *Cross-phase*.

`src/mcb/http/errors.ts` classifies registry errors by substring-matching `err.message`. *Changing the wording of a human-readable error message silently changes the HTTP status code* — a latent regression in every PR that touches error strings. Refactoring `BridgeRegistry` / `LeaseRegistry` to typed errors with stable `code` fields (the way `PortResolutionError` already does) is no behavior change but makes the whole error surface introspectable for the cycle walker, the future operator dashboard, and the MCB CLI.

## 5. Session attach + MCB-crash recovery

**Source:** MCB backlog — *Phase 2*.

MCB is currently a soft single point of failure: if it restarts, every connected MCP loses its lease and the agent gets cryptic errors until someone reconnects everything. Once MCB is a real always-on service (LaunchAgent / systemd), the (a) re-claim path with cached `sessionId` + manifest is what makes that promise honest. Pairs with the *PID-reuse guard on session attach* cross-phase item — both have to land for the reattach surface to be safe.

---

## Considered but ranked lower

- **Mock-runner black UI when MCB is down** — real bug the user hits today, but contained; doesn't block other backlog work.
- **Stale mock-registry entry purge on MCB startup** — correctness gap, but only manifests when both mock-runner is offline AND a mock crashed. Narrow trigger.
- **Disabled-section warnings — apply to JUNO-X / Prophet-6** — high value for agent UX but doesn't unblock other infrastructure.
- **ZCore / JUNO-X Model / RD Piano UI panels** — biggest user-visible feature gap on a single model, but model-local; nothing else depends on it.
