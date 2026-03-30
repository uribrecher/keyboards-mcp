import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MidiManager } from "./midi/midi-manager.js";
import { ParameterState } from "./nord/parameter-state.js";
import { getParamByCC, isPerPartParam } from "./nord/nord-electro-5d-map.js";
import { registerListDevices } from "./tools/list-devices.js";
import { registerConnect } from "./tools/connect.js";
import { registerSetParameters } from "./tools/set-parameters.js";
import { registerApplyPatch } from "./tools/apply-patch.js";
import { registerGetState } from "./tools/get-state.js";
import { registerListParameters } from "./tools/list-parameters.js";
import { registerListPresets } from "./tools/list-presets.js";
import { registerExtractBackup } from "./tools/extract-backup.js";
import { registerGetLastBackupLocation } from "./tools/get-last-backup-location.js";
import { registerIsConnected } from "./tools/is-connected.js";
import { registerLoadProgram } from "./tools/load-program.js";
import { loadBackupCache } from "./nord/backup-cache.js";

// Load cached inventory data from previous extract_backup (if available)
loadBackupCache();

const server = new McpServer({
  name: "nord-electro-5d",
  version: "1.0.0",
});

const midiManager = new MidiManager();
const paramState = new ParameterState();

// Wire up MIDI input listener to update state
midiManager.setOnCC((msg) => {
  const entry = getParamByCC(msg.controller);
  if (!entry) return;

  // Update state (all CCs come on global channel, treat as upper/global)
  paramState.set(entry.key, msg.value, isPerPartParam(entry.key) ? "upper" : undefined);
});

// Register all tools
registerListDevices(server, midiManager);
registerConnect(server, midiManager);
registerSetParameters(server, midiManager, paramState);
registerApplyPatch(server, midiManager, paramState);
registerGetState(server, paramState);
registerListParameters(server);
registerListPresets(server);
registerExtractBackup(server);
registerGetLastBackupLocation(server);
registerIsConnected(server, midiManager);
registerLoadProgram(server, midiManager);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
