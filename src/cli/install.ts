import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
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
    try {
      const h = await getMcbHealth();
      if (h?.ok) return true;
    } catch {
      // A reachable-but-sick broker (5xx / parse error) must not abort the
      // install — the daemon is already loaded. Treat it as not-yet-healthy.
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

/** Resolve the installed dist/cli/index.js through the npm global-bin symlink. */
function resolveCliPath(): string {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error(
      "Cannot resolve the keyboards-mcp CLI path (process.argv[1] is empty). " +
      "Reinstall with `npm i -g keyboards-mcp`.",
    );
  }
  const resolved = realpathSync(entry);
  // launchd runs the daemon with plain `node`, which can't execute TypeScript.
  // When installing from source (npx tsx src/cli/index.ts), map the .ts entry to
  // its built dist/ JS so the LaunchAgent points at a node-runnable file.
  if (resolved.endsWith(".ts") && resolved.includes(`${sep}src${sep}`)) {
    const built = resolved
      .replace(`${sep}src${sep}`, `${sep}dist${sep}`)
      .replace(/\.ts$/, ".js");
    if (!existsSync(built)) {
      throw new Error(
        `Built CLI not found at ${built}. Run \`npm run build\` before installing from source.`,
      );
    }
    return built;
  }
  return resolved;
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
  const cliPath = deps.cliPath ?? resolveCliPath();
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
    log(`⚠ Daemon installed, but it has not answered a health check yet. ` +
        `Run \`keyboards-mcp doctor\` in a moment, or check ${logPath}.`);
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
