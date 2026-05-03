import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerIsConnected(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "is_connected",
    {
      description: "List all connected MIDI keyboards with their indices, model names, and labels. " +
        "Use the returned indices in other tools' optional `device` parameter.",
    },
    async () => {
      const entries = pool.list();
      if (entries.length === 0) {
        return {
          content: [
            { type: "text", text: "Not connected. Call connect_to_keyboard to establish a MIDI connection." },
          ],
        };
      }

      const lines = entries.map((entry) => {
        const labelStr = entry.device.label ? ` "${entry.device.label}"` : "";
        return `  device ${entry.index}: ${entry.device.model.info.displayName}${labelStr}`;
      });

      const summary = entries.length === 1
        ? "1 device connected"
        : `${entries.length} devices connected`;

      return {
        content: [{ type: "text", text: `${summary}:\n${lines.join("\n")}` }],
      };
    },
  );
}
