# MidiCodec Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor so the MockHandler speaks pure params (no MIDI), a new `MidiCodec` owns param ↔ MIDI translation, and that codec is shared by both the mock and the MCP. The MockEngine stays as transport (ports, WS, source-aware routing).

**Architecture:** Three responsibilities, three modules:

```
                ┌───────────────────────────────────────────┐
                │   MockHandler (model logic)               │
                │   - set_params({name: value}, part?)      │
                │   - get_params([names], part?)            │
                │   - load_program(bank, slot)              │
                │   - load_song(bank, slot, part?)          │
                │   - get_full_state() / set_full_state()   │
                │   - state keyed by param NAME, not addr   │
                └───────┬───────────────────────────────────┘
                        │ pure param domain
            ┌───────────┴───────────┐
            ▼                       ▼
         ┌─────┐         ┌──────────────────────────────────┐
         │ UI  │         │  MidiCodec (per model)           │
         │     │         │  encodeParams([{name,value,part}]) → bytes[][]
         │     │         │  encodeAction({kind, ...})       → bytes[][]
         │     │         │  decode(bytes)                   → DecodedEvent[]
         │     │         │  parseRequest(bytes)             → RequestDescriptor?
         │     │         │  buildResponse(req, values)      → bytes[]
         │     │         └────────┬─────────────────────────┘
         │     │                  │ MIDI bytes
         │     │                  ▼
         │     │         ┌────────────────────────────┐
         │     │         │  MockEngine / MidiManager  │
         │     │         │  (transport: ports, WS,    │
         │     │         │  source-aware routing)     │
         │     │         └────────────────────────────┘
         └─────┘
```

**Tech Stack:** TypeScript 5.5, `node:test`, easymidi.

---

## Design decisions (locked)

