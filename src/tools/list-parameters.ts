import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerListParameters(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "list_parameters",
    {
      description: "List all available keyboard parameters with their names, types, ranges, and descriptions. " +
        "Use this to understand what you can control on the keyboard. " +
        "Omit the section parameter to list ALL parameters across all sections.",
      inputSchema: {
        section: z
          .string()
          .optional()
          .describe("Optional section filter (e.g. organ, piano, effect1, reverb, etc.). Omit to list all parameters."),
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("1-based device index from is_connected. Required when more than one device is connected."),
      },
    },
    async ({ section, device }) => {
      let kdev;
      try { kdev = pool.resolve(device).device; }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return kdev.listParameters(section);
    },
  );
}
