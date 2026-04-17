import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerListParameters(server: McpServer, holder: ModelHolder): void {
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
      },
    },
    async ({ section }) => {
      let device;
      try { device = holder.requireDevice(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return device.listParameters(section);
    },
  );
}
