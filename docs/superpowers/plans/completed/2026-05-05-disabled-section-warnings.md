# Disabled-Section Warnings (Nord Electro 5D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent calls `set_parameters` on a Nord Electro 5D parameter that lives in a section currently disabled on the hardware, append a warning to the MCP response so the agent knows the change has no audible effect until the section is enabled.

**Architecture:** Single-file change inside `src/keyboard_models/nord/electro_5d/validation.ts`. Add a new pass at the end of `validateParameterBatch` that builds a post-batch view of the relevant enable / engine-select keys, computes the disabled-section set, and emits one warning per disabled section touched by the batch. No changes to MCP wiring, `ToolResult`, or the base device — warnings already flow through `BaseKeyboardDevice.setParameters` (`src/shared/base-keyboard-device.ts:176-184`).

**Tech Stack:** TypeScript 5.5+, `node:test` + `node:assert`, `tsx` runner. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-05-disabled-section-warnings-mvp.md`. Backlog: `docs/superpowers/specs/2026-05-05-disabled-section-warnings-backlog.md` — do NOT pull tasks from the backlog.

---

## File Structure

- **Modify:** `src/keyboard_models/nord/electro_5d/validation.ts` — add the new disabled-section rule at the end of `validateParameterBatch`. The function already takes everything we need (`parameters`, `state`, `targetPart`, `parameterMap`).
- **Create:** `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` — new unit-test file dedicated to the new rule. Kept separate from `mock-handler.test.ts` and `parameter-map.test.ts` because it exercises validation, not mock or map.

No other files are touched.

---

## Background reference for the implementer

`validateParameterBatch` signature and helpers (already in the file you're editing):

```ts
import type { StateManager, ParameterMap } from "../../../shared/keyboard-model.js";
import { midiToDiscrete } from "../../../shared/parameter-resolution.js";

export function validateParameterBatch(
  parameters: Array<{ key: string; value: number | string }>,
  state: StateManager,
  targetPart: string,
  parameterMap: ParameterMap,
): string[]
```

- `parameterMap.params[key]` → `KeyboardParameter | undefined`. Each param has a `section: string` field.
- `parameterMap.resolveValue(param, value)` → resolves a user value (label, drawbar position, model index, raw MIDI int) to MIDI 0-127.
- `state.get(key)` → returns the global MIDI value or `undefined`. (For `part_*_engine_select`, the key itself encodes which part it applies to, so no `part` arg needed.)
- Engine-select labels come from the param itself: `part_lower_engine_select.labels = { 0: "Organ", 1: "Piano", 2: "Sample Synth" }`.

Section-name reference (from `midi-map.ts`):

| Section key | Display name | "Disabled" condition (MVP) | Self-control keys (don't self-warn) |
|---|---|---|---|
| `organ` | `Organ engine` | no part has engine = Organ | `part_lower_engine_select`, `part_upper_engine_select` |
| `piano` | `Piano engine` | no part has engine = Piano | same as above |
| `sample_synth` | `Sample Synth engine` | no part has engine = Sample Synth | same as above |
| `effect1` | `Effect 1` | `effect1_enable === 0` or `undefined` | `effect1_enable` |
| `effect2` | `Effect 2` | `effect2_enable === 0` or `undefined` | `effect2_enable` |
| `reverb` | `Reverb` | `reverb_enable === 0` or `undefined` | `reverb_enable` |
| `delay` | `Delay` | `delay_enable === 0` or `undefined` | `delay_enable` |
| `eq` | `EQ` | `eq_enable === 0` or `undefined` | `eq_enable` |
| `rotary` | `Rotary/Speaker` | `spkr_comp_enable === 0` or `undefined` | `spkr_comp_enable` |
| `global` | — | always active (skip) | — |
| `parts` | — | always active (skip) | — |
| `amp` | — | always active (skip) | — |

Stable warning order (when multiple sections fire in one batch): `organ`, `piano`, `sample_synth`, `effect1`, `effect2`, `reverb`, `delay`, `eq`, `rotary`.

---

## Task 1: Test the simplest disabled effect-section case

**Files:**
- Test: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (new)

- [ ] **Step 1: Create the test file with a single failing test**

Path: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts`

```ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { createParameterMap } from "../../../src/keyboard_models/nord/electro_5d/midi-map.js";
import { NordElectro5DState } from "../../../src/keyboard_models/nord/electro_5d/state-manager.js";
import { validateParameterBatch } from "../../../src/keyboard_models/nord/electro_5d/validation.js";

const parameterMap = createParameterMap();

function freshState(): NordElectro5DState {
  return new NordElectro5DState(parameterMap);
}

describe("Nord Electro 5D disabled-section warnings", () => {
  it("warns when setting a reverb parameter while reverb is disabled", () => {
    const state = freshState();
    state.set("reverb_enable", 0);

    const warnings = validateParameterBatch(
      [{ key: "reverb_amount", value: 64 }],
      state,
      "upper",
      parameterMap,
    );

    const reverbWarning = warnings.find((w) => w.includes("Reverb"));
    assert.ok(reverbWarning, `expected a Reverb warning, got: ${JSON.stringify(warnings)}`);
    assert.match(reverbWarning, /disabled/i);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: FAIL — the rule isn't implemented yet, so `warnings` will not contain a Reverb warning.

If the test errors out on imports rather than asserting, fix the import paths first.

- [ ] **Step 3: Implement the rule in `validation.ts`**

Open `src/keyboard_models/nord/electro_5d/validation.ts`. At the **end** of `validateParameterBatch`, immediately before `return warnings;`, insert the block below.

```ts
  // ── Disabled-section rule ──
  // Warn when a parameter is set in a section that is currently disabled.
  // Uses post-batch state (so flipping the enable flag in the same batch suppresses the warning).
  {
    const ALWAYS_ACTIVE = new Set(["global", "parts", "amp"]);

    // Map: section key → ordered display name.
    const SECTION_DISPLAY: Record<string, string> = {
      organ: "Organ engine",
      piano: "Piano engine",
      sample_synth: "Sample Synth engine",
      effect1: "Effect 1",
      effect2: "Effect 2",
      reverb: "Reverb",
      delay: "Delay",
      eq: "EQ",
      rotary: "Rotary/Speaker",
    };
    const SECTION_ORDER = [
      "organ", "piano", "sample_synth",
      "effect1", "effect2", "reverb", "delay", "eq", "rotary",
    ];

    // Effect-style sections gated by an `_enable` key.
    const ENABLE_KEY: Record<string, string> = {
      effect1: "effect1_enable",
      effect2: "effect2_enable",
      reverb: "reverb_enable",
      delay: "delay_enable",
      eq: "eq_enable",
      rotary: "spkr_comp_enable",
    };
    const SELF_CONTROL_KEYS = new Set([
      ...Object.values(ENABLE_KEY),
      "part_lower_engine_select",
      "part_upper_engine_select",
    ]);

    // Post-batch view: start from current state, then overlay the batch.
    const postBatch: Record<string, number | undefined> = {};
    for (const k of [...Object.values(ENABLE_KEY), "part_lower_engine_select", "part_upper_engine_select"]) {
      postBatch[k] = state.get(k);
    }
    for (const { key, value } of parameters) {
      if (key in postBatch) {
        const param = parameterMap.params[key];
        if (param) postBatch[key] = parameterMap.resolveValue(param, value);
      }
    }

    // Resolve engine label → MIDI value via the engine-select param itself.
    const engineParam = parameterMap.params["part_upper_engine_select"];
    const engineMidi: Record<string, number | undefined> = {
      organ: engineParam ? parameterMap.resolveValue(engineParam, "Organ") : undefined,
      piano: engineParam ? parameterMap.resolveValue(engineParam, "Piano") : undefined,
      sample_synth: engineParam ? parameterMap.resolveValue(engineParam, "Sample Synth") : undefined,
    };

    // Build the disabled set.
    const disabled = new Set<string>();
    for (const [section, enableKey] of Object.entries(ENABLE_KEY)) {
      const v = postBatch[enableKey];
      if (v === undefined || v === 0) disabled.add(section);
    }
    const lower = postBatch["part_lower_engine_select"];
    const upper = postBatch["part_upper_engine_select"];
    for (const eng of ["organ", "piano", "sample_synth"] as const) {
      const target = engineMidi[eng];
      if (target === undefined) continue;
      const onLower = lower !== undefined && lower === target;
      const onUpper = upper !== undefined && upper === target;
      if (!onLower && !onUpper) disabled.add(eng);
    }

    // Walk the batch, record disabled sections that are touched.
    const touched = new Set<string>();
    for (const { key } of parameters) {
      if (SELF_CONTROL_KEYS.has(key)) continue;
      const param = parameterMap.params[key];
      if (!param) continue;
      const section = param.section;
      if (ALWAYS_ACTIVE.has(section)) continue;
      if (disabled.has(section)) touched.add(section);
    }

    for (const section of SECTION_ORDER) {
      if (!touched.has(section)) continue;
      const display = SECTION_DISPLAY[section];
      let hint: string;
      if (section === "organ" || section === "piano" || section === "sample_synth") {
        const engineName = section === "sample_synth" ? "Sample Synth"
          : section === "piano" ? "Piano" : "Organ";
        hint = `select ${engineName} on a part`;
      } else {
        hint = `set ${ENABLE_KEY[section]} = on`;
      }
      warnings.push(
        `WARNING: ${display} is currently disabled. The parameter(s) you set will have no audible effect until ${hint}.`,
      );
    }
  }
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/keyboard_models/nord/electro_5d/validation.ts tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git commit -m "feat(nord-electro-5d): warn when setting a parameter in a disabled section"
```

---

## Task 2: No warning when the section is enabled

**Files:**
- Test: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (modify)

- [ ] **Step 1: Add the test**

Append inside the `describe` block in `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts`:

```ts
  it("does NOT warn when reverb is enabled", () => {
    const state = freshState();
    state.set("reverb_enable", 1);

    const warnings = validateParameterBatch(
      [{ key: "reverb_amount", value: 64 }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Reverb is currently disabled")),
      `expected no Reverb-disabled warning, got: ${JSON.stringify(warnings)}`,
    );
  });
```

- [ ] **Step 2: Run the test and verify it passes**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: PASS (no implementation change needed — the rule should already do the right thing; this test pins the behaviour).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git commit -m "test(nord-electro-5d): pin no-warning case when reverb is enabled"
```

---

## Task 3: Setting the enable flag itself never self-warns

**Files:**
- Test: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (modify)

- [ ] **Step 1: Add the test**

Append inside the `describe` block:

```ts
  it("does NOT warn when the parameter being set IS the section's enable flag", () => {
    const state = freshState();
    state.set("reverb_enable", 0); // section currently disabled

    const warnings = validateParameterBatch(
      [{ key: "reverb_enable", value: 0 }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Reverb is currently disabled")),
      `expected no self-warning when toggling reverb_enable, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("does NOT warn when the parameter being set IS an engine select", () => {
    const state = freshState();
    // No engine set yet → all engines disabled per the rule.

    const warnings = validateParameterBatch(
      [{ key: "part_upper_engine_select", value: "Piano" }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => /engine is currently disabled/i.test(w)),
      `expected no self-warning when picking an engine, got: ${JSON.stringify(warnings)}`,
    );
  });
```

- [ ] **Step 2: Run the tests**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: PASS. The implementation already guards via `SELF_CONTROL_KEYS`.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git commit -m "test(nord-electro-5d): pin no-self-warning for enable flags and engine selects"
```

---

## Task 4: Same-batch enable suppresses the warning

**Files:**
- Test: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (modify)

- [ ] **Step 1: Add the test**

Append inside the `describe` block:

```ts
  it("does NOT warn when the same batch enables the section", () => {
    const state = freshState();
    state.set("effect1_enable", 0); // currently disabled

    const warnings = validateParameterBatch(
      [
        { key: "effect1_rate", value: 70 },
        { key: "effect1_enable", value: 1 },
      ],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Effect 1 is currently disabled")),
      `expected no Effect 1 warning when batch enables it, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("does NOT warn when the same batch selects the engine", () => {
    const state = freshState();
    // No engine selected on either part initially.

    const warnings = validateParameterBatch(
      [
        { key: "piano_model", value: 0 },
        { key: "part_upper_engine_select", value: "Piano" },
      ],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Piano engine is currently disabled")),
      `expected no Piano-engine warning when batch selects it, got: ${JSON.stringify(warnings)}`,
    );
  });
```

- [ ] **Step 2: Run the tests**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: PASS. The post-batch overlay logic in the implementation should already cover this.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git commit -m "test(nord-electro-5d): pin same-batch-enable suppression"
```

---

## Task 5: Engine-section warning fires when no part is on that engine

**Files:**
- Test: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (modify)

- [ ] **Step 1: Add the test**

Append inside the `describe` block:

```ts
  it("warns when setting a piano param while no part is on the Piano engine", () => {
    const state = freshState();
    state.set("part_lower_engine_select", 0); // Organ
    state.set("part_upper_engine_select", 0); // Organ

    const warnings = validateParameterBatch(
      [{ key: "piano_model", value: 0 }],
      state,
      "upper",
      parameterMap,
    );

    const pianoWarning = warnings.find((w) => w.includes("Piano engine is currently disabled"));
    assert.ok(pianoWarning, `expected a Piano-engine warning, got: ${JSON.stringify(warnings)}`);
  });

  it("does NOT warn when at least one part is on the Piano engine", () => {
    const state = freshState();
    state.set("part_lower_engine_select", 0); // Organ
    state.set("part_upper_engine_select", 1); // Piano

    const warnings = validateParameterBatch(
      [{ key: "piano_model", value: 0 }],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => w.includes("Piano engine is currently disabled")),
      `expected no Piano-engine warning, got: ${JSON.stringify(warnings)}`,
    );
  });
```

- [ ] **Step 2: Run the tests**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git commit -m "test(nord-electro-5d): pin engine-section warning when no part has the engine"
```

---

## Task 6: Dedup — multiple params in the same disabled section produce one warning

**Files:**
- Test: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (modify)

- [ ] **Step 1: Add the test**

Append inside the `describe` block:

```ts
  it("emits exactly one warning per disabled section, regardless of param count", () => {
    const state = freshState();
    state.set("reverb_enable", 0);

    const warnings = validateParameterBatch(
      [
        { key: "reverb_amount", value: 64 },
        { key: "reverb_type", value: 1 },
      ],
      state,
      "upper",
      parameterMap,
    );

    const reverbWarnings = warnings.filter((w) => w.includes("Reverb is currently disabled"));
    assert.equal(reverbWarnings.length, 1, `expected exactly 1 Reverb warning, got: ${JSON.stringify(warnings)}`);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: PASS — the implementation uses a `Set<string>` (`touched`) to dedupe.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git commit -m "test(nord-electro-5d): pin one-warning-per-section dedup"
```

---

## Task 7: Always-active sections never warn

**Files:**
- Test: `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (modify)

- [ ] **Step 1: Add the test**

Append inside the `describe` block:

```ts
  it("does NOT warn for global, parts, or amp parameters even when every gated section is disabled", () => {
    const state = freshState();
    // Disable everything that has an enable flag.
    state.set("effect1_enable", 0);
    state.set("effect2_enable", 0);
    state.set("reverb_enable", 0);
    state.set("delay_enable", 0);
    state.set("eq_enable", 0);
    state.set("spkr_comp_enable", 0);
    // Engines: leave both parts on Organ.
    state.set("part_lower_engine_select", 0);
    state.set("part_upper_engine_select", 0);

    const warnings = validateParameterBatch(
      [
        { key: "gain_level", value: 100 },          // section: global
        { key: "part_mix", value: 64 },              // section: parts
      ],
      state,
      "upper",
      parameterMap,
    );

    assert.ok(
      !warnings.some((w) => /is currently disabled/.test(w)),
      `expected no disabled-section warnings, got: ${JSON.stringify(warnings)}`,
    );
  });
```

- [ ] **Step 2: Run the tests**

Run: `npm run test:unit -- --test-name-pattern "disabled-section warnings"`

Expected: PASS — both `global` and `parts` are in `ALWAYS_ACTIVE`.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/nord-electro-5d/disabled-section-warnings.test.ts
git commit -m "test(nord-electro-5d): pin global/parts/amp always-active exemption"
```

---

## Task 8: Final sweep — full test suite + lint + build

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite to confirm no regressions in existing nord tests**

Run: `npm run test:unit`

Expected: PASS — including `mock-handler.test.ts`, `parameter-map.test.ts`, all other models, and the new `disabled-section-warnings.test.ts`.

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: PASS, no errors.

If you see `no-unused-vars` warnings on local consts inside the new block, prefix with `_` or remove. If you see `no-floating-promises`, you've accidentally introduced an unawaited promise — undo that, the new code is synchronous.

- [ ] **Step 3: Type-check tests**

Run: `npm run test:check`

Expected: PASS.

- [ ] **Step 4: Build**

Run: `npm run build`

Expected: clean `tsc` exit (no errors).

- [ ] **Step 5: Run E2E `set-parameters` test for the smoke check**

Run: `npm run test:e2e -- --test-name-pattern "set parameters"`

Expected: PASS — confirms the new validation block didn't break the live MCP set-parameters flow. (E2E spawns the headless mock and the MCP server; treats warnings as part of the response text, so this verifies the warnings actually surface through MCP.)

- [ ] **Step 6: Final commit (only if anything was touched in this task — usually nothing)**

If steps 1-5 forced you to amend the implementation (e.g., a lint fix), commit the fix:

```bash
git add -p
git commit -m "fix(nord-electro-5d): <describe the small fix>"
```

Otherwise skip — no empty commits.

---

## Self-review notes (for the implementer, not steps)

- Spec coverage check: every "In scope" bullet in the MVP spec maps to a task above (effect-style enable check → Task 1 + 2; engine-select check → Task 5; same-batch suppression → Task 4; self-control exemption → Task 3; always-active → Task 7; dedup → Task 6; warning wording → Task 1's implementation step). ✓
- The MCP-visibility requirement is covered by Task 8 step 5 (E2E test).
- Backlog items deliberately not implemented: per-parameter `global` exemptions, `amp` enable semantics, Juno-X / Prophet-6 port, auto-enable, split-mode-aware engine check, separate vibrato sub-rule, structured `warnings` field on `ToolResult`.
