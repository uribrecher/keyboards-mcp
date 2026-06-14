---
topic: installable-mcp-broker-daemon
issue: https://github.com/uribrecher/keyboards-mcp/issues/124
status: design
related:
  - ./2026-05-05-midi-connections-broker-design.md
  - ./2026-05-05-midi-connections-broker-backlog.md   # "OS service templates" backlog item
---

# Installable keyboards-mcp + auto-managed broker daemon

## Problem

Getting `keyboards-mcp` running today means: clone the repo, `npm install` + `npm run build`,
start the **MCB (midi-connections-broker)** as a separate long-running process (`npm run mcb`),
and hand-wire an MCP client config that points at a built `dist/index.js`. There is no published
package, no one-command install, and the broker prerequisite is invisible — `connect_to_keyboard`
just fails with "Is MCB running? (npm run mcb)" if MCB isn't already up.

This is the gate before listing in MCP registries/directories. A multi-step, broker-first,
build-from-source setup loses people immediately.

## Goal

A new user on macOS who owns a supported MIDI keyboard goes from zero to a working MCP connection
in a few documented, copy-paste steps, with the broker installed and managed as a real launchd
daemon (never run by hand), and a canonical client-config snippet that works verbatim.

## Scope

**In:**
- A globally-installable npm package (`npm i -g keyboards-mcp`) with a `bin` CLI.
- A `keyboards-mcp install` command that registers MCB as a macOS launchd **LaunchAgent** daemon.
- A lean published tarball (the Electron Mock Runner and its heavy deps leave the package).
- Broker-aware error/UX (`doctor`, updated failure messages).
- A canonical MCP client-config snippet in the README that works as-is.

**Target user:** owner of a supported MIDI keyboard, on macOS.

**Out (tracked as separate follow-up issues):**
- Packaging the Electron Mock Runner / the no-hardware "virtual keyboard" path. **This explicitly
  descopes the issue's "mock-device path works end-to-end with no hardware and no extra processes"
  bullet** — a note will be posted on #124.
- Linux `systemd` user unit and Windows service (the macOS LaunchAgent is the only OS target here;
  the installer fails friendly on other platforms). Linux/systemd is already in the MCB backlog.

## Decisions (settled with the issue author)

1. **Distribution:** publish to npm, installed globally (`npm i -g keyboards-mcp`). Not npx-only and
   not Docker — a launchd daemon needs a stable executable path, which npx's ephemeral cache can't
   give.
2. **Broker:** MCB is a genuine dependency installed as a real macOS daemon — *not* embedded in the
   MCP process and *not* auto-spawned ad hoc. It is delivered as a launchd LaunchAgent via an
   `install` command. The broker's existing multi-session port-leasing behavior is unchanged; it
   just becomes automatic.
3. **Package shape:** one package; the Mock Runner is excluded from the published tarball via the
   `files` whitelist and its deps move to `devDependencies`. No workspaces split now — any real
   split belongs to the separate mock-runner packaging issue.

## Architecture

### Components

