import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ParameterState } from "../nord/parameter-state.js";
import { getSections } from "../nord/nord-electro-5d-map.js";

export function registerGetState(server: McpServer, state: ParameterState): void {
  server.tool(
    "get_current_state",
    "Get the current state of all (or a section of) Nord Electro 5D parameters. " +
      "Shows what values have been sent to the keyboard in this session.",
    {
      section: z
        .string()
        .optional()
        .describe(
          `Optional section filter: ${getSections().join(", ")}`
        ),
    },
    async ({ section }) => {
      const text = state.format(section);
      return { content: [{ type: "text", text }] };
    }
  );
}
