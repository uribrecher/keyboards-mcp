import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerDisconnect(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "disconnect_from_keyboard",
    {
      description: "Disconnect a connected MIDI device. " +
        "If multiple devices are connected, pass `device` (1-based index from is_connected). " +
        "If only one device is connected, the index can be omitted.",
      inputSchema: {
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("1-based device index from is_connected. Required when more than one device is connected."),
      },
    },
    async ({ device }) => {
      let entry;
      try {
        entry = pool.resolve(device);
      } catch (err) {
        if (pool.size() === 0) {
          return {
            content: [{ type: "text", text: "No device was connected" }],
          };
        }
        return {
          content: [{ type: "text", text: (err as Error).message }],
          isError: true,
        };
      }

      const { index, device: kdev } = entry;
      const modelName = kdev.model.info.displayName;
      const labelStr = kdev.label ? ` "${kdev.label}"` : "";
      pool.disconnect(index);

      return {
        content: [
          {
            type: "text",
            text: `Disconnected device ${index}: ${modelName}${labelStr}`,
          },
        ],
      };
    },
  );
}
