import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerLoadSong(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "load_song",
    {
      description: "Load a song from a keyboard set list. Switches to set list mode, " +
        "selects the set list bank and song slot, and optionally picks a part.",
      inputSchema: {
        bank: z.coerce.number().min(1).max(99).describe("Set list number"),
        slot: z.coerce.number().min(1).max(99).describe("Song number within the set list"),
        part: z
          .string()
          .optional()
          .describe("Part to select (e.g. A, B, C, D). Default: first available part."),
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("1-based device index from is_connected. Required when more than one device is connected."),
      },
    },
    async ({ bank, slot, part, device }) => {
      let kdev;
      try { kdev = pool.resolve(device).device; }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return kdev.loadSong(bank, slot, part);
    },
  );
}
