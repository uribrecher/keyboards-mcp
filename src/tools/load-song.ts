import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerLoadSong(
  server: McpServer,
  _midi: unknown,
  holder: ModelHolder,
): void {
  server.registerTool(
    "load_song",
    {
      description: "Load a song from a keyboard set list. Switches to set list mode, " +
        "selects the set list bank and song slot, and optionally picks a part.",
      inputSchema: {
        bank: z.number().min(1).max(99).describe("Set list number"),
        slot: z.number().min(1).max(99).describe("Song number within the set list"),
        part: z
          .string()
          .optional()
          .describe("Part to select (e.g. A, B, C, D). Default: first available part."),
      },
    },
    async ({ bank, slot, part }) => {
      let device;
      try { device = holder.requireDevice(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return device.loadSong(bank, slot, part);
    },
  );
}
