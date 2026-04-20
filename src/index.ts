import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MidiManager, initMidiBackend } from "./midi/midi-manager.js";
import { ModelHolder } from "./shared/model-holder.js";
import { registerListDevices } from "./tools/list-devices.js";
import { registerConnect } from "./tools/connect.js";
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
import { registerListSynthEngines } from "./tools/list-synth-engines.js";

await initMidiBackend();

const server = new McpServer({
  name: "keyboards-mcp",
  version: "2.0.0",
});

const midiManager = new MidiManager();
const holder = new ModelHolder();

// Register all tools — they self-guard via holder.requireDevice()
registerListDevices(server, midiManager);
registerConnect(server, midiManager, holder);
registerSetParameters(server, midiManager, holder);
registerGetState(server, holder);
registerListParameters(server, holder);
registerListPrograms(server, holder);
registerListSongs(server, holder);
registerIsConnected(server, midiManager, holder);
registerLoadProgram(server, midiManager, holder);
registerLoadSong(server, midiManager, holder);
registerExtractBackup(server, holder);
registerGetLastBackupLocation(server, holder);
registerSystemPrompt(server, holder);
registerListSynthEngines(server, holder);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
