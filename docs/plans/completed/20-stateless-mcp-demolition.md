# 20 — Stateless-MCP Demolition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the per-device parameter `StateManager` shadow and every rule that depends on it, so the MCP no longer pretends to know what is on the device. Per-model `get_current_state` becomes "not supported" (Nord, Prophet-6) or "not yet implemented — see todo #21" (JUNO-X). PR B (#21) replaces the JUNO-X stub with a real RQ1 query.

**Architecture:** Pure demolition + light per-model overrides. No new abstractions. The agent owns its own memory of what it sent across turns; the device (real or mock) owns ground truth. `setParameters` becomes a pure send-and-format with no side effects on the MCP side.

**Tech Stack:** TypeScript 5.5+, `node:test` + `node:assert`, ESLint 9+ flat config. No new dependencies.

**Source:** `docs/plans/pending/todo-list.md` item #20.
**Branch:** `feat/plan-20/stateless-mcp` (create from current `main`).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/shared/parameter-state.ts` | **delete** | The `GenericParameterState` shadow cache — no longer needed. |
| `src/shared/disabled-section-rule.ts` | **delete** | Generic helper used only by state-driven validation rules. |
| `src/keyboard_models/nord/electro_5d/state-manager.ts` | **delete** | Nord-specific shadow with preset-drawbar routing. |
| `src/keyboard_models/nord/electro_5d/validation.ts` | **delete** | All Nord validation rules read state. |
| `src/keyboard_models/sequential_circuits/prophet_6/validation.ts` | **delete** | Both Prophet-6 rules (arpeggiator gate, glide gate) read state. |
| `src/keyboard_models/roland/juno_x/state-manager.ts` | **delete** | Holds `JunoXState` (key→value cache + per-part engine tracking). |
| `src/keyboard_models/roland/juno_x/validation.ts` | **delete** | Scene-effect gates read state. |
| `src/shared/keyboard-model.ts` | modify | Remove `StateManager` interface; remove `state` field plumbing from `KeyboardDevice`. |
| `src/shared/base-keyboard-device.ts` | modify | Remove `state` field, `validateAfterSet`/`preflightBatch` hooks, prev→new diff in `setParameters`, default `getState` returns "not supported" sentinel. |
| `src/keyboard_models/nord/electro_5d/device.ts` | modify | Drop state ctor, drop `preflightBatch`/`validateAfterSet`/`onIncomingCC` overrides, override `getState` to return Nord's "not supported" message. |
| `src/keyboard_models/sequential_circuits/prophet_6/device.ts` | modify | Drop state ctor, drop `validateAfterSet` override, override `getState`. |
| `src/keyboard_models/roland/juno_x/device.ts` | modify | Drop `junoState`, simplify `setParameters` (no state writes, no prev→new), drop `validateAfterSet`, drop "ACTIVE ENGINES" header from `listParameters`, override `getState` to return "not yet implemented". |
| `src/keyboard_models/nord/electro_5d/index.ts` | modify | `createDevice` no longer constructs/passes state. |
| `src/keyboard_models/sequential_circuits/prophet_6/index.ts` | modify | Same. |
| `src/keyboard_models/roland/juno_x/index.ts` | modify | Same. |
| `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` | **delete** | All assertions read shadow state. |
| `tests/unit/nord-electro-5d/blocked-warning-filter.test.ts` | **delete** | Asserts on the now-removed preflight blocker. |
| `tests/unit/prophet-6/disabled-section-warnings.test.ts` | **delete** | All assertions read shadow state. |
| `tests/unit/juno-x/disabled-section-warnings.test.ts` | **delete** | All assertions read shadow state. |
| `tests/unit/nord-electro-5d/get-state.test.ts` | **new** | Asserts Nord's `get_current_state` returns the not-supported message. |
| `tests/unit/prophet-6/get-state.test.ts` | **new** | Same for Prophet-6. |
| `tests/unit/juno-x/get-state.test.ts` | **new** | Asserts JUNO-X's `get_current_state` returns the not-yet-implemented message. |
| `tests/e2e/get-state.test.ts` | modify | Update Nord assertion to expect the not-supported message instead of formatted state. |

The four `disabled-section-rule`/`disabled-section-warnings` files are the entire stateful-validation surface, plus their tests. Everything else is mechanical follow-on once those go.

---

## Task 1: Override `getState` on Nord to return "not supported"

**Files:**
- Modify: `src/keyboard_models/nord/electro_5d/device.ts`
- Test: `tests/unit/nord-electro-5d/get-state.test.ts` (new)

This is additive — the override sits next to existing code; nothing yet depends on it not being there.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/nord-electro-5d/get-state.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import nordModel from "../../../src/keyboard_models/nord/electro_5d/index.js";

describe("Nord Electro 5D get_current_state", () => {
  it("returns 'not supported' message — Nord MIDI is one-way", () => {
    const device = nordModel.createDevice!();
    const result = device.getState();
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /not supported/i);
    assert.match(text, /Nord MIDI is one-way/i);
  });

  it("returns the same not-supported message regardless of section filter", () => {
    const device = nordModel.createDevice!();
    const result = device.getState("organ");
    assert.match(result.content[0].text, /not supported/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/nord-electro-5d/get-state.test.ts`
