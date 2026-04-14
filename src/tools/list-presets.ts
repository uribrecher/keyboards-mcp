import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerListPresets(server: McpServer, holder: ModelHolder): void {
  server.registerTool(
    "list_presets",
    {
      description: "List available built-in preset patches for the connected keyboard. " +
        "Each preset is a complete set of parameters for a specific keyboard sound.",
      inputSchema: {
        genre: z
          .string()
          .optional()
          .describe("Optional genre filter, e.g. 'jazz', 'rock', 'funk', 'pop'"),
      },
    },
    async ({ genre }) => {
      let model;
      try { model = holder.requireModel(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      const presets = genre ? model.getPresetsByGenre(genre) : model.presets;

      if (presets.length === 0) {
        const genres = [...new Set(model.presets.map((p) => p.genre))].join(", ");
        return {
          content: [
            {
              type: "text",
              text: genre
                ? `No presets found for genre "${genre}". Available genres: ${genres}`
                : "No presets available.",
            },
          ],
        };
      }

      const lines = presets.map(
        (p) => `- **${p.name}** [${p.genre}]\n  ${p.description}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `## Available Presets (${presets.length})\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    },
  );
}
