import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRESETS, getPresetsByGenre } from "../nord/presets.js";

export function registerListPresets(server: McpServer): void {
  server.tool(
    "list_presets",
    "List available built-in preset patches for the Nord Electro 5D. " +
      "Each preset is a complete set of parameters for a specific keyboard sound.",
    {
      genre: z
        .string()
        .optional()
        .describe("Optional genre filter, e.g. 'jazz', 'rock', 'funk', 'pop'"),
    },
    async ({ genre }) => {
      const presets = genre ? getPresetsByGenre(genre) : PRESETS;

      if (presets.length === 0) {
        const genres = [...new Set(PRESETS.map((p) => p.genre))].join(", ");
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
        (p) => `- **${p.name}** [${p.genre}]\n  ${p.description}`
      );

      return {
        content: [
          {
            type: "text",
            text: `## Available Presets (${presets.length})\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );
}
