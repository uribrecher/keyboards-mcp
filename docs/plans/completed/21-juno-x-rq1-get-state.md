# 21 — Roland RQ1 Protocol on JUNO-X mock + virtual MIDI input ports for all models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Roland RQ1 (Data Request 1) protocol on the JUNO-X mock — when the mock receives an RQ1 SysEx, it responds with a DT1 carrying the requested bytes from its own scene state. Also: every model mock gains a virtual MIDI **input port** to mirror what the real hardware exposes (the device's MIDI Out socket — from any listener's perspective, an MIDI input source). Outgoing SysEx (DT1 responses) is written to that port.

**Not in scope here:** End-to-end `get_current_state` for JUNO-X. The MCP cannot yet receive on the mock's virtual MIDI input port — that requires `connect_to_keyboard` to open the input direction (or a bridge to route it), which is the separate todo #22 (added below). The JUNO-X `getState` stub stays as-is in this PR.

This PR lays the foundation: protocol decode/encode + mock response side + emulation fidelity for the device's MIDI Out. PR #22 adds the MCP-side receive plumbing (transport-level); PR #23 wires JUNO-X `getState` against the live receive path.

**Architecture:** Two surface changes.
1. **All mock models** gain a virtual MIDI port pair at the OS level. Today MockEngine creates only the device's MIDI In socket (constructed via `easymidi.Input(name, true)` — apps send TO it). This PR adds the device's MIDI Out socket (constructed via `easymidi.Output(name, true)` — apps listen FROM it). Each MockEngine now exposes both directions, matching the real hardware. Outgoing SysEx written by handlers gets emitted on the new MIDI Out port.
2. **JUNO-X mock** parses incoming RQ1 SysEx, looks up the requested bytes from `sceneGlobal`, and emits a DT1 response via the new `MockHandlerResult.sysexOut` field. Pure mock-side work — the MCP doesn't consume the response in this PR.

**Tech Stack:** TypeScript 5.5+, easymidi, `node:test` + `node:assert`. No new dependencies.

**Source:** `docs/plans/pending/todo-list.md` item #21.
**Branch:** `feat/plan-21/juno-x-rq1` (create from `main`).

