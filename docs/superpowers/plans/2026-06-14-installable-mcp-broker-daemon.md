# Installable keyboards-mcp + launchd Broker Daemon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `keyboards-mcp` installable in a few copy-paste steps — `npm i -g keyboards-mcp`, `keyboards-mcp install` (which registers MCB as a macOS launchd daemon), paste a canonical config — with the broker never run by hand.

**Architecture:** Add a single `bin` CLI (`dist/cli/index.js`) that, with no args, starts today's MCP stdio server, and with subcommands installs/uninstalls/diagnoses a launchd LaunchAgent that runs the existing MCB broker (`keyboards-mcp broker`). Trim the published tarball so the Electron Mock Runner and its heavy deps leave the package. Spec: `docs/superpowers/specs/2026-06-14-installable-mcp-broker-daemon-design.md`.

**Tech Stack:** TypeScript 5.5 (ESM, Node16 module), Node 20+, `node:test` + `node:assert` (zero test deps), `tsx`, launchd (`launchctl`), npm `bin`/`files`/`engines`.

---

## Pre-flight (already done — do not redo)

- Work happens in the worktree `.claude/worktrees/package-keyboards-mcp` on branch `worktree-package-keyboards-mcp`, branched fresh from `origin/main`.
- The design spec is committed there.

## File Structure

**New source files**
- `src/server.ts` — `runServer()`: builds the MCP server, wires all tools, connects stdio. (Extracted verbatim from today's `src/index.ts`.)
- `src/cli/index.ts` — the `bin` entry (shebang). A thin shim: `import { main } from "./main.js"; await main();`. Never imported by tests.
- `src/cli/main.ts` — `resolveCommand(argv)` (pure) + `main()` dispatcher + usage text + macOS guard.
- `src/cli/plist.ts` — daemon label + path helpers + `renderLaunchAgentPlist()` (pure).
- `src/cli/doctor.ts` — `classifyBrokerState()` (pure) + `runDoctor()` + `printConfigSnippet` lives in install.ts.
- `src/cli/install.ts` — `installDaemon()` / `uninstallDaemon()` (injectable `launchctl` runner + health-wait) + `printConfigSnippet()`.

**Modified source files**
- `src/index.ts` — becomes `import { runServer } from "./server.js"; await runServer();` (preserves `dist/index.js` as an entry).
- `src/tools/connect.ts` — replace the `(npm run mcb)` guidance in the tool description.
- `src/shared/mcb-client.ts` — replace the `Is MCB running? (npm run mcb)` text in the `mcb-unreachable` error.
- `package.json` — add `bin`, `files`, `engines`; bump `version`; move mock-only deps to `devDependencies`; remove the consumer-facing `postinstall`; add `prepublishOnly`.
- `README.md` — replace the broker/config sections with a 3-step Quick Start.

**New test files**
- `tests/unit/cli/plist.test.ts`
- `tests/unit/cli/doctor.test.ts`
- `tests/unit/cli/dispatch.test.ts`
- `tests/integration/cli-install.test.ts`

---

## Task 1: Extract `runServer()` so the CLI can start the server cleanly

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts` (full replace)

This is a mechanical refactor guarded by the existing test suite (no new unit test — the e2e:mcb suite in Task 9 exercises a real server launch).

- [ ] **Step 1: Create `src/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initMidiBackend } from "./midi/midi-manager.js";
import { DevicePool } from "./shared/device-pool.js";
import { setOnSessionLost, setOnDeviceLost } from "./shared/mcb-client.js";
import { registerListDevices } from "./tools/list-devices.js";
import { registerConnect } from "./tools/connect.js";
import { registerDisconnect } from "./tools/disconnect.js";
import { registerSetParameters } from "./tools/set-parameters.js";
import { registerGetState } from "./tools/get-state.js";
import { registerListParameters } from "./tools/list-parameters.js";
import { registerListPrograms } from "./tools/list-programs.js";
import { registerListSongs } from "./tools/list-songs.js";
import { registerExtractBackup } from "./tools/extract-backup.js";
import { registerGetLastBackupLocation } from "./tools/get-last-backup-location.js";
import { registerIsConnected } from "./tools/is-connected.js";
import { registerLoadProgram } from "./tools/load-program.js";
import { registerLoadSong } from "./tools/load-song.js";
import { registerSystemPrompt } from "./tools/system-prompt.js";
import { registerGetHealth } from "./tools/get-health.js";

