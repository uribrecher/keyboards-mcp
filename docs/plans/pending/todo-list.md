# Follow-up Tasks

> Backlog of follow-up items. Each entry becomes its own numbered plan when promoted out of this list.

## Tasks

### 11. Full JUNO chorus mode sub-parameters

**Status:** Ready to plan.

The JUNO Chorus (type 09) has a Mode parameter with values I, II, I+II, JX I, JX II, III, I+III, II+III, I+II+III. The current implementation sends chorus_switch on/off but doesn't set the actual chorus sub-parameters via DT1 SysEx. Requires finding the exact SysEx addresses for the chorus type 09 mode parameter within the Scene Chorus block (offset `00 50 00`).

### 12. ZCore / JUNO-X Model / RD Piano UI panels

**Status:** Ready to plan.

The mock UI has placeholder panels for these three engines. Each needs:
- **ZCore:** Partial selector (1-4), per-partial sliders (OSC/Filter/Amp/LFO), synth common params. Most complex panel.
- **JUNO-X Model:** Similar to Analog Synth panel with extended controls.
- **RD Piano:** Minimal — sympathetic resonance controls only. Part 1 only.

### 13. JUNO-X scene/tone bank browsing

**Status:** Ready to plan.

The JUNO-X organizes tones by bank (JUNO-106, JUNO-60, JUNO-X, PR-X, RD-PIANO, etc.). Implement tone bank select + program change for switching between factory tones, and scene bank select for switching between user scenes (1-256). Requires bank select MSB/LSB + program change sequences from the MIDI Implementation (page 1).

### 14. Analog Synth sub-model selection (JUNO-106 / JUNO-60)

**Status:** Ready to plan.

The Analog Synth engine emulates both the JUNO-106 and JUNO-60 as sub-models. Each has different waveform sets, octave ranges, and parameter behaviors (see Parameter Guide pages 19-20 for separate JUNO-106 and JUNO-60 tone parameter tables). The current implementation defines one generic Analog Synth param set. Add:
- Sub-model selector (JUNO-106 / JUNO-60) in the UI and as a settable parameter
- Engine-specific parameter variations (different CC mappings, value ranges, available waveforms)
- Mock handler awareness of which sub-model is active per part

### 15. JUNO-X backup parsing

**Status:** Needs research.

Parse JUNO-X backup files to extract scene/tone inventory, similar to the Nord backup parser. Requires understanding the Roland backup file format (likely SysEx bulk dump or proprietary format). Lower priority until a real JUNO-X is available for testing.

### 16. PPG Wave keyboard model

**Status:** Needs brainstorming — model design required before planning.

Implement a new keyboard model emulating the famous PPG Wave synthesizer. The PPG Wave is a classic wavetable synth known for its evolving, digital textures and metallic timbres. Requires designing the parameter map (wavetable selection, wave position, analog filter, envelopes, LFO), mock handler with wavetable engine behavior, and web UI. Should follow the same model architecture pattern as the JUNO-X (KeyboardModel + KeyboardDevice + MockHandler + web UI).

### 17. Yamaha DX7 keyboard model

**Status:** Needs brainstorming — model design required before planning.

Implement a new keyboard model emulating the Yamaha DX7, the iconic FM (frequency modulation) synthesizer. The DX7 defined the sound of the 1980s with its electric pianos, bells, bass, and brass patches. Requires designing the FM synthesis parameter map (6 operators, algorithms 1-32, operator levels/ratios/envelopes, feedback, LFO), mock handler with FM engine behavior, and web UI. The operator/algorithm architecture is fundamentally different from subtractive synthesis, so the parameter system and UI will need a distinct approach. Should follow the same model architecture pattern as the JUNO-X.

### 19. Re-home the chat backup/reset and event-log clear actions

**Status:** Needs brainstorming — small UX question, not blocking #18.

The Event Log design (`docs/superpowers/specs/2026-05-08-mock-runner-event-log-design.md`) converts what was the chat console header into a two-tab strip whose only job is identity (CHAT tab carries lamp + SID + agent meter) and selection (LOG tab + unread LED). The three action buttons that used to live in that header — `backup`, `reset`, and the would-be `clear` for the event log — have no home.

