---
status: draft
backlog: ./2026-05-05-midi-connections-broker-backlog.md
---

# midi-connections-broker (MCB) — Design

## Goal

Introduce `midi-connections-broker` (shorthand: **MCB**): a long-running OS-managed process that brokers connection ownership across all `keyboards-mcp` sessions running on the host. MCB's responsibility is **inventory and lock arbitration**, not MIDI routing or state management. After MCB grants an MCP a connection lease, all subsequent communication (MIDI, WebSocket) flows directly between the MCP and the device — MCB is not in the data path.

## Why MCB

Today, the connection layer lives inside each MCP server process. MIDI ports, mock-UI WebSockets, and bridge metadata are all OS-singleton concerns, but each MCP holds its own view. With concurrent agent sessions, two MCPs can each open the same MIDI Output, each maintain its own `StateManager`, each create its own `?client=mcp` WebSocket against a mock — and silently disagree on what the kit is doing. The mock-UI status WS bug fixed in PR #28 is a symptom of that mismatch. A broker that adjudicates "who owns what port right now" — without taking on the data plane — is the smallest correct answer.

## Non-goals

- Owning MIDI ports.
- Owning mock-UI WebSockets.
- Holding `StateManager` instances.
- Routing parameter sets, validating per-model schemas, or otherwise mediating tool calls. The MCP's existing internal machinery (`MidiManager`, `StateManager`, per-model `KeyboardDevice`, `validateParameterBatch`) stays where it is.
- Owning mock processes (mock-runner remains user-launched).
- Multi-host coordination. UDS is local-only.
- Persistence across MCB restarts.
- Automatic takeover (T2) of locked devices.

## What MCB owns

- **Session registry.** Active MCP sessions, with peer PID for liveness.
- **Lease registry.** `port → { ownerSessionId, deviceId }`. R1 (read-open) + T1 (hard-reject on conflict).
- **Bridge registry.** `masterDeviceId → shadowPortName`. Pure metadata. MCB never opens a forward MIDI port.
- **Port resolver.** Authoritative answer for "what does this label/name resolve to" against mock registry + OS port list, strict and direction-aware.
- **Notification stream.** SSE for topology changes (sessions/devices/bridges add/remove).

## What stays in the MCP

- All OS resources: `easymidi.Output`/`Input`, mock-UI WebSockets — including the forward `Output` for any bridge the MCP holds.
- `MidiManager` (existing), now configured by the manifest MCB hands back.
- `StateManager`, per-device.
- Per-model `KeyboardDevice`, schema validation, `validateParameterBatch`, etc.
- The MCP's local working-set pool (1-based addressing).
- All tool handlers (`set_parameters`, `get_current_state`, `list_parameters`, `extract_backup`, `load_program`, …) — they continue to operate on local objects exactly as today.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Host OS                                                                      │
│                                                                              │
│  Agent A          Agent B                                                    │
│    │ stdio          │ stdio                                                  │
│    ▼                ▼                                                        │
│  keyboards-mcp A  keyboards-mcp B                                            │
│    │   │            │   │                                                    │
│    │   │ (lease)    │   │ (lease)                                            │
│    │   │            │   │                                                    │
│    │   ▼            │   ▼                                                    │
│    │ ┌──────────────────────────────────────────────┐                        │
│    │ │ midi-connections-broker (MCB)  control plane │                        │
│    │ │                                              │                        │
│    │ │   sessions                                   │                        │
│    │ │   leases (port → session/device)             │                        │
│    │ │   bridges (master → shadow)                  │   ← metadata only      │
│    │ │   PortResolver                               │                        │
│    │ │   PID liveness GC                            │                        │
│    │ │   SSE topology notifications                 │                        │
│    │ │                                              │                        │
│    │ │   reads: mock-registry,                      │                        │
│    │ │          easymidi port lists                 │                        │
│    │ └──────────────────────────────────────────────┘                        │
│    │                                                                         │
│    │ MIDI I/O ◄────► MidiManager (in MCP) ◄────► MIDI ports / mock WS        │
│    │ (data plane — direct, MCB not involved)                                 │
│    ▼                                                                         │
│  Real keyboards & mocks                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Data plane (MIDI traffic, WS messages, state changes) is point-to-point between MCP and device. Control plane (who can claim what, what bridges exist, what's the topology) is MCB's job.

## Lease lifecycle

1. **MCP startup**: `POST /v1/sessions` → `{ sessionId, ownerPid }`.
2. **Connect**: MCP calls `POST /v1/devices` with `{ port, model, with_shadow?, input_port?, label?, channel?, ... }` and `X-Session-Id`.
3. **MCB validates**:
   - Strict port resolution for `port`, `with_shadow`, `input_port`.
   - Lock checks: `port` not currently leased; `with_shadow` not currently a primary or another bridge's shadow; no cycle; no self-shadow.
4. **MCB registers** the lease and (if applicable) the bridge edge. Emits `device-connected` and `bridge-created` SSE events. Returns the **endpoint manifest**:
   ```jsonc
   {
     "deviceId": "<uuid>",
     "ownerSessionId": "<uuid>",
     "model": "nord-electro-5d",
     "primary": { "portName": "Nord Electro 5 MIDI Input", "wsPort": null },
     "input":   { "portName": "Nord Electro 5 MIDI Output" },
     "shadow":  { "portName": "Nord Electro 5D Mock", "wsPort": 3002 },
     "label": "default",
     "channel": 1, "lowerChannel": 2, "upperChannel": 3
   }
   ```
   `wsPort` is non-null when the corresponding port is a registered mock.
5. **MCP opens its own connections** using the manifest: `easymidi.Output` for `primary` and (if present) `shadow`, `easymidi.Input` for `input`, WebSockets to any wsPort that came back. Wires up `MidiManager` with all of these. The bridge's MIDI THRU lives entirely in `MidiManager` (existing pattern).
6. **MCP runs its tool calls** entirely against its local `MidiManager` + `StateManager`. MCB is not involved in any per-message traffic.
7. **Disconnect**: `DELETE /v1/devices/:id` → MCB releases the lease and removes the bridge edge. MCP closes its OS resources.
8. **PID death**: MCB GCs the session; OS closes the MCP's FDs naturally.

## How this dissolves the original bug

The mock-UI WS bug existed because the MCP guessed the wrong wsPort. Under the new model MCB hands back `shadow.wsPort` (or `primary.wsPort` for a solo-mock connection) in the manifest. There's no shared `mockWsPort` field; there's no implicit default. The MCP attaches its WS to the exact port MCB resolved for the mock the lease covers. Two MCPs cannot both attach to the same mock because they cannot both hold the lease.

## Phases

- **Phase 1 (MVP)** — Standalone MCB binary. Control plane only: sessions, lease registry, bridge registry, port resolver, SSE topology events. **Zero touches to existing MCP code.** Tests via HTTP-over-UDS.
- **Phase 2** — MCP integration. Add session bootstrap on MCP startup. Refactor `connect_to_keyboard` to claim a lease via MCB before opening MIDI; consume the endpoint manifest. Drop implicit defaults (`auto_input`/`auto_forward`/`mock_ws_port`/`forward_port`). Add `with_shadow` parameter that triggers MCB-side bridge registration. The MCP's `MidiManager`, `StateManager`, `KeyboardDevice`, validation, etc. are unchanged in structure — they just read configuration from the manifest instead of from the tool args' implicit defaults.
- **Phase 3** — Mock-runner connection-viewer subscribing to MCB's SSE.

## Backlog

See `2026-05-05-midi-connections-broker-backlog.md`.
