# sounds-and-recreation-app

## 0.2.0

### Minor Changes

- [#159](https://github.com/uribrecher/keyboards-mcp/pull/159) [`94114c7`](https://github.com/uribrecher/keyboards-mcp/commit/94114c7891dfc8564db91b2a7c306732a561305e) Thanks [@uribrecher](https://github.com/uribrecher)! - WS-mode SysEx receive: a second WebSocket "out lane" for outgoing-from-mock MIDI ([#109](https://github.com/uribrecher/keyboards-mcp/issues/109)).

  In CI/Docker WS mode (no real MIDI), the mock now stands up a dedicated, broadcast-only WS server for outgoing SysEx, and `WsMidiConnection` listens on it — giving WS-only transport the RQ1→DT1 receive path that previously existed only over real MIDI. The mock also dispatches inbound raw MIDI (`cc`/`program`/`sysex`) arriving over WS, so `get_current_state` works end-to-end in WS mode.

  External MIDI input is still never echoed back out (only an RQ1 emits its DT1 response), and the out lane is receive-only on the MCP side — so the new lane cannot form a MIDI feedback loop. `wsOutPort` is surfaced through the mock registry and the MCB manifest (`primary.wsOutPort`); `connect_to_keyboard` plumbs it via `MOCK_WS_OUT_URL` (or derives it from the registry). The headless mock (`cli.ts`) gains a `--ws-out-port` flag.

### Patch Changes

- Updated dependencies [[`94114c7`](https://github.com/uribrecher/keyboards-mcp/commit/94114c7891dfc8564db91b2a7c306732a561305e)]:
  - keyboards-mcp@2.1.0

## 0.1.0

### Minor Changes

- Renamed the Electron desktop app from "Mock Runner" to **Sounds and Recreation**
  and added `npm run sar:dist` to build a standalone, unsigned `Sounds and Recreation.app`
  (UI facade + in-process mock keyboards). The renderer's import-map dependencies
  (`marked`, `@sounds-and-recreation/agent-client`) are vendored into `shell/vendor/`
  so the packaged app launches and is fully interactive. Internal mock/`.mockrack`
  formats unchanged. (#126, #131, #132)