**Naming convention used in this plan:** "MIDI input port" = input from the MCP/listener's perspective, i.e. the device's MIDI Out socket. Today MockEngine creates the device's MIDI In socket via `easymidi.Input(name, true)` (apps send TO it). This PR adds the device's MIDI Out via `easymidi.Output(name, true)` (apps listen FROM it).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/shared/roland-dt1.ts` | modify | Add `parseRQ1` (mirrors `parseDT1`, command byte 0x11) so the mock can decode incoming requests. |
| `src/shared/keyboard-model.ts` | modify | Extend `MockHandlerResult` with optional `sysexOut?: number[][]`. |
| `src/mock-runner/engine.ts` | modify | Add an `easymidi.Output(name, true)` virtual port (the device's MIDI Out socket — apps listen FROM it) alongside the existing `easymidi.Input(name, true)` (the device's MIDI In socket — apps send TO it). On every `MockHandlerResult.sysexOut`, write each packet to the new MIDI Out port. All model mocks get this — the engine is shared. |
| `src/keyboard_models/roland/juno_x/mock-handler.ts` | modify | Detect incoming RQ1, look up `size` consecutive bytes starting at the requested address from `sceneGlobal`, return one DT1 response via `sysexOut`. |
| `docs/plans/pending/todo-list.md` | modify | Add todos #22 (MCP-side receive plumbing + `connect_to_keyboard` semantics + bridge integration), #23 (JUNO-X `get_current_state` rewrite, blocked on #22), and #24 (UI-driven mock MIDI emission). Also strikes #21 from the list (final-sweep task). |
| `tests/unit/shared/roland-dt1.test.ts` | modify | Add tests for `parseRQ1`. |
| `tests/unit/juno-x/mock-rq1.test.ts` | new | Mock handler RQ1 round-trip: feed an RQ1 via `onMIDI`, assert returned `sysexOut[0]` parses as the expected DT1. |

That's it. Four source files + one docs file + two test files. Notably absent:

**Deferred to #22 (transport-level receive):**
- `MidiConnection.requestSysEx` — no consumer in this PR.
- WsMidiConnection second URL or OS-level `input.on("sysex")` — depends on receive.
- MockEngine second WS lane (if needed) — depends on receive.
- mock-registry receive-port plumbing — depends on receive.
- `connect_to_keyboard` opening the device's MIDI Out — depends on receive.

**Deferred to #23 (JUNO-X feature, blocked on #22):**
- JUNO-X `getState` rewrite — depends on the live receive path.
- End-to-end integration test for RQ1 — same.
- System-prompt + CLAUDE.md updates — same.

**Deferred to #24 (independent of #22/#23):**
- `MockHandlerResult.ccOut` / `programOut` — needed for UI-driven emission, not for RQ1.
- Engine source-aware routing (UI-source vs external-MIDI-source).

---

## Task 1: Add `parseRQ1` to the Roland DT1 module

**Files:**
- Modify: `src/shared/roland-dt1.ts`
- Test: `tests/unit/shared/roland-dt1.test.ts`

The mock needs to parse incoming RQ1 requests. The existing module has `parseDT1` (cmd 0x12) but no `parseRQ1` (cmd 0x11). Same wire format except command byte and the trailing `size[4]` instead of `data[N+]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/shared/roland-dt1.test.ts`:

```ts
describe("parseRQ1", () => {
  it("decodes a valid RQ1 message into address + size", () => {
    const sysex = buildRQ1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x50, 0x00, 0x00], [0x00, 0x00, 0x00, 0x10]);
    const parsed = parseRQ1(sysex, JUNO_X_MODEL_ID);
    assert.ok(parsed);
    assert.deepStrictEqual(parsed!.address, [0x01, 0x50, 0x00, 0x00]);
    assert.deepStrictEqual(parsed!.size, [0x00, 0x00, 0x00, 0x10]);
  });

  it("returns null for a DT1 message (wrong command byte)", () => {
    const sysex = buildDT1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x00, 0x00, 0x00], [0x42]);
    assert.strictEqual(parseRQ1(sysex, JUNO_X_MODEL_ID), null);
  });

  it("returns null when checksum is wrong", () => {
    const sysex = buildRQ1(JUNO_X_MODEL_ID, 0x10, [0x01, 0x50, 0x00, 0x00], [0x00, 0x00, 0x00, 0x10]);
    sysex[sysex.length - 2] = (sysex[sysex.length - 2] + 1) & 0x7f;
    assert.strictEqual(parseRQ1(sysex, JUNO_X_MODEL_ID), null);
  });
});
```

If `parseRQ1`, `JUNO_X_MODEL_ID`, etc. aren't yet imported in this test file, add to the imports at the top:

```ts
import { buildDT1, buildRQ1, parseRQ1 } from "../../../src/shared/roland-dt1.js";
const JUNO_X_MODEL_ID = { bytes: [0x00, 0x00, 0x00, 0x00, 0x12] } as const;
```

(Use the existing `JUNO_X_MODEL_ID` constant if the test file already pulls it in.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/shared/roland-dt1.test.ts`
Expected: FAIL — `parseRQ1` is not exported.

- [ ] **Step 3: Implement `parseRQ1` and add a `RQ1Message` type**

In `src/shared/roland-dt1.ts`, after the existing `parseDT1` function:

```ts
export interface RQ1Message {
  address: number[];  // 4 bytes
  size: number[];     // 4 bytes (nibble-encoded byte count)
}

/**
 * Parse incoming SysEx bytes as a Roland RQ1 (Data Request 1) message.
 * Returns address + size if valid RQ1 for the given model, null otherwise.
 * Verifies: manufacturer=0x41, model ID match, command=0x11, checksum.
 */
export function parseRQ1(sysex: number[], modelId: RolandModelId): RQ1Message | null {
  // F0 41 <dev> <modelId> 11 <addr:4> <size:4> <checksum> F7
  const expectedLen = 1 + 1 + 1 + modelId.bytes.length + 1 + 4 + 4 + 1 + 1;
  if (sysex.length !== expectedLen) return null;

  let i = 0;
  if (sysex[i++] !== SYSEX_START) return null;
  if (sysex[i++] !== ROLAND_ID) return null;
  i++; // device id — accept any
  for (const b of modelId.bytes) {
    if (sysex[i++] !== b) return null;
  }
  if (sysex[i++] !== CMD_RQ1) return null;

  const address = sysex.slice(i, i + 4);
  i += 4;
  const size = sysex.slice(i, i + 4);
  i += 4;

  const receivedChecksum = sysex[i++];
  if (sysex[i] !== SYSEX_END) return null;

  const expectedChecksum = rolandChecksum([...address, ...size]);
  if (receivedChecksum !== expectedChecksum) return null;

  return { address, size };
}
```

