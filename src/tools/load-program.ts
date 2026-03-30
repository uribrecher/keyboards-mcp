import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";

export function registerLoadProgram(
  server: McpServer,
  midi: MidiManager
): void {
  server.tool(
    "load_program",
    "Load a stored program on the Nord Electro 5D by bank and program number. " +
      "Sends MIDI Bank Select (CC0 + CC32) followed by Program Change. " +
      "Bank 1-5, program 1-50 (matching hardware display).",
    {
      bank: z.number().min(1).max(5).describe("Program bank (1-5)"),
      slot: z.number().min(1).max(50).describe("Program number within bank (1-50)"),
    },
    async ({ bank, slot }) => {
      if (!midi.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Not connected. Use connect_to_nord first." }],
          isError: true,
        };
      }

      // Nord Electro 5D program change sequence:
      // 1. CC 0  (Bank Select MSB) = 0
      // 2. CC 32 (Bank Select LSB) = bank - 1 (0-indexed)
      // 3. Program Change = slot - 1 (convert 1-indexed input to 0-indexed MIDI)
      midi.sendCC(0, 0);
      midi.sendCC(32, bank - 1);
      midi.sendProgramChange(slot - 1);

      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded program ${bank}:${slot}`,
          },
        ],
      };
    }
  );
}
