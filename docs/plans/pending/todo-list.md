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

