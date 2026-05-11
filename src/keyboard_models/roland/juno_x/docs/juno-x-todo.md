# Roland JUNO-X — Follow-up Tasks

> JUNO-X-specific backlog. Cross-model items live in `docs/plans/pending/todo-list.md`.
> Architecture reference: `juno_x.md` in this folder.

## Tasks

### 1. Full JUNO chorus mode sub-parameters

**Status:** Ready to plan.

The JUNO Chorus (type 09) has a Mode parameter with values I, II, I+II, JX I, JX II, III, I+III, II+III, I+II+III. The current implementation sends chorus_switch on/off but doesn't set the actual chorus sub-parameters via DT1 SysEx. Requires finding the exact SysEx addresses for the chorus type 09 mode parameter within the Scene Chorus block (offset `00 50 00`).

### 2. ZCore / JUNO-X Model / RD Piano UI panels

**Status:** Ready to plan.

The mock UI has placeholder panels for these three engines. Each needs:
- **ZCore:** Partial selector (1-4), per-partial sliders (OSC/Filter/Amp/LFO), synth common params. Most complex panel.
- **JUNO-X Model:** Similar to Analog Synth panel with extended controls.
- **RD Piano:** Minimal — sympathetic resonance controls only. Part 1 only.

### 3. Scene/tone bank browsing

**Status:** Ready to plan.

The JUNO-X organizes tones by bank (JUNO-106, JUNO-60, JUNO-X, PR-X, RD-PIANO, etc.). Implement tone bank select + program change for switching between factory tones, and scene bank select for switching between user scenes (1-256). Requires bank select MSB/LSB + program change sequences from the MIDI Implementation (page 1).

### 4. Analog Synth sub-model selection (JUNO-106 / JUNO-60)

**Status:** Ready to plan.

The Analog Synth engine emulates both the JUNO-106 and JUNO-60 as sub-models. Each has different waveform sets, octave ranges, and parameter behaviors (see Parameter Guide pages 19-20 for separate JUNO-106 and JUNO-60 tone parameter tables). The current implementation defines one generic Analog Synth param set. Add:
- Sub-model selector (JUNO-106 / JUNO-60) in the UI and as a settable parameter
- Engine-specific parameter variations (different CC mappings, value ranges, available waveforms)
- Mock handler awareness of which sub-model is active per part

### 5. Backup parsing

**Status:** Needs research.

Parse JUNO-X backup files to extract scene/tone inventory, similar to the Nord backup parser. Requires understanding the Roland backup file format (likely SysEx bulk dump or proprietary format). Lower priority until a real JUNO-X is available for testing.

### 6. Mock — RQ1 per-part address routing

**Status:** Needs design.

Plan #21 implemented RQ1→DT1 round-trip on the JUNO-X mock, but the handler only reads from `sceneGlobal` — the scene-level state map (chorus/delay/reverb/drive). Per-part data (engine params per part: ADSR, filter, oscillator, LFO, etc.) lives in `parts[partIdx].sceneParams`. An RQ1 to a per-part address (`01:1X:00:00` where X = part 0..4) currently returns zeros from the mock.

To extend RQ1 support to per-part addresses:

- **Recognize per-part address prefix.** Address byte 1 in `0x10..0x14` selects a part (mirroring how the existing DT1 path routes scene-part writes).
- **Route lookup to `parts[partIdx].sceneParams`** instead of `sceneGlobal`.
- **Engine-aware decoding (third complication).** Each part can run a different engine (Analog Synth / ZEN-Core / JUNO-X Model / RD Piano). The same byte at the same per-part offset means different things depending on the active engine. The mock's per-part state is keyed by SysEx address only — the engine context is implicit in which params have been set. For RQ1 reads, returning the raw byte is fine (decoding happens MCP-side, where the param map drives `formatValue`); but writes need to know the engine to pick the right param map. Document the read-only-no-engine-dispatch path explicitly.

