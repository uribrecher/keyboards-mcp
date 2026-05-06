---
mode: backlog
parent_topic: disabled-section-warnings
mvp_spec: ./completed/2026-05-05-disabled-section-warnings-mvp.md
---

# Disabled-Section Warnings — Deferred Backlog

## Amp section enable semantics

The current rule treats `amp` as always-active. If the amp section gets its own `_enable` flag (e.g., a future amp-modeling toggle) or becomes gated by `spkr_comp_enable`, revisit the rule so amp parameters warn when amp output is disabled.

## Apply rule to Juno-X and Prophet-6

Only `src/keyboard_models/nord/electro_5d/validation.ts` exists. Juno-X and Prophet-6 likely have analogous "set parameter in inactive section" cases (e.g., setting LFO target while LFO depth is 0, setting effect params with effects bypassed). Each model has its own enable conventions — port the rule per model rather than centralising prematurely. When two models implement the rule, consider extracting a shared helper into `src/shared/`.

## Separate vibrato sub-rule

`vibrato_enable` lives inside section `organ` in the midi-map. The MVP folds vibrato parameters under the organ-engine rule (warns if no part is using Organ). A more precise rule would warn specifically when `vibrato_enable === 0` for parameters logically tied to vibrato (e.g., `vibrato_chorus_type`). Defer until we can list which organ parameters are vibrato-specific.

## Structured warnings field on `ToolResult`

Today warnings are concatenated into the response `text`. A dedicated `warnings: string[]` field would let downstream agents (or UIs) treat warnings differently from the result text — color them, count them, suppress them, etc. This touches every model and the base device, so defer until we have a consumer that needs the structure.
