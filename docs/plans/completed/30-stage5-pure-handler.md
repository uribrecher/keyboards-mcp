# Stage 5 — Pure handler, name-keyed state, full engine MIDI ownership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Realize the full vision of plan #30. The handler becomes pure: it speaks only the param domain (`set_params`, `get_params`, `load_program`, `load_song`, `getFullState`), with internal state keyed by param NAME — no addresses, no MIDI bytes, no protocol awareness. The engine and the codec own all MIDI.

**Why this and not “stage 4b”:** Stages 1-4 carried byte-level state and a vestigial `handler.onMIDI` along the way. Stage 5 is a coherent end-state of its own — clean enough to defend in isolation. Calling it stage 5 (not 4b) keeps the staging honest about what was deferred.

**Architecture (final):**

```
                ┌─────────────────────────────────────────────────┐
                │   MockHandler (pure logic — no MIDI)            │
                │   - state: { params: Record<paramKey, number>,  │
                │              parts: PartState[],                │
                │              scene, currentScene, ... }         │
                │   - set_params(refs)                            │
                │   - get_params(names, part?)                    │
                │   - load_program(bank, slot)                    │
                │   - load_song(bank, slot, part?)                │
                │   - getFullState() / setFullState()             │
                └─────────────┬───────────────────────────────────┘
                              │ pure param domain
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
            ┌────┐               ┌──────────────────────┐
            │ UI │               │  MidiCodec (per model)│
            └────┘               │  encodeParams         │
                                 │  encodeBytes  (NEW)   │
                                 │  encodeAction         │
                                 │  decode               │
                                 │  parseRequest         │
                                 │  buildResponse        │
                                 │  paramsAtAddress (NEW)│
                                 └──────────┬────────────┘
                                            │ MIDI bytes
                                            ▼
                                  ┌────────────────────┐
                                  │  MockEngine        │
                                  │  + bank-select acc │
                                  │  + RQ1 handling    │
                                  └────────────────────┘
```

---

## Design decisions (locked)

