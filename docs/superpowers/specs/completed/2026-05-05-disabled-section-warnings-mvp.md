---
mode: mvp
parent_topic: disabled-section-warnings
backlog: ./2026-05-05-disabled-section-warnings-backlog.md
---

# Disabled-Section Warnings (Nord Electro 5D) — MVP Slice

> **Scope discipline:** This spec is intentionally a thin slice. Deferred features live in the backlog file linked above. `writing-plans` should plan ONLY what is in this spec — do not pull from the backlog.

## What this slice is

When the agent sets a Nord Electro 5D parameter that lives in a section the hardware currently has disabled, append a warning to the `set_parameters` MCP response so the agent knows the change has no audible effect until that section is enabled. The warning is advisory — the parameter is still set.

## Why this cut

The model already has a `validateParameterBatch` function in `src/keyboard_models/nord/electro_5d/validation.ts` whose output is concatenated into the `set_parameters` MCP response by `BaseKeyboardDevice.setParameters` (`src/shared/base-keyboard-device.ts:176-184`). Adding one more pass to that function gives the agent visibility for free, with no new infrastructure, no new tool, and no MCP wire changes.

## In scope

- New rule inside `validateParameterBatch` that, for each parameter in the batch, checks whether the parameter's `section` is currently "disabled" and emits one warning per disabled section touched (deduped — no per-parameter spam).
- "Disabled" is defined per section:
  - `effect1` → `effect1_enable === 0` (or `undefined`)
  - `effect2` → `effect2_enable === 0`
  - `reverb` → `reverb_enable === 0`
  - `delay` → `delay_enable === 0`
  - `eq` → `eq_enable === 0`
  - `rotary` → `spkr_comp_enable === 0`
  - `organ` → no part has `part_*_engine_select == Organ` AND that part's `part_*_enable != 0` (treating undefined enable as on, matching hardware default)
  - `piano` → same shape, with Piano
  - `sample_synth` → same shape, with Sample Synth
- Engine-section "no part has this engine" check uses the **post-batch** state — i.e., if the batch itself selects an engine, the warning is suppressed for that engine's parameters in the same call. (Same pattern as the existing same-engine check in `validateParameterBatch`.)
- The parameter being set is exempt from triggering its own warning when it IS the section's enable flag or engine select (`effect1_enable`, `reverb_enable`, `part_lower_engine_select`, etc.). Setting the enable flag itself never warns about its section being disabled.
- Sections **always considered active** (no warning ever): `global`, `parts`, `amp`. The `vibrato_enable` parameter in section `organ` is treated as part of the organ section — the engine-active rule applies (no separate vibrato section).
- Warning wording (one per affected section per call):
  > `WARNING: <Section display name> is currently disabled. The parameter(s) you set will have no audible effect until <enable hint>.`
  Section display names: `Effect 1`, `Effect 2`, `Reverb`, `Delay`, `EQ`, `Rotary/Speaker`, `Organ engine`, `Piano engine`, `Sample Synth engine`. Enable hint: `set <enable_key> = on` for effect-style sections; `select <Engine name> on a part` for engine sections.

## Out of scope (see backlog)

- Per-parameter exemption list within `global` (whole section is exempt).
- "Amp" section enable semantics (treated as always-on for now).
- Same rule for Juno-X and Prophet-6 models.
- Auto-enabling a section when a user sets a parameter inside it.
- Split-mode-aware engine check that warns when the engine is on the *other* part than the one being targeted.
- A separate "vibrato disabled" warning distinct from the organ-engine check.
- A structured `warnings: string[]` field in `ToolResult` (currently warnings are inlined into `text`).

## Architecture

Single touch point: `src/keyboard_models/nord/electro_5d/validation.ts`, function `validateParameterBatch`.

Add a new pass at the end of the function (after the existing checks) that:

1. Builds a post-batch view of the relevant enable / engine-select keys: start from `state.get(key)`, then overlay any `parameterMap.resolveValue(param, value)` from the batch for those same keys.
2. Determines the disabled set of sections from that view.
3. Walks the batch a second time. For each parameter:
   - Skip if the parameter IS one of the section-control keys (the `_enable` flags, `part_*_engine_select`).
   - Skip if `param.section` is in the always-active set (`global`, `parts`, `amp`).
   - If `param.section` is in the disabled set, record that section.
4. Emits one warning per recorded section, in a stable order (organ, piano, sample_synth, effect1, effect2, reverb, delay, eq, rotary).

No changes to: tool wiring, MCP server, `ToolResult` shape, base device, or any other model.

## Data flow

```
set_parameters (MCP tool)
  → NordElectro5DDevice.setParameters (inherited from BaseKeyboardDevice)
    → for each param: state.set(...)
    → validateAfterSet(...)
      → validateParameterBatch(...)
        → existing rules + NEW disabled-section rule
        → returns string[] warnings
    → BaseKeyboardDevice concatenates warnings into response text
  → MCP response → agent sees the warning
```

## Error handling

No new error paths. The rule reads from `state` and the batch only; both are already trusted inputs to `validateParameterBatch`. If a section name is not recognized (future-proofing), the rule silently treats it as always-active.

## Testing

Add a new file `tests/unit/nord-electro-5d/disabled-section-warnings.test.ts` (or extend an existing nord-electro-5d unit test if one fits) covering:

- Setting `reverb_amount` while `reverb_enable === 0` → warning mentioning Reverb.
- Setting `reverb_amount` while `reverb_enable === 1` → no warning.
- Setting `reverb_enable = 0` itself → no self-warning.
- Setting `effect1_rate` AND `effect1_enable = 1` in the same batch → no warning (post-batch state shows enabled).
- Setting `piano_model` while neither part has the Piano engine selected → warning mentioning Piano engine.
- Setting `piano_model` AND `part_upper_engine_select = Piano` in the same batch → no warning.
- Setting two reverb params at once while reverb is disabled → exactly one Reverb warning (deduped).
- Setting a `global` parameter (e.g., `master_level`) while every effect section is disabled → no warning.
- Setting an `amp` parameter while everything else is disabled → no warning.

Run `npm run test:unit` and `npm run lint` after the change. The existing E2E `set-parameters.test.ts` should continue to pass — no behavior change for the happy path beyond the added warning text.
