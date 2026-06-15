# Privacy Policy — keyboards-mcp

keyboards-mcp is a local MCP server that runs on your own machine. In normal
operation it communicates only with:

- your MIDI hardware (over USB / CoreMIDI), and
- a local MIDI Connections Broker daemon on the same machine (over a Unix
  domain socket).

It performs **no analytics, telemetry, tracking, or automatic "phone-home"**,
and it does not collect, store, or share personal data. Any data it reads —
keyboard parameters, programs, set lists, backups — stays on your machine
unless you explicitly enable one of the optional networked modes below.

## Optional networked modes (off by default)

- **WebSocket transport (`MOCK_WS_URL`).** If you set the `MOCK_WS_URL`
  environment variable, `connect_to_keyboard` connects to the WebSocket URL you
  provide instead of local MIDI (used for hardware-less / CI testing). The
  server only contacts the URL you configure.
- **`web_search` tool.** The package source includes an optional `web_search`
  tool that queries DuckDuckGo over HTTPS. It is **not registered or enabled**
  in the published server and runs only if a developer explicitly wires it in.

No data is sent to the author or any third party in any mode.

## Related UI assets (not the MCP server)

The project's separate developer "Mock Runner" UI and its documentation website
(under `docs/`) load web fonts from Google Fonts. Neither is part of the MCP
server you install from npm.

_Last updated: 2026-06-15_
