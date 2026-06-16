# keyboards-mcp

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
