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

### 21. JUNO-X get_current_state via Roland RQ1 (stateless-MCP pivot, PR B)

**Status:** Needs brainstorming — depends on #20 landing first.

Implement JUNO-X's `get_current_state` by issuing a Roland Data Request 1 (RQ1) sysex to the device, awaiting the matching DT1 response, and rendering it as the tool result. Real JUNO-X hardware speaks this natively; the JUNO-X mock has to start emitting it too.

Design surfaces to figure out before planning:

- **Request/response correlation over MIDI.** RQ1 is async — the response comes back as a DT1 sysex on the device's MIDI input some milliseconds later. Need a request-id-or-address-keyed promise table, a timeout, and graceful handling of dropped responses. Probably belongs in `MidiConnection` as a generic `requestSysEx(req, matchFn, timeout)` helper, with the JUNO-X device using it.
- **Address scoping.** RQ1 takes a (start address, size) pair. We probably want a small set of canonical reads — "current scene", "selected part tone", maybe a per-section reader. Decide whether `get_current_state` reads everything or a section.
- **JUNO-X mock needs a MIDI _output_ port.** Today the mock receives MIDI in but doesn't emit any back; for the MCP to listen for RQ1 responses against the mock the same way it would against real hw, the mock has to expose a virtual MIDI output port (Roland RTPMidi virtual port) and write DT1 responses to it. The MCP-side input listener (`MidiManager.connectInput`) is already wired in `connect.ts` — we just need the mock to publish a port name and the MCB / connect path to plumb it through.
- **Mock-side state source.** The JUNO-X mock has full state in its `MockHandler`. Wire RQ1 → look up the addressed bytes → emit DT1.
- **Render.** DT1 bytes need to be decoded back to parameter values via the JUNO-X parameter map. Reuse the same encoding helpers used to send DT1 in the first place.
- **Error paths.** Timeout: tool returns "no response from device — check that JUNO-X is connected and listening." Malformed response: tool returns "got a malformed DT1 — see logs." Don't fall back to a stale shadow (we don't have one any more — that's the point).

Useful prior art in this repo: `src/shared/roland-dt1.ts` (DT1 encoder), `src/midi/midi-manager.ts` (connection + sysex send/receive), `src/keyboard_models/roland/juno_x/midi-map.ts`.

### 22. MCP-side receive plumbing for SysEx: connect semantics + bridge integration

**Status:** Needs brainstorming.

PR #21 implemented the Roland RQ1 protocol on the JUNO-X mock side and added a virtual MIDI input port (device's MIDI Out socket) to every model mock. **The MCP cannot yet receive on that port.** This todo closes the loop on the receive direction across all models — pure plumbing, no model-specific feature work.

Open design questions:

- **`connect_to_keyboard` arg semantics.** Today `port` means "the device's MIDI In socket (where MCP sends)" and `input_port` is a sidecar for shadow physical-knob mirroring. For queryable models, the MCP needs to listen on the device's MIDI Out. Should `input_port` be promoted to a real receive channel? Auto-resolved from a name pattern? Or rename `port` → `output_port` for clarity?
- **MCB lease scope.** Today MCB leases the primary output port. MIDI Input opens are exclusive on macOS — should the lease also cover the input direction so two MCPs don't fight over the same device's response stream?
- **Bridges as the receive-direction primitive.** Today `with_shadow` tees outgoing MIDI from primary → shadow. Could bridges become bidirectional, with a `with_input_bridge` argument forwarding device-output → MCP-input?
- **Transport options for receive.** Two paths to evaluate:
  - (a) MCP opens an OS-level MIDI input on the device's MIDI Out port and consumes `input.on("sysex")`. Works for both real hw and mocks. Requires extending `connect_to_keyboard` semantics.
  - (b) Mock-only: MockEngine spins up a dedicated WebSocket lane for outgoing MIDI, MCP listens there. Real-hw still needs path (a).
- **`MidiConnection.requestSysEx` API.** Generic request/response correlator (one-shot listener, timeout, matched-only resolution). Belongs on the interface so device classes can use it without knowing the transport.

Out of scope: any model-level feature that uses the receive path (e.g. JUNO-X get_current_state — that's #23, blocked on this).

Useful prior art: `src/midi/midi-manager.ts` `connectInput`, `src/mcb/bridge-registry.ts`, the `with_shadow` flow in `src/tools/connect.ts`. Mock side already done in #21.

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

