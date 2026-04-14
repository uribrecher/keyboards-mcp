import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MidiManager } from "./midi/midi-manager.js";
import { ModelHolder } from "./shared/model-holder.js";
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
import { registerLoadSong } from "./tools/load-song.js";
import { registerSystemPrompt } from "./tools/system-prompt.js";

const server = new McpServer({
  name: "keyboards-mcp",
  version: "2.0.0",
});

const midiManager = new MidiManager();
const holder = new ModelHolder();

// Register all tools — they self-guard via holder.requireModel()
registerListDevices(server, midiManager);
registerConnect(server, midiManager, holder);
registerSetParameters(server, midiManager, holder);
registerApplyPatch(server, midiManager, holder);
registerGetState(server, holder);
registerListParameters(server, holder);
registerListPresets(server, holder);
registerIsConnected(server, midiManager, holder);
registerLoadProgram(server, midiManager, holder);
registerLoadSong(server, midiManager, holder);
registerExtractBackup(server, holder);
registerGetLastBackupLocation(server, holder);
registerSystemPrompt(server, holder);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