1. **Internal handler state is keyed by canonical param name.** No `sceneGlobal[addrKey]`, no `parts[i].sceneParams[addrKey]`, no `parts[i].params: Map<cc, value>`. Replaced by `parts[i].params: Record<paramKey, number>` for per-part values and `globalParams: Record<paramKey, number>` for non-perPart.
2. **Stored values are USER-DOMAIN — never wire bytes.** For `chorus_switch=1` the handler stores `1` (the OFF/ON index), not `127` (the scaled wire byte). For `chorus_level=80` the handler stores `80`. The handler is pure logic — wire-byte translation happens in the codec, full stop.
3. **String label inputs are normalized to canonical numeric user-domain on write.** When `set_params({name:"chorus_switch", value:"ON"})` arrives, the handler stores `1` (the label's index). New codec helper: `codec.normalizeUserValue(name, value): number`.
4. **`handler.onMIDI` removed.** Engine never calls it. External MIDI in goes through `codec.decode` and gets translated to `set_params` / `load_program` calls.
5. **`handler.read_bytes` removed.** RQ1 fulfillment moves entirely to the engine using `codec.paramsAtAddress` + `handler.get_params` + `codec.encodeBytes` (which takes user-domain values and returns wire bytes).
6. **New codec helpers:**
   - `normalizeUserValue(name: string, value: number | string): number` — string labels → numeric index; numbers clamped to `[min, max]`.
   - `paramsAtAddress(address: number[], size: number): Array<{name, part?, byteOffset, byteCount}>` — reverse lookup. Given an RQ1 address+size, return the list of params whose addresses fall in the range. Engine uses this to assemble a DT1 reply from `get_params` values.
   - `encodeBytes(name, userValue, part?): number[]` — returns just the data bytes (no DT1 header) for a single param. Takes USER-domain value, returns wire bytes. Engine uses this to assemble the DT1 reply data field.
7. **Bank-select accumulator lives in the engine.** When an external CC 0 or CC 32 arrives, the engine accumulates MSB/LSB. When a Program Change arrives, the engine builds a `{kind: "loadProgram", bank, slot, channel}` action and calls `handler.load_program(bank, slot)`.
8. **Handler gains `load_program(bank, slot): MockHandlerResult`.** Replaces today's `handleProgram` and the bank-select tracking that lives inside the JUNO-X handler.
9. **Broadcast `data.params.<name>` is user-domain.** UIs already use the value via `(value ?? 0) > 0` checks for switches and direct slider positions for continuous — both work for user-domain. Display labels go through `codec.formatValue(name, userValue)`.

---

## Tasks

### Task 1 — Add codec helpers: `paramsAtAddress`, `encodeBytes`

**Files:**
- Modify: `src/shared/midi-codec.ts` — interface additions
- Modify: `src/keyboard_models/roland/juno_x/midi-codec.ts` — JUNO-X impl
- Test: `tests/unit/juno-x/midi-codec.test.ts` — round-trip tests

- [ ] **Step 1.** Extend `MidiCodec`:

```ts
/** Where a param's bytes appear within an RQ1 address+size range. */
export interface ParamAtAddress {
  name: string;
  part?: number;
  /** Byte offset within the request's data field where this param's bytes begin. */
  byteOffset: number;
  /** Number of bytes this param occupies. */
  byteCount: number;
}

export interface MidiCodec {
  // ... existing methods ...

  /**
   * Reverse-lookup: given a Roland RQ1 address+size, return the params
   * whose addresses fall within that range. Used by the engine to fulfill
   * an RQ1 by asking the handler for those params and packing the bytes.
   */
  paramsAtAddress(address: number[], size: number): ParamAtAddress[];

  /**
   * Return just the data bytes (no DT1 header) for a single param write.
   * Used by the engine when assembling RQ1 replies — it needs to pack
   * the wire-byte value back to data bytes (1 byte for raw, multiple
   * for nibble-packed sysex).
   */
  encodeBytes(name: string, value: number | string, part?: number): number[];
}
```

- [ ] **Step 2.** Implement on JUNO-X codec.

- [ ] **Step 3.** Test round-trip: `set_params` → `paramsAtAddress` → `encodeBytes` → `buildResponse` → `decode` returns the same value.

### Task 2 — Engine: bank-select accumulator + `load_program` dispatch

**Files:**
- Modify: `src/mock-runner/engine.ts`

- [ ] **Step 1.** Add accumulator state:

```ts
private pendingBank: { msb: number; lsb: number; ch: number } = { msb: 0, lsb: 0, ch: 0 };
```

- [ ] **Step 2.** In `dispatch` for external CC 0 / 32, update accumulator. For external program-change, build `{bank, slot, channel}` and call `handler.load_program(bank, slot)`. Reset accumulator state.

- [ ] **Step 3.** Test the sequence: CC 0 → CC 32 → PC produces a single `load_program` call with the correct bank.

### Task 3 — Engine: external MIDI via `codec.decode → set_params`

**Files:**
- Modify: `src/mock-runner/engine.ts`

- [ ] **Step 1.** In `dispatch` for external `cc` / `sysex` (after RQ1 check), call `codec.decode(message)` and process each event:
  - `kind: "param"` → `handler.set_params([{name, value, part}])`. Note: codec.decode returns the wire byte value; if handler stores wire bytes, this is direct. If handler stores user-domain values, codec needs `formatWireValue` reversal — better to store wire bytes.
  - `kind: "loadProgram"` → already handled by accumulator path (Task 2).
  - `kind: "unknown"` → log and ignore (no special handling, no fallback `write_bytes`).

- [ ] **Step 2.** Drop the call to `handler.onMIDI`.

### Task 4 — Engine: RQ1 fulfillment via `paramsAtAddress`

**Files:**
- Modify: `src/mock-runner/engine.ts`

- [ ] **Step 1.** Replace `handler.read_bytes` use with:

```ts
const refs = codec.paramsAtAddress(req.address, req.size);
const values = handler.get_params(refs.map(r => r.name)); // and per-part subgroups if mixed
const data = new Array(req.size).fill(0);
for (const ref of refs) {
  const bytes = codec.encodeBytes(ref.name, values[ref.name], ref.part);
  for (let i = 0; i < bytes.length; i++) data[ref.byteOffset + i] = bytes[i];
}
const reply = codec.buildResponse(req, data);
```

- [ ] **Step 2.** Test: existing `get_current_state` E2E (`tests/e2e/mcb/juno-x-get-state.test.ts`) must still pass with engine-driven RQ1 fulfillment.

### Task 5 — JUNO-X handler: name-keyed state + drop legacy methods

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/mock-handler.ts`

- [ ] **Step 1.** Replace internal state shape:

```ts
interface PartState {
  engine: JunoXEngine;
  params: Record<string, number>;        // canonical paramKey → wire byte
}
let parts: PartState[] = [];
let globalParams: Record<string, number> = {};   // non-perPart params
let currentScene = { bank: 0, program: 0 };
```

- [ ] **Step 2.** Rewrite `set_params` to write directly to `globalParams[name]` or `parts[part-1].params[name]` based on `param.perPart`. The wire byte comes from `codec.map.resolveValue(param, value)`.

- [ ] **Step 3.** Rewrite `get_params` to read from the new state.

- [ ] **Step 4.** Rewrite `getFullStateObj`. Drop `sceneGlobal`. The `params` view IS the state now (no separate computation).

- [ ] **Step 5.** Implement `load_program(bank, slot)` — updates `currentScene`, returns `{state, log}`.

- [ ] **Step 6.** **Remove**: `onMIDI`, `read_bytes`, `handleSysEx`, `handleCC`, `handleProgram`, `handleUIParam`, `pendingBankMSB`, `pendingBankLSB`, `sysexLookup`, `parseDT1`/`addAddresses` imports, `SCENE_BASE`/`SCENE_PART_OFFSETS` imports (handler doesn't need address math anymore — codec does).

- [ ] **Step 7.** Verify the class wrapper `JunoXMockHandler` mirrors only the surviving methods.

### Task 6 — UI broadcast format

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/web/app.js`

- [ ] **Step 1.** Drop reads of `data.sceneGlobal` (the field is gone). All UI reads use `data.params.<name>` and `data.parts[N].params.<name>`.

- [ ] **Step 2.** Verify chorus / FX mirror still works (`syncFxUI` already reads `data.params`).

### Task 7 — Tests

- [ ] Drop / rewrite tests that depend on byte-level state shape. Tests should verify behavior through the public API only: `set_params` → `get_params` round-trip, `set_params` → `getFullState` reflects the change, etc.
- [ ] Add an engine-level test: external CC 0 + 32 + PC → `handler.load_program(bank, slot)` called once with the correct bank.
- [ ] Add an engine-level test: external DT1 with a known param address → `handler.set_params` called.
- [ ] Existing E2E (`juno-x-get-state.test.ts`) verifies the RQ1 round-trip works engine-driven.

### Task 8 — Documentation

- [ ] Update `docs/mock_runner.md` "Engine and handler — runtime contract" section: handler is now param-domain only, engine + codec own all MIDI.
- [ ] Update `CLAUDE.md` Mock Runner blurb.
- [ ] Move `30-midi-codec-architecture.md` and `30-stage5-pure-handler.md` to `docs/plans/completed/` once stage 5 ships.

---

## Test plan

- [ ] `npm run test:unit` — all pass; new tests for codec.paramsAtAddress / encodeBytes; new engine tests for bank-select + DT1 dispatch.
- [ ] `npm run test:integration` — pass.
- [ ] `npm run test:e2e:mcb` — pass (`juno-x-get-state` is the canary for engine-driven RQ1).
- [ ] Manual: connect to JUNO-X mock, change params via UI and via MCP, verify mock UI reflects state, verify `get_current_state` reads back.

## Out of scope

- Nord / Prophet handler refactor: they don't have addressable state today (CC-only with no protocol round-trip). The MockHandler interface changes are forward-compatible — Nord/Prophet handlers add `set_params` / `get_params` if/when they're exercised.
- ZEN-Core multi-partial RQ1 (todo #26 territory).
