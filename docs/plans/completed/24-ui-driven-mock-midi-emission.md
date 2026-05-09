# UI-Driven Mock MIDI Emission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the mock UI manipulates a parameter, the mock must (a) update its internal state and (b) emit the matching MIDI on its virtual MIDI Out port — same as a real panel knob — without echoing externally-received MIDI back out (which would loop on bridges).

**Architecture:**

Two pieces, layered:

1. **Handler-side: route UI param messages into state.** Today the engine's WS handler converts `{type:"cc"}` UI messages into `handler.onMIDI({type:"cc"})` so state updates. But for SysEx-addressed params (JUNO-X chorus mode, fx switches), the UI sends `{type:"param", name, value}` and the engine only `console.log`s — state never updates. This is why an RQ1 read after a UI button press returns the default. Fix by adding an optional `MockHandler.onUIParam(name, value, channel?)` method; the model's handler encodes the param to MIDI bytes, applies state via its own onMIDI, and returns a `MockHandlerResult` with the encoded message in `ccOut`/`sysexOut`.

2. **Engine-side: source-aware MIDI emission.** `MockEngine.onMIDI` becomes `(msg, source)`-aware. UI-sourced messages → engine writes the encoded MIDI to the device's MIDI Out (panel-knob analogue). External-MIDI-sourced messages → state updates, but NO echo to MIDI Out (otherwise an external CC would feedback-loop the moment a bridge or shadow listener forwards it back). Handler-explicit emissions (`result.sysexOut` / `ccOut` / `programOut`) are always written.

**Tech Stack:** TypeScript, easymidi virtual ports, WebSocket, `node:test`.

---

## File Structure

- `src/shared/keyboard-model.ts` — extend `MockHandlerResult` with `ccOut?` / `programOut?`; add `MockHandler.onUIParam?` to the interface.
- `src/mock-runner/engine.ts` — source-aware `onMIDI`; fan-out for ccOut / programOut; wire `{type:"param"}` WS path to `handler.onUIParam`.
- `src/keyboard_models/roland/juno_x/mock-handler.ts` — implement `onUIParam`: encode named params via parameter map → DT1 or CC → call own onMIDI for state.
- `tests/unit/mock-runner-ui-emit.test.ts` — engine source-aware routing.
- `tests/unit/juno-x/mock-ui-param.test.ts` — JUNO-X handler `onUIParam` round-trip (param → state + sysexOut).

## Tasks

### Task 1: Extend `MockHandlerResult` with `ccOut` and `programOut`

**Files:**
- Modify: `src/shared/keyboard-model.ts`

- [ ] **Step 1** — already added in this branch. Confirm fields present:

```ts
ccOut?: Array<{ controller: number; value: number; channel: number }>;
programOut?: Array<{ number: number; channel: number }>;
```

- [ ] **Step 2** — type-check: `npm run test:check`. Expected: pass.

### Task 2: Add `MockHandler.onUIParam` to the interface

**Files:**
- Modify: `src/shared/keyboard-model.ts`

- [ ] **Step 1** — add optional method to the `MockHandler` interface, after `onMIDI`:

```ts
/**
 * Called when a UI control fires `{type:"param", name, value, channel?}` — for
 * params addressed by SysEx address (no CC). The handler MUST encode the
 * named param to MIDI bytes, apply state by routing through its own onMIDI,
 * and return the encoded packet(s) in `sysexOut` / `ccOut` so the engine
 * can emit them on the device's MIDI Out (panel-knob analogue).
 *
 * Models whose UI never sends `{type:"param"}` (Nord, Prophet today) can
 * leave this unimplemented.
 */
onUIParam?(name: string, value: number | string, channel?: number): MockHandlerResult;
```

- [ ] **Step 2** — type-check: `npm run test:check`. Expected: pass.

