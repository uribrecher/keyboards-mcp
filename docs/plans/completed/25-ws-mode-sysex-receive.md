# 25 — WS-mode SysEx receive: second WebSocket lane for outgoing MIDI

Closes #109. Companion to the real-MIDI receive path (plans 22/23).

## Problem

In CI/Docker WS mode (`MIDI_TRANSPORT=ws`, no easymidi), the MCP connects to a
mock via `WsMidiConnection` instead of `MidiManager`. Two gaps break the
RQ1→DT1 round-trip there:

1. **No receive lane.** `WsMidiConnection.onSysEx` was an explicit no-op — the
   mock's outgoing MIDI (the DT1 reply built by `MockTransport.fulfillRequest`
   → `emitOne`) only ever went to the virtual MIDI Out, which is `null` in
   WS-only mode (`noMidi`). So `emitOne` early-returned and the reply was lost.
2. **No inbound dispatch.** The lane-1 WS message handler only understood
   `setParam` / `reload-cache` / `setActiveEngine`; raw `{type:"cc|program|sysex"}`
   from `WsMidiConnection.send*` was silently dropped, so the mock never even
   saw the RQ1.

Note: the issue text references `MockHandlerResult.sysexOut`, which was removed
in the #30 stage-5 refactor — outgoing MIDI now flows through
`MockTransport.emitOne`, so that is where the broadcast hook lives.

## Design

A dedicated **second WS server** (`wsOutPort`) carries outgoing-from-mock MIDI,
keeping lane 1 (`wsPort`) for UI state + MCP status. The MCP's
`WsMidiConnection` keeps **sending** on lane 1 and **listens** on lane 2.

### `MockTransport` (app)
- `EngineOptions.wsOutPort?` — when set, stand up a second HTTP+WS server.
- Lane-1 message handler: route `{type:"cc|program|sysex"}` through a new
  `ingestExternalMidi()` (emits `midi-event` + `dispatch`), shared with the
  real-MIDI input listeners.
- `emitOne`: broadcast every outgoing message as JSON to the out-lane clients
  **regardless of `midiOutput`** (so WS-only mode emits), then send to
  `midiOutput` if present.
- `stop()`: tear down the out-lane server + clients.
- `publishToRegistry`: include `wsOutPort`.

### `mock-registry` (keyboards-mcp)
- `MockRegistryEntry.wsOutPort?: number` (optional, additive — old entries still
  validate).

### MCB manifest (keyboards-mcp)
- `PortInfo.wsOutPort?`, slim `MockRegistryEntry.wsOutPort?`, `resolvePort`
  populates it, `mcb-client.Manifest.primary.wsOutPort?` surfaces it.

### `WsMidiConnection` (keyboards-mcp)
- `connect(url, channel, outUrl?)` opens a second socket; `{type:"sysex"}` on it
  fires `onSysEx` (now a real subscriber list returning unsubscribe). `close()`
  closes both.

### `connect.ts` (keyboards-mcp)
- WS branch: out-lane URL from `MOCK_WS_OUT_URL`, else derived from the
  mock-registry entry whose `wsPort` matches the inbound lane (`primary.wsOutPort`
  surfaced via the registry).

### `cli.ts` + `MockProcess` helper
- `--ws-out-port` flag; `MockProcessOptions.wsOutPort` / `noMidi`.

## Tests (TDD)
1. App unit: lane-1 RQ1 in → DT1 out on lane 2 (inbound dispatch + out lane).
2. keyboards-mcp unit: `WsMidiConnection` two-lane `onSysEx` + unsubscribe + close.
3. **Required CI integration**: full-stack WS-mode `connect` → `set_parameters`
   → `get_current_state` reads live JUNO-X values via the out lane.
4. `port-resolver` unit: `wsOutPort` surfaced in resolved `PortInfo`.

## Out of scope
Bidirectional bridges / separate input bridge on real hardware.
