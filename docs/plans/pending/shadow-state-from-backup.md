# Shadow state from backup on program / song load

**Status:** Ready to implement.

## Problem

The MCP `StateManager` is a passive observer of MIDI traffic. After
`load_program` / `load_song`:

- MCP sends `Bank Select` + `Program Change` bytes.
- The mock applies the program's saved params to its **own** internal state
  and broadcasts to its WebSocket UI.
- The mock does **not** echo the loaded params back over MIDI.
- The MCP's shadow `StateManager` therefore stays empty (or stale from a
  previous session).

This breaks the new disabled-section blocking rule for any case where the
agent expects state to follow a program load. Example: load a program with
`effect1_enable=0` saved, then try `set_parameters effect1_rate=…`. The
shadow doesn't know `effect1_enable=0`, so the rule treats it as `undefined`
and lets the change through.

## Idea

Programs are already parsed into `device.backupData` by `extract_backup`.
After sending the PC, the device class can read the program's saved params
out of the backup and write them into its own `StateManager`, mirroring what
the device just did internally.

This is purely a client-side fix. No mock changes, no hardware changes, no
new MIDI traffic.

## Decisions (locked)

1. **No backup loaded** when `load_program` runs:
   - **Mock connection:** fail-fast with an error result. A mock literally
     needs the backup to load anything meaningful, so the agent should be
     told to call `extract_backup` first.
   - **Real hardware connection:** silent no-op (PC still sent). Real
     hardware applies the program from its own internal storage; we just
     can't shadow it without a backup. Add a one-line note in the result
     text suggesting `extract_backup` so the agent knows the shadow may be
     out of date.
2. **Partial shadow:** only overwrite keys that the program defines. Do
   **not** clear keys outside the program — they stay as previously
   observed. Programs typically don't carry global params (master_volume,
   tempo, MIDI settings); those remain whatever the agent / user last set.
3. **Stale-backup acceptance:** if the user edited a program on hardware
   after `extract_backup`, the shadow will reflect the saved version, not
   the live edit buffer. Document this as a known limitation; don't try to
   detect it.
4. Distinguishing mock vs real hardware for behavior (1) is the only place
   this matters. Use the existing `mock` registry annotation on the port —
   the device already knows whether it's bound to a mock at connect time.

## Scope

- Nord Electro 5D `loadProgram` and `loadSong`.
- Other models (Juno-X, Prophet-6) get the no-op default and are unaffected
  until they implement the hook.

## Design

### New device hook

Add a method to `KeyboardDevice`:

```ts
/**
 * After a program / song is loaded, return the per-key shadow updates the
 * device knows about (typically from cached backup data). Each entry is
 * the param key, its raw MIDI value, and the optional part for per-part
 * params. Returning `undefined` means "no shadow data available" and the
 * caller decides between fail-fast (mock) and silent (real hw).
 */
getProgramShadowSnapshot(
  bank: number,
  slot: number,
  part?: string,
): Record<string, { value: number; part?: string }> | undefined;
```

Default implementation in `BaseKeyboardDevice`: return `undefined`.

### Apply step

Add a private helper on `BaseKeyboardDevice`:

```ts
private applyProgramShadow(
  snapshot: Record<string, { value: number; part?: string }>,
): void {
  for (const [key, entry] of Object.entries(snapshot)) {
    this.state.set(key, entry.value, entry.part);
  }
}
```

### loadProgram / loadSong wrap

`BaseKeyboardDevice.loadProgram` and `NordElectro5DDevice.loadSong` both
follow the same pattern after their PC send:

```ts
const snapshot = this.getProgramShadowSnapshot(bank, slot, part);
if (snapshot) {
  this.applyProgramShadow(snapshot);
  // success path: include "(shadow seeded from backup)" in result text
} else if (this.isBoundToMock()) {
  return errorResult(
    "Cannot load on a mock device without a backup. " +
    "Run extract_backup first, or connect to real hardware."
  );
} else {
  // real hw, silent — but note in result text:
  // "(no backup loaded; shadow may be out of date — extract_backup recommended)"
}
```

### Detecting a mock binding

`BaseKeyboardDevice` doesn't currently know whether it's bound to a mock.
Two options:

1. **Pass it at connect time.** `connect_to_keyboard` already consults the
   mock registry. Stash a `boundToMock: boolean` on the device when it is
   attached.
2. **Check via the registry on demand.** Slightly slower, but doesn't
   require new state.

Prefer **(1)**. The connect path already knows the answer; passing it once
keeps the hot path simple.

### Nord implementation

`NordElectro5DDevice.getProgramShadowSnapshot(bank, slot, part)`:

1. If `this.backupData` is undefined or has no `programs`, return
   `undefined`.
2. Find the program by `(bank, slot - 1)` (slot is 1-based in user input,
   0-based in backup).
3. If found: walk `program.params` (a `Record<string, number>`). For each
   key:
   - If `parameterMap.isPerPart(key)` → use the param routing rule:
     - For Nord, programs store both parts. Backup format:
       `params["part_lower:drawbar_1"] = 8` etc., or two separate
       sub-objects. **Verify exact shape during implementation.**
     - Route to the correct part via the `part` argument or the embedded
       part marker.
   - Else: write with `part = undefined` (global).
4. Return the assembled record.

**Action item during implementation:** read
`src/keyboard_models/nord/electro_5d/backup-parser.ts` to confirm the
program-params shape; the design above assumes per-part keys but the parser
may flatten differently.

### Set-list / song handling

`loadSong(bank, slot, part)` in `NordElectro5DDevice`:

- The set-list entry references a program per part (A/B/C/D). The device
  loads the program for the requested part.
- `getProgramShadowSnapshot` for songs: look up
  `setLists[bank][slot - 1].programs[partIndex]` → that's a `(bank, slot)`
  reference into `programs`. Reuse the program-snapshot logic.

## Tests

### Unit

`tests/unit/nord-electro-5d/program-shadow.test.ts`:

- Snapshot returns `undefined` when `backupData` is unset.
- Snapshot returns the exact key/value/part triples for a program with
  known params.
- Per-part keys are routed to the correct part.
- Songs delegate to the right program per part.
- Loading a program with `effect1_enable=0` → state shadow now reports
  `effect1_enable=0`; loading the same program then attempting an
  effect1 param set is blocked by the existing preflight rule.

### Integration

Spawn a headless mock with a known backup, connect the MCP, call
`load_program`, then `get_current_state effect1` → expect the program's
saved values.

### E2E

Extend `tests/e2e/mcb/get-health.test.ts` (or a new file) with a
load-program-then-set-blocked-param scenario against a mock-backed device.

## Out of scope

- Shadow for live hardware edits (knob turns) made between program loads.
  That requires the bidirectional reconciliation tracked in
  `pending/todo-list.md` item #10 (RQ1 protocol).
- Pushing shadow updates from the mock to the MCP at non-program-load
  moments (UI knob turns on the mock UI). Same item #10.
- Other models. Juno-X / Prophet-6 hook lands as `undefined` and stays
  that way until each model is ready.