Note: `CMD_RQ1` (= 0x11), `SYSEX_START`, `SYSEX_END`, `ROLAND_ID`, and `rolandChecksum` already exist in this file — reuse them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/unit/shared/roland-dt1.test.ts`
Expected: PASS, all three new cases.

- [ ] **Step 5: Commit**

```bash
git add src/shared/roland-dt1.ts tests/unit/shared/roland-dt1.test.ts
git commit -m "feat(roland-dt1): add parseRQ1 (todo #21)"
```

---

## Task 2: Extend `MockHandlerResult` with `sysexOut`

**Files:**
- Modify: `src/shared/keyboard-model.ts`

Pure type addition. Task 3 wires the engine to fan out the bytes; Task 4 has the JUNO-X handler emit them.

- [ ] **Step 1: Add the field to the interface**

In `src/shared/keyboard-model.ts`, find the `MockHandlerResult` interface and add `sysexOut`:

```ts
/** What the handler returns after processing a MIDI message */
export interface MockHandlerResult {
  /** Full state message to broadcast to UI (if changed) */
  state?: Record<string, any>;
  /** Console log line */
  log?: string;
  /**
   * Outgoing SysEx messages emitted by the handler. Each entry is one
   * full SysEx packet (F0..F7). The engine writes each packet to the
   * mock's virtual MIDI input port (the device's MIDI Out socket).
   */
  sysexOut?: number[][];
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: clean (no consumers exist yet — the field is optional).

- [ ] **Step 3: Commit**

```bash
git add src/shared/keyboard-model.ts
git commit -m "refactor(mock): add sysexOut to MockHandlerResult (todo #21)"
```

---

## Task 3: MockEngine — virtual MIDI Out port for the device + fan-out for `sysexOut`

**Files:**
- Modify: `src/mock-runner/engine.ts`

Two changes:
- (a) Add an `easymidi.Output(name, true)` virtual port (the device's MIDI Out socket — apps listen FROM it) alongside the existing `easymidi.Input(name, true)` (the device's MIDI In socket — apps send TO it). This matches the real hardware (every keyboard has both a MIDI In and MIDI Out socket).
- (b) On every `MockHandlerResult.sysexOut`, write each packet to the new MIDI Out port.

These changes apply to all model mocks because MockEngine is shared. Nord and Prophet-6 mocks won't emit anything yet (their handlers don't return `sysexOut`), but their port exists — fidelity, future-proofing.

- [ ] **Step 1: Add `midiOutput` field**

In `src/mock-runner/engine.ts`, find:

```ts
private midiInput: any | null = null;
```

Add directly below:

```ts
// The device's MIDI Out socket — apps listen FROM this port to receive
// outgoing MIDI emitted by the mock. Constructed via `easymidi.Output`.
// Task 4 wires JUNO-X RQ1 responses through here via MockHandlerResult.sysexOut.
private midiOutput: any | null = null;
```

- [ ] **Step 2: Create the virtual MIDI Out in `start()`**

Find the existing virtual-Input creation block in `start()`:

```ts
if (!this.opts.noMidi) {
  const easymidi = await import("easymidi");
  const before = new Set<string>(easymidi.default.getOutputs());
  this.midiInput = new easymidi.default.Input(this.opts.portName, true);
  // Capture the OS-assigned name. Core MIDI suffixes duplicates
  // ("Foo" then "Foo1") so two same-model mocks have distinct names.
  const after = easymidi.default.getOutputs();
  const newOnes = after.filter((p: string) => !before.has(p));
  if (newOnes.length === 1) this.actualPortName = newOnes[0];
}
```

Replace with:

```ts
if (!this.opts.noMidi) {
  const easymidi = await import("easymidi");
  const before = new Set<string>(easymidi.default.getOutputs());
  this.midiInput = new easymidi.default.Input(this.opts.portName, true);
  // Capture the OS-assigned name. Core MIDI suffixes duplicates
  // ("Foo" then "Foo1") so two same-model mocks have distinct names.
  const after = easymidi.default.getOutputs();
  const newOnes = after.filter((p: string) => !before.has(p));
  if (newOnes.length === 1) this.actualPortName = newOnes[0];

  // Virtual MIDI Out port (the device's MIDI Out socket — apps listen
  // FROM it). Same OS port name as the Input — Core MIDI distinguishes
  // by direction. easymidi `Output` = OS-level MIDI source.
  this.midiOutput = new easymidi.default.Output(this.actualPortName, true);
}
```

- [ ] **Step 3: Fan out `sysexOut` in `onMIDI`**

Find the existing `private onMIDI`:

```ts
private onMIDI(msg: MidiMessage): void {
  const result = this.handler.onMIDI(msg);
  if (result.state) this.broadcast(result.state);
  if (result.log) console.log(`MIDI: ${result.log}`);
}
```

Replace with:

```ts
private onMIDI(msg: MidiMessage): void {
  const result = this.handler.onMIDI(msg);
  if (result.state) this.broadcast(result.state);
  if (result.log) console.log(`MIDI: ${result.log}`);
  if (result.sysexOut && result.sysexOut.length > 0 && this.midiOutput) {
    for (const bytes of result.sysexOut) {
      try {
        this.midiOutput.send("sysex", bytes);
      } catch (err) {
        console.error("Mock virtual output sysex send failed:", err);
      }
    }
  }
}
```

