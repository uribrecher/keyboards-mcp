import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerSetParameters(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "set_parameters",
    {
      description: "Set one or more keyboard parameters by name and value.",
      inputSchema: {
        parameters: z
          .preprocess(
            (v) => (typeof v === "string" ? JSON.parse(v) : v),
            z.array(
              z.object({
                name: z.string().describe("Parameter key or name, e.g. 'drawbar_1', 'organ_model', 'reverb_type'"),
                value: z.union([z.coerce.number(), z.string()]).describe("Numeric value or string label, e.g. 8, 'B3', 'Hall', 'Fast'"),
              }),
            ),
          )
          .describe("Array of parameter name/value pairs to set"),
        part: z
          .enum(["lower", "upper"])
          .optional()
          .describe("Target part for per-part params (default: upper)"),
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("1-based device index from is_connected. Required when more than one device is connected."),
      },
    },
    async ({ parameters, part, device }) => {
      let kdev;
      try { kdev = pool.resolve(device).device; }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return kdev.setParameters(parameters, part);
    },
  );
}
