# Roland JUNO-X — model architecture

Reference for the JUNO-X-specific code under `src/keyboard_models/roland/juno_x/`. Covers what makes this model different from the simpler Nord / Prophet-6 implementations and where each piece of logic lives.

## At a glance

- **Multi-timbral**: 5 parts, each independently assignable to one of 4 sound engines.
- **Per-part engines** with **separate state per engine per part** — switching engines on a part preserves the inactive engines' settings.
- **Scene-based program system**: a Scene holds all 5 parts plus scene-level effects (Chorus, Delay, Reverb, Drive).
- **Roland sysex protocol**: parameter access via DT1 (Data Set 1, write) and RQ1 (Data Request 1, read) — the only model in this repo that supports a live read-back path (`get_current_state` via RQ1).

## File layout

```
roland/juno_x/
├── docs/juno_x.md          ← this file
├── index.ts                ← KeyboardModel export, factory wiring
├── device.ts               ← MCP-side JunoXDevice (set_parameters, get_current_state via RQ1)
├── midi-codec.ts           ← param ↔ MIDI translator (used by mock + MCP)
├── midi-map.ts             ← JunoXParameterMap: per-engine + global param sets
├── mock-handler.ts         ← mock state owner (pure logic, per-(part, engine, key) state)
├── scene-params.ts         ← scene-global params (chorus_*, delay_*, reverb_*, drive_*)
├── engines/
│   ├── engine-types.ts     ← JunoXEngine enum, SCENE_BASE, SCENE_PART_OFFSETS
│   ├── analog-synth.ts     ← AnalogSynth engine params (~36)
│   ├── juno-x-model.ts     ← JunoXModel engine params (~17)
│   ├── zcore.ts            ← ZEN-Core engine params (~58 across 4 partials)
│   └── rd-piano.ts         ← RD Piano engine params (~4)
└── web/                    ← mock UI (HTML/CSS/JS loaded by Electron)
```

## Engines

JUNO-X has 4 engines. Each part runs exactly one at a time.

| Engine | Purpose | Sysex addresses? | Notable |
|--------|---------|------------------|---------|
| `analog-synth` | JUNO-106 / JUNO-60 modeling | No — CC only | Default seed engine on every part |
| `juno-x-model` | Extended JUNO modeling | No — CC only | |
| `zcore` (ZEN-Core) | Modern digital synth | No — CC only | 4 partials per part; param keys prefixed `p1_..p4_` |
| `rd-piano` | Electric piano (RD-series) | Yes — symreso block at `01:00:00:0X` | Part 1 only on real HW |

The active engine on a part is **state owned by the mock-handler** (`parts[i].activeEngine`). Routing decisions live in the handler — the codec is engine-agnostic, the engine layer (transport) doesn't know the concept exists.

### Why CCs collide across engines

Many physical knobs on the panel exist in multiple engines: Cutoff (CC 3) is `cutoff` in AnalogSynth, JunoXModel, and `p1_cutoff` in ZCore. CC 110 ("Tone/AMP Level") exists in all 4 engines. The merged param namespace can't represent this cleanly with single-key entries — see [param-map design](#param-map-design) below.

## Parts

5 parts (indexed 1-5 in the UI / param-domain APIs, 0-4 internally). Each part has:

- An **active engine** (1 of the 4 above).
- **Per-engine param state** stored as `parts[i].engineParams[engine][paramKey] = userValue`.
- A receive **MIDI channel**. `init(lowerChannel, upperChannel)` seeds Part 1 and Part 2; the others default to channels 2-4.

The handler doesn't remember CC numbers — wire-byte translation happens in the codec. Stored values are user-domain (e.g. `chorus_switch=1` is stored as `1`, not as the wire byte `0x7F`).

## Roland DT1 / RQ1 protocol

Roland's parameter sysex protocol is the third significant complication on JUNO-X:

- **DT1 (Data Set 1, command `0x12`)**: write-only. Sets one or more bytes at a given address. Used for scene-global params (chorus, delay, reverb, drive) and RD-Piano sympathetic-resonance settings.
- **RQ1 (Data Request 1, command `0x11`)**: request-only. Asks the device to send back N bytes starting at a given address. The device responds with a DT1 carrying the requested data. Used by `get_current_state` for the live read-back.

Both sysex frames share a header: `F0 41 <devID> <modelID..> <cmd> <addr..> <data..> <chk> F7`. The model ID is `00 00 00 00 12` (5 bytes). Addresses are 4 bytes; `SCENE_BASE` is `01 00 00 00`. Per-part offsets (`SCENE_PART_OFFSETS`) shift `address[1]` from `0x10` to `0x14` for parts 1-5.

Helpers live in `shared/roland-dt1.ts` (`buildDT1`, `parseDT1`, `buildRQ1`, `parseRQ1`, `requestRolandValue`, `addAddresses`, `packNibbles`, `unpackNibbles`). The codec wraps these with param-domain entry points.