/** Build the MCP server, wire all tools, and connect it over stdio. */
export async function runServer(): Promise<void> {
  await initMidiBackend();

  const server = new McpServer({
    name: "keyboards-mcp",
    version: "2.0.0",
  });

  const pool = new DevicePool();

  // MCB owns sessions and leases; the pool is a local cache. When MCB drops the
  // session, the cache must follow — disconnectAll() closes every device's MIDI
  // + WS handles before the next claim mints a fresh session.
  setOnSessionLost(() => pool.disconnectAll());

  // Per-device variant: when MCB reports a single lease is gone (because the
  // bound mock instance closed), drop just that pool entry. The user reconnects
  // manually — we don't auto-reclaim.
  setOnDeviceLost((deviceId) => pool.disconnectByDeviceId(deviceId));

  registerListDevices(server, pool);
  registerConnect(server, pool);
  registerDisconnect(server, pool);
  registerSetParameters(server, pool);
  registerGetState(server, pool);
  registerListParameters(server, pool);
  registerListPrograms(server, pool);
  registerListSongs(server, pool);
  registerIsConnected(server, pool);
  registerLoadProgram(server, pool);
  registerLoadSong(server, pool);
  registerExtractBackup(server, pool);
  registerGetLastBackupLocation(server, pool);
  registerSystemPrompt(server, pool);
  registerGetHealth(server, pool);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: Replace `src/index.ts` with a thin caller**

```ts
import { runServer } from "./server.js";

await runServer();
```

- [ ] **Step 3: Build to verify the refactor compiles**

Run: `npm run build`
Expected: exits 0, emits `dist/server.js` and `dist/index.js`.

- [ ] **Step 4: Run the unit suite (must stay green)**

Run: `npm run test:unit`
Expected: all pass (no behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/index.ts
git commit -S -m "refactor: extract runServer() into src/server.ts (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `src/cli/plist.ts` — paths + plist renderer (pure, TDD)

**Files:**
- Create: `src/cli/plist.ts`
- Test: `tests/unit/cli/plist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cli/plist.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  DAEMON_LABEL,
  plistPath,
  launchAgentDir,
  brokerLogPath,
  renderLaunchAgentPlist,
} from "../../../src/cli/plist.js";

describe("plist paths", () => {
  it("plistPath is <home>/Library/LaunchAgents/<label>.plist", () => {
    assert.equal(
      plistPath("/Users/test"),
      `/Users/test/Library/LaunchAgents/${DAEMON_LABEL}.plist`,
    );
  });

  it("launchAgentDir is <home>/Library/LaunchAgents", () => {
    assert.equal(launchAgentDir("/Users/test"), "/Users/test/Library/LaunchAgents");
  });

  it("brokerLogPath is <home>/.mcb/mcb.log", () => {
    assert.equal(brokerLogPath("/Users/test"), "/Users/test/.mcb/mcb.log");
  });
});

describe("renderLaunchAgentPlist", () => {
  const xml = renderLaunchAgentPlist({
    nodePath: "/usr/local/bin/node",
    cliPath: "/usr/local/lib/node_modules/keyboards-mcp/dist/cli/index.js",
    logPath: "/Users/test/.mcb/mcb.log",
  });

  it("uses the daemon label", () => {
    assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>${DAEMON_LABEL}</string>`));
  });

  it("invokes node, then the cli, then the broker subcommand", () => {
    const i = xml.indexOf("/usr/local/bin/node");
    const j = xml.indexOf("dist/cli/index.js");
    const k = xml.indexOf("<string>broker</string>");
    assert.ok(i > -1 && j > i && k > j, "expected node → cli → broker ordering");
  });

  it("sets RunAtLoad and KeepAlive true", () => {
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("routes stdout and stderr to the log path", () => {
    assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/test\/\.mcb\/mcb\.log<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/test\/\.mcb\/mcb\.log<\/string>/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test tests/unit/cli/plist.test.ts`
Expected: FAIL — cannot find module `../../../src/cli/plist.js`.

- [ ] **Step 3: Implement `src/cli/plist.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

/** launchd label for the MIDI Connections Broker daemon. */
export const DAEMON_LABEL = "com.uribrecher.midi-connections-broker";

export function launchAgentDir(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents");
}

export function plistPath(home: string = homedir()): string {
  return join(launchAgentDir(home), `${DAEMON_LABEL}.plist`);
}

/** Where the daemon's stdout/stderr are written. */
export function brokerLogPath(home: string = homedir()): string {
  return join(home, ".mcb", "mcb.log");
}

export interface PlistOptions {
  /** Absolute path to the node binary (process.execPath). */
  nodePath: string;
  /** Absolute path to the installed dist/cli/index.js. */
  cliPath: string;
  /** Absolute path for stdout + stderr. */
  logPath: string;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the launchd LaunchAgent plist that runs `<node> <cli> broker` at
 * login, keeps it alive across crashes, and logs to logPath.
 */
export function renderLaunchAgentPlist(opts: PlistOptions): string {
  const args = [opts.nodePath, opts.cliPath, "broker"];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx --test tests/unit/cli/plist.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add src/cli/plist.ts tests/unit/cli/plist.test.ts
git commit -S -m "feat(cli): LaunchAgent plist renderer + path helpers (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `src/cli/doctor.ts` — broker-state classifier (TDD)

**Files:**
- Create: `src/cli/doctor.ts`
- Test: `tests/unit/cli/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cli/doctor.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBrokerState, runDoctor } from "../../../src/cli/doctor.js";
import { plistPath, launchAgentDir } from "../../../src/cli/plist.js";

const HEALTHY = { ok: true, uptimeSec: 1, sessionsActive: 0, devicesConnected: 0 };

describe("classifyBrokerState", () => {
  it("healthy when the broker answers ok (even with no plist)", () => {
    assert.equal(classifyBrokerState({ plistExists: false, health: HEALTHY }), "healthy");
  });
  it("loaded-but-unreachable when a plist exists but health is null", () => {
    assert.equal(classifyBrokerState({ plistExists: true, health: null }), "loaded-but-unreachable");
  });
  it("not-installed when there's no plist and no health", () => {
    assert.equal(classifyBrokerState({ plistExists: false, health: null }), "not-installed");
  });
});

describe("runDoctor", () => {
  it("returns not-installed for a fresh home with an unreachable broker", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-doc-"));
    const state = await runDoctor({ home, fetchHealth: async () => null, log: () => {} });
    assert.equal(state, "not-installed");
  });

  it("returns loaded-but-unreachable when the plist exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-doc-"));
    mkdirSync(launchAgentDir(home), { recursive: true });
    writeFileSync(plistPath(home), "<plist/>");
    const state = await runDoctor({ home, fetchHealth: async () => null, log: () => {} });
    assert.equal(state, "loaded-but-unreachable");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test tests/unit/cli/doctor.test.ts`
Expected: FAIL — cannot find module `../../../src/cli/doctor.js`.

- [ ] **Step 3: Implement `src/cli/doctor.ts`**

```ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { getMcbHealth, type McbHealth } from "../shared/mcb-client.js";
import { plistPath } from "./plist.js";

export type BrokerState = "not-installed" | "loaded-but-unreachable" | "healthy";

/**
 * Classify broker state from a snapshot. A reachable healthy broker is
 * "healthy" regardless of the plist (it may be run by hand); otherwise an
 * installed plist means it's loaded-but-unreachable; with no plist it's
 * not-installed.
 */
export function classifyBrokerState(input: {
  plistExists: boolean;
  health: McbHealth | null;
}): BrokerState {
  if (input.health?.ok) return "healthy";
  if (input.plistExists) return "loaded-but-unreachable";
  return "not-installed";
}

const REMEDIATION: Record<BrokerState, string> = {
  "healthy": "Broker daemon is running. You're good to go.",
  "loaded-but-unreachable":
    "The daemon is installed but not answering. Check the log at ~/.mcb/mcb.log, " +
    "then reinstall with `keyboards-mcp install`.",
  "not-installed":
    "The broker daemon is not installed. Run `keyboards-mcp install`.",
};

export interface DoctorDeps {
  home?: string;
  fetchHealth?: () => Promise<McbHealth | null>;
  log?: (msg: string) => void;
}

/** Gather broker state and print remediation. Returns the classified state. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<BrokerState> {
  const home = deps.home ?? homedir();
  const fetchHealth = deps.fetchHealth ?? getMcbHealth;
  const log = deps.log ?? console.log;

  const plistExists = existsSync(plistPath(home));
  const health = await fetchHealth();
  const state = classifyBrokerState({ plistExists, health });

  log(`Broker state: ${state}`);
  log(REMEDIATION[state]);
  return state;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx --test tests/unit/cli/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts tests/unit/cli/doctor.test.ts
git commit -S -m "feat(cli): broker doctor + state classifier (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `src/cli/install.ts` — install/uninstall the LaunchAgent (TDD)

**Files:**
- Create: `src/cli/install.ts`
- Test: `tests/integration/cli-install.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/cli-install.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDaemon, uninstallDaemon, type Runner } from "../../src/cli/install.js";
import { plistPath, DAEMON_LABEL } from "../../src/cli/plist.js";

function recordingRunner(): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => { calls.push([cmd, ...args]); };
  return { runner, calls };
}

describe("installDaemon", () => {
  it("writes the plist and loads it via launchctl (bootout → bootstrap → kickstart)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-inst-"));
    const { runner, calls } = recordingRunner();

    const healthy = await installDaemon({
      home,
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/kbmcp/dist/cli/index.js",
      runner,
      waitForHealth: async () => true,
      log: () => {},
    });

    assert.equal(healthy, true);
    const plist = plistPath(home);
    assert.ok(existsSync(plist), "plist written");
    const xml = readFileSync(plist, "utf8");
    assert.match(xml, /<string>broker<\/string>/);
    assert.match(xml, new RegExp(DAEMON_LABEL));

    const verbs = calls.map((c) => c[1]); // each call is ["launchctl", <verb>, ...]
    assert.deepEqual(verbs, ["bootout", "bootstrap", "kickstart"]);
  });
});

describe("uninstallDaemon", () => {
  it("removes the plist and is idempotent when already gone", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-uninst-"));
    const { runner } = recordingRunner();

    await installDaemon({
      home, nodePath: "/n", cliPath: "/c", runner,
      waitForHealth: async () => true, log: () => {},
    });
    assert.ok(existsSync(plistPath(home)));

    await uninstallDaemon({ home, runner, log: () => {} });
    assert.equal(existsSync(plistPath(home)), false, "plist removed");

    // second uninstall must not throw
    await uninstallDaemon({ home, runner, log: () => {} });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test tests/integration/cli-install.test.ts`
Expected: FAIL — cannot find module `../../src/cli/install.js`.

- [ ] **Step 3: Implement `src/cli/install.ts`**

```ts
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { homedir, userInfo } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMcbHealth } from "../shared/mcb-client.js";
import {
  DAEMON_LABEL,
  launchAgentDir,
  plistPath,
  brokerLogPath,
  renderLaunchAgentPlist,
} from "./plist.js";

const execFileAsync = promisify(execFile);

/** Runs a command; rejects on non-zero exit. Injected for tests. */
export type Runner = (cmd: string, args: string[]) => Promise<void>;

const realRunner: Runner = async (cmd, args) => {
  await execFileAsync(cmd, args);
};

/** Default: poll the broker's health until it answers or we give up. */
async function defaultWaitForHealth(attempts = 20, delayMs = 250): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const h = await getMcbHealth();
    if (h?.ok) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

export interface InstallDeps {
  home?: string;
  nodePath?: string;
  cliPath?: string;
  runner?: Runner;
  waitForHealth?: () => Promise<boolean>;
  log?: (msg: string) => void;
}

/**
 * Write + load the LaunchAgent so launchd runs the broker now and at every
 * login. Idempotent: an existing agent is booted out first, then re-bootstrapped.
 * Returns true if the broker answered a health check after loading.
 */
export async function installDaemon(deps: InstallDeps = {}): Promise<boolean> {
  const home = deps.home ?? homedir();
  const nodePath = deps.nodePath ?? process.execPath;
  const cliPath = deps.cliPath ?? realpathSync(process.argv[1]);
  const runner = deps.runner ?? realRunner;
  const waitForHealth = deps.waitForHealth ?? defaultWaitForHealth;
  const log = deps.log ?? console.log;

  const target = `gui/${uid()}`;
  const label = `${target}/${DAEMON_LABEL}`;
  const plist = plistPath(home);
  const logPath = brokerLogPath(home);

  // Best-effort unload of any prior instance so bootstrap doesn't collide.
  try { await runner("launchctl", ["bootout", label]); } catch { /* not loaded */ }

  mkdirSync(launchAgentDir(home), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(plist, renderLaunchAgentPlist({ nodePath, cliPath, logPath }));

  await runner("launchctl", ["bootstrap", target, plist]);
  // -k restarts if already running, so the freshly-written plist is the live one.
  await runner("launchctl", ["kickstart", "-k", label]);

  const healthy = await waitForHealth();
  if (healthy) {
    log("✓ MIDI Connections Broker daemon installed and running.");
  } else {
    log("⚠ Daemon installed, but it has not answered a health check yet. " +
        "Run `keyboards-mcp doctor` in a moment, or check ~/.mcb/mcb.log.");
  }
  return healthy;
}

/** Unload + remove the LaunchAgent. Idempotent. */
export async function uninstallDaemon(deps: InstallDeps = {}): Promise<void> {
  const home = deps.home ?? homedir();
  const runner = deps.runner ?? realRunner;
  const log = deps.log ?? console.log;

  const label = `gui/${uid()}/${DAEMON_LABEL}`;
  try { await runner("launchctl", ["bootout", label]); } catch { /* not loaded */ }

  const plist = plistPath(home);
  if (existsSync(plist)) rmSync(plist);
  log("✓ MIDI Connections Broker daemon uninstalled.");
}

const CONFIG_SNIPPET = `{
  "mcpServers": {
    "keyboards-mcp": {
      "command": "keyboards-mcp"
    }
  }
}`;

/** Print the MCP client config + next steps after a successful install. */
export function printConfigSnippet(log: (msg: string) => void = console.log): void {
  log("\nAdd this to your MCP client config, then restart the client:\n");
  log(CONFIG_SNIPPET);
  log("\nThen ask the agent to `list_midi_devices` and `connect_to_keyboard`.\n");
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx --test tests/integration/cli-install.test.ts`
Expected: PASS (no real `launchctl` invoked — the runner is stubbed).

- [ ] **Step 5: Commit**

```bash
git add src/cli/install.ts tests/integration/cli-install.test.ts
git commit -S -m "feat(cli): install/uninstall the broker LaunchAgent daemon (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `src/cli/main.ts` + `src/cli/index.ts` — the bin dispatcher (TDD)

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/index.ts`
- Test: `tests/unit/cli/dispatch.test.ts`

The bin is split in two so tests can import `resolveCommand` without triggering `main()` on import: `index.ts` is the shim that calls `main()`, `main.ts` holds the (importable) logic.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/cli/dispatch.test.ts
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolveCommand } from "../../../src/cli/main.js";

function argv(...rest: string[]): string[] {
  return ["node", "/path/to/cli.js", ...rest];
}

describe("resolveCommand", () => {
  it("no subcommand → server", () => assert.equal(resolveCommand(argv()), "server"));
  it("install → install", () => assert.equal(resolveCommand(argv("install")), "install"));
  it("uninstall → uninstall", () => assert.equal(resolveCommand(argv("uninstall")), "uninstall"));
  it("broker → broker", () => assert.equal(resolveCommand(argv("broker")), "broker"));
  it("doctor → doctor", () => assert.equal(resolveCommand(argv("doctor")), "doctor"));
  it("--help → help", () => assert.equal(resolveCommand(argv("--help")), "help"));
  it("bogus → unknown", () => assert.equal(resolveCommand(argv("frobnicate")), "unknown"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test tests/unit/cli/dispatch.test.ts`
Expected: FAIL — cannot find module `../../../src/cli/main.js`.

- [ ] **Step 3: Implement `src/cli/main.ts`**

```ts
import { runServer } from "../server.js";
import { installDaemon, uninstallDaemon, printConfigSnippet } from "./install.js";
import { runDoctor } from "./doctor.js";

export type Command =
  | "server" | "install" | "uninstall" | "broker" | "doctor" | "help" | "unknown";

/** Map argv (process.argv; argv[2] is the subcommand) to a command. Pure. */
export function resolveCommand(argv: string[]): Command {
  const cmd = argv[2];
  if (cmd === undefined) return "server";
  switch (cmd) {
    case "install":
    case "uninstall":
    case "broker":
    case "doctor":
      return cmd;
    case "help":
    case "-h":
    case "--help":
      return "help";
    default:
      return "unknown";
  }
}

const USAGE = `keyboards-mcp — MCP server for MIDI keyboards

Usage:
  keyboards-mcp                 Start the MCP stdio server (used by your MCP client)
  keyboards-mcp install         Install + start the broker daemon (macOS)
  keyboards-mcp uninstall       Stop + remove the broker daemon
  keyboards-mcp doctor          Report broker daemon status
  keyboards-mcp broker          Run the broker in the foreground (advanced)
  keyboards-mcp help            Show this help
`;

function requireMacOS(): boolean {
  if (process.platform === "darwin") return true;
  console.error(
    `keyboards-mcp install is only supported on macOS (launchd) right now. ` +
    `Detected platform: ${process.platform}. ` +
    `Run the broker manually with \`keyboards-mcp broker\` for now.`,
  );
  return false;
}

export async function main(): Promise<void> {
  switch (resolveCommand(process.argv)) {
    case "server":
      await runServer();
      break;
    case "broker":
      // Side-effect import: mcb/index.js starts listening and holds the loop.
      await import("../mcb/index.js");
      break;
    case "install":
      if (!requireMacOS()) { process.exitCode = 1; break; }
      await installDaemon();
      printConfigSnippet();
      break;
    case "uninstall":
      if (!requireMacOS()) { process.exitCode = 1; break; }
      await uninstallDaemon();
      break;
    case "doctor":
      await runDoctor();
      break;
    case "help":
      console.log(USAGE);
      break;
    case "unknown":
      console.error(`Unknown command: ${process.argv[2]}\n`);
      console.error(USAGE);
      process.exitCode = 1;
      break;
  }
}
```

- [ ] **Step 4: Implement `src/cli/index.ts` (the bin shim)**

```ts
#!/usr/bin/env node
import { main } from "./main.js";

await main();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test tests/unit/cli/dispatch.test.ts`
Expected: PASS (importing `main.js` does not run `main()`).

- [ ] **Step 6: Smoke-check the dev CLI for non-server commands**

Run: `npx tsx src/cli/index.ts help`
Expected: prints the usage block, exits 0.

Run: `npx tsx src/cli/index.ts frobnicate`
Expected: prints "Unknown command: frobnicate" + usage; exit code 1.

- [ ] **Step 7: Commit**

```bash
git add src/cli/main.ts src/cli/index.ts tests/unit/cli/dispatch.test.ts
git commit -S -m "feat(cli): bin dispatcher (server/install/uninstall/broker/doctor) (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `package.json` — bin, files, engines, lean deps, drop postinstall

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Apply the edits**

Make these exact changes to `package.json`:

1. Bump `version`:
```json
  "version": "2.0.0",
```

2. Add `bin` and `engines` (place after the `"main"` line):
```json
  "main": "dist/index.js",
  "bin": { "keyboards-mcp": "dist/cli/index.js" },
  "engines": { "node": ">=20" },
```

3. Add a `files` whitelist (place after `engines`):
```json
  "files": [
    "dist/index.js",
    "dist/server.js",
    "dist/cli/**",
    "dist/mcb/**",
    "dist/tools/**",
    "dist/shared/**",
    "dist/midi/**",
    "dist/keyboard_models/**",
    "README.md",
    "LICENSE"
  ],
```

4. In `scripts`: **remove** the `postinstall` line entirely, and **add** a `prepublishOnly` that builds dist before packing. The `scripts` block becomes (only the changed lines shown — keep all others as-is):
```json
    "copy:peaks-vendor": "mkdir -p src/mock-runner/shell/vendor && cp node_modules/peaks.js/dist/peaks.ext.min.js src/mock-runner/shell/vendor/peaks.min.js && cp node_modules/konva/konva.min.js src/mock-runner/shell/vendor/konva.min.js && cp node_modules/waveform-data/dist/waveform-data.min.js src/mock-runner/shell/vendor/waveform-data.min.js",
    "prebuild": "npm run copy:peaks-vendor",
    "build": "tsc",
    "prepublishOnly": "npm run build",
    "start": "node dist/index.js",
```
(`postinstall` is deleted; `prebuild` stays so local dev builds still copy the mock-UI vendor files.)

5. Move the mock-runner-only deps from `dependencies` to `devDependencies`. The `dependencies` block becomes:
```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "adm-zip": "^0.5.16",
    "easymidi": "^3.0.0",
    "ws": "^8.20.0",
    "zod": "^3.23.0"
  },
```
and `devDependencies` becomes (additions: the five moved deps, kept alphabetical-ish):
```json
  "devDependencies": {
    "@eslint/js": "^9.39.4",
    "@sounds-and-recreation/agent-client": "file:../sound-recreation-agent/client-sdk",
    "@types/adm-zip": "^0.5.8",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.18.1",
    "electron": "^41.1.1",
    "eslint": "^9.39.4",
    "konva": "^9.3.22",
    "marked": "^18.0.3",
    "openapi-typescript": "^7.13.0",
    "peaks.js": "^4.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "typescript-eslint": "^8.58.2",
    "waveform-data": "^4.5.2"
  },
```

- [ ] **Step 2: Rebuild and run the unit suite**

Run: `npm run build && npm run test:unit`
Expected: build exits 0; all unit tests pass (deps still present because dev installs include devDeps).

- [ ] **Step 3: Verify the published tarball is lean and complete**

Run: `npm pack --dry-run 2>&1 | grep -E 'dist/(cli|mcb|mock-runner|index|server)' | sort`
Expected: lists `dist/cli/...`, `dist/mcb/...`, `dist/index.js`, `dist/server.js`. **No `dist/mock-runner/...` entries.**

Run: `npm pack --dry-run 2>&1 | grep -c mock-runner`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -S -m "build: publishable global package — bin, files, lean deps, drop consumer postinstall (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Broker-aware UX strings

**Files:**
- Modify: `src/tools/connect.ts` (the tool description line)
- Modify: `src/shared/mcb-client.ts` (the `mcb-unreachable` error message)

- [ ] **Step 1: Update `src/tools/connect.ts`**

Replace this line (currently in the tool description, ending the `description:` string):
```ts
        "MCB must be running for this tool to work (npm run mcb).",
```
with:
```ts
        "The keyboards-mcp broker daemon must be running. If a connection fails with " +
        "mcb-unreachable, run 'keyboards-mcp doctor' (or 'keyboards-mcp install').",
```

- [ ] **Step 2: Update `src/shared/mcb-client.ts`**

Replace the `req.on("error", ...)` line:
```ts
    req.on("error", (err) => reject(new MCBError(0, "mcb-unreachable", `MCB unreachable at ${describeTarget(target)}: ${err.message}. Is MCB running? (npm run mcb)`)));
```
with:
```ts
    req.on("error", (err) => reject(new MCBError(0, "mcb-unreachable", `MCB unreachable at ${describeTarget(target)}: ${err.message}. Is the keyboards-mcp broker daemon running? Run 'keyboards-mcp doctor'.`)));
```

- [ ] **Step 3: Verify the old guidance is gone and the new text is present**

Run: `grep -rn "npm run mcb" src/tools/connect.ts src/shared/mcb-client.ts`
Expected: no matches (exit code 1).

Run: `grep -rn "keyboards-mcp doctor" src/tools/connect.ts src/shared/mcb-client.ts`
Expected: one match in each file.

- [ ] **Step 4: Build + unit tests**

Run: `npm run build && npm run test:unit`
Expected: build exits 0; unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/connect.ts src/shared/mcb-client.ts
git commit -S -m "feat: broker-aware connect/unreachable guidance points at keyboards-mcp doctor (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: README Quick Start

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the `## Setup` section**

Replace the entire `## Setup` section (from the `## Setup` heading down to — but **not including** — the `## Usage` heading) with:

````markdown
## Quick Start (macOS)

**Prerequisites:** macOS, Node.js 20+, and a supported keyboard connected via USB.

```bash
npm install -g keyboards-mcp     # 1. install
keyboards-mcp install            # 2. install + start the broker daemon (launchd)
```

Then add this to your MCP client config (e.g. `.mcp.json` / Claude Code settings) and restart the client:

```json
{
  "mcpServers": {
    "keyboards-mcp": {
      "command": "keyboards-mcp"
    }
  }
}
```

That's it. The **midi-connections-broker (MCB)** is now a launchd daemon that starts at login and is
kept alive automatically — you never run it by hand. Ask your agent to `connect_to_keyboard`.

- Check broker status anytime: `keyboards-mcp doctor` (logs at `~/.mcb/mcb.log`).
- Remove the daemon: `keyboards-mcp uninstall`.

> The no-hardware **Mock Runner** (a visual device simulator) is packaged separately — see the
> mock-runner packaging issue. This package targets owners of real MIDI hardware.

## Development (from source)

```bash
npm install
npm run build
npx tsx src/cli/index.ts install   # or: keyboards-mcp install after a global link
```

`keyboards-mcp broker` runs the broker in the foreground (the daemon's entry point); the headless
mock and the Electron Mock Runner remain available via `npm run mock:headless` / `npm run mock:runner`.
````

- [ ] **Step 2: Sanity-check the embedded config JSON is valid**

Run: `node -e "JSON.parse(process.argv[1])" '{ "mcpServers": { "keyboards-mcp": { "command": "keyboards-mcp" } } }'`
Expected: exits 0 (no output).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -S -m "docs(readme): 3-step global-install Quick Start + daemon notes (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: exits 0. (If lint flags the new `src/cli/**` files, fix inline — common: `no-floating-promises` is `src`-scoped, so all awaited calls must be awaited; the dispatcher already awaits.)

- [ ] **Step 2: Type-check tests**

Run: `npm run test:check`
Expected: exits 0.

- [ ] **Step 3: Unit + integration**

Run: `npm run test:unit && npm run test:integration`
Expected: all pass.

- [ ] **Step 4: Self-provisioning broker e2e (proves the runServer refactor + broker entry)**

Run: `npm run test:e2e:mcb`
Expected: all pass (these suites spawn their own MCB and connect through the MCP server).

- [ ] **Step 5: Final dev smoke of the daemon path (real launchctl — macOS only)**

Run:
```bash
npx tsx src/cli/index.ts install
keyboards-mcp doctor 2>/dev/null || npx tsx src/cli/index.ts doctor
npx tsx src/cli/index.ts uninstall
```
Expected: install reports the daemon installed (health may need a moment); `doctor` reports `healthy` or `loaded-but-unreachable`; `uninstall` removes it. (This actually touches your user launchd domain — run only on a dev mac. Skip on CI.)

- [ ] **Step 6: Commit any fixups**

```bash
git add -A
git commit -S -m "chore: verification fixups for installable package (#124)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(Skip if nothing changed.)

---

## Release (manual — user-triggered, NOT part of automated execution)

Publishing is an irreversible outward action; do **not** run these without the user's explicit go-ahead for the specific version.

- Decide the npm name: try `keyboards-mcp`; if taken, set `"name": "@uribrecher/keyboards-mcp"` and publish with `--access public`. (The `bin` name stays `keyboards-mcp` regardless, so the README snippet is unchanged.)
- `npm login`, then `npm publish` (runs `prepublishOnly` → `build`).
- Verify: `npm view keyboards-mcp version` and a clean-machine `npm i -g keyboards-mcp && keyboards-mcp install`.
- Post the approved descope comment on issue #124 (mock-runner / no-hardware path → follow-up) alongside the PR link.

---

## Self-Review

**Spec coverage:**
- Global package + `bin` → Tasks 5, 6. ✓
- `keyboards-mcp install` registers launchd LaunchAgent + verifies health + prints config → Tasks 2, 4, 5. ✓
- `uninstall` / `broker` / `doctor` → Tasks 3, 4, 5. ✓
- Lean tarball (mock-runner + heavy deps + `file:` dep out; postinstall removed) → Task 6 (verified via `npm pack --dry-run`). ✓
- Broker-aware error/UX → Task 7. ✓
- README canonical snippet + 3-step Quick Start → Task 8. ✓
- Testing strategy (pure renderers/classifiers unit-tested; install/uninstall integration against tmp HOME with injected runner; e2e:mcb regression) → Tasks 2–5, 9. ✓
- Native-dep / npm-name / pack-exclusion risks → Task 6 + Release section. ✓
- Descope of the no-hardware bullet → Release section note + spec. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✓

**Type consistency:** `Runner`, `InstallDeps`, `DoctorDeps`, `PlistOptions`, `BrokerState`, `Command` are defined once and used consistently. `renderLaunchAgentPlist`, `installDaemon`, `uninstallDaemon`, `classifyBrokerState`, `runDoctor`, `resolveCommand`, `main`, `runServer`, `printConfigSnippet` keep the same names/signatures across tasks. `getMcbHealth`/`McbHealth` match `src/shared/mcb-client.ts`. ✓
