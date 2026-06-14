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
