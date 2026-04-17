import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerListSongs(server: McpServer, holder: ModelHolder): void {
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
        bank: z
          .number()
          .optional()
          .describe("Optional set list bank number to filter by"),
      },
    },
    async ({ filter, bank }) => {
      let device;
      try { device = holder.requireDevice(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return device.listSongs(filter, bank);
    },
  );
}