Tests: extend `tests/unit/juno-x/mock-rq1.test.ts` with per-part address cases — DT1 write to part 0 + RQ1 read returns the same byte; cross-part isolation (write to part 0 doesn't show on part 1).

Out of scope: ZEN-Core multi-partial RQ1 (each ZCore part has 4 partials; the partial address space is its own ladder under the part). Tracked separately if needed.

Useful prior art: `src/keyboard_models/roland/juno_x/mock-handler.ts` `handleSysEx` (DT1 path already routes to `parts[partIdx].sceneParams` via address byte 1 check at lines 250–262), `src/keyboard_models/roland/juno_x/engines/engine-types.ts` (`SCENE_PART_OFFSETS`).

### 7. `get_current_state` — per-part scope

**Status:** Blocked on #6.

Today's `JunoXDevice.getState` (plan #23) only reads scene-effect sections. Engine params (ENV, FILTER, OSC, AMP, LFO, the partial sections, RD-piano sections) are per-part and require the per-part RQ1 path — blocked on #6.

Scope when #6 lands:

- Add `part` arg to `get_current_state` so the agent can target part 1..5.
- For per-part sections (ENV, FILTER, OSC, AMP, LFO, PERFORMANCE, PARTIAL-1..4, TONE-COMMON, RD-TONE, RD-SYMRESO), compute the per-part address as `SCENE_BASE + SCENE_PART_OFFSETS[partIdx] + param.sysexAddress` (the same formula `setParameters` already uses for per-part DT1 writes).
- Issue RQ1s in parallel via `requestRolandValue`, render grouped by section.
- Engine-awareness: the active engine on the target part determines which sections are meaningful. Either query the part's `tone_type` first to pick the read list, or read all engines' sections and label irrelevant ones as "engine-not-active." Decide during planning.

Out of scope: scene-modify (per-part offsets within scene-modify section), scene-common (always-active globals — could land alongside scene-effects in a small follow-up).

Useful prior art: `docs/plans/completed/23-juno-x-get-state-rq1.md` (scene-effects scope), `src/keyboard_models/roland/juno_x/device.ts` `setParameters` (per-part address calculation already in place), `src/keyboard_models/roland/juno_x/engines/engine-types.ts` (`SCENE_PART_OFFSETS`, `PART_NAMES`, `JunoXEngine`).

### 8. Chorus type — UI ↔ state propagation bug

**Status:** Needs investigation.

Observed during plan #24 local testing: clicking a chorus mode button on jino's UI causes chorus_switch to propagate correctly (verifiable via shadow mock junio's UI lighting up the chorus group), but chorus *type* (the algorithm selector — JUNO Chorus, etc., 0..9 at `01:50:00:01`) does NOT propagate properly.

This is distinct from the wiring fix shipped in plan #24:
- The `{type:"param"}` UI message → `MockHandler.onUIParam` → DT1 → state path is now correct generally.
- The bridge from primary → shadow is verified working for delay_switch, reverb_switch, drive_switch.
- chorus_switch propagates.
- chorus *type* (the algorithm) still misbehaves — symptom unclear without further repro.

Likely culprits to investigate:
- The chorus mode buttons on the UI emit `chorus_mode` (param name doesn't exist server-side — see #1) rather than `chorus_type`. So clicking a mode button never sends the actual chorus_type DT1, even when the user expected "select JUNO Chorus" semantics.
- The chorus *type* selector (a separate dropdown control, distinct from the mode buttons) may not have a syncSceneGlobalUI mirror — `syncSceneGlobalUI` in `web/app.js` only mirrors switch-toggle buttons today.
- Possible UI selector listening on a different state path (CC vs scene-global SysEx).

Scope when picked up:
- Reproduce: change Chorus Type via jino's selector dropdown → verify junio's selector updates.
- If selector mirrors are missing, extend `syncSceneGlobalUI` to read `01:50:00:01[0]` for chorus_type and update the selector.
- If chorus_mode buttons should route to chorus_type semantically (e.g. "JUNO Chorus" on click), wire that mapping. Otherwise wait for #1 (full chorus mode sub-parameter set) which will give chorus_mode a proper home.

Useful prior art: `src/keyboard_models/roland/juno_x/scene-params.ts` (chorus_type at offset `00:50:00:01`), `src/keyboard_models/roland/juno_x/web/app.js` (`syncSceneGlobalUI`, `initChorusButtons`), #1.

### 9. Drive button — click does nothing

**Status:** Needs investigation.

Observed during plan #24 local testing: clicking the "DRV" button on jino's UI doesn't toggle anything. Delay and Reverb buttons in the same FX cluster work correctly; only Drive is broken.

Likely culprits:
- Markup mismatch: HTML may have `data-fx="drv"` but `FX_PARAMS` map in `web/app.js:260` uses `drive: "drive_switch"`. If the data attribute is `drv` instead of `drive`, the lookup misses and no UI param is sent.
- Or `tog-btn` class missing on the drive button — `initFxButtons` selects `button.tog-btn[data-fx]`.

Quick fix is likely a one-character HTML change.
