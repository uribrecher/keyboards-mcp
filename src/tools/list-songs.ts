import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerListSongs(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "list_songs",
    {
      description: "List set list songs from the device's backup inventory. " +
        "Requires a backup to have been extracted first via extract_backup.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Optional name filter (case-insensitive substring match)"),
        bank: z.coerce.number()
          .optional()
          .describe("Optional set list bank number to filter by"),
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("1-based device index from is_connected. Required when more than one device is connected."),
      },
    },
    async ({ filter, bank, device }) => {
      let kdev;
      try { kdev = pool.resolve(device).device; }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return kdev.listSongs(filter, bank);
    },
  );
}
