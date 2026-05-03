import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";

export function registerLoadProgram(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "load_program",
    {
      description: "Load a stored program on the keyboard by bank and program number. " +
        "Sends MIDI Bank Select (CC0 + CC32) followed by Program Change.",
      inputSchema: {
        bank: z.coerce.number().min(1).max(99).describe("Program bank"),
        slot: z.coerce.number().min(1).max(99).describe("Program number within bank"),
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("1-based device index from is_connected. Required when more than one device is connected."),
      },
    },
    async ({ bank, slot, device }) => {
      let kdev;
      try { kdev = pool.resolve(device).device; }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return kdev.loadProgram(bank, slot);
    },
  );
}