### Task 3: Implement `onUIParam` on JUNO-X mock-handler

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/mock-handler.ts`

- [ ] **Step 1** — implement `onUIParam(name, value, channel)`:
  - Use the scene-params parameter map (or aggregated map already exposed) to find the param by name.
  - Resolve the user value to a midiValue (mirror `device.setParameters`: `resolveValue` → for sysex `data = sysexSize > 1 ? packNibbles(midiValue, sysexSize*2) : [midiValue]`).
  - For per-part params, derive `partIdx` from `channel` (channel 0 → part 0). Compute `fullAddress = addAddresses(SCENE_BASE, partOffset, param.sysexAddress)`.
  - Build the DT1 sysex via `buildDT1(JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddress, data)`.
  - Apply state by calling `this.onMIDI({type:"sysex", bytes: dt1Sysex})` (existing handler path writes to `sceneGlobal`/`parts`).
  - Return `{ ...inner, sysexOut: [dt1Sysex] }` so the engine emits.
  - For params with only `cc` defined: build `{controller, value: midiValue, channel: partIdx}`, call inner `onMIDI({type:"cc",...})`, return with `ccOut: [{...}]`.
  - For unknown params: return `{ log: \`UI: unknown param ${name}\` }` (graceful no-op).

- [ ] **Step 2** — keep the existing scene-globals routing intact; do not change the existing `onMIDI` paths.

- [ ] **Step 3** — `npm run lint && npm run build`. Expected: pass.

### Task 4: Source-aware routing in `MockEngine.onMIDI`

**Files:**
- Modify: `src/mock-runner/engine.ts`

- [ ] **Step 1** — change signature to `private onMIDI(msg: MidiMessage, source: "ui" | "external"): void`. Pass `"ui"` from WS handlers (cc/program/sysex) and `"external"` from `midiInput.on(...)` listeners.

- [ ] **Step 2** — replace the existing `result.sysexOut` fan-out with a unified emit block:

```ts
this.emitToMidiOut(result, source === "ui" ? msg : null);
```

and add a private helper:

```ts
private emitToMidiOut(result: MockHandlerResult, uiSource: MidiMessage | null): void {
  if (!this.midiOutput) return;
  // Handler-explicit emissions always go out.
  if (result.sysexOut) {
    for (const bytes of result.sysexOut) {
      try { this.midiOutput.send("sysex", bytes); }
      catch (err) { console.error("Mock virtual output sysex send failed:", err); }
    }
  }
  if (result.ccOut) {
    for (const cc of result.ccOut) {
      try { this.midiOutput.send("cc", cc); }
      catch (err) { console.error("Mock virtual output cc send failed:", err); }
    }
  }
  if (result.programOut) {
    for (const pc of result.programOut) {
      try { this.midiOutput.send("program", pc); }
      catch (err) { console.error("Mock virtual output program send failed:", err); }
    }
  }
  // UI-source echo: panel-knob analogue. External MIDI is NOT echoed (loops).
  // Only echo bare cc/program. UI-sourced sysex is rare — handler emits it
  // explicitly via sysexOut if it should be re-emitted.
  if (uiSource) {
    try {
      if (uiSource.type === "cc") {
        this.midiOutput.send("cc", { controller: uiSource.controller, value: uiSource.value, channel: uiSource.channel });
      } else if (uiSource.type === "program") {
        this.midiOutput.send("program", { number: uiSource.number, channel: uiSource.channel });
      }
    } catch (err) { console.error("Mock virtual output UI-echo send failed:", err); }
  }
}
```

- [ ] **Step 3** — build and lint: `npm run build && npm run lint`. Expected: pass.

### Task 5: Wire `{type:"param"}` WS path through `handler.onUIParam`

**Files:**
- Modify: `src/mock-runner/engine.ts`

- [ ] **Step 1** — in the WS message handler, replace the `console.log` for `msg.type === "param"` with:

```ts
} else if (msg.type === "param") {
  const result = this.handler.onUIParam
    ? this.handler.onUIParam(msg.name, msg.value, msg.channel ?? 0)
    : { log: `UI: ${msg.name} = ${msg.value} (handler has no onUIParam)` };
  if (result.state) this.broadcast(result.state);
  if (result.log) console.log(`UI: ${result.log}`);
  // UI-source for emit. The handler's own onMIDI may also have applied
  // state; the encoded packet is in result.sysexOut/ccOut.
  this.emitToMidiOut(result, null);
}
```

Note: we pass `null` as the `uiSource` here because the handler ALREADY put the encoded packet into `sysexOut`/`ccOut` — passing `uiSource` would cause a double-emit. The "UI source" routing model still holds — it's just that for `{type:"param"}`, the handler is responsible for the echo, not the engine.

- [ ] **Step 2** — `npm run build && npm run lint`. Expected: pass.

### Task 6: Unit tests

**Files:**
- Create: `tests/unit/mock-runner-ui-emit.test.ts`
- Create: `tests/unit/juno-x/mock-ui-param.test.ts`

- [ ] **Step 1** — `mock-runner-ui-emit.test.ts`: stub handler that records onMIDI calls and returns canned results. Construct engine with `noMidi:true, noRegistry:true`. Inject a fake `midiOutput` via `(engine as any).midiOutput = { send: (type, data) => sent.push({type,data}) }`. Then exercise `(engine as any).onMIDI(msg, source)` with the four scenarios:

```ts
// 1. UI CC → emitted (echo) + handler called
// 2. External CC → handler called, NOT emitted (no echo)
// 3. Handler-explicit ccOut → emitted regardless of source
// 4. Handler-explicit sysexOut → emitted regardless of source
```

Run: `npm run test:unit -- --grep mock-runner-ui-emit`. Expected: pass.

- [ ] **Step 2** — `juno-x/mock-ui-param.test.ts`: construct the JUNO-X mock handler, init it, call `onUIParam("chorus_switch", 1)`. Assert:
  - `result.sysexOut` contains a single DT1 packet whose address decodes to `01:00:50:00:00` and data is `[0x01]`.
  - The handler's internal `sceneGlobal` now has `chorus_switch` = 1 (read via `getFullState` snapshot or by triggering an RQ1 round-trip).

Run: `npm run test:unit -- --grep mock-ui-param`. Expected: pass.

- [ ] **Step 3** — full test suite: `npm test`. Expected: pass.

### Task 7: Plan housekeeping + commit

- [ ] **Step 1** — move `docs/plans/pending/24-ui-driven-mock-midi-emission.md` → `docs/plans/completed/`.
- [ ] **Step 2** — remove item #24 from `docs/plans/pending/todo-list.md`.
- [ ] **Step 3** — commit on `feat/24-ui-driven-mock-midi`, push, open PR.