Expected: FAIL — current `getState` returns the formatted shadow state ("No parameters have been set yet."), not the not-supported message.

- [ ] **Step 3: Implement the override**

In `src/keyboard_models/nord/electro_5d/device.ts`, add to `NordElectro5DDevice`:

```ts
override getState(_section?: string): ToolResult {
  return textResult(
    "Nord MIDI is one-way — get_current_state is not supported on this model. " +
    "The agent owns its memory of what it set; the hardware itself is the ground truth.",
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/unit/nord-electro-5d/get-state.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/nord/electro_5d/device.ts tests/unit/nord-electro-5d/get-state.test.ts
git commit -m "feat(nord): get_current_state returns 'not supported' (todo #20)"
```

---

## Task 2: Override `getState` on Prophet-6 to return "not supported"

**Files:**
- Modify: `src/keyboard_models/sequential_circuits/prophet_6/device.ts`
- Test: `tests/unit/prophet-6/get-state.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/prophet-6/get-state.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import prophetModel from "../../../src/keyboard_models/sequential_circuits/prophet_6/index.js";

describe("Prophet-6 get_current_state", () => {
  it("returns 'not supported' message — no implemented query path", () => {
    const device = prophetModel.createDevice!();
    const result = device.getState();
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /not supported/i);
    assert.match(text, /Prophet-6/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/prophet-6/get-state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the override**

In `src/keyboard_models/sequential_circuits/prophet_6/device.ts`, add to `Prophet6Device`:

```ts
override getState(_section?: string): ToolResult {
  return textResult(
    "Prophet-6 has no implemented query path — get_current_state is not supported on this model. " +
    "The agent owns its memory of what it set; the hardware itself is the ground truth.",
  );
}
```

You will need to add the imports: `import type { ToolResult } from "../../../shared/tool-result.js"; import { textResult } from "../../../shared/tool-result.js";`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/unit/prophet-6/get-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/sequential_circuits/prophet_6/device.ts tests/unit/prophet-6/get-state.test.ts
git commit -m "feat(prophet-6): get_current_state returns 'not supported' (todo #20)"
```

---

## Task 3: Override `getState` on JUNO-X to return "not yet implemented"

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/device.ts`
- Test: `tests/unit/juno-x/get-state.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/juno-x/get-state.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import junoModel from "../../../src/keyboard_models/roland/juno_x/index.js";

