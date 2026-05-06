---
mode: backlog
parent_topic: disabled-section-warnings
mvp_spec: ./completed/2026-05-05-disabled-section-warnings-mvp.md
---

# Disabled-Section Warnings — Deferred Backlog

Features identified during MVP brainstorm but not in the first slice. Each is a stub — when picked up, run standard `superpowers:brainstorming` (or `mvp-brainstorm` again if it is still big) on it as a fresh topic.

## Per-parameter exemptions inside `global`

The MVP treats the entire `global` section as always-active (no warning). The user mentioned that "transpose, mix etc." in `global` are exceptions, which implies some `global` parameters might still warrant a "section disabled"-style warning (e.g., parameters tied to features that aren't currently routed). Defer until we identify a concrete `global` parameter that needs to warn — at that point design the exemption list (allowlist vs blocklist).

## Amp section enable semantics

The MVP treats `amp` as always-active. If the amp section has its own `_enable` flag (e.g., a future amp-modeling toggle) or is gated by `spkr_comp_enable`, revisit the rule so amp parameters warn when amp output is disabled.

## Apply rule to Juno-X and Prophet-6

The MVP only modifies the Nord Electro 5D's `validation.ts`. Juno-X and Prophet-6 likely have analogous "set parameter in inactive section" cases (e.g., setting LFO target while LFO depth is 0, setting effect params with effects bypassed). Each model has its own enable conventions — port the rule per model rather than centralising prematurely. When we have two models implementing the rule, consider extracting a shared helper into `src/shared/`.

## Auto-enable instead of warn

Instead of (or in addition to) the warning, optionally enable the section automatically when a parameter inside it is set. Riskier — surprises the user — and not what the user asked for, so defer until we see whether the agent reliably notices and acts on the warnings.

## Target-part-aware engine check

The current rule says "engine is active iff at least one part has it selected AND that part is enabled". It does NOT check whether the engine is on the *part the parameter is targeting* (the `part` arg passed to `validateParameterBatch` / `set_parameters`). In split mode you can have Organ on Lower and Piano on Upper; setting a piano param with `part: "lower"` is currently silent, even though the audible result is determined by Lower's engine (Organ). Refining this requires modelling per-part engine state and per-part parameter routing (some Nord params are global, some per-part). Defer until we see real confusion from this in agent traces.

## Separate vibrato sub-rule

`vibrato_enable` lives inside section `organ` in the midi-map. The MVP folds vibrato parameters under the organ-engine rule (warns if no part is using Organ). A more precise rule would warn specifically when `vibrato_enable === 0` for parameters logically tied to vibrato (e.g., `vibrato_chorus_type`). Defer until we can list which organ parameters are vibrato-specific.

## Structured warnings field on `ToolResult`

Today warnings are concatenated into the response `text`. A dedicated `warnings: string[]` field would let downstream agents (or UIs) treat warnings differently from the result text — color them, count them, suppress them, etc. This touches every model and the base device, so defer until we have a consumer that needs the structure.