(In `noMidi` WS-only mode, `this.midiOutput` is null — outgoing sysex simply has nowhere to go in this PR. PR #22 will add the WS lane for that case.)

- [ ] **Step 4: Close the virtual Output during shutdown**

Find the cleanup path (search for `midiInput.close` or similar). Add:

```ts
this.midiOutput?.close?.();
this.midiOutput = null;
```

next to the `midiInput` cleanup.

- [ ] **Step 5: Verify build + lint + unit**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -5
```

Expected: green. **No automated test for the engine fan-out path** in this PR — Task 4's mock-rq1 test calls `handler.onMIDI(...)` directly and asserts on the returned `sysexOut`; it does NOT go through `MockEngine.onMIDI` or verify the `midiOutput.send("sysex", ...)` line. The full transport chain gets covered by the end-to-end integration test that lands with #23 (when receive plumbing is in place). For this PR, Step 6's manual smoke is the gate.

- [ ] **Step 6: Verify the new port shows up in `list_midi_devices`**

This is a manual smoke check — not a CI gate, and the only verification of the engine fan-out in this PR. Build, start a JUNO-X mock (`npm run mock:headless -- --model roland-juno-x`), and check `list_midi_devices` in the MCP. The `inputs` array should now include "Roland JUNO-X Mock" alongside the existing entry in `outputs`. Same name, opposite direction.

- [ ] **Step 7: Commit**

```bash
git add src/mock-runner/engine.ts
git commit -m "feat(mock-engine): virtual MIDI input port for the device's MIDI Out socket (todo #21)"
```

---

## Task 4: JUNO-X mock RQ1 handler — return DT1 via `sysexOut`

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/mock-handler.ts`
- Test: `tests/unit/juno-x/mock-rq1.test.ts` (new)

When the mock receives an RQ1, look up the requested bytes from `sceneGlobal` (the existing scene-state map) and emit a single DT1 response via `sysexOut`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/juno-x/mock-rq1.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { JunoXMockHandler } from "../../../src/keyboard_models/roland/juno_x/mock-handler.js";
import { JUNO_X_MODEL_ID, SCENE_BASE } from "../../../src/keyboard_models/roland/juno_x/engines/engine-types.js";
import { buildDT1, buildRQ1, parseDT1, addAddresses } from "../../../src/shared/roland-dt1.js";

const DEVICE_ID = 0x10;
const CHORUS_SWITCH_OFFSET = [0x00, 0x50, 0x00, 0x00]; // see scene-params.ts
const CHORUS_SWITCH_ADDR = addAddresses(SCENE_BASE, CHORUS_SWITCH_OFFSET);

let handler: JunoXMockHandler;
beforeEach(() => {
  handler = new JunoXMockHandler();
  handler.init(0, 1);
});

describe("JUNO-X mock RQ1 → DT1 round-trip", () => {
  it("responds to RQ1 of chorus_switch with a DT1 carrying the stored byte", () => {
    // Set chorus_switch via DT1 first.
    const setMsg = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x01]);
    handler.onMIDI({ type: "sysex", bytes: setMsg });

    // Now issue RQ1 for the same address, size = 1 byte.
    const reqMsg = buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x00, 0x00, 0x00, 0x01]);
    const result = handler.onMIDI({ type: "sysex", bytes: reqMsg });

    assert.ok(result.sysexOut, "expected sysexOut on the result");
    assert.equal(result.sysexOut!.length, 1, "expected exactly one DT1 response");

    const parsed = parseDT1(result.sysexOut![0], JUNO_X_MODEL_ID);
    assert.ok(parsed, "response must parse as a DT1");
    assert.deepStrictEqual(parsed!.address, CHORUS_SWITCH_ADDR);
    assert.deepStrictEqual(parsed!.data, [0x01]);
  });

  it("responds with zero bytes when the address is unset", () => {
    const reqMsg = buildRQ1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x00, 0x00, 0x00, 0x01]);
    const result = handler.onMIDI({ type: "sysex", bytes: reqMsg });

    assert.ok(result.sysexOut);
    const parsed = parseDT1(result.sysexOut![0], JUNO_X_MODEL_ID);
    assert.deepStrictEqual(parsed!.data, [0x00], "default byte for unset address is 0");
  });

  it("does not emit sysexOut for a DT1 (which only updates state)", () => {
    const setMsg = buildDT1(JUNO_X_MODEL_ID, DEVICE_ID, CHORUS_SWITCH_ADDR, [0x01]);
    const result = handler.onMIDI({ type: "sysex", bytes: setMsg });
    assert.equal(result.sysexOut, undefined);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/unit/juno-x/mock-rq1.test.ts`
Expected: FAIL — the mock currently doesn't handle RQ1; `result.sysexOut` is undefined.

- [ ] **Step 3: Implement RQ1 handling**

In `src/keyboard_models/roland/juno_x/mock-handler.ts`, update the existing import to also pull in `parseRQ1`, `buildDT1`, and `unpackNibbles`:

```ts
import { parseDT1, parseRQ1, buildDT1, addAddresses, unpackNibbles } from "../../../shared/roland-dt1.js";
```

Find `handleSysEx` and replace with:

```ts
function handleSysEx(bytes: number[]): MockHandlerResult {
  // Try RQ1 first — if it matches, respond with a DT1 carrying the
  // requested bytes from our scene state. Real JUNO-X hardware does the
  // same; we mirror that so the MCP can use get_current_state once the
  // receive plumbing lands (todo #22) and getState is wired (todo #23).
  const rq1 = parseRQ1(bytes, JUNO_X_MODEL_ID);
  if (rq1) {
    const sizeBytes = unpackNibbles(rq1.size);
    const baseKey = addrKey(rq1.address);
    const data: number[] = [];
    for (let i = 0; i < sizeBytes; i++) {
      data.push(sceneGlobal[`${baseKey}[${i}]`] ?? 0);
    }
    const dt1Response = buildDT1(JUNO_X_MODEL_ID, 0x10, rq1.address, data);
    return {
      log: `RQ1: addr=${baseKey} size=${sizeBytes} → DT1 ${data.join(",")}`,
      sysexOut: [dt1Response],
    };
  }

  // Existing DT1 handling — unchanged below.
  const dt1 = parseDT1(bytes, JUNO_X_MODEL_ID);
  if (!dt1) {
    return { log: `SysEx (${bytes.length} bytes) — not a JUNO-X DT1, ignored` };
  }

  const { address, data } = dt1;
  const ak = addrKey(address);
  const paramName = sysexLookup.get(ak);

  // Route by address[0]
  if (address[0] === 0x01) {
    // Temporary Scene
    const subAddr = address[1];
    if (subAddr >= 0x10 && subAddr <= 0x14) {
      // Scene Part (partIndex 0-4)
      const partIdx = subAddr - 0x10;
      for (let i = 0; i < data.length; i++) {
        const key = `${ak}[${i}]`;
        parts[partIdx].sceneParams[key] = data[i];
      }
      const label = paramName ?? `addr ${ak}`;
      return {
        state: getFullStateObj(),
        log: `DT1: ${label} = ${data.join(",")}`,
      };
    } else {
      // Scene global params
      for (let i = 0; i < data.length; i++) {
        const key = `${ak}[${i}]`;
        sceneGlobal[key] = data[i];
      }
      const label = paramName ?? `Scene @ ${ak}`;
      return {
        state: getFullStateObj(),
        log: `DT1: ${label} = ${data.join(",")}`,
      };
    }
  }

  // Any other DT1 prefix — just log
  const label = paramName ?? `addr ${ak}`;
  return { log: `DT1: ${label} = ${data.join(",")} (not routed)` };
}
```

**Caveat:** the lookup `sceneGlobal[\`${baseKey}[${i}]\`]` assumes the RQ1 reads bytes within a single-param block (the same baseKey). Cross-param spans (RQ1 starting in one param's block and continuing into the next) will return zeros for the bytes outside the first block. That's an acceptable limitation for this PR — `get_current_state` consumers (lands in #23) should issue per-param RQ1s.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/unit/juno-x/mock-rq1.test.ts`
Expected: PASS, all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/roland/juno_x/mock-handler.ts tests/unit/juno-x/mock-rq1.test.ts
git commit -m "feat(juno-x mock): respond to RQ1 with DT1 from sceneGlobal (todo #21)"
```

---

## Task 5: Add todos #22, #23, and #24 — defer MCP-side receive, JUNO-X get_current_state, and UI-driven mock MIDI emission

**Files:**
- Modify: `docs/plans/pending/todo-list.md`

#21 lays the protocol foundation. Three follow-up items:
- **#22** = connection-semantics work: bidirectional `connect_to_keyboard`, MCB bridge integration, MCP-side `requestSysEx`. Pure plumbing.
- **#23** = JUNO-X `get_current_state` rewrite via RQ1. Blocked on #22 (needs the receive path).
- **#24** = UI-driven mock MIDI emission: when the JUNO-X mock UI is clicked/dragged, emit the corresponding MIDI on the new virtual MIDI input port (matches real hw knob-turn behavior). Independent of #22/#23.

- [ ] **Step 1: Add the three todo entries**

Open `docs/plans/pending/todo-list.md` and insert at the bottom:

```markdown
### 22. MCP-side receive plumbing for SysEx: connect semantics + bridge integration

**Status:** Needs brainstorming.

PR #21 implemented the Roland RQ1 protocol on the JUNO-X mock side and added a virtual MIDI input port (device's MIDI Out socket) to every model mock. **The MCP cannot yet receive on that port.** This todo closes the loop on the receive direction across all models — pure plumbing, no model-specific feature work.

Open design questions:

- **`connect_to_keyboard` arg semantics.** Today `port` means "the device's MIDI In socket (where MCP sends)" and `input_port` is a sidecar for shadow physical-knob mirroring. For queryable models, the MCP needs to listen on the device's MIDI Out. Should `input_port` be promoted to a real receive channel? Auto-resolved from a name pattern? Or rename `port` → `output_port` for clarity?
- **MCB lease scope.** Today MCB leases the primary output port. MIDI Input opens are exclusive on macOS — should the lease also cover the input direction so two MCPs don't fight over the same device's response stream?
- **Bridges as the receive-direction primitive.** Today `with_shadow` tees outgoing MIDI from primary → shadow. Could bridges become bidirectional, with a `with_input_bridge` argument forwarding device-output → MCP-input?
- **Transport options for receive.** Two paths to evaluate:
  - (a) MCP opens an OS-level MIDI input on the device's MIDI Out port and consumes `input.on("sysex")`. Works for both real hw and mocks. Requires extending `connect_to_keyboard` semantics.
  - (b) Mock-only: MockEngine spins up a dedicated WebSocket lane for outgoing MIDI, MCP listens there. Real-hw still needs path (a).
- **`MidiConnection.requestSysEx` API.** Generic request/response correlator (one-shot listener, timeout, matched-only resolution). Belongs on the interface so device classes can use it without knowing the transport.

Out of scope: any model-level feature that uses the receive path (e.g. JUNO-X get_current_state — that's #23, blocked on this).

Useful prior art: `src/midi/midi-manager.ts` `connectInput`, `src/mcb/bridge-registry.ts`, the `with_shadow` flow in `src/tools/connect.ts`. Mock side already done in #21.

### 23. JUNO-X `get_current_state` via Roland RQ1

**Status:** Blocked on #22.

Replace the JUNO-X `get_current_state` stub (added in PR #65) with a real RQ1-based query. The mock side is already in place from #21 (it parses RQ1 and emits DT1 responses); the MCP-side receive path is in place from #22.

Scope:
- Issue RQ1s for the addressed sections (start with scene-effects: chorus, delay, reverb, drive). Use the `MidiConnection.requestSysEx` API from #22.
- Decode the DT1 responses via the JUNO-X parameter map (the same address → param key/encoding lookups already used by `set_parameters`).
- Render the live values as the tool result.
- Map errors to tool-result text — timeout: "no response from JUNO-X (RQ1 timeout); is the device connected?". Malformed: "got a malformed DT1 — see logs."
- Update JUNO-X `agentSystemPrompt` and `CLAUDE.md` to reflect that RQ1 actually works (today both say "not yet implemented").

Out of scope: per-part RQ1 reads, ZCore / RD-piano per-part details, scene-modify section. Those are explicit follow-ups beyond #23 once the four scene-effects sections work end-to-end.

Useful prior art: \`docs/plans/completed/21-juno-x-rq1-get-state.md\` (mock side), \`src/keyboard_models/roland/juno_x/scene-params.ts\` (addresses), \`src/shared/roland-dt1.ts\` (\`buildRQ1\`, \`parseDT1\`, \`addAddresses\`, \`packNibbles\`).

### 24. UI-driven mock MIDI emission

**Status:** Needs design.

When the JUNO-X mock UI (Electron mock-runner web UI) is manipulated by mouse — knob clicks, drag-to-rotate, button presses — the mock should emit the corresponding MIDI message (CC, SysEx) on the virtual MIDI input port added in #21 (the device's MIDI Out socket). This mirrors real hardware: turning a knob on the panel emits MIDI on the device's MIDI Out for downstream listeners.

#### Today's flow

When the UI sends a `{type: "cc", controller, value, channel}` WebSocket message, MockEngine routes it as `this.onMIDI({type: "cc", ...})` — the SAME entry point used for external MIDI input arriving on the virtual Output port (the device's MIDI In socket). The handler updates internal state and broadcasts to UI clients. **No MIDI is emitted on the device's MIDI Out.**

#### What needs to change

The engine must, on receipt of a UI-sourced WS message, do BOTH:
1. Update internal state (call the handler — existing path).
2. Write the same MIDI bytes to the virtual MIDI input port (the device's MIDI Out — new path).

#### ⚠️ Echo-loop trap to design around

There's a subtle architectural hazard: today's engine doesn't distinguish "this CC came from UI" from "this CC came in over external MIDI." Both flow through `this.onMIDI({type: "cc", ...})` on the SAME path. If we naively make the engine "fan every onMIDI call to the MIDI output port too," we get an immediate echo loop the moment a real external MIDI source (or another mock, or the MCP itself) sends a CC into the mock's MIDI In:

```
External MIDI in → engine.onMIDI(cc) → midiOutput.send(cc)
  → loops back into anything listening on the device's MIDI Out
  → in worst case, into the same mock's MIDI In via a bridge → infinite loop
```

The fix is to keep "where this came from" out of the handler and resolve it at the engine routing layer:

- **UI-sourced** WS messages → engine writes to `midiOutput` directly (the hw analogue of "panel knob turned"), AND calls handler to update state.
- **External-MIDI-sourced** events (arriving on `midiInput.on("cc"|"program"|"sysex")`) → engine ONLY calls the handler. Does NOT write to `midiOutput` — that would echo what we just received.
- **Handler-explicit emissions** via `MockHandlerResult.ccOut` / `sysexOut` (e.g. JUNO-X RQ1→DT1 response from #21) → engine writes to `midiOutput`. The handler decided to emit; that's not an echo.

In other words, **routing decisions live in the engine**, keyed off the source of the inbound message. The handler stays source-agnostic. Echo-loops happen when source-agnostic routing meets a feedback path; we prevent that by making source-aware routing explicit and only at the boundary.

#### Scope when this lands

- Add `MockHandlerResult.ccOut?: Array<{controller, value, channel}>` (and possibly `programOut?` for completeness — match the existing `MidiMessage` types). Naming: `*Out` = mock-emits-this, mirroring `sysexOut` from #21.
- Engine extends `onMIDI` fan-out to write `ccOut` (and `programOut`) packets via `midiOutput.send("cc", ...)`.
- Engine adds a UI-source path that ALSO writes the inbound CC/sysex to `midiOutput` (separate from the handler-explicit `ccOut` mechanism).
- UI side: knob/button widgets already send `{type:"cc"}` etc. — likely no client-side changes needed beyond verifying the existing message format.
- Tests: unit-test the engine's source-aware routing (UI source → MIDI out, external source → no MIDI out).

#### Why this matters

Once a real external MIDI source can also drive the mock (hw + mock pair via a bridge — todo #22 territory), getting the routing wrong becomes a hard-to-debug runtime feedback loop. Documenting the trap here means the next implementer designs around it instead of discovering it the hard way.
```

- [ ] **Step 2: Commit**

```bash
git add docs/plans/pending/todo-list.md
git commit -m "docs(plans): add todos #22, #23, #24 for the deferred work (todo #21)"
```

---

## Task 6: Final sweep + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full local pyramid**

```bash
npm run lint
npm run test:check
npm run test:unit
npm run test:integration
npm run test:e2e:mcb
```

Expected: all green.

- [ ] **Step 2: Move plan to completed, strike #21 from todo-list**

```bash
mv docs/plans/pending/21-juno-x-rq1-get-state.md docs/plans/completed/
git add docs/plans/completed/21-juno-x-rq1-get-state.md
```

Edit `docs/plans/pending/todo-list.md` and delete the entire `### 21. JUNO-X get_current_state via Roland RQ1` block. Leave the `### 22.`, `### 23.`, and `### 24.` entries added in Task 5.

```bash
git add docs/plans/pending/todo-list.md
git commit -m "docs(plans): #21 complete — RQ1 protocol on JUNO-X mock + virtual input ports"
```

- [ ] **Step 3: Push + create PR**

```bash
git push -u origin feat/plan-21/juno-x-rq1
gh pr create --title "feat(juno-x): Roland RQ1 protocol on mock + virtual input ports for all models (#21)" --body "$(cat <<'EOF'
## Summary

Foundation PR for JUNO-X \`get_current_state\` over Roland RQ1. Two changes:

1. **All mock models gain a virtual MIDI input port** at the OS level (the device's MIDI Out socket). Today MockEngine only exposes the device's MIDI In side; with this change, the mock matches the real hardware's port pair.
2. **JUNO-X mock implements the RQ1 protocol.** When the mock receives an RQ1 SysEx, it looks up the requested bytes from \`sceneGlobal\` and emits a DT1 response on the new virtual input port via \`MockHandlerResult.sysexOut\`.

**End-to-end \`get_current_state\` is NOT in scope here** — the MCP cannot yet receive on the device's MIDI Out port. That work splits into two follow-ups: \`#22\` (connection-semantics + bridge integration — pure plumbing) and \`#23\` (JUNO-X \`get_current_state\` rewrite — blocked on #22).

## What's new

- \`parseRQ1\` in \`src/shared/roland-dt1.ts\` (mirrors existing \`parseDT1\`).
- \`MockHandlerResult.sysexOut\` field.
- MockEngine creates a virtual \`easymidi.Output(name, true)\` alongside the existing virtual Input.
- MockEngine writes any \`sysexOut\` packets to the new port.
- JUNO-X mock-handler responds to RQ1 with a DT1 carrying scene-state bytes.
- Todos #22, #23, and #24 added for the deferred work.

## What's deferred

**Todo #22 — MCP-side receive plumbing (pure transport):**
- \`MidiConnection.requestSysEx\` API.
- MCP-side OS-level \`input.on("sysex")\` consumption (or WS-based receive path).
- \`connect_to_keyboard\` opening the device's MIDI Out for receive.
- MCB bridge integration for bidirectional flows.

**Todo #23 — JUNO-X \`get_current_state\` (blocked on #22):**
- JUNO-X \`getState\` rewrite using \`requestSysEx\`.
- Decoding DT1 responses + rendering values.
- System-prompt + CLAUDE.md docs updates ("RQ1 not yet implemented" → "live").
- End-to-end integration test.

**Todo #24 — UI-driven mock MIDI emission (independent of #22/#23):**
- \`MockHandlerResult.ccOut\` (and \`programOut\`) for handler-explicit CC emissions.
- Engine source-aware routing: UI-sourced events → also write to MIDI out; external-MIDI-sourced events → handler only (no echo).
- Documents the echo-loop trap to design around.

## Test plan

- [x] \`npm run lint\`
- [x] \`npm run test:check\`
- [x] \`npm run test:unit\` — includes new \`parseRQ1\` tests + JUNO-X mock RQ1→DT1 round-trip
- [x] \`npm run test:integration\`
- [x] \`npm run test:e2e:mcb\`
- [ ] CI

## Plan

\`docs/plans/completed/21-juno-x-rq1-get-state.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Monitor CI + Copilot review**

Use `superpowers:finishing-a-development-branch` to handle CI failures and Copilot comments. Coverage gate is pre-existing red on `main`.

---

## Self-Review

**Spec coverage** (against the goal: implement RQ1 protocol for JUNO-X + add virtual MIDI input ports for all models):

| Goal element | Task |
|---|---|
| `parseRQ1` (decode side of RQ1 protocol) | Task 1 |
| `MockHandlerResult.sysexOut` (carrier for outgoing) | Task 2 |
| Virtual MIDI input port on all mocks | Task 3 |
| Mock fan-out to the new port | Task 3 |
| JUNO-X mock RQ1 → DT1 round-trip | Task 4 |
| Defer MCP-side receive plumbing | Task 5 (todo #22) |
| Defer JUNO-X `get_current_state` rewrite (depends on #22) | Task 5 (todo #23) |
| Defer UI-driven mock MIDI emission + document echo-loop trap | Task 5 (todo #24) |

**What's deliberately absent and where it lives:**
- `MidiConnection.requestSysEx` → todo #22 (no consumer in this PR; lives there with the receive path).
- WsMidiConnection second URL / OS input.on("sysex") → todo #22.
- MockEngine second WS lane (if used at all) → todo #22.
- mock-registry receive-port plumbing → todo #22.
- `connect_to_keyboard` semantic changes → todo #22.
- JUNO-X `getState` rewrite → todo #23 (blocked on #22).
- Integration test for end-to-end RQ1 → todo #23.
- System-prompt + CLAUDE.md updates → todo #23. **Known staleness:** the JUNO-X `agentSystemPrompt` (`src/keyboard_models/roland/juno_x/index.ts`) and the `JunoXDevice.getState` text both say `"planned in todo #21"`. After this PR ships, #21 is done but the feature isn't (it's in #23). The substantive claim — "not yet implemented" — remains true; only the cross-reference becomes stale. Per the user's "no docs changes in this PR" directive, the staleness is accepted; #23 will fix both wording sites when it lands.

**Placeholder scan:** Every step shows the actual edit. No "TBD" markers.

**Type consistency:**
- `parseRQ1` returns `RQ1Message { address: number[], size: number[] }` — used in Task 4's mock handler.
- `MockHandlerResult.sysexOut: number[][]` matches what the JUNO-X handler returns and what MockEngine consumes.
- `addrKey`, `sceneGlobal`, `parts` in mock-handler.ts already exist — Task 4 reuses them.

**Pre-flight verification:** Confirm `unpackNibbles` is exported from `src/shared/roland-dt1.ts`. (It is — checked during plan-writing.)
