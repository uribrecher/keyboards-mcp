import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerLoadProgram(
  server: McpServer,
  _midi: unknown,
  holder: ModelHolder,
): void {
  server.registerTool(
    "load_program",
    {
      description: "Load a stored program on the keyboard by bank and program number. " +
        "Sends MIDI Bank Select (CC0 + CC32) followed by Program Change.",
      inputSchema: {
        bank: z.number().min(1).max(99).describe("Program bank"),
        slot: z.number().min(1).max(99).describe("Program number within bank"),
      },
    },
    async ({ bank, slot }) => {
      let device;
      try { device = holder.requireDevice(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      return device.loadProgram(bank, slot);
    },
  );
}
