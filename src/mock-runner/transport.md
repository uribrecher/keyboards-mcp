# `transport.ts` — `MockTransport`

> **About the name.** Previously called `MockEngine`. Renamed because this file owns no model logic — it's mostly a router with a small amount of protocol state. All model semantics live in the per-model `MockHandler` and `MidiCodec`.

## Responsibilities

The transport owns three things:

1. **Transport.** One virtual MIDI port (in + out) + one WebSocket server, per mock instance.
2. **Routing.** WS messages → handler methods. External MIDI → codec/handler.
3. **A small amount of stateful protocol glue** that neither the codec (stateless) nor the handler (model-agnostic transport) can own:
   - Bank-select accumulator (CC 0 / CC 32) before a Program Change.
   - RQ1 → DT1 fulfillment for Roland devices.
   - Default-channel resolution on emit.
   - MCP-connection bookkeeping, label, registry heartbeat.

What it does **not** own: parameter values, MIDI map, engine selection, backup data, anything model-specific. Those all live in the `MockHandler` (state) and `MidiCodec` (param ↔ MIDI translation).

## Topology

```
                                ┌─────────────────────────────────┐
                                │           MockTransport            │
              WS (UI client)    │  ┌─────────────────────────────┐│
  ◀──────── (full state) ◀───── │  │ WebSocketServer             ││
            UI panels           │  │  - this.clients   (UI)      ││
  ────────► setParam ─────────► │  │  - this.mcpClients (MCP)    ││
            setActiveEngine     │  └─────────────────────────────┘│
            reload-cache        │            │           ▲        │
                                │            ▼           │        │
                                │  ┌─────────────────────┴───────┐│
              MIDI (cc/pc/sx)   │  │ routing + protocol glue     ││
  ────────►  inbound  ────────► │  │  - bank-select accumulator  ││
                                │  │  - RQ1 fulfillment          ││
                                │  │  - dispatch()/emitOne()     ││
                                │  └─────────┬───────────────────┘│
                                │            │                    │
                                │            ▼                    │
                                │     handler  +  codec           │
                                │   (per-model, model-aware)      │
                                │                                 │
              MIDI (cc/pc/sx)   │  ┌─────────────────────────────┐│
  ◀──────── outbound  ◀──────── │  │ easymidi.Output             ││
                                │  └─────────────────────────────┘│
                                └─────────────────────────────────┘
```

## WebSocket clients

The transport accepts two kinds of WebSocket clients, distinguished by `?client=mcp` on the connect URL:

| Client | Set | Receives | Sends |
|---|---|---|---|
| UI (default) | `this.clients` | Full state snapshots (+ `mcpConnected`, `label`) | `setParam`, `setActiveEngine`, `reload-cache` |
| MCP server | `this.mcpClients` | `{mcpConnected, label}` only — for label discovery and live status | nothing |

`broadcast()` fans out to both sets but sends different payloads. `broadcastMcpStatus()` sends the label-only payload to both sets on MCP connect/disconnect (so UIs can flip their "MCP connected" indicator).

## Inbound WS message types

Handled in the `ws.on("message", ...)` block:

| `msg.type` | What the transport does |
|---|---|
| `setParam` | `handler.set_params([{name, value, part}])`, broadcast resulting state, then `codec.encodeParams(...)` → `emitOne()` for each encoded message (UI is a closed-loop source — panel-knob analogue). |
| `setActiveEngine` | `handler.set_active_engine(part, engine)` if implemented; broadcast the new state. |
| `reload-cache` | `handler.onCacheReload?.()` then broadcast a fresh full state snapshot. Used after `extract_backup`. |
| anything else | Silently ignored (the outer `try { ... } catch {}` swallows malformed JSON too). |

Adding a new WS message means adding a branch here. Each branch is a thin call into a handler method.

## Inbound MIDI dispatch

`dispatch(msg: MidiMessage)` routes everything from the virtual MIDI Input. Source is implicitly **external** — the transport **must not** echo inbound MIDI back out (would feedback-loop on bridges/shadows).

```
sysex                    parseRequest matches?  ──► RQ1 fulfillment (read-only path)
                         no match              ──► codec.decode → set_params

cc, controller 0 or 32   accumulate bank-select per channel  (no handler call)

program                  combine accumulated bank with PC slot
                         handler.load_program(bank, slot)

cc (anything else)       codec.decode → set_params
```

