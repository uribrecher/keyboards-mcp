import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerSetParameters(
  server: McpServer,
  _midi: unknown,
  holder: ModelHolder,
): void {
  server.registerTool(
    "set_parameters",
    {
      description: "Set one or more keyboard parameters by name and value.",
      inputSchema: {
        parameters: z
          .array(
            z.object({
              name: z.string().describe("Parameter key or name, e.g. 'drawbar_1', 'organ_model', 'reverb_type'"),
              value: z.union([z.number(), z.string()]).describe("Numeric value or string label, e.g. 8, 'B3', 'Hall', 'Fast'"),
            }),
          )
          .describe("Array of parameter name/value pairs to set"),
        part: z
          .enum(["lower", "upper"])
          .optional()
          .describe("Target part for per-part params (default: upper)"),
      },
    },
    async ({ parameters, part }) => {
      let device;
      try { device = holder.requireDevice(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return device.setParameters(parameters, part);
    },
  );
}