### get_current_state via RQ1

`JunoXDevice.getState(section?)`:

1. Filter the parameter map to params with a `sysexAddress` in the requested sections (default: all four scene-effect sections).
2. Fan out one `requestRolandValue(...)` per param in parallel. Per-param timeouts surface in the rendered text but don't fail the whole call.
3. For each reply, synthesize a DT1 and feed it through `codec.decode` to recover the user-domain value.
4. Render grouped by section.

The RQ1 round-trip orchestration (send + await reply with timeout) lives in `requestRolandValue`. The codec is responsible for decoding the reply.

### Engine-handled RQ1 (mock side)

When the JUNO-X mock receives an RQ1, the **mock-runner engine** (not the handler) fulfills it:

```
codec.parseRequest(msg) → request descriptor
codec.paramsAtAddress(addr, size) → list of (engine, paramKey) at the requested address range
handler.get_params(names) → user-domain values
codec.encodeBytes(name, value, part) → wire bytes per param
codec.buildResponse(req, data) → DT1
emit on virtual MIDI Out
```

The handler never sees the RQ1 message — it just answers `get_params` from its name-keyed state.

## Param-map design

`JunoXParameterMap` is the JUNO-X-specific extension of the generic `ParameterMap`. Two access modes:

- **Per-engine** (`getParamsForEngine`, `findParamInEngine`, `getParamsByCC`): the source of truth for routing and codec decoding. CC reverse-lookup returns *every* (engine, key) match.
- **Flat best-effort** (`params`, `findParam`, `getParamByCC`): a last-wins merged view exposed for tooling that doesn't drive routing (`list_parameters`, generic devices).

Keys are written without engine prefixes (`cutoff`, `lfo_rate`, not `as_cutoff` / `jx_cutoff`). The same physical knob's variant in each engine uses the same key; engine-specific metadata (range, displayName, encoding) lives on each engine's own KeyboardParameter entry.

Scene-global params (chorus_*, delay_*, reverb_*, drive_*) live in `scene-params.ts` and are exposed as `paramMap.globalParams`. They're engine-agnostic.

## Codec → handler routing for incoming MIDI

External MIDI on the mock's virtual MIDI In flows:

```
   raw MIDI bytes
        ↓
   codec.decode(message)
        ↓
   DecodedEvent[]
   - kind: "param", name, value, part?, engine?
   - kind: "request"  (Roland RQ1 — engine handles)
   - kind: "loadProgram", "unknown"
        ↓
   engine.applySetEvents
        ↓
   handler.set_params([{name, value, part, engine?}])
        ↓
   handler.resolveTarget → engine namespace, key
        ↓
   parts[i].engineParams[engine][key] = userValue
```

For an **ambiguous CC** (CC 3 maps to 3 engine variants), the codec emits one event per matching engine. The handler's `resolveTarget` keeps only the one matching the active engine on the targeted part — real-HW routing.

For an **unambiguous DT1** (sysex address resolves to a unique engine + key), the codec emits a single event with `engine` set; handler routes to that engine's namespace.

Bank-select MSB/LSB CC sequences are accumulated in the **engine** layer (per channel) and finalized as `handler.load_program(bank, slot)` on the matching Program Change.

## Stage progression (#30)

The current architecture landed across 5 stages:

| Stage | What landed |
|-------|-------------|
| 1 | Introduced `MidiCodec`, JUNO-X impl, MCP `setParameters`/`getState` delegate |
| 2 | Mock `handleSysEx`/`handleCC` delegate to codec |
| 3 | Handler API: `set_params`/`get_params`; UI WS protocol switched to `setParam` |
| 4 | Engine handles RQ1 + UI emission via codec; dropped `MockHandlerResult.{ccOut, sysexOut, programOut}` |
| 5 | Per-engine state, generic param keys, codec emits per-engine candidates, handler is pure param-domain |

The completed plans live in `docs/plans/completed/30-midi-codec-architecture.md` and `docs/plans/completed/30-stage5-pure-handler.md`.

## Known gaps / follow-ups

Tracked in `docs/plans/pending/todo-list.md`:

- **#11 Full JUNO chorus mode sub-parameters** — chorus_mode (Mode I/II/I+II/etc.) isn't wired through to a sysex address yet.
- **#12 ZCore / JUNO-X Model / RD Piano UI panels** — placeholder panels; only Analog Synth has real controls.
- **#13 Scene/tone bank browsing**, **#14 Analog sub-model**, **#15 Backup parsing** — not implemented.
- **#26 Per-part RQ1 routing** in the mock — `get_current_state` only reads scene-effect sections today.
- **#27 Per-part `get_current_state`** scope — blocked on #26.
- **#28 Chorus type UI ↔ state propagation bug**.
- **#31 Part selector bug** — clicking a part button updates the UI active class but doesn't re-render from the cached state.
