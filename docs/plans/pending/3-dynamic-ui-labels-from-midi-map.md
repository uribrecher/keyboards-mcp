# Dynamic UI Labels from MIDI Map

> **Execution order: 3 of 7** — Depends on: architecture plan (MockHandler owns state building). Small, self-contained change. No dependency on multi-device or backup plans.

## Context

Both the Nord and Prophet-6 mock UIs duplicate discrete parameter labels — once in the MIDI map (source of truth) and again as hardcoded `PARAM_LABELS` in each UI's `app.js`. This means adding or changing labels requires updating two places. We should send labels in the mock state so UIs build selectors dynamically.

## Architecture Alignment

Per the architecture plan, the mock engine is a **thin shell** — it does not build state messages or know about parameter types. The model's `MockHandler` owns all state formatting via `onMIDI() → MockHandlerResult.state`.

This means labels must be included in the state object that the **MockHandler** builds and broadcasts, not added by the engine. The engine just relays whatever the handler returns.

## Changes

### 1. Model MockHandlers (Nord + Prophet-6)

Each model's `MockHandler.onMIDI()` already builds the full state message for the UI. Update each handler to include `labels` in the state entries for discrete parameters:

```ts
// Inside the handler's state-building logic:
if (param.labels) {
  entry.labels = param.labels;  // e.g., { 0: "B3", 1: "Vox", 2: "Farfisa" }
}
```

The labels come from the model's own parameter map — the handler already has access to it. No engine involvement needed.

### 2. Nord UI — `src/keyboard_models/nord/electro_5d/web/app.js`

- Remove the hardcoded `PARAM_LABELS` constant (lines 4-21)
- In the UI build logic, check if the incoming param state has a `labels` object
- If it does and type is `discrete`, render button-group selectors from those labels
- The `updateUI()` selector logic (toggling `.active` class via `p.index`) stays the same

### 3. Prophet-6 UI — `src/keyboard_models/sequential_circuits/prophet_6/web/app.js`

- Remove the hardcoded `PARAM_LABELS` constant
- In `buildUI()`, replace `PARAM_LABELS[item.key]` check with `item.labels` check
- Rest of the logic (button creation, `updateUI()`) stays the same

### Notes

- Labels only need to be read during `buildUI()` (first state message). Subsequent updates use `index` to toggle the active button — no performance concern.
- Toggle params (On/Off) should NOT get button groups — they already render as toggle chips. Only render selectors for `type === "discrete"` params with `labels`.
- The Nord UI has additional complexity (bi-timbral parts, engine-dependent sections, drawbars). This change only affects the selector buttons — drawbars and continuous knobs are untouched.
- **No changes to `engine.ts`** — the engine is a thin relay. All state formatting is the handler's responsibility.

### Prerequisite

This plan assumes the **architecture plan** has been implemented first. `MockHandler` instances (created via `KeyboardModel.createMockHandler()`) must already own state building (no `buildParamEntry()` in the engine).

## Verification

1. `npm run build` — clean compile
2. Start mock runner with Nord model, check UI — selectors should render identically to before
3. Switch to Prophet-6 model, check UI — same
4. Verify no hardcoded `PARAM_LABELS` remain in either UI file
5. Add a new discrete param to a MIDI map and confirm it automatically gets a selector in the UI without any UI code changes

## Test Coverage

### Unit tests

**`tests/unit/nord-electro-5d/mock-handler.test.ts`** — add:
- **Labels in state:** Send a CC for a discrete param (e.g., `organ_model`). Assert the corresponding state entry includes a `labels` object with the expected keys/values from the MIDI map.
- **Labels absent for continuous/toggle:** Send a CC for a continuous param (e.g., `drawbar_1`) and a toggle param (e.g., `organ_on`). Assert neither state entry has a `labels` field.
- **Labels only on first state:** Call `getFullState()` twice. Assert `labels` is present in both (since the handler always builds full state).

**`tests/unit/juno-x/mock-handler.test.ts`** — add:
- **Labels in state for discrete params:** Same pattern — send a CC for a discrete JUNO-X param, verify `labels` in state entry.
- **No labels for continuous/toggle params.**

**`tests/unit/prophet-6/mock-handler.test.ts`** — add:
- **Labels in state for discrete params:** Same pattern for Prophet-6 discrete params.
- **No labels for continuous/toggle params.**

### Integration tests

**`tests/integration/mock-runner.test.ts`** — add:
- **Labels broadcast via WebSocket:** For each model, spawn mock, call `waitForState()`, pick a known discrete param key and assert its state entry contains `labels`. This verifies labels survive the handler → engine → WebSocket → client path.

### E2E tests

No new E2E tests needed — labels are a mock UI concern, not an MCP tool concern. The MCP tools (`list_parameters`, `set_parameters`) are unaffected. Existing E2E tests remain as-is to verify no regressions.
