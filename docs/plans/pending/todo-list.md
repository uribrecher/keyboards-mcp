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

### 23. JUNO-X `get_current_state` via Roland RQ1

**Status:** Blocked on #22.

Replace the JUNO-X `get_current_state` stub (added in PR #65) with a real RQ1-based query. The mock side is already in place from #21 (it parses RQ1 and emits DT1 responses); the MCP-side receive path is in place from #22.

Scope:
- Issue RQ1s for the addressed sections (start with scene-effects: chorus, delay, reverb, drive). Use the `MidiConnection.requestSysEx` API from #22.
- Decode the DT1 responses via the JUNO-X parameter map (the same address → param key/encoding lookups already used by `set_parameters`).
- Render the live values as the tool result.
- Map errors to tool-result text — timeout: "no response from JUNO-X (RQ1 timeout); is the device connected?". Malformed: "got a malformed DT1 — see logs."
- Update JUNO-X `agentSystemPrompt` and `CLAUDE.md` to reflect that RQ1 actually works (today both say "not yet implemented").

Out of scope: per-part RQ1 reads, ZCore / RD-piano per-part details, scene-modify section. Those are explicit follow-ups beyond #23 once the four scene-effects sections work end-to-end.

Useful prior art: `docs/plans/completed/21-juno-x-rq1-get-state.md` (mock side), `src/keyboard_models/roland/juno_x/scene-params.ts` (addresses), `src/shared/roland-dt1.ts` (`buildRQ1`, `parseDT1`, `addAddresses`, `packNibbles`).

### 24. UI-driven mock MIDI emission

**Status:** Needs design.

When the JUNO-X mock UI (Electron mock-runner web UI) is manipulated by mouse — knob clicks, drag-to-rotate, button presses — the mock should emit the corresponding MIDI message (CC, SysEx) on the virtual MIDI input port added in #21 (the device's MIDI Out socket). This mirrors real hardware: turning a knob on the panel emits MIDI on the device's MIDI Out for downstream listeners.

#### Today's flow

When the UI sends a `{type: "cc", controller, value, channel}` WebSocket message, MockEngine routes it as `this.onMIDI({type: "cc", ...})` — the SAME entry point used for external MIDI input arriving on the virtual Output port (the device's MIDI In socket). The handler updates internal state and broadcasts to UI clients. **No MIDI is emitted on the device's MIDI Out.**

#### What needs to change

The engine must, on receipt of a UI-sourced WS message, do BOTH:
1. Update internal state (call the handler — existing path).
2. Write the same MIDI bytes to the virtual MIDI input port (the device's MIDI Out — new path).

#### ⚠️ Echo-loop trap to design around

There's a subtle architectural hazard: today's engine doesn't distinguish "this CC came from UI" from "this CC came in over external MIDI." Both flow through `this.onMIDI({type: "cc", ...})` on the SAME path. If we naively make the engine "fan every onMIDI call to the MIDI output port too," we get an immediate echo loop the moment a real external MIDI source (or another mock, or the MCP itself) sends a CC into the mock's MIDI In:

```
External MIDI in → engine.onMIDI(cc) → midiOutput.send(cc)
  → loops back into anything listening on the device's MIDI Out
  → in worst case, into the same mock's MIDI In via a bridge → infinite loop
```

The fix is to keep "where this came from" out of the handler and resolve it at the engine routing layer:

- **UI-sourced** WS messages → engine writes to `midiOutput` directly (the hw analogue of "panel knob turned"), AND calls handler to update state.
- **External-MIDI-sourced** events (arriving on `midiInput.on("cc"|"program"|"sysex")`) → engine ONLY calls the handler. Does NOT write to `midiOutput` — that would echo what we just received.
- **Handler-explicit emissions** via `MockHandlerResult.ccOut` / `sysexOut` (e.g. JUNO-X RQ1→DT1 response from #21) → engine writes to `midiOutput`. The handler decided to emit; that's not an echo.

In other words, **routing decisions live in the engine**, keyed off the source of the inbound message. The handler stays source-agnostic. Echo-loops happen when source-agnostic routing meets a feedback path; we prevent that by making source-aware routing explicit and only at the boundary.

#### Scope when this lands

- Add `MockHandlerResult.ccOut?: Array<{controller, value, channel}>` (and possibly `programOut?` for completeness — match the existing `MidiMessage` types). Naming: `*Out` = mock-emits-this, mirroring `sysexOut` from #21.
- Engine extends `onMIDI` fan-out to write `ccOut` (and `programOut`) packets via `midiOutput.send("cc", ...)`.
- Engine adds a UI-source path that ALSO writes the inbound CC/sysex to `midiOutput` (separate from the handler-explicit `ccOut` mechanism).
- UI side: knob/button widgets already send `{type:"cc"}` etc. — likely no client-side changes needed beyond verifying the existing message format.
- Tests: unit-test the engine's source-aware routing (UI source → MIDI out, external source → no MIDI out).

#### Why this matters

Once a real external MIDI source can also drive the mock (hw + mock pair via a bridge — todo #22 territory), getting the routing wrong becomes a hard-to-debug runtime feedback loop. Documenting the trap here means the next implementer designs around it instead of discovering it the hard way.

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

