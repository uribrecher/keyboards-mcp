---
mode: backlog
parent_topic: disabled-section-warnings
mvp_spec: ./2026-05-05-disabled-section-warnings-mvp.md
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

## Split-mode aware engine check

In split mode, Organ Preset 1 routes to Lower and Preset 2 to Upper. The MVP's engine-section rule only checks "is this engine selected on *any* part"; it doesn't check whether the engine is on the *targeted* part. Refining this requires modelling per-part engine state in the rule, which is more nuance than the MVP needs.

## Separate vibrato sub-rule

`vibrato_enable` lives inside section `organ` in the midi-map. The MVP folds vibrato parameters under the organ-engine rule (warns if no part is using Organ). A more precise rule would warn specifically when `vibrato_enable === 0` for parameters logically tied to vibrato (e.g., `vibrato_chorus_type`). Defer until we can list which organ parameters are vibrato-specific.

## Structured warnings field on `ToolResult`

Today warnings are concatenated into the response `text`. A dedicated `warnings: string[]` field would let downstream agents (or UIs) treat warnings differently from the result text — color them, count them, suppress them, etc. This touches every model and the base device, so defer until we have a consumer that needs the structure.
