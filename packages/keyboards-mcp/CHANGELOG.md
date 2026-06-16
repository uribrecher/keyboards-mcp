# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are published to npm automatically when a `vX.Y.Z` tag is pushed (see
[Releasing](README.md#releasing)).

## [Unreleased]

### Changed
- Renamed the Electron desktop app from "Mock Runner" to **Sounds and Recreation**
  and added `npm run sar:dist` to build a standalone, unsigned `Sounds and Recreation.app`
  (UI facade + in-process mock keyboards). The renderer's import-map dependencies
  (`marked`, `@sounds-and-recreation/agent-client`) are vendored into `shell/vendor/`
  so the packaged app launches and is fully interactive. Internal mock/`.mockrack`
  formats unchanged. (#126, #131, #132)

## [2.0.0] - 2026-06-14

First release published to npm. (Earlier `1.x` development was never published.)

### Added
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

### Changed
- The broker is no longer a manual prerequisite: `connect_to_keyboard` works against
  the already-running daemon. Connection and `mcb-unreachable` guidance now points at
  `keyboards-mcp doctor`.
- Leaner published package — the Electron Mock Runner and its heavy dependencies
  (Electron, peaks.js, konva, waveform-data) are excluded from the tarball, so an
  install pulls only the runtime dependencies.

### Removed
- The consumer-facing `postinstall` hook, which would fail on a global install.

[2.0.0]: https://www.npmjs.com/package/keyboards-mcp/v/2.0.0
