# Follow-up Tasks

> Backlog of follow-up items. Each entry becomes its own numbered plan when promoted out of this list.

## Tasks

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

### 18. Mock-runner Event Log panel — separate non-chat events from the chat console

**Status:** Needs brainstorming — UI surface design required before planning.

The chat console in the mock-runner shell currently absorbs *everything* that comes through `menu:console-note`: agent dialog (the actual reason it exists) plus a stream of unrelated lifecycle / status / "not yet implemented" notes from the per-tab MockHandlers and from File-menu actions. After loading a multi-tab `.mockrack`, the chat is flooded with lines like:

```
Roland JUNO-X ("junio"): full state restore not yet implemented — knobs reset to defaults.
Roland JUNO-X ("jino"): full state restore not yet implemented — knobs reset to defaults.
Prophet-6 ("pro_fat"): full state restore not yet implemented — knobs reset to defaults.
```

These belong in their own pane.

Design questions for brainstorming:

- **Layout**: separate tab next to the chat? Collapsible drawer at the bottom? Side-by-side panes? Whatever shape it takes, the chat must stay focused on the agent dialog.
- **Routing**: today the renderer subscribes to `menu:console-note` from `src/mock-runner/main.ts`. Need a second IPC channel (e.g. `menu:event-log`) and a clear rule for which messages go where. First-pass split: anything emitted in response to user agent input → chat; anything emitted by File-menu actions, tab lifecycle, MockHandler init/restore, MCB lease changes → event log.
- **Persistence + scrollback**: chat already has scrollback inside a session. Event log should match, plus probably a clear-all and timestamp on each line.
- **Filtering / severity**: tab lifecycle notes are info-level; "not yet implemented" is warn; MCB-unreachable would be error. Worth color-coding from day one.
- **Source attribution**: include the originating tab/model where applicable (the existing notes already prefix with `${model.info.displayName} ("${label}")` — keep that).

Emitter sites to migrate (search `mainWindow?.webContents.send("menu:console-note"` in `src/mock-runner/main.ts`): tab create/close/select-model, setup load/save, full-state restore notices, MCB-aware tab LED status changes if any are surfaced. Audit the full list in the planning pass.

Out of scope for the MVP: a unified backend event-log that aggregates across MCB / mock-runner / MCP servers — the *Operator dashboard* item in the MCB backlog covers that broader ambition. This task is just the mock-runner shell: pull the noise out of the chat box.

### 19. Mock-runner: tab LEDs reflect MCB liveness via blinking-amber state

**Status:** Ready to plan. The frontend-design skill is appropriate for the LED visuals.

When MCB is unreachable, every per-tab LED in the mock-runner switches to a blinking-amber "MCB-down" state. When MCB recovers, the LEDs stop blinking and resume rendering from lease ownership (primary / shadow / none) as today.

mcb-client owns liveness internally and pushes broker-up / broker-down notifications. Mock-runner subscribes and toggles the blink state — no polling on the mock-runner side.

