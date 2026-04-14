# Dynamic UI Labels from MIDI Map

## Context

Both the Nord and Prophet-6 mock UIs duplicate discrete parameter labels — once in the MIDI map (source of truth) and again as hardcoded `PARAM_LABELS` in each UI's `app.js`. This means adding or changing labels requires updating two places. We should send labels from the engine so UIs build selectors dynamically.

## Changes

### 1. Engine — `src/mock-runner/engine.ts`

- Add `labels?: Record<number, string>` to the `ParamState` interface
- In `buildParamEntry()`, include `param.labels` for discrete/toggle params:
  ```ts
  if (param.labels) {
    entry.labels = param.labels;
  }
  ```

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

## Verification

1. `npm run build` — clean compile
2. Start mock runner with Nord model, check UI — selectors should render identically to before
3. Switch to Prophet-6 model, check UI — same
4. Verify no hardcoded `PARAM_LABELS` remain in either UI file
5. Add a new discrete param to a MIDI map and confirm it automatically gets a selector in the UI without any UI code changes
