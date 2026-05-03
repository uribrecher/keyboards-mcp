# Follow-up Tasks

> Backlog of follow-up items. Each entry becomes its own numbered plan when promoted out of this list.

## Tasks

### 9. File menu — Save / Save as… / Open… / Recent setups

**Status:** Needs brainstorming — file format + scope of "studio state" need to be designed.

Add a top-level **File** menu to the Electron mock-runner shell with:

- **Save** — write the current studio state to the last-used setup file (or behave like *Save as…* if none).
- **Save as…** — native save dialog; user picks the path. File format TBD (JSON is the obvious default).
- **Open…** — native open dialog; load a setup file and restore the rack: re-create tabs in order, assign labels, pick the right model per tab, and recall each tab's internal mock state (params, program/song selection, etc.).
- **Recent setups** — submenu of up to 5 most-recently-used setup paths. macOS conventionally calls this *Open Recent*; Electron's `app.addRecentDocument()` integrates with the Dock.

Studio state to persist (initial scope):
- Tab list with `{ modelId, label }` per tab.
- Per-tab parameter state (the mock handler's current `getFullState()`-shaped snapshot, minus inventory).
- Active tab index.

Open / restore considerations:
- Free WS ports differ between sessions, so don't persist them — re-allocate on load.
- If a saved tab references a model that's no longer registered, skip it with a clear message in the chat console.
- Should `Open` close existing tabs or merge? Probably close (with a "save current?" prompt if dirty).
- Mock state is owned by the engine's `MockHandler` — likely needs a new `setFullState(snapshot)` interface so the handler can load the snapshot back in. This is a model-side contract change.

Open questions for brainstorming:
- Does saved state include the per-tab backup-cache *label*, or just the program/song selection? (The cache is keyed by label and lives on disk; arguably it should not be embedded in the setup file.)
- Should the `_default` label be auto-renamed on first save (so saved setups always reference user-meaningful labels)?
- Auto-save / unsaved-indicator UX in the title bar.

### 10. Bidirectional mock/MCP state reconciliation via RQ1 [BRAINSTORM]

**Status:** Needs brainstorming — architectural design required before planning.

The MCP device currently tracks only outgoing state (what it sent). The mock handler has its own state (including UI changes). These can diverge. The Roland RQ1 (Data Request 1) protocol allows querying the device for current parameter values. Design a system where `get_current_state` can query the mock/real hardware for the actual state, not just the MCP's local cache. This affects shared interfaces (`MidiConnection.onSysEx`, async request/response over MIDI) and could benefit all models, not just JUNO-X.

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

