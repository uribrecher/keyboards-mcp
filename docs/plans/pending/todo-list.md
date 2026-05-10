# Follow-up Tasks

> Cross-model backlog. Each entry becomes its own numbered plan when promoted out of this list.
>
> Per-model backlogs:
> - JUNO-X — `src/keyboard_models/roland/juno_x/docs/juno-x-todo.md`

## Tasks

### 1. PPG Wave keyboard model

**Status:** Needs brainstorming — model design required before planning.

Implement a new keyboard model emulating the famous PPG Wave synthesizer. The PPG Wave is a classic wavetable synth known for its evolving, digital textures and metallic timbres. Requires designing the parameter map (wavetable selection, wave position, analog filter, envelopes, LFO), mock handler with wavetable engine behavior, and web UI. Should follow the same model architecture pattern as the JUNO-X (KeyboardModel + KeyboardDevice + MockHandler + web UI).

### 2. Yamaha DX7 keyboard model

**Status:** Needs brainstorming — model design required before planning.

Implement a new keyboard model emulating the Yamaha DX7, the iconic FM (frequency modulation) synthesizer. The DX7 defined the sound of the 1980s with its electric pianos, bells, bass, and brass patches. Requires designing the FM synthesis parameter map (6 operators, algorithms 1-32, operator levels/ratios/envelopes, feedback, LFO), mock handler with FM engine behavior, and web UI. The operator/algorithm architecture is fundamentally different from subtractive synthesis, so the parameter system and UI will need a distinct approach. Should follow the same model architecture pattern as the JUNO-X.

### 3. Re-home the chat backup/reset and event-log clear actions

**Status:** Needs brainstorming — small UX question.

The Event Log design (`docs/superpowers/specs/2026-05-08-mock-runner-event-log-design.md`) converts what was the chat console header into a two-tab strip whose only job is identity (CHAT tab carries lamp + SID + agent meter) and selection (LOG tab + unread LED). The three action buttons that used to live in that header — `backup`, `reset`, and the would-be `clear` for the event log — have no home.

Until this ships, those actions are reachable only via keyboard accelerator (`backup` already has ⌘E; `reset` already has its accelerator; `clear` needs one added when implemented).

Design questions:

- Where do the buttons go? Candidates: a thin toolbar above the composer (CHAT) and above the event-log pane (LOG); a single composer-row utility button cluster; a command palette / overflow menu shared between panes; per-pane footers below the scrollback.
- Should the buttons be pane-scoped (live with their respective pane body) or always-visible (then how do they not creep back into the tab strip)?
- Discoverability: keyboard accelerators are fine for power users but the existing `backup` button is the only signal for new operators that the action exists. Whatever replaces it has to be at least as discoverable.
- Visual: the existing `.console__btn` is a compact graphite button — preserve that idiom or rethink in light of the new tabbed layout.

### 4. WS-mode SysEx receive — second WebSocket lane for outgoing MIDI

**Status:** Needs design.

Plan #21 added a virtual MIDI Out port on every model mock; plan #22 wired the MCP-side real-MIDI receive path. CI/Docker mode (where `MOCK_WS_URL` is set and real MIDI is unavailable) currently has no symmetric receive path — `WsMidiConnection.onSysEx` is still a no-op.

To close that gap, mirror the real-MIDI approach over WebSockets. The user's directive from the plan #22 brainstorm (paraphrased): *similar to the output direction's env var, we can have an env var that picks real MIDI vs WS for receive.*

Scope:
- **MockEngine: second WS server.** Per the "port for port" decision recorded in earlier plan #21 brainstorm — each MIDI direction maps to its own WS port. Existing WS keeps its mixed role (UI state + UI commands + MCP status); new WS is dedicated to outgoing-from-mock MIDI events. On every `MockHandlerResult.sysexOut`, broadcast `{type:"sysex", bytes}` only on the new server.
- **mock-registry**: add `wsOutPort` field alongside the existing `wsPort`.
- **MCB manifest**: surface `primary.wsOutPort` from the mock-registry entry.
- **`WsMidiConnection`**: take a second URL; listen there for `{type:"sysex"}`; fire `onSysEx`.
- **`connect.ts`**: plumb `manifest.primary.wsOutPort` into the WS-mode `WsMidiConnection.connect` call. Add `MOCK_WS_OUT_URL` env var for direct-WS-mode usage in tests.
- **CI integration test** for RQ1 round-trip in WS mode.

Out of scope (separate todo if needed): the receive path on real hardware over a *bridge* (e.g. someone wants to listen for DT1 via a bridge tee instead of direct connection). Today's bridges are one-way (master out → shadow in); making them bidirectional or adding a separate input bridge is its own design work.

Useful prior art: `src/midi/ws-midi-connection.ts` (existing send-only WS impl), `src/mock-runner/engine.ts` (existing WS server + virtual MIDI Out fan-out from plan #21), `tests/helpers/test-harness.ts` (CI/Docker WS-mode infrastructure).

### 5. Move per-model MIDI status line to the mock runner shell

**Status:** Ready to plan.

Today every mock UI (Nord, Prophet, JUNO-X) renders its own "last MIDI change" status line at the bottom of the panel, with model-specific formatting (e.g. JUNO-X writes `lfo_rate = 64 (Part 1)`). That breaks the architectural boundary established by plan #30 stage 5: the mock UI should speak param domain, not MIDI.

Move the status line to the **mock runner shell** instead — the chassis around the per-model iframes. The shell logs raw MIDI events as they happen on each tab's virtual MIDI ports, formatted generically:

- `CC93=32 ch=0` for control change
- `PC=12 ch=2` for program change
- `SysEx 16 bytes [F0 41 10 .. F7]` for sysex (head/tail summary, like the existing engine logs)

No model-specific interpretation in the shell — just raw MIDI. Per-model meaning lives in the codec/handler layer where it belongs.

Scope:
- Drop `setLastChange` calls and the `#last-change` element from each model's `web/index.html` and `web/app.js`.
- Add a status strip to `src/mock-runner/shell/` (next to the existing tab bar / chat console) that shows the most recent MIDI event(s) per active tab.
- Wire the engine's existing `MIDI-IN` / `MIDI-OUT` log lines (`src/mock-runner/engine.ts` already prints them) through to the shell — either via the existing `state-changed` event with a new payload type, or a dedicated WS broadcast for raw MIDI events.
