---
"keyboards-mcp": minor
"sounds-and-recreation-app": minor
---

WS-mode SysEx receive: a second WebSocket "out lane" for outgoing-from-mock MIDI (#109).

In CI/Docker WS mode (no real MIDI), the mock now stands up a dedicated, broadcast-only WS server for outgoing SysEx, and `WsMidiConnection` listens on it — giving WS-only transport the RQ1→DT1 receive path that previously existed only over real MIDI. The mock also dispatches inbound raw MIDI (`cc`/`program`/`sysex`) arriving over WS, so `get_current_state` works end-to-end in WS mode.

External MIDI input is still never echoed back out (only an RQ1 emits its DT1 response), and the out lane is receive-only on the MCP side — so the new lane cannot form a MIDI feedback loop. `wsOutPort` is surfaced through the mock registry and the MCB manifest (`primary.wsOutPort`); `connect_to_keyboard` plumbs it via `MOCK_WS_OUT_URL` (or derives it from the registry). The headless mock (`cli.ts`) gains a `--ws-out-port` flag.
