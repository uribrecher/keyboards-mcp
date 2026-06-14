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
