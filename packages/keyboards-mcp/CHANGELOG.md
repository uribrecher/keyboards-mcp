# keyboards-mcp

## 2.1.0

### Minor Changes

- [#159](https://github.com/uribrecher/keyboards-mcp/pull/159) [`94114c7`](https://github.com/uribrecher/keyboards-mcp/commit/94114c7891dfc8564db91b2a7c306732a561305e) Thanks [@uribrecher](https://github.com/uribrecher)! - WS-mode SysEx receive: a second WebSocket "out lane" for outgoing-from-mock MIDI ([#109](https://github.com/uribrecher/keyboards-mcp/issues/109)).

  In CI/Docker WS mode (no real MIDI), the mock now stands up a dedicated, broadcast-only WS server for outgoing SysEx, and `WsMidiConnection` listens on it — giving WS-only transport the RQ1→DT1 receive path that previously existed only over real MIDI. The mock also dispatches inbound raw MIDI (`cc`/`program`/`sysex`) arriving over WS, so `get_current_state` works end-to-end in WS mode.

  External MIDI input is still never echoed back out (only an RQ1 emits its DT1 response), and the out lane is receive-only on the MCP side — so the new lane cannot form a MIDI feedback loop. `wsOutPort` is surfaced through the mock registry and the MCB manifest (`primary.wsOutPort`); `connect_to_keyboard` plumbs it via `MOCK_WS_OUT_URL` (or derives it from the registry). The headless mock (`cli.ts`) gains a `--ws-out-port` flag.

## 2.0.0

### Major Changes

First release published to npm. (Earlier `1.x` development was never published.)

**Added**

- Global install with a `keyboards-mcp` CLI: run with no arguments to start the MCP
  stdio server, plus `install`, `uninstall`, `doctor`, and `broker` subcommands.
- `keyboards-mcp install` registers the MIDI Connections Broker (MCB) as a macOS
  launchd LaunchAgent daemon (`RunAtLoad` + `KeepAlive`) — the broker now starts at
  login and is managed automatically instead of being run by hand. `keyboards-mcp
doctor` reports broker status; `keyboards-mcp uninstall` removes the daemon.
- Tag-driven release workflow that publishes to npm via OIDC trusted publishing (no
  stored token) with build provenance.
- CI `audit` job that fails the build on high/critical advisories in production
  dependencies.

**Changed**

- The broker is no longer a manual prerequisite: `connect_to_keyboard` works against
  the already-running daemon. Connection and `mcb-unreachable` guidance now points at
  `keyboards-mcp doctor`.
- Leaner published package — the Electron Mock Runner and its heavy dependencies
  (Electron, peaks.js, konva, waveform-data) are excluded from the tarball, so an
  install pulls only the runtime dependencies.

**Removed**

- The consumer-facing `postinstall` hook, which would fail on a global install.
