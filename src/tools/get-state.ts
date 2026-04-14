import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerGetState(server: McpServer, holder: ModelHolder): void {
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
      },
    },
    async ({ section }) => {
      let state;
      try { state = holder.requireState(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      const text = state.format(section);
      return { content: [{ type: "text", text }] };
    },
  );
}
