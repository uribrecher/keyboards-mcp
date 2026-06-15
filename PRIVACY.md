# Privacy Policy — keyboards-mcp

keyboards-mcp is a local MCP server that runs entirely on your own machine. It
communicates only with:

- your MIDI hardware (over USB / CoreMIDI), and
- a local MIDI Connections Broker daemon on the same machine (over a Unix
  domain socket).

It does **not** collect, store, transmit, or share any personal data. It
contains no analytics, telemetry, tracking, or "phone-home" behavior, and makes
no network connections to remote servers. Any data it reads — keyboard
parameters, programs, set lists, backups — never leaves your machine.

(The separate developer "Mock Runner" UI, which is **not** part of the published
npm package, loads web fonts from Google Fonts; the published server does not.)

_Last updated: 2026-06-15_