1. **Name**: `MidiCodec`.
2. **Per-part addressing**: optional `part?` arg on `encodeParams` / `get_params` / `set_params`. Params with `perPart: true` in the parameter map require `part`; global params ignore it. The codec computes the full sysex address as `SCENE_BASE + SCENE_PART_OFFSETS[part-1] + param.sysexAddress` (mirroring today's logic in `device.setParameters`).
3. **Semantic actions**: `loadProgram`, `loadSong`, `loadSetList` are explicit methods on `MockHandler` — NOT params. `MidiCodec.encodeAction({kind: "loadProgram", bank, slot})` translates them to bank-select + program-change byte sequences. `decode(bytes)` returns a discriminated union including these as `{kind: "loadProgram", bank, slot}`.
4. **NoteOn / clock / aftertouch**: explicitly out of scope for the codec. Pass through engine unchanged.
5. **RQ1 round-trip orchestration stays in the MCP**: the codec exposes `parseRequest(bytes)` (returns a request descriptor, e.g. `{addr, size}` for Roland RQ1) and `buildResponse(req, paramValues)` (assembles the DT1 reply). The synchronous request/response with timeout (`requestRolandValue` today) lives in the MCP-side device helpers, not in the codec.
6. **State broadcast format**: handler broadcasts `{params: {name: value, ...}, parts: [...], scene: {...}, ...}` — keyed by param name, not by sysex address. Each model's UI updates its `ws.onmessage` to read `data.params.chorus_switch` etc. — mechanical edit, contained in stage 3.

## Decoded event shape

```ts
type DecodedEvent =
  | { kind: "param"; name: string; value: number; part?: number }
  | { kind: "loadProgram"; bank: number; slot: number; channel?: number }
  | { kind: "loadSong"; bank: number; slot: number; part?: string }
  | { kind: "request"; descriptor: RequestDescriptor }   // e.g. Roland RQ1
  | { kind: "unknown"; bytes: number[] };                // pass-through for things the codec doesn't handle
```

## Stages overview

- **Stage 1** — Introduce `MidiCodec` interface + JUNO-X implementation. MCP-side `device.setParameters` and `device.getState` delegate to it. Existing tests cover wire compatibility.
- **Stage 2** — Mock-side `handleSysEx`/`handleCC` delegate to `MidiCodec.decode` for parsing. Internal state stays addr-keyed (no semantic-state migration yet).
- **Stage 3** — MockHandler API switches to `set_params`/`get_params`. Internal state re-keyed by param name. UI WS protocol switches to `{type:"setParam",...}`. Each model's UI migrated.
- **Stage 4** — Drop `MockHandlerResult.{ccOut, programOut, sysexOut}` channels. Engine asks MidiCodec for emissions instead of accepting them from the handler.

Each stage ships a self-contained PR with passing tests.

---

## Stage 1 — `MidiCodec` interface + JUNO-X impl + MCP migration

**Files:**
- Create: `src/shared/midi-codec.ts` — interface + types
- Create: `src/keyboard_models/roland/juno_x/midi-codec.ts` — JUNO-X impl
- Create: `tests/unit/juno-x/midi-codec.test.ts` — round-trip tests
- Modify: `src/keyboard_models/roland/juno_x/index.ts` — expose `createCodec()` factory
- Modify: `src/keyboard_models/roland/juno_x/device.ts` — `setParameters` and `getState` delegate
- Modify: `src/shared/keyboard-model.ts` — optional `createCodec?()` on `KeyboardModel`

### Task 1.1 — Define the `MidiCodec` interface

**Files:**
- Create: `src/shared/midi-codec.ts`

- [ ] **Step 1: Write the interface module.**

```ts
import type { KeyboardParameter } from "./types.js";

/** A param to encode, optionally targeted to a specific part (1-based). */
export interface ParamRef {
  name: string;
  value: number | string;
  /** 1-based part index, required when the param has perPart=true. */
  part?: number;
}

/** A semantic action that translates to a sequence of MIDI messages. */
export type Action =
  | { kind: "loadProgram"; bank: number; slot: number; channel?: number }
  | { kind: "loadSong"; bank: number; slot: number; part?: string };

/** Roland-style request descriptor (RQ1: address + size). */
export interface RequestDescriptor {
  protocol: "roland-rq1";
  address: number[];
  size: number;
  deviceId: number;
}

/** What `decode` returns, per inbound MIDI message. */
export type DecodedEvent =
  | { kind: "param"; name: string; value: number; part?: number }
  | { kind: "loadProgram"; bank: number; slot: number; channel?: number }
  | { kind: "loadSong"; bank: number; slot: number; part?: string }
  | { kind: "request"; descriptor: RequestDescriptor }
  | { kind: "unknown"; bytes: number[] };

/** A single MIDI message to send (cc / program / sysex). */
export type EncodedMessage =
  | { type: "cc"; controller: number; value: number; channel: number }
  | { type: "program"; number: number; channel: number }
  | { type: "sysex"; bytes: number[] };

/**
 * Per-model translator between the param domain and the MIDI byte domain.
 * Used by both the mock (incoming MIDI → set_params) and the MCP
 * (outgoing set_params → MIDI bytes).
 */
export interface MidiCodec {
  /** Parameter map this codec is bound to (for findParam / formatValue). */
  readonly params: Readonly<Record<string, KeyboardParameter>>;

  /** Encode one or more param writes as the MIDI messages to send. */
  encodeParams(refs: ParamRef[]): EncodedMessage[];

  /** Encode a semantic action (loadProgram, loadSong) as MIDI messages. */
  encodeAction(action: Action): EncodedMessage[];

  /**
   * Decode an inbound MIDI message into one or more param-domain events.
   * Returns an empty array when the message has no model-relevant meaning.
   */
  decode(message: EncodedMessage): DecodedEvent[];

  /**
   * If the message is a request (e.g. Roland RQ1), return its descriptor.
   * Otherwise undefined. Caller decides how to fulfill it (e.g. mock reads
   * its own state and calls `buildResponse`; MCP awaits the actual reply).
   */
  parseRequest(message: EncodedMessage): RequestDescriptor | undefined;

  /**
   * Build the reply to a request given the param values that should be
   * carried in the response. Caller is responsible for resolving the
   * request descriptor's address into the right param values.
   */
  buildResponse(req: RequestDescriptor, paramValues: number[]): EncodedMessage;
}
```

- [ ] **Step 2: Type-check.** `npm run test:check`. Expected: pass.

### Task 1.2 — JUNO-X codec implementation

**Files:**
- Create: `src/keyboard_models/roland/juno_x/midi-codec.ts`

- [ ] **Step 1: Write a failing round-trip test.**

```ts
// tests/unit/juno-x/midi-codec.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createJunoXCodec } from "../../../src/keyboard_models/roland/juno_x/midi-codec.js";

describe("JUNO-X MidiCodec — encodeParams round-trips through decode", () => {
  it("scene-chorus toggle: ON encodes to a DT1 with byte 0x7F", () => {
    const codec = createJunoXCodec();
    const [msg] = codec.encodeParams([{ name: "chorus_switch", value: 1 }]);
    assert.equal(msg.type, "sysex");
    const events = codec.decode(msg);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { kind: "param", name: "chorus_switch", value: 127 });
  });

  it("scene-chorus continuous: chorus_level=80 round-trips as raw byte", () => {
    const codec = createJunoXCodec();
    const [msg] = codec.encodeParams([{ name: "chorus_level", value: 80 }]);
    const events = codec.decode(msg);
    assert.deepEqual(events[0], { kind: "param", name: "chorus_level", value: 80 });
  });
});
```

Run: `npm run test:unit -- --grep "JUNO-X MidiCodec"`. Expected: FAIL (module missing).

- [ ] **Step 2: Implement the codec.** Bridge to existing helpers:

```ts
// src/keyboard_models/roland/juno_x/midi-codec.ts
import type { KeyboardParameter } from "../../../shared/types.js";
import type { MidiCodec, ParamRef, Action, EncodedMessage, DecodedEvent, RequestDescriptor } from "../../../shared/midi-codec.js";
import { createParameterMap } from "./midi-map.js";
import { JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, SCENE_BASE, SCENE_PART_OFFSETS } from "./engines/engine-types.js";
import { buildDT1, parseDT1, parseRQ1, addAddresses, packNibbles, unpackNibbles, decodeRolandSize } from "../../../shared/roland-dt1.js";

export function createJunoXCodec(): MidiCodec {
  const map = createParameterMap();

  function encodeParam(ref: ParamRef): EncodedMessage {
    const found = map.findParam(ref.name);
    if (!found) throw new Error(`Unknown parameter: "${ref.name}"`);
    const midiValue = map.resolveValue(found.param, ref.value);

    if (found.param.sysexAddress !== undefined) {
      const partIdx = (ref.part ?? 1) - 1;
      let fullAddress: number[];
      if (found.param.perPart) {
        const partOffset = SCENE_PART_OFFSETS[partIdx] ?? SCENE_PART_OFFSETS[0];
        fullAddress = addAddresses(addAddresses(SCENE_BASE, partOffset), found.param.sysexAddress);
      } else {
        fullAddress = addAddresses(SCENE_BASE, found.param.sysexAddress);
      }
      const sysexSize = found.param.sysexSize ?? 1;
      const data = sysexSize > 1 ? packNibbles(midiValue, sysexSize * 2) : [midiValue];
      const bytes = buildDT1(JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddress, data);
      return { type: "sysex", bytes };
    }
    if (found.param.cc !== undefined) {
      const channel = ((ref.part ?? 1) - 1);
      return { type: "cc", controller: found.param.cc, value: midiValue, channel };
    }
    throw new Error(`${found.param.name}: no transport address`);
  }

  function encodeParams(refs: ParamRef[]): EncodedMessage[] {
    return refs.map(encodeParam);
  }

  function encodeAction(action: Action): EncodedMessage[] {
    if (action.kind === "loadProgram") {
      const channel = action.channel ?? 0;
      return [
        { type: "cc", controller: 0,  value: (action.bank >> 7) & 0x7F, channel },
        { type: "cc", controller: 32, value: action.bank & 0x7F,        channel },
        { type: "program", number: action.slot, channel },
      ];
    }
    if (action.kind === "loadSong") {
      // Same as loadProgram for JUNO-X — set lists are at separate banks.
      // Detailed addressing comes with todo #13.
      const channel = action.part ? (parseInt(action.part, 10) - 1) : 0;
      return [
        { type: "cc", controller: 0,  value: (action.bank >> 7) & 0x7F, channel },
        { type: "cc", controller: 32, value: action.bank & 0x7F,        channel },
        { type: "program", number: action.slot, channel },
      ];
    }
    return [];
  }

  function decode(message: EncodedMessage): DecodedEvent[] {
    if (message.type === "sysex") {
      // Try RQ1 first (it's a request, not a param write).
      const rq1 = parseRQ1(message.bytes, JUNO_X_MODEL_ID);
      if (rq1) {
        return [{
          kind: "request",
          descriptor: {
            protocol: "roland-rq1",
            address: rq1.address,
            size: decodeRolandSize(rq1.size),
            deviceId: rq1.deviceId,
          },
        }];
      }
      const dt1 = parseDT1(message.bytes, JUNO_X_MODEL_ID);
      if (!dt1) return [{ kind: "unknown", bytes: message.bytes }];
      // Resolve address back to a param name + part.
      return decodeDt1ToParams(dt1.address, dt1.data);
    }
    if (message.type === "cc") {
      const ccLookup = map.getParamByCC(message.controller);
      if (!ccLookup) return [];
      // Channel → 1-based part. perPart drives whether we surface part.
      const part = ccLookup.param.perPart ? message.channel + 1 : undefined;
      return [{ kind: "param", name: ccLookup.key, value: message.value, part }];
    }
    if (message.type === "program") {
      // Bank state lives in the engine/handler — codec only emits the PC half.
      return [{ kind: "loadProgram", bank: 0, slot: message.number, channel: message.channel }];
    }
    return [];
  }

  function decodeDt1ToParams(address: number[], data: number[]): DecodedEvent[] {
    // Walk the parameter map. For each param whose full address (with
    // current part offset) matches a prefix of `address`, emit a param
    // event with the unpacked value.
    const results: DecodedEvent[] = [];
    for (const [key, param] of Object.entries(map.params)) {
      if (!param.sysexAddress) continue;
      const candidates = param.perPart
        ? SCENE_PART_OFFSETS.map((off, i) => ({
            full: addAddresses(addAddresses(SCENE_BASE, off), param.sysexAddress!),
            part: i + 1,
          }))
        : [{ full: addAddresses(SCENE_BASE, param.sysexAddress), part: undefined as number | undefined }];
      for (const c of candidates) {
        if (c.full.length !== address.length) continue;
        if (!c.full.every((b, i) => b === address[i])) continue;
        const sysexSize = param.sysexSize ?? 1;
        const value = sysexSize > 1 ? unpackNibbles(data.slice(0, sysexSize * 2)) : data[0];
        results.push({ kind: "param", name: key, value, part: c.part });
        break;
      }
    }
    return results;
  }

  function parseRequest(message: EncodedMessage): RequestDescriptor | undefined {
    if (message.type !== "sysex") return undefined;
    const rq1 = parseRQ1(message.bytes, JUNO_X_MODEL_ID);
    if (!rq1) return undefined;
    return { protocol: "roland-rq1", address: rq1.address, size: decodeRolandSize(rq1.size), deviceId: rq1.deviceId };
  }

  function buildResponse(req: RequestDescriptor, paramValues: number[]): EncodedMessage {
    return { type: "sysex", bytes: buildDT1(JUNO_X_MODEL_ID, req.deviceId, req.address, paramValues) };
  }

  return { params: map.params, encodeParams, encodeAction, decode, parseRequest, buildResponse };
}
```

- [ ] **Step 3: Run round-trip test.** `npm run test:unit -- --grep "JUNO-X MidiCodec"`. Expected: PASS.

- [ ] **Step 4: Add per-part round-trip test.**

```ts
it("per-part param: encoded with correct part offset, decoded with part info", () => {
  const codec = createJunoXCodec();
  const [msg] = codec.encodeParams([{ name: "osc_attack", value: 64, part: 2 }]);
  const events = codec.decode(msg);
  const e = events.find(ev => ev.kind === "param" && ev.name === "osc_attack");
  assert.ok(e && e.kind === "param");
  assert.equal(e.part, 2);
  assert.equal(e.value, 64);
});
```

(Requires `osc_attack` to exist as a per-part param. If not, swap for any per-part name from the engine param sets — pick whichever exists in `engines/analog-synth.ts` or similar.)

Run: PASS.

- [ ] **Step 5: Add RQ1 / DT1 round-trip test.**

```ts
it("parseRequest + buildResponse round-trip via decode", () => {
  const codec = createJunoXCodec();
  // Build an RQ1 byte sequence from an existing helper for sanity.
  const reqBytes = /* helpers/buildRQ1 */;
  const req = codec.parseRequest({ type: "sysex", bytes: reqBytes });
  assert.ok(req);
  const reply = codec.buildResponse(req!, [0x7F]);
  const events = codec.decode(reply);
  assert.equal(events.find(e => e.kind === "param")?.value, 0x7F);
});
```

Run: PASS.

### Task 1.3 — Wire `createCodec()` into the model interface

**Files:**
- Modify: `src/shared/keyboard-model.ts`
- Modify: `src/keyboard_models/roland/juno_x/index.ts`

- [ ] **Step 1: Add `createCodec?()` to `KeyboardModel`.**

```ts
import type { MidiCodec } from "./midi-codec.js";

export interface KeyboardModel {
  // ...existing fields...
  /** Optional: per-model param ↔ MIDI codec. Required for stage 2+. */
  createCodec?(): MidiCodec;
}
```

- [ ] **Step 2: Implement on JUNO-X model export.**

```ts
// src/keyboard_models/roland/juno_x/index.ts
import { createJunoXCodec } from "./midi-codec.js";

const junoXModel: KeyboardModel = {
  // ...
  createCodec() { return createJunoXCodec(); },
};
```

- [ ] **Step 3: Build + lint.** `npm run build && npm run lint`. Expected: pass.

### Task 1.4 — MCP-side `device.setParameters` delegates to codec

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/device.ts`

- [ ] **Step 1: Replace inline encoding in `setParameters` with codec call.**

```ts
override setParameters(params, part?): ToolResult {
  this.requireConnection();
  const codec = junoXModel.createCodec!();
  const partNum = part === "lower" ? 2 : (part ? parseInt(part, 10) : undefined);

  const refs = params.map(p => ({ name: p.name, value: p.value, part: partNum }));
  let messages: EncodedMessage[];
  try { messages = codec.encodeParams(refs); }
  catch (err) { return { content: [{ type: "text", text: `Errors:\n${err.message}` }] }; }

  for (const m of messages) {
    if (m.type === "cc") this.connection!.sendCC(m.controller, m.value, m.channel);
    else if (m.type === "sysex") this.connection!.sendSysEx(m.bytes);
    else if (m.type === "program") this.connection!.sendProgramChange(m.number, m.channel);
  }

  // Build display lines using the codec's parameter map.
  const lines = refs.map(r => {
    const found = (codec.params)[r.name];
    return found ? `  ${found.name}: ${this.formatRefValue(found, r.value)}` : `  ${r.name}: ${r.value}`;
  });
  return { content: [{ type: "text", text: `Parameters set:\n${lines.join("\n")}` }] };
}
```

- [ ] **Step 2: Run existing JUNO-X setParameters tests.** Expected: PASS (wire bytes unchanged).

- [ ] **Step 3: Run E2E `set_parameters` test under MCB.** `npm run test:e2e:mcb -- --grep set-parameters` (or similar). Expected: PASS.

### Task 1.5 — MCP-side `device.getState` delegates to codec

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/device.ts`
- Modify: `src/shared/roland-dt1.ts` (if `requestRolandValue` needs codec hook)

- [ ] **Step 1: Replace `requestRolandValue` per-param call with a flow that uses the codec.**
  - For each param in the requested section: encode an RQ1 via codec helper (or keep direct `requestRolandValue` for now), receive the DT1, pass it to `codec.decode` to get back `{name, value}`.
  - Render with `formatValue` from the codec's parameter map.

- [ ] **Step 2: Run `tests/unit/juno-x/get-state.test.ts`.** Expected: PASS.

- [ ] **Step 3: Run `tests/e2e/mcb/juno-x-get-state.test.ts`.** Expected: PASS.

### Task 1.6 — Stage-1 commit + PR

- [ ] **Step 1:** Run full suite: `npm run test:unit && npm run test:integration && npm run test:e2e:mcb`. Expected: pass (modulo the pre-existing label-discovery failures on main).
- [ ] **Step 2:** Commit `feat: introduce MidiCodec; JUNO-X impl + MCP migration (stage 1 of #30)`.
- [ ] **Step 3:** Push + open PR. Title: `feat(midi-codec): JUNO-X codec + MCP migration (stage 1)`.

---

## Stage 2 — Mock-side delegates inbound parsing to MidiCodec

Sketch only — to be detailed when picked up.

- Mock handler's `handleSysEx` and `handleCC` call `codec.decode(message)` and process the returned `DecodedEvent[]`.
  - For `kind: "param"`, write to existing addr-keyed `sceneGlobal`/`parts` until stage 3 re-keys by name.
  - For `kind: "request"` (Roland RQ1), the mock reads the current value from its own state (using the same codec to map address → param name) and calls `codec.buildResponse(req, [value])`.
  - For `kind: "loadProgram"`, call mock's program-change handler.
- Removes inline `parseDT1`/`parseRQ1`/`unpackNibbles` use from JUNO-X mock-handler.
- Existing `tests/unit/juno-x/mock-rq1.test.ts` and `tests/integration/mcp-sysex-receive.test.ts` continue to pass.

## Stage 3 — Handler API switches to set_params / get_params

Sketch only — to be detailed when picked up.

- New `MockHandler` interface methods: `set_params(refs, part?)`, `get_params(names, part?)`. Old `onMIDI` and `onUIParam` removed (or kept only for migration).
- Internal state re-keyed by param name (not by sysex addr).
- `MockHandlerResult` simplified: just `{state?, log?}` — no more `ccOut`/`sysexOut`/`programOut` (those become engine-level via codec).
- Engine's WS handler accepts `{type:"setParam", name, value, part?}` from UI. Translates to `handler.set_params([{name, value, part}])`. The engine *also* asks the codec to encode it and emits MIDI on the device's MIDI Out (panel-knob analogue).
- Each model's UI WS message protocol updated:
  - Old: `{type:"cc", controller, value, channel}` and `{type:"param", name, value}`.
  - New: `{type:"setParam", name, value, part?}` (single shape).
- Each model's UI `ws.onmessage` reads `data.params.<name>` instead of `data.sceneGlobal[<addr>]`.

## Stage 4 — Drop MockHandlerResult emission channels

Sketch only — to be detailed when picked up.

- Remove `ccOut`, `programOut`, `sysexOut` from `MockHandlerResult` and from `MockHandler.onMIDI` if it still exists.
- Engine routes outbound by asking the codec: when `set_params` is invoked, engine encodes via codec and writes to `midiOutput`.
- For RQ1 → DT1 inside the mock: engine's incoming sysex listener invokes codec.parseRequest, asks handler for the param values, builds the response via codec, writes to midiOutput.
- Source-aware routing simplifies to: external MIDI in → handler.set_params (or load_program); UI setParam → handler.set_params + codec-encoded emission. No more "explicit handler emission" channel.

---

## Self-review

- [ ] **Spec coverage**: all six design decisions appear as tasks (codec interface, per-part, semantic actions, RQ1 split, broadcast format, name).
- [ ] **Type consistency**: `ParamRef`, `EncodedMessage`, `DecodedEvent`, `RequestDescriptor` used consistently in stage 1 tasks.
- [ ] **Placeholder scan**: stages 2-4 are explicitly "sketch only — to be detailed when picked up", so no placeholder pretending to be ready.
