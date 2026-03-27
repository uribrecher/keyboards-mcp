import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MidiManager } from "./midi/midi-manager.js";
import { ParameterState } from "./nord/parameter-state.js";
import { registerListDevices } from "./tools/list-devices.js";
import { registerConnect } from "./tools/connect.js";
import { registerSetParameters } from "./tools/set-parameters.js";
import { registerApplyPatch } from "./tools/apply-patch.js";
import { registerGetState } from "./tools/get-state.js";
import { registerListParameters } from "./tools/list-parameters.js";
import { registerListPresets } from "./tools/list-presets.js";

const server = new McpServer({
  name: "nord-electro-5d",
  version: "1.0.0",
});

const midiManager = new MidiManager();
const paramState = new ParameterState();

// Register all tools
registerListDevices(server, midiManager);
registerConnect(server, midiManager);
registerSetParameters(server, midiManager, paramState);
registerApplyPatch(server, midiManager, paramState);
registerGetState(server, paramState);
registerListParameters(server);
registerListPresets(server);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