### RQ1 → DT1 fulfillment (`fulfillRequest`)

Transport-side because it's a pure read: codec describes which params live in the requested address range; handler returns their user-domain values; codec packs each one back to wire bytes; codec builds the reply sysex; transport emits it. Handler is read-only — no state mutation. See `paramsAtAddress` / `encodeBytes` / `buildResponse` on the `MidiCodec` interface.

### Bank-select accumulator (`pendingBankByCh`)

CC 0 (MSB) and CC 32 (LSB) on their own mean nothing — they're stateful predecessors to a Program Change. The codec is stateless by design, so the transport accumulates them per channel and only finalizes a `handler.load_program(bank, slot)` call when the matching PC arrives.

## Inbound message flows

The four flows below cover everything the transport actually does on the inbound side — both the WebSocket message types from the UI and the virtual-MIDI-In packets from external sources. They expand on the tables/decision tree above with step-by-step diagrams of what calls what.

### Flow 1 — UI sets a parameter

The UI never touches MIDI bytes; it sends a named param write over the WebSocket. The transport updates state via the handler, then asks the codec to encode the same write and emits it on MIDI Out (the panel-knob analogue — external listeners see the change).

```
UI ──{type:"setParam", name, value, part?}──► transport WS handler
                                               │
                                               ├──► handler.set_params([{name, value, part}])
                                               │      └─ updates state, returns { state, log }
                                               │
                                               ├──► transport.broadcast(state)  ──► UI clients
                                               │
                                               └──► codec.encodeParams([{name, value, part}])
                                                      → [{cc, value, channel}, …]
                                                      └─ transport emits to MIDI Out
```

`{type:"setActiveEngine", engine, part?}` follows the same shape but routes to `handler.set_active_engine`, which preserves inactive engines' state (JUNO-X has per-part engines: ZEN-Core, Analog Synth, JUNO-X Model, RD Piano).

`{type:"reload-cache"}` calls `handler.onCacheReload?.()` and broadcasts a fresh full state — used after `extract_backup` rewrites the on-disk cache.

### Flow 2 — External MIDI writes a parameter (CC, no echo)

External MIDI arriving on the virtual In must NOT echo back to MIDI Out — otherwise a bridge that fans out would loop the message right back into our own In. The transport decodes via the codec and applies through the handler; no echo, ever.

```
External MIDI ──cc──► virtual MIDI In ──► transport.dispatch
                                            │
                                            ├──► codec.decode({type:"cc", controller, value, channel})
                                            │      → [{kind:"param", name, value, part?}, …]
                                            │
                                            └──► handler.set_params(refs)
                                                   ├─ updates state
                                                   └─ transport.broadcast(state) ──► UI clients

                                            (no emission to MIDI Out)
```

### Flow 3 — External Program Change (with bank-select accumulator)

CC 0 (bank MSB) and CC 32 (bank LSB) on their own mean nothing — they're stateful predecessors to a Program Change. The codec is stateless by design, so the **transport** accumulates MSB/LSB per channel and finalizes a `handler.load_program(bank, slot)` call when the matching PC arrives.

```
External MIDI ──CC 0 (MSB)──►  transport: pendingBankByCh[ch].msb = value   (no handler call)
External MIDI ──CC 32 (LSB)──► transport: pendingBankByCh[ch].lsb = value   (no handler call)
External MIDI ──PC──►          transport: bank = (msb << 7) | lsb
                                          handler.load_program(bank, slot)
                                          └─ updates state → broadcast
```

### Flow 4 — External Roland RQ1 (transport-fulfilled, handler read-only)

RQ1 is a pure read of state. The transport orchestrates the round-trip entirely via the codec; the handler just returns the requested params' values.

```
External MIDI ──sysex──► virtual MIDI In ──► transport.dispatch
                                              │
                                              ├──► codec.parseRequest(msg)
                                              │      → { address, size, deviceId } | undefined
                                              │
                                              ├──► codec.paramsAtAddress(address, size)
                                              │      → [{name, part?, byteOffset, byteCount}, …]
                                              │
                                              ├──► handler.get_params(names, part)   per part
                                              │      → { name: userValue, … }
                                              │
                                              ├──► codec.encodeBytes(name, value, part)   per param
                                              │      → wire bytes
                                              │
                                              ├──► codec.buildResponse(req, dataBytes)
                                              │      → DT1 reply sysex
                                              │
                                              └──► transport emits DT1 to MIDI Out
```