Until this ships, those actions are reachable only via keyboard accelerator (`backup` already has ⌘E; `reset` already has its accelerator; `clear` needs one added during #18 implementation).

Design questions:

- Where do the buttons go? Candidates: a thin toolbar above the composer (CHAT) and above the event-log pane (LOG); a single composer-row utility button cluster; a command palette / overflow menu shared between panes; per-pane footers below the scrollback.
- Should the buttons be pane-scoped (live with their respective pane body) or always-visible (then how do they not creep back into the tab strip)?
- Discoverability: keyboard accelerators are fine for power users but the existing `backup` button is the only signal for new operators that the action exists. Whatever replaces it has to be at least as discoverable.
- Visual: the existing `.console__btn` is a compact graphite button — preserve that idiom or rethink in light of the new tabbed layout.

### 25. WS-mode SysEx receive — second WebSocket lane for outgoing MIDI

**Status:** Needs design.

#21 added a virtual MIDI Out port on every model mock; #22 wired the MCP-side real-MIDI receive path. CI/Docker mode (where `MOCK_WS_URL` is set and real MIDI is unavailable) currently has no symmetric receive path — `WsMidiConnection.onSysEx` is still a no-op.

To close that gap, mirror the real-MIDI approach over WebSockets. The user's directive from the #22 brainstorm (paraphrased): *similar to the output direction's env var, we can have an env var that picks real MIDI vs WS for receive.*

Scope:
- **MockEngine: second WS server.** Per the "port for port" decision recorded in earlier #21 brainstorm — each MIDI direction maps to its own WS port. Existing WS keeps its mixed role (UI state + UI commands + MCP status); new WS is dedicated to outgoing-from-mock MIDI events. On every `MockHandlerResult.sysexOut`, broadcast `{type:"sysex", bytes}` only on the new server.
- **mock-registry**: add `wsOutPort` field alongside the existing `wsPort`.
- **MCB manifest**: surface `primary.wsOutPort` from the mock-registry entry.
- **`WsMidiConnection`**: take a second URL; listen there for `{type:"sysex"}`; fire `onSysEx`.
- **`connect.ts`**: plumb `manifest.primary.wsOutPort` into the WS-mode `WsMidiConnection.connect` call. Add `MOCK_WS_OUT_URL` env var for direct-WS-mode usage in tests.
- **CI integration test** for RQ1 round-trip in WS mode.

Out of scope (separate todo if needed): the receive path on real hardware over a *bridge* (e.g. someone wants to listen for DT1 via a bridge tee instead of direct connection). Today's bridges are one-way (master out → shadow in); making them bidirectional or adding a separate input bridge is its own design work.

Useful prior art: `src/midi/ws-midi-connection.ts` (existing send-only WS impl), `src/mock-runner/engine.ts` (existing WS server + virtual MIDI Out fan-out from #21), `tests/helpers/test-harness.ts` (CI/Docker WS-mode infrastructure).

### 26. JUNO-X mock — RQ1 per-part address routing

**Status:** Needs design.

#21 implemented RQ1→DT1 round-trip on the JUNO-X mock, but the handler only reads from `sceneGlobal` — the scene-level state map (chorus/delay/reverb/drive). Per-part data (engine params per part: ADSR, filter, oscillator, LFO, etc.) lives in `parts[partIdx].sceneParams`. An RQ1 to a per-part address (`01:1X:00:00` where X = part 0..4) currently returns zeros from the mock.

To extend RQ1 support to per-part addresses:

- **Recognize per-part address prefix.** Address byte 1 in `0x10..0x14` selects a part (mirroring how the existing DT1 path routes scene-part writes).
- **Route lookup to `parts[partIdx].sceneParams`** instead of `sceneGlobal`.
- **Engine-aware decoding (third complication).** Each part can run a different engine (Analog Synth / ZEN-Core / JUNO-X Model / RD Piano). The same byte at the same per-part offset means different things depending on the active engine. The mock's per-part state is keyed by SysEx address only — the engine context is implicit in which params have been set. For RQ1 reads, returning the raw byte is fine (decoding happens MCP-side, where the param map drives `formatValue`); but writes need to know the engine to pick the right param map. Document the read-only-no-engine-dispatch path explicitly.

Tests: extend `tests/unit/juno-x/mock-rq1.test.ts` with per-part address cases — DT1 write to part 0 + RQ1 read returns the same byte; cross-part isolation (write to part 0 doesn't show on part 1).

Out of scope: ZEN-Core multi-partial RQ1 (each ZCore part has 4 partials; the partial address space is its own ladder under the part). Tracked separately if needed.

Useful prior art: `src/keyboard_models/roland/juno_x/mock-handler.ts` `handleSysEx` (DT1 path already routes to `parts[partIdx].sceneParams` via address byte 1 check at lines 250–262), `src/keyboard_models/roland/juno_x/engines/engine-types.ts` (`SCENE_PART_OFFSETS`).

### 27. JUNO-X `get_current_state` — per-part scope

**Status:** Blocked on #26.

Today's `JunoXDevice.getState` (#23) only reads scene-effect sections. Engine params (ENV, FILTER, OSC, AMP, LFO, the partial sections, RD-piano sections) are per-part and require the per-part RQ1 path — blocked on #26.

Scope when #26 lands:

- Add `part` arg to `get_current_state` so the agent can target part 1..5.
- For per-part sections (ENV, FILTER, OSC, AMP, LFO, PERFORMANCE, PARTIAL-1..4, TONE-COMMON, RD-TONE, RD-SYMRESO), compute the per-part address as `SCENE_BASE + SCENE_PART_OFFSETS[partIdx] + param.sysexAddress` (the same formula `setParameters` already uses for per-part DT1 writes).
- Issue RQ1s in parallel via `requestRolandValue`, render grouped by section.
- Engine-awareness: the active engine on the target part determines which sections are meaningful. Either query the part's `tone_type` first to pick the read list, or read all engines' sections and label irrelevant ones as "engine-not-active." Decide during planning.

Out of scope: scene-modify (per-part offsets within scene-modify section), scene-common (always-active globals — could land alongside scene-effects in a small follow-up).

Useful prior art: `docs/plans/completed/23-juno-x-get-state-rq1.md` (scene-effects scope), `src/keyboard_models/roland/juno_x/device.ts` `setParameters` (per-part address calculation already in place), `src/keyboard_models/roland/juno_x/engines/engine-types.ts` (`SCENE_PART_OFFSETS`, `PART_NAMES`, `JunoXEngine`).

### 30. MidiCodec architecture refactor

**Status:** Planned — see `docs/plans/pending/30-midi-codec-architecture.md`.

Major architectural cleanup of the mock + MCP. Introduces `MidiCodec`, a per-model translator between the param domain and the MIDI byte domain, used by both the mock-runner (incoming MIDI → set_params) and the MCP (outgoing set_params → MIDI bytes). MockHandler's API simplifies to `set_params` / `get_params` / `load_program` / `load_song` — no MIDI knowledge. Eliminates the awkward UI-synthesizes-MIDI-for-the-mock-to-parse-back-into-state round-trip introduced in #24, sharing all encoding logic between the mock and the MCP.

Staged across four PRs:
- Stage 1: Introduce `MidiCodec` interface + JUNO-X impl. MCP `device.setParameters` / `getState` delegate.
- Stage 2: Mock handler's `handleSysEx`/`handleCC` delegate parsing to the codec.
- Stage 3: MockHandler API switches to `set_params` / `get_params` keyed by param name. UI WS protocol switches to `{type:"setParam",...}`.
- Stage 4: Drop `MockHandlerResult.{ccOut, programOut, sysexOut}` channels — emissions go through the codec at the engine boundary.

### 28. JUNO-X chorus type — UI ↔ state propagation bug

**Status:** Needs investigation.

Observed during #24 local testing: clicking a chorus mode button on jino's UI causes chorus_switch to propagate correctly (verifiable via shadow mock junio's UI lighting up the chorus group), but chorus *type* (the algorithm selector — JUNO Chorus, etc., 0..9 at `01:50:00:01`) does NOT propagate properly.

This is distinct from the wiring fix shipped in #24:
- The `{type:"param"}` UI message → `MockHandler.onUIParam` → DT1 → state path is now correct generally.
- The bridge from primary → shadow is verified working for delay_switch, reverb_switch, drive_switch.
- chorus_switch propagates.
- chorus *type* (the algorithm) still misbehaves — symptom unclear without further repro.

Likely culprits to investigate:
- The chorus mode buttons on the UI emit `chorus_mode` (param name doesn't exist server-side — see todo #11) rather than `chorus_type`. So clicking a mode button never sends the actual chorus_type DT1, even when the user expected "select JUNO Chorus" semantics.
- The chorus *type* selector (a separate dropdown control, distinct from the mode buttons) may not have a syncSceneGlobalUI mirror — `syncSceneGlobalUI` in `web/app.js` only mirrors switch-toggle buttons today.
- Possible UI selector listening on a different state path (CC vs scene-global SysEx).

Scope when picked up:
- Reproduce: change Chorus Type via jino's selector dropdown → verify junio's selector updates.
- If selector mirrors are missing, extend `syncSceneGlobalUI` to read `01:50:00:01[0]` for chorus_type and update the selector.
- If chorus_mode buttons should route to chorus_type semantically (e.g. "JUNO Chorus" on click), wire that mapping. Otherwise wait for #11 (full chorus mode sub-parameter set) which will give chorus_mode a proper home.

Useful prior art: `src/keyboard_models/roland/juno_x/scene-params.ts` (chorus_type at offset `00:50:00:01`), `src/keyboard_models/roland/juno_x/web/app.js` (`syncSceneGlobalUI`, `initChorusButtons`), todo #11.

### 29. JUNO-X drive button — click does nothing

**Status:** Needs investigation.

Observed during #24 local testing: clicking the "DRV" button on jino's UI doesn't toggle anything. Delay and Reverb buttons in the same FX cluster work correctly; only Drive is broken.

Likely culprits:
- Markup mismatch: HTML may have `data-fx="drv"` but `FX_PARAMS` map in `web/app.js:260` uses `drive: "drive_switch"`. If the data attribute is `drv` instead of `drive`, the lookup misses and no UI param is sent.
- Or `tog-btn` class missing on the drive button — `initFxButtons` selects `button.tog-btn[data-fx]`.

Quick fix is likely a one-character HTML change.


### 30. Move per-model MIDI status line to the mock runner shell

**Status:** Ready to plan.

Today every mock UI (Nord, Prophet, JUNO-X) renders its own "last MIDI change" status line at the bottom of the panel, with model-specific formatting (e.g. JUNO-X writes `lfo_rate = 64 (Part 1)`). That breaks the architectural boundary established by stage 5: the mock UI should speak param domain, not MIDI.

Move the status line to the **mock runner shell** instead — the chassis around the per-model iframes. The shell logs raw MIDI events as they happen on each tab's virtual MIDI ports, formatted generically:

- `CC93=32 ch=0` for control change
- `PC=12 ch=2` for program change
- `SysEx 16 bytes [F0 41 10 .. F7]` for sysex (head/tail summary, like the existing engine logs)

No model-specific interpretation in the shell — just raw MIDI. Per-model meaning lives in the codec/handler layer where it belongs.

Scope:
- Drop `setLastChange` calls and the `#last-change` element from each model's `web/index.html` and `web/app.js`.
- Add a status strip to `src/mock-runner/shell/` (next to the existing tab bar / chat console) that shows the most recent MIDI event(s) per active tab.
- Wire the engine's existing `MIDI-IN` / `MIDI-OUT` log lines (`src/mock-runner/engine.ts` already prints them) through to the shell — either via the existing `state-changed` event with a new payload type, or a dedicated WS broadcast for raw MIDI events.

### 31. JUNO-X part selector not actually selecting the active part

**Status:** Bug.

Clicking the part buttons (Part 1..5) in the JUNO-X mock UI updates the visual `active` class on the button but doesn't actually drive the param state — the displayed slider values continue to reflect the previously-selected part.

Likely culprit in `src/keyboard_models/roland/juno_x/web/app.js`:
- `initPartButtons` updates `activePart` and the button styling, but the next `handleState` broadcast might still render `data["part" + activePart]` from a stale state object (state hasn't changed since the last broadcast).
- Or `updatePartParams` is only called when the broadcast fires, not when `activePart` changes locally — so switching parts in the UI doesn't repaint.

Fix sketch: when `activePart` changes, immediately re-render from the last received state (cache it on the WS handler and re-invoke `handleState` with that cached state).

The bug pre-dates stage 5 — it's a UI state-flow issue, not a state-shape issue.
