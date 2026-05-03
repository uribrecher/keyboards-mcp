import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerSystemPrompt(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "get_system_prompt",
    {
      description: "Get the model-specific system prompt for AI agents. " +
        "Returns a detailed description of the connected keyboard's signal path, " +
        "engine capabilities, and sound design guidelines. Requires an active connection. " +
        "When multiple devices are connected, the response also enumerates each device with its index.",
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
      try { entry = pool.resolve(device); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      const result = entry.device.getSystemPrompt();

      // When multiple devices are connected, append a roster so the agent
      // knows how to address each one in subsequent tool calls.
      if (pool.size() > 1) {
        const roster = pool.list()
          .map((e) => {
            const labelStr = e.device.label ? ` "${e.device.label}"` : "";
            const marker = e.index === entry.index ? " (this prompt)" : "";
            return `  - device ${e.index}: ${e.device.model.info.displayName}${labelStr}${marker}`;
          })
          .join("\n");
        const text = result.content[0]?.text ?? "";
        const augmented = `${text}\n\nCONNECTED DEVICES:\n${roster}\n\n` +
          "Pass the desired index as the `device` parameter on tool calls (set_parameters, " +
          "load_program, etc.) to target a specific keyboard.";
        return { content: [{ type: "text", text: augmented }] };
      }

      return result;
    },
  );
}
