import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerGetState(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "get_current_state",
    {
      description: "Get the current state of all (or a section of) keyboard parameters. " +
        "Shows what values have been sent to the keyboard in this session.",
      inputSchema: {
        section: z
          .string()
          .optional()
          .describe("Optional section filter (e.g. organ, piano, effect1, reverb, etc.)"),
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

      return kdev.getState(section);
    },
  );
}