| Component | Where | Role |
|-----------|-------|------|
| MCP stdio server | `src/index.ts` (today) | The MCP server the client launches per session. Unchanged in behavior. |
| **CLI dispatcher** | `src/cli.ts` → `dist/cli.js` (**new**) | The single `bin`. Dispatches subcommands; with no args, starts the MCP stdio server. |
| MCB broker | `src/mcb/index.ts` (today) | The long-running lease broker. Reached as `keyboards-mcp broker` (the daemon's entry point). |
| LaunchAgent plist | `~/Library/LaunchAgents/com.uribrecher.midi-connections-broker.plist` (**new, generated**) | launchd definition that runs `keyboards-mcp broker` at login and keeps it alive. |
| Installer | `src/cli/install.ts` (**new**) | Renders + loads/unloads the LaunchAgent; verifies health; prints config. |

### CLI surface (`keyboards-mcp <subcommand>`)

- **`keyboards-mcp`** *(no args)* — start the MCP stdio server (today's `src/index.ts`). This is what
  the client config invokes.
- **`keyboards-mcp install`** — render the LaunchAgent plist, `launchctl bootstrap` it (idempotent:
  reloads if already present), wait until MCB answers `GET /v1/health` over the socket (bounded
  retry), then print the MCP client-config snippet and next steps. On a non-macOS platform: print a
  friendly "not yet supported — see <follow-up>" message and exit non-zero.
- **`keyboards-mcp uninstall`** — `launchctl bootout` and remove the plist (idempotent).
- **`keyboards-mcp broker`** — run MCB in the foreground (thin wrapper over `src/mcb/index.ts`). This
  is the plist's `ProgramArguments` target; not normally run by hand.
- **`keyboards-mcp doctor`** — classify and print broker state: **not-installed** (no plist),
  **loaded-but-unreachable** (plist present, socket dead → point at the log), or **healthy**
  (reuses `getMcbHealth()` from `mcb-client.ts`). Prints the remediation for each state.

### LaunchAgent definition

- **Label:** `com.uribrecher.midi-connections-broker` (matches the backlog's reserved name).
- **Path:** `~/Library/LaunchAgents/com.uribrecher.midi-connections-broker.plist`.
- **ProgramArguments:** `[ <process.execPath>, <realpath of installed dist/cli.js>, "broker" ]` —
  both absolute paths resolved at install time so launchd has stable targets regardless of the npm
  global prefix.
- **RunAtLoad:** `true` (starts immediately on install and at every login).
- **KeepAlive:** `true` (launchd restarts the broker if it crashes).
- **StandardOutPath / StandardErrorPath:** `~/.mcb/mcb.log`.
- **Socket:** the broker keeps its default UDS at `~/.mcb/sock`; the MCP client defaults to the same
  path — so server and daemon align with zero extra config. MCB's existing `socket-cleanup.ts`
  (alive/stale/absent probe) handles stale sockets across restarts.
- **User-scoped LaunchAgent** (not a system LaunchDaemon) so it runs as the user and CoreMIDI access
  works.

### Data flow (after `install`)

```
login / install ──> launchd ──> `keyboards-mcp broker` ──> MCB listening on ~/.mcb/sock
                                                              ▲
MCP client ──spawns──> `keyboards-mcp` (stdio server) ──connect_to_keyboard──> claimLease() ──┘
                                                              │
                                                         lease granted ──> MIDI port opens
```

The broker is already running before the first `connect_to_keyboard`, so the claim succeeds with no
manual step. The MCP server process stays stateless and per-session, exactly as today.

## Packaging changes (`package.json`)

- **Add `bin`:** `{ "keyboards-mcp": "dist/cli.js" }` (shebang `#!/usr/bin/env node`, `chmod +x` via
  build or `files`).
- **Add `engines`:** `{ "node": ">=20" }`.
- **Add `files`:** whitelist `dist/index.js`, `dist/cli.js`, `dist/cli/**`, `dist/mcb/**`,
  `dist/tools/**`, `dist/shared/**`, `dist/midi/**`, `dist/keyboard_models/**` (plus `README.md`,
  `LICENSE`). Excludes `dist/mock-runner/**` and `dist/audio-analysis-client/**` (Mock-Runner-only).
- **Move to `devDependencies`** (Mock-Runner-only, confirmed not imported by server/broker):
  `electron`, `peaks.js`, `konva`, `waveform-data`, the `file:` `@sounds-and-recreation/agent-client`
  blocker, and `marked` if it is mock-only (verify at implementation time).
- **Keep runtime `dependencies`:** `@modelcontextprotocol/sdk`, `easymidi`, `adm-zip`, `ws`, `zod`.
- **Remove the consumer-facing `postinstall: copy:peaks-vendor`** — it would run on consumers'
  machines and fail once peaks.js is no longer a dependency. The vendor copy moves into a
  Mock-Runner/dev-only script (e.g. keep it under `prebuild`/`mock:*` paths so local dev still
  works; it must not run on `npm i -g`).
- **Bump `version`** (e.g. `2.0.0`, matching the MCP server's declared version) and ensure the
  package name is publishable: prefer `keyboards-mcp` if available, else `@uribrecher/keyboards-mcp`
  (scoped, `--access public`). The `bin` name stays `keyboards-mcp` either way, so the config
  snippet and CLI UX are identical. **Availability checked at implementation time.**

The Mock Runner keeps building in-repo for local dev (its deps remain present as devDeps); only the
**published tarball** excludes it. Verified via `npm pack --dry-run` contents during implementation.

## Error handling / UX

- Update `connect_to_keyboard`'s description and failure text (`src/tools/connect.ts`) and the
  `mcb-unreachable` message (`src/shared/mcb-client.ts`): replace "Is MCB running? (npm run mcb)"
  with guidance pointing at `keyboards-mcp doctor` and reinstall, since the broker is now expected
  to be a running daemon.
- `install` does not report success until MCB answers `/v1/health`, so the user gets a real
  confirmation rather than a fire-and-forget.
- `doctor` gives the agent and the user a one-command way to self-diagnose a dead/un-installed
  broker.
- The existing `get_health` MCP tool continues to surface broker reachability to the agent at
  runtime.

## README changes

Replace the "Run the connections broker" + manual-config sections with a 3-step Quick Start:

1. `npm i -g keyboards-mcp`
2. `keyboards-mcp install`
3. Paste the printed config into your MCP client and restart it:
   ```json
   { "mcpServers": { "keyboards-mcp": { "command": "keyboards-mcp" } } }
   ```

Plus: prerequisites (macOS, Node 20+, a supported keyboard connected via USB), a one-liner on what
the daemon is and how to inspect it (`keyboards-mcp doctor`, `~/.mcb/mcb.log`), `uninstall`, and a
link to the mock-runner / no-hardware follow-up issue.

## Testing strategy

- **Unit**
  - CLI argument dispatch: each subcommand routes to the right handler; unknown subcommand →
    non-zero + usage.
  - Pure `renderPlist({ nodePath, cliPath, logPath, label, socketPath })` → correct label,
    `ProgramArguments`, `RunAtLoad`/`KeepAlive`, log paths. No filesystem.
  - Pure `classifyBrokerState(probe)` for `doctor`: maps {plist exists?, health reachable?} →
    not-installed / loaded-but-unreachable / healthy.
- **Integration**
  - `install` / `uninstall` against a temp `HOME` and temp socket: assert the plist is written/removed
    with the right contents. The real `launchctl` + health-wait are gated behind an env flag
    (e.g. `KBMCP_INSTALL_REAL=1`) so CI hosts without launchd exercise the file logic and stub the load.
- **Regression**
  - Existing self-provisioning MCB e2e suites (`tests/e2e/mcb/*`, which spawn their own MCB) are
    unaffected.
  - `npm run build` + the full `node:test` suite stay green after the dependency reshuffle (devDeps
    remain installed in dev, so Mock-Runner tests still run).
- **Manual acceptance** (recorded in the plan, run on a clean machine):
  `npm i -g keyboards-mcp` → `keyboards-mcp install` → paste config → restart client →
  `connect_to_keyboard` against real hardware succeeds; reboot → broker auto-starts; `uninstall`
  removes it.

## Risks & open items

- **Native dependency:** `easymidi` → `@julusian/midi` is a native CoreMIDI binding; global install
  fetches a prebuilt or builds via node-gyp. macOS CoreMIDI is built-in. Document Node 20+ as a
  prerequisite; flag if a prebuilt isn't available for the target Node/arch.
- **npm package-name availability** — resolved at implementation time (unscoped vs scoped).
- **`npm pack` exclusion correctness** — verify the Mock Runner and the `file:` dep are absent from
  the tarball, and that nothing the server/broker needs is accidentally excluded.
- **Global-prefix path resolution** — the installer must resolve the real installed `dist/cli.js`
  path (through the bin symlink) so the plist points at the actual file, not the symlink.

## Done when (maps to issue #124)

- A new user goes from zero to a working MCP connection in ~3 documented, copy-paste steps, no source
  build. ✅ (`npm i -g` → `install` → paste config)
- MCB is started/managed automatically as a launchd daemon; never run by hand. ✅
- A canonical MCP client-config snippet lives in the README and works verbatim. ✅
- Installable via a standard one-liner and versioned. ✅ (`npm i -g keyboards-mcp`)
- ~~Mock-device path works with no hardware / no extra processes~~ → **descoped to a separate
  follow-up issue** (per the issue author; this package targets hardware owners).