describe("JUNO-X get_current_state", () => {
  it("returns 'not yet implemented' message pointing to the RQ1 follow-up", () => {
    const device = junoModel.createDevice!();
    const result = device.getState();
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /not yet implemented/i);
    assert.match(text, /RQ1|todo #21/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/juno-x/get-state.test.ts`
Expected: FAIL — current `getState` returns formatted state.

- [ ] **Step 3: Implement the override**

In `src/keyboard_models/roland/juno_x/device.ts`, add to `JunoXDevice`:

```ts
override getState(_section?: string): ToolResult {
  return textResult(
    "JUNO-X get_current_state via Roland RQ1 is not yet implemented (planned in todo #21). " +
    "The agent owns its memory of what it set in the meantime.",
  );
}
```

`textResult` and `ToolResult` are already imported in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/unit/juno-x/get-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/roland/juno_x/device.ts tests/unit/juno-x/get-state.test.ts
git commit -m "feat(juno-x): get_current_state stub awaiting RQ1 (todo #20)"
```

---

## Task 4: Strip Nord's stateful validation + preflight

**Files:**
- Modify: `src/keyboard_models/nord/electro_5d/device.ts`
- Delete: `src/keyboard_models/nord/electro_5d/validation.ts`
- Delete: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts`
- Delete: `tests/unit/nord-electro-5d/blocked-warning-filter.test.ts`

After this task, Nord no longer emits advisory warnings or refuses-with-error-when-disabled. Real Nord hw silently no-ops on disabled-section CCs anyway, so behavior matches hardware. The system prompt's `STATE & MEMORY` section already tells the agent it owns this responsibility.

- [ ] **Step 1: Remove the validation imports and overrides from `NordElectro5DDevice`**

In `src/keyboard_models/nord/electro_5d/device.ts`:
- Remove the line `import { validateParameterBatch, preflightDisabledSections } from "./validation.js";`
- Delete the entire `preflightBatch` override (the whole method).
- Delete the entire `validateAfterSet` override (the whole method).

- [ ] **Step 2: Delete the validation file and its tests**

```bash
git rm src/keyboard_models/nord/electro_5d/validation.ts
git rm tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git rm tests/unit/nord-electro-5d/blocked-warning-filter.test.ts
```

- [ ] **Step 3: Verify build + lint + remaining unit tests pass**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -20
```

Expected: all green. The Nord unit tests that remain (`mock-handler.test.ts`, `parameter-map.test.ts`, plus the new `get-state.test.ts`) do not exercise validation.

- [ ] **Step 4: Commit**

```bash
git add -u src/keyboard_models/nord/electro_5d/device.ts
git commit -m "refactor(nord): drop stateful validation + preflight (todo #20)"
```

---

## Task 5: Strip Prophet-6's stateful validation

**Files:**
- Modify: `src/keyboard_models/sequential_circuits/prophet_6/device.ts`
- Delete: `src/keyboard_models/sequential_circuits/prophet_6/validation.ts`
- Delete: `tests/unit/prophet-6/disabled-section-warnings.test.ts`

- [ ] **Step 1: Remove the validation override from `Prophet6Device`**

In `src/keyboard_models/sequential_circuits/prophet_6/device.ts`:
- Remove `import { validateParameterBatch } from "./validation.js";`
- Delete the entire `validateAfterSet` override.

- [ ] **Step 2: Delete the validation file and its test**

```bash
git rm src/keyboard_models/sequential_circuits/prophet_6/validation.ts
git rm tests/unit/prophet-6/disabled-section-warnings.test.ts
```

- [ ] **Step 3: Verify**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -u src/keyboard_models/sequential_circuits/prophet_6/device.ts
git commit -m "refactor(prophet-6): drop stateful validation (todo #20)"
```

---

## Task 6: Strip JUNO-X's stateful validation

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/device.ts`
- Delete: `src/keyboard_models/roland/juno_x/validation.ts`
- Delete: `tests/unit/juno-x/disabled-section-warnings.test.ts`

- [ ] **Step 1: Remove the validation override from `JunoXDevice`**

In `src/keyboard_models/roland/juno_x/device.ts`:
- Remove `import { validateParameterBatch } from "./validation.js";`
- Delete the entire `validateAfterSet` override.
- In the existing `setParameters` override, remove the line `const warnings = this.validateAfterSet(resolvedKeys, part ?? "1");` and any subsequent code that handles `warnings` (the warnings block and the `result.warnings` assignment). The result text becomes just `Parameters set:\n...` and (if any) `Errors:\n...`.

- [ ] **Step 2: Delete the validation file and its test**

```bash
git rm src/keyboard_models/roland/juno_x/validation.ts
git rm tests/unit/juno-x/disabled-section-warnings.test.ts
```

- [ ] **Step 3: Verify**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -u src/keyboard_models/roland/juno_x/device.ts
git commit -m "refactor(juno-x): drop stateful validation (todo #20)"
```

---

## Task 7: Strip JUNO-X engine tracking from `listParameters`

**Files:**
- Modify: `src/keyboard_models/roland/juno_x/device.ts`

The "ACTIVE ENGINES" header in `listParameters` is rendered from `junoState.getAllEngines()`. That's a state-shaped fact derived from previous `set_parameters` calls. With statelessness, the device cannot know the active engine without querying — that's PR B (RQ1). For PR A, drop the header.

- [ ] **Step 1: Remove the override**

In `src/keyboard_models/roland/juno_x/device.ts`:
- Delete the entire `listParameters` override.
- Remove `import { JunoXState } from "./state-manager.js";` and `import { ... PART_NAMES, ENGINE_DISPLAY_NAMES } from "./engines/engine-types.js";` (keep imports still used by other methods — open the file and prune dead ones).
- Delete the `private junoState: JunoXState;` and `private junoMap: JunoXParameterMap;` fields (the latter is currently kept around for `findParam`; replace usages with `this.parameterMap as JunoXParameterMap` inline, or just keep `junoMap` if it's still useful — but `junoState` definitely goes).

NOTE: `junoState` is also referenced in `setParameters` (state.set / state.get for prev→new). Those go in Task 9. For this task, leave them temporarily — replace `this.junoState` with a stack-local `new JunoXState(...)` so the build still passes, OR do this task and Task 9 in the same sitting. Recommended: do them together — see Step 2 below.

- [ ] **Step 2: Combined with Task 9 — strip all `junoState` usage in one commit**

This task is best done together with Task 9 (which removes prev→new diff and state writes from `setParameters`). Skip ahead to Task 9, do both at once, commit as one. Mark this task complete at that point.

- [ ] **Step 3: Commit (combined with Task 9)**

See Task 9.

---

## Task 8: Decommission `validateAfterSet` and `preflightBatch` hooks in `BaseKeyboardDevice`

**Files:**
- Modify: `src/shared/base-keyboard-device.ts`

After Tasks 4–6 nothing overrides these hooks. Their definitions in the base class are dead.

- [ ] **Step 1: Remove the default hook bodies**

In `src/shared/base-keyboard-device.ts`:
- Delete the `protected preflightBatch(...)` method (the no-op default).
- Delete the `protected validateAfterSet(...)` method (the no-op default).

- [ ] **Step 2: Remove their use sites in `setParameters`**

Still in `src/shared/base-keyboard-device.ts`:
- Delete the entire "Phase 2: preflight" block (the `const preflight = this.preflightBatch(...)` line and surrounding logic that uses `preflight.blockedKeys` and `preflight.errors`).
- In "Phase 3: apply", remove the `if (preflight.blockedKeys.has(entry.found.key)) continue;` check — every resolved entry is now applied unconditionally.
- Delete the entire "Phase 4: post-apply advisory warnings" block (the call to `validateAfterSet` and the `warnings` accumulation).
- Remove the `if (warnings.length > 0) result.warnings = warnings;` line at the end.
- Remove the `if (warnings.length > 0) text += ...` block that appended warnings to the result text.

After this, `setParameters` is: resolve → apply (sendCC + state.set) → format result. Phases collapse.

- [ ] **Step 3: Verify build + lint + tests**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -u src/shared/base-keyboard-device.ts
git commit -m "refactor(base): drop validateAfterSet/preflightBatch hooks (todo #20)"
```

---

## Task 9 (combined with Task 7): Strip `state` writes and prev→new diff from BOTH `BaseKeyboardDevice.setParameters` AND `JunoXDevice.setParameters`. Drop `junoState` entirely.

**Files:**
- Modify: `src/shared/base-keyboard-device.ts`
- Modify: `src/keyboard_models/roland/juno_x/device.ts`

The base `setParameters` reads `this.state.get(...)` for prev display, then writes `this.state.set(...)` after each apply. JUNO-X's override does the same with `this.junoState`. Both go away.

- [ ] **Step 1: Strip from `BaseKeyboardDevice.setParameters`**

In `src/shared/base-keyboard-device.ts`, inside the apply loop:

```ts
// BEFORE:
for (const entry of applyQueue) {
  const prevMidi = this.state.get(entry.found.key, entry.statePart);
  if (entry.found.param.cc !== undefined) {
    this.connection!.sendCC(entry.found.param.cc, entry.midiValue);
  }
  this.state.set(entry.found.key, entry.midiValue, entry.statePart);

  const displayValue = this.parameterMap.formatValue(entry.found.param, entry.midiValue);
  const prevDisplay =
    prevMidi !== undefined
      ? this.parameterMap.formatValue(entry.found.param, prevMidi)
      : "unset";
  results.push(`  ${entry.found.param.name}: ${prevDisplay} → ${displayValue}`);
}

// AFTER:
for (const entry of applyQueue) {
  if (entry.found.param.cc !== undefined) {
    this.connection!.sendCC(entry.found.param.cc, entry.midiValue);
  }
  const displayValue = this.parameterMap.formatValue(entry.found.param, entry.midiValue);
  results.push(`  ${entry.found.param.name}: ${displayValue}`);
}
```

`statePart` is no longer used in the apply path — `resolvePartForParam` is still called for downstream models that may need it for transport routing (e.g. JUNO-X uses `part` for SysEx address calculation). Keep the per-part *resolution*, drop the per-part *storage*.

- [ ] **Step 2: Strip from `JunoXDevice.setParameters`**

In `src/keyboard_models/roland/juno_x/device.ts`:
- Remove every `this.junoState.get(...)` and `this.junoState.set(...)` call.
- Remove the prev→new formatting (replace with `Name: <new>`).
- Remove the `private junoState: JunoXState;` field, the constructor's `const junoState = ...; this.junoState = junoState;` line, and the `super(model, deps, junoState)` becomes `super(model, deps)` (signature change handled in Task 11).
- Delete the entire `listParameters` override (Task 7 step).
- Remove now-unused imports: `JunoXState`, `PART_NAMES` (if only used for engine display), `ENGINE_DISPLAY_NAMES`. Keep `JUNO_X_MODEL_ID`, `JUNO_X_DEVICE_ID`, `SCENE_BASE`, `SCENE_PART_OFFSETS` — those are SysEx routing.

- [ ] **Step 3: Verify build + lint + tests**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -10
```

Expected: all green. JUNO-X mock-handler tests do not assert on the "ACTIVE ENGINES" header (verified during plan-writing).

- [ ] **Step 4: Commit**

```bash
git add -u src/shared/base-keyboard-device.ts src/keyboard_models/roland/juno_x/device.ts
git commit -m "refactor: drop state writes and prev→new diff from setParameters (todo #20)"
```

---

## Task 10: Update each model's `createDevice` and constructor signatures

**Files:**
- Modify: `src/shared/base-keyboard-device.ts` (constructor signature)
- Modify: `src/shared/keyboard-model.ts` (`KeyboardDevice` interface)
- Modify: `src/keyboard_models/nord/electro_5d/device.ts`
- Modify: `src/keyboard_models/sequential_circuits/prophet_6/device.ts`
- Modify: `src/keyboard_models/roland/juno_x/device.ts`
- Modify: `src/keyboard_models/nord/electro_5d/index.ts`
- Modify: `src/keyboard_models/sequential_circuits/prophet_6/index.ts`
- Modify: `src/keyboard_models/roland/juno_x/index.ts`

After Task 9, no device class uses `this.state`. Now we can remove the field itself.

- [ ] **Step 1: `BaseKeyboardDevice` — drop `state` field and ctor arg**

In `src/shared/base-keyboard-device.ts`:
- Remove `protected state: StateManager;` field.
- Remove the `state: StateManager` parameter from the constructor signature.
- Remove `this.state = state;` from the constructor body.
- Remove `this.state.reset();` from `detach()`.
- Remove `import type { ..., StateManager, ... }` (drop the `StateManager` symbol from the type-only import — the rest of the import line stays).

- [ ] **Step 2: Update `KeyboardDevice` interface**

In `src/shared/keyboard-model.ts`:
- Delete the entire `// ── State manager ──` section, including the `StateManager` interface block.
- The `KeyboardDevice` interface itself does NOT have `state` as a field, only the base class did. No interface change needed — but verify by reading the interface body and confirming no `state` reference.

- [ ] **Step 3: Update each model's device ctor and `createDevice`**

In `src/keyboard_models/nord/electro_5d/device.ts`:
- Change ctor body from `super(model, deps, new NordElectro5DState(deps.parameterMap));` to `super(model, deps);`.
- Remove `import { NordElectro5DState } from "./state-manager.js";`.
- Remove the `onIncomingCC` override entirely (it only existed to write incoming CC values to state; with no state, no purpose).

In `src/keyboard_models/sequential_circuits/prophet_6/device.ts`:
- Change `super(model, deps, new GenericParameterState([], deps.parameterMap));` to `super(model, deps);`.
- Remove `import { GenericParameterState } from "../../../shared/parameter-state.js";`.

In `src/keyboard_models/roland/juno_x/device.ts`:
- Change ctor `super(model, deps, junoState);` to `super(model, deps);`. Verify the `junoState` field/local was already removed in Task 9.

The three `index.ts` files do not currently pass `state` to `createDevice`, so they don't change.

- [ ] **Step 4: Verify build + lint + tests**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -u src/shared/base-keyboard-device.ts src/shared/keyboard-model.ts \
        src/keyboard_models/nord/electro_5d/device.ts \
        src/keyboard_models/sequential_circuits/prophet_6/device.ts \
        src/keyboard_models/roland/juno_x/device.ts
git commit -m "refactor: drop StateManager field from KeyboardDevice (todo #20)"
```

---

## Task 11: Delete `parameter-state.ts`, `disabled-section-rule.ts`, and the two model-specific state-manager files

**Files:**
- Delete: `src/shared/parameter-state.ts`
- Delete: `src/shared/disabled-section-rule.ts`
- Delete: `src/keyboard_models/nord/electro_5d/state-manager.ts`
- Delete: `src/keyboard_models/roland/juno_x/state-manager.ts`

By this point all imports have been pruned. These files are unreferenced.

- [ ] **Step 1: Verify nothing imports them**

```bash
grep -rln "parameter-state\|disabled-section-rule\|state-manager" src/ tests/
```

Expected: zero results. If anything is found, fix that first — don't delete a still-referenced file.

- [ ] **Step 2: Delete the files**

```bash
git rm src/shared/parameter-state.ts \
       src/shared/disabled-section-rule.ts \
       src/keyboard_models/nord/electro_5d/state-manager.ts \
       src/keyboard_models/roland/juno_x/state-manager.ts
```

- [ ] **Step 3: Verify**

```bash
npm run build && npm run lint && npm run test:unit 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: delete StateManager files and disabled-section helper (todo #20)"
```

---

## Task 12: Update the e2e `get-state.test.ts` to expect "not supported"

**Files:**
- Modify: `tests/e2e/get-state.test.ts`

The current test asserts the result includes "Drawbar 1" after setting drawbar_1. After the pivot, `get_current_state` on Nord returns the not-supported message regardless of what was set.

- [ ] **Step 1: Rewrite the test to assert the new behavior**

Replace the existing single test inside `describe("E2E: get_current_state", ...)` with:

```ts
it("Nord get_current_state returns the not-supported message", async () => {
  const conn = await h.callTool("connect_to_keyboard", { port: "Nord Electro 5D Mock", model: "nord-electro-5d" });
  assert.ok(!conn.isError, `connect failed: ${conn.content[0].text}`);
  await new Promise((r) => setTimeout(r, 500));

  // Even after a set_parameters, get_current_state does not surface what was set.
  const setResult = await h.callTool("set_parameters", {
    parameters: [{ name: "drawbar_1", value: 5 }],
  });
  assert.ok(!setResult.isError);

  const result = await h.callTool("get_current_state");
  assert.ok(!result.isError, `get_state error: ${result.content[0].text}`);
  const text = result.content[0].text;
  assert.match(text, /not supported/i, `expected not-supported message: ${text.slice(0, 300)}`);
  assert.doesNotMatch(text, /Drawbar 1/, "must not surface previously-set values");
  await h.reset();
});
```

- [ ] **Step 2: Verify (requires external MCB — skip if not available locally)**

If `npm run mcb` is running in another terminal:
```bash
npm run test:e2e 2>&1 | tail -10
```
Expected: passes. If MCB is not running, defer to CI.

- [ ] **Step 3: Commit**

```bash
git add -u tests/e2e/get-state.test.ts
git commit -m "test(e2e): get_current_state returns not-supported on Nord (todo #20)"
```

---

## Task 13: Final sweep — lint, typecheck, full test pyramid, push, PR

**Files:** none (verification + PR creation)

- [ ] **Step 1: Run the full local pyramid**

```bash
npm run lint
npm run test:check
npm run test:unit
npm run test:integration
npm run test:e2e:mcb
```

Expected: every step green. Do NOT proceed to PR if any layer fails.

- [ ] **Step 2: Move the plan to completed**

```bash
git mv docs/plans/pending/20-stateless-mcp-demolition.md docs/plans/completed/
git commit -m "docs(plans): move 20-stateless-mcp-demolition to completed"
```

- [ ] **Step 3: Strike item #20 out of `docs/plans/pending/todo-list.md`**

Edit `docs/plans/pending/todo-list.md` and replace the entire `### 20. ...` block (header + body) with a single line note pointing to the executed plan, OR delete the block entirely. Convention in this repo (see #5–#9 which are now executed) is to delete from `pending/todo-list.md` once the plan is in `completed/`.

```bash
git add docs/plans/pending/todo-list.md
git commit -m "docs(todo): #20 done — see docs/plans/completed/20-stateless-mcp-demolition.md"
```

- [ ] **Step 4: Push and create the PR**

```bash
git push -u origin feat/plan-20/stateless-mcp
gh pr create --title "refactor: drop StateManager / shadow / disabled-section preflight (#20)" --body "$(cat <<'EOF'
## Summary

Removes the per-device parameter shadow (`StateManager`) and every rule that depended on it. Implements per-model `get_current_state` per the design in #64:

- Nord: returns "not supported — Nord MIDI is one-way."
- Prophet-6: returns "not supported — no implemented query path."
- JUNO-X: returns "not yet implemented (planned in todo #21)."

PR B (#21) replaces the JUNO-X stub with a real RQ1 query.

## What's gone

- `src/shared/parameter-state.ts`, `src/shared/disabled-section-rule.ts`
- Per-model `state-manager.ts` and `validation.ts` files (Nord, Prophet-6, JUNO-X)
- `validateAfterSet` and `preflightBatch` hooks on `BaseKeyboardDevice`
- The `prev → new` diff in `setParameters` output (just `name: new` now)
- The "ACTIVE ENGINES" header in JUNO-X `listParameters`
- The disabled-section warning/error tests for all three models, plus the blocked-warning-filter test

## Test plan

- [x] `npm run lint`
- [x] `npm run test:check`
- [x] `npm run test:unit`
- [x] `npm run test:integration`
- [x] `npm run test:e2e:mcb`
- [ ] CI

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Monitor CI + Copilot review**

Use `superpowers:finishing-a-development-branch` to handle CI failures and Copilot comments. Coverage gate is pre-existing red on `main` — same as #64; safe to merge red on coverage with user confirmation.

---

## Self-Review

**Spec coverage:** Walked the todo #20 body line-by-line. Every named removal (parameter-state.ts, disabled-section-rule.ts, Nord state-manager.ts, Nord/Prophet-6/JUNO-X validation.ts, `state` field plumbing, prev→new diff, `validateAfterSet`/`preflightBatch` hooks, `get_current_state` per-model) maps to a task. Engine tracking on JUNO-X (`listParameters` header) is also covered (Task 7/9). Tests called out (`disabled-section-warnings.test.ts` ×3, `blocked-warning-filter.test.ts`, `tests/e2e/get-state.test.ts`, `tests/e2e/multi-model.test.ts`) all addressed. The `multi-model.test.ts` assertion `!stateResult.isError` still holds for the new "not supported" tool result (no change needed).

**Placeholder scan:** None — every step shows the actual code or command. The Task 7/9 merge note explicitly tells the engineer to skip ahead and combine the work, with the combined commit shown in Task 9.

**Type consistency:** `getState` is the existing method name on `KeyboardDevice` (singular, not `getCurrentState`); plan uses `getState` everywhere. `ToolResult` and `textResult` come from `src/shared/tool-result.js`. `BaseKeyboardDevice` and the three model device classes are named correctly throughout.
