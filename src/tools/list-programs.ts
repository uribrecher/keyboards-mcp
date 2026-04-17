import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerListPrograms(server: McpServer, holder: ModelHolder): void {
  server.registerTool(
    "list_programs",
    {
      description: "List stored programs from the device's backup inventory. " +
        "Requires a backup to have been extracted first via extract_backup.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Optional name filter (case-insensitive substring match)"),
      },
    },
    async ({ filter }) => {
      let device;
      try { device = holder.requireDevice(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return device.listPrograms(filter);
    },
  );
}
