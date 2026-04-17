import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerIsConnected(server: McpServer, midi: MidiManager, holder: ModelHolder): void {
  server.registerTool(
    "is_connected",
    {
      description: "Check whether the MCP server currently has an active MIDI connection to a keyboard (or mock device). " +
        "Call this before using tools that require a connection (set_parameters, load_program).",
    },
    async () => {
      const connected = midi.isConnected();
      const port = midi.getConnectedPort();
      const inputPort = midi.getConnectedInputPort();
      const forwardPort = midi.getConnectedForwardPort();
      const modelName = holder.model?.info.displayName;

      if (!connected) {
        if (port && midi.hasMockPort()) {
          if (forwardPort && !midi.isMockWsOpen()) {
            return {
              content: [
                {
                  type: "text",
                  text: `Partially connected: MIDI output to ${port} and forward to ${forwardPort}, but the WebSocket to the mock device is down (mock may have restarted). Call connect_to_keyboard to re-establish a full connection.`,
                },
              ],
            };
          }
          if (!forwardPort) {
            return {
              content: [
                {
                  type: "text",
                  text: `Partially connected: output to ${port}, but mock device is available and not forwarding. Call connect_to_keyboard to establish a full connection.`,
                },
              ],
            };
          }
        }
        return {
          content: [
            { type: "text", text: "Not connected. Call connect_to_keyboard to establish a MIDI connection." },
          ],
        };
      }

      const parts = [`Connected to: ${port}`];
      if (modelName) parts.push(`Model: ${modelName}`);
      if (inputPort) parts.push(`Input port: ${inputPort}`);
      if (forwardPort) parts.push(`Forward port: ${forwardPort}`);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    },
  );
}
