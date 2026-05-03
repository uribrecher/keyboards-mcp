import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initMidiBackend } from "./midi/midi-manager.js";
import { DevicePool } from "./shared/device-pool.js";
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

await initMidiBackend();

const server = new McpServer({
  name: "keyboards-mcp",
  version: "2.0.0",
});

const pool = new DevicePool();

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

const transport = new StdioServerTransport();
await server.connect(transport);
