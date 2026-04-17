import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerSystemPrompt(server: McpServer, holder: ModelHolder): void {
  server.registerTool(
    "get_system_prompt",
    {
      description: "Get the model-specific system prompt for AI agents. " +
        "Returns a detailed description of the connected keyboard's signal path, " +
        "engine capabilities, and sound design guidelines. Requires an active connection.",
    },
    async () => {
      let device;
      try { device = holder.requireDevice(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return device.getSystemPrompt();
    },
  );
}