The handler never sees raw MIDI here. Adding a new addressable-param read on a Roland model means extending the per-model codec's `paramsAtAddress` — no transport changes.

### Source-aware emission

The only source-aware rule is: **external MIDI is never echoed back to MIDI Out** (loop prevention on bridges). UI writes always emit (the panel-knob mirror). Handler-driven emissions (RQ1 replies) emit on their own path. There's no `source` flag on a dispatcher — the rule is implicit in which entry point fires (WS message vs. virtual MIDI In listener).

## Outbound — `emitOne`

Called from two paths: outbound after `setParam` (encoded by codec) and outbound from RQ1 fulfillment (the DT1 reply). Resolves the default channel (codec contract: `channel === undefined` → use the connection's default, which on the mock side is `opts.lowerChannel`). Sends to `easymidi.Output` and emits a structured `midi-event` only *after* `send` returns successfully — otherwise the per-tab MIDI drawer would show traffic that never reached the wire.

## Telemetry

Two channels alongside the `console.log` lines:

- `midi-event` (EventEmitter) — structured `{direction, kind, ...}` payload with the *full* sysex byte array. Consumed by the mock-runner shell to render the per-tab MIDI drawer (50-event ring buffer per tab, #82).
- `state-changed` (EventEmitter) — fires after every broadcast. Consumed by the main process to flip the `.mockrack` dirty flag without subscribing to WS messages (plan #9).

The stdout `summarizeSysex` format trims long sysex packets (head ≤4 bytes + tail 1 byte) for log readability. The structured payload always carries the full bytes.

## Lifecycle

| Method | When | Notes |
|---|---|---|
| `start()` | Once at construction. | Initializes handler, creates virtual MIDI port (unless `noMidi`), starts HTTP+WS, captures the OS-assigned port name (Core MIDI suffixes duplicates: "Foo", "Foo1"), publishes to the runtime registry. |
| `reloadCache()` | After `extract_backup` writes new backup data to disk. | Tells the handler to re-read caches, then broadcasts a fresh full state. |
| `relabel(label, lo, hi)` | Hot label swap from `main.ts` (e.g. tab rename). | Re-inits handler under a new label without tearing the WS or MIDI port. Updates the registry entry's label too. |
| `getFullState(...)` / `restoreSnapshot(...)` | `.mockrack` save / load (plan #9). | Snapshot/restore round-trip; restore broadcasts once for consistent UI transition. Returns false when the handler doesn't implement `setFullState`. |
| `stop()` | Tab close, app quit. | Clears heartbeat timer, unregisters from the registry, closes MIDI ports + WS clients + HTTP server. |

## Mock registry & heartbeat

`publishToRegistry()` writes an entry to the shared mock registry (`shared/mock-registry.ts`) so other processes — most importantly the MCP server's `list_midi_devices` — can discover this mock and drop entries left by crashed processes. A 30-second heartbeat refreshes `lastTouched`; `stop()` unregisters explicitly.

Tests pass `noRegistry: true` to skip this and avoid cross-test pollution.

## Things the transport deliberately does NOT do

These are easy to misattribute to the transport. They all live elsewhere:

- **Parameter values.** Owned by the `MockHandler` (state lives in `parts[i].engineParams` or equivalent — model-specific).
- **CC numbers, sysex addresses, value encoding.** Owned by the per-model `MidiCodec`.
- **Active engine on a part.** Owned by the handler via `set_active_engine(part, engine)`.
- **Backup parsing and inventory.** Owned by per-model backup parsers; the handler reads them.
- **Source-aware decisions** (e.g. "echo on UI source, don't echo on external"). Source classification happens at the entry point: WS-in is UI source (echoed via `emitOne` after `setParam`); MIDI-in is external (never echoed).

If you're tempted to add model knowledge here, the right answer is almost always to extend `MockHandler` or `MidiCodec` instead.

## See also

- [`docs/mock_runner.md`](../../docs/mock_runner.md) — user-facing mock runner doc covering the shell UI, file menu, headless mode, and the high-level transport/codec/handler split.
- [`src/shared/keyboard-model.ts`](../shared/keyboard-model.ts) — `MockHandler` interface (state contract).
- [`src/shared/midi-codec.ts`](../shared/midi-codec.ts) — `MidiCodec` interface (param ↔ MIDI contract).
