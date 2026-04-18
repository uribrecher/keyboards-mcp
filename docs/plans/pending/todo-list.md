# Follow-up Tasks

> **Execution order: 8** — Depends on: JUNO-X v1 implementation (completed 2026-04-18).

## Tasks

### 8a. Agent redesign — Vercel AI + gateway + dual MCP [PLAN NEEDED]

**Status:** Needs a plan — design exists in a Gemini conversation, needs to be written up as a plan in `docs/plans/`.

**Priority:** High — blocks future agent-dependent work.

Major redesign of `src/agent.ts`. The new architecture is based on:
- **Vercel AI SDK** as the agent framework (replacing the current OpenAI-direct implementation)
- **Vercel AI Gateway** for LLM routing with built-in **Perplexity web search tool** (replaces manual research workflows)
- **Two MCP server connections:** keyboards-mcp (this repo) and audio-analysis-mcp (plan 7, not yet implemented)
- **Preloaded recreate-sound skill** as part of the agent's system prompt (the sound recreation workflow from `docs/recreate-sound.md`)

The Gemini conversation contains the current design thinking. Next step: extract that into a formal plan under `docs/plans/pending/`.

### 8b. Bidirectional mock/MCP state reconciliation via RQ1 [BRAINSTORM]

**Status:** Needs brainstorming — architectural design required before planning.

The MCP device currently tracks only outgoing state (what it sent). The mock handler has its own state (including UI changes). These can diverge. The Roland RQ1 (Data Request 1) protocol allows querying the device for current parameter values. Design a system where `get_current_state` can query the mock/real hardware for the actual state, not just the MCP's local cache. This affects shared interfaces (`MidiConnection.onSysEx`, async request/response over MIDI) and could benefit all models, not just JUNO-X.

### 8c. Full JUNO chorus mode sub-parameters

**Status:** Ready to plan.

The JUNO Chorus (type 09) has a Mode parameter with values I, II, I+II, JX I, JX II, III, I+III, II+III, I+II+III. The current implementation sends chorus_switch on/off but doesn't set the actual chorus sub-parameters via DT1 SysEx. Requires finding the exact SysEx addresses for the chorus type 09 mode parameter within the Scene Chorus block (offset `00 50 00`).

### 8d. ZCore / JUNO-X Model / RD Piano UI panels

**Status:** Ready to plan.

The mock UI has placeholder panels for these three engines. Each needs:
- **ZCore:** Partial selector (1-4), per-partial sliders (OSC/Filter/Amp/LFO), synth common params. Most complex panel.
- **JUNO-X Model:** Similar to Analog Synth panel with extended controls.
- **RD Piano:** Minimal — sympathetic resonance controls only. Part 1 only.

### 8e. JUNO-X scene/tone bank browsing

**Status:** Ready to plan.

The JUNO-X organizes tones by bank (JUNO-106, JUNO-60, JUNO-X, PR-X, RD-PIANO, etc.). Implement tone bank select + program change for switching between factory tones, and scene bank select for switching between user scenes (1-256). Requires bank select MSB/LSB + program change sequences from the MIDI Implementation (page 1).

### 8f. Analog Synth sub-model selection (JUNO-106 / JUNO-60)

**Status:** Ready to plan.

The Analog Synth engine emulates both the JUNO-106 and JUNO-60 as sub-models. Each has different waveform sets, octave ranges, and parameter behaviors (see Parameter Guide pages 19-20 for separate JUNO-106 and JUNO-60 tone parameter tables). The current implementation defines one generic Analog Synth param set. Add:
- Sub-model selector (JUNO-106 / JUNO-60) in the UI and as a settable parameter
- Engine-specific parameter variations (different CC mappings, value ranges, available waveforms)
- Mock handler awareness of which sub-model is active per part

### 8g. JUNO-X backup parsing

**Status:** Needs research.

Parse JUNO-X backup files to extract scene/tone inventory, similar to the Nord backup parser. Requires understanding the Roland backup file format (likely SysEx bulk dump or proprietary format). Lower priority until a real JUNO-X is available for testing.

### 8h. PPG Wave keyboard model

**Status:** Needs brainstorming — model design required before planning.

Implement a new keyboard model emulating the famous PPG Wave synthesizer. The PPG Wave is a classic wavetable synth known for its evolving, digital textures and metallic timbres. Requires designing the parameter map (wavetable selection, wave position, analog filter, envelopes, LFO), mock handler with wavetable engine behavior, and web UI. Should follow the same model architecture pattern as the JUNO-X (KeyboardModel + KeyboardDevice + MockHandler + web UI).

### 8i. Yamaha DX7 keyboard model

**Status:** Needs brainstorming — model design required before planning.

Implement a new keyboard model emulating the Yamaha DX7, the iconic FM (frequency modulation) synthesizer. The DX7 defined the sound of the 1980s with its electric pianos, bells, bass, and brass patches. Requires designing the FM synthesis parameter map (6 operators, algorithms 1-32, operator levels/ratios/envelopes, feedback, LFO), mock handler with FM engine behavior, and web UI. The operator/algorithm architecture is fundamentally different from subtractive synthesis, so the parameter system and UI will need a distinct approach. Should follow the same model architecture pattern as the JUNO-X.
