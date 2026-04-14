import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerLoadProgram(
  server: McpServer,
  midi: MidiManager,
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
      let model;
      try { model = holder.requireModel(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      if (!model.programLoader) {
        return {
          content: [{ type: "text", text: `${model.info.displayName} does not support program loading.` }],
          isError: true,
        };
      }

      if (!midi.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Not connected. Use connect_to_keyboard first." }],
          isError: true,
        };
      }

      const loader = model.programLoader;
      if (bank < loader.bankRange.min || bank > loader.bankRange.max) {
        return {
          content: [{ type: "text", text: `Bank must be ${loader.bankRange.min}-${loader.bankRange.max} for ${model.info.displayName}.` }],
          isError: true,
        };
      }
      if (slot < loader.slotRange.min || slot > loader.slotRange.max) {
        return {
          content: [{ type: "text", text: `Slot must be ${loader.slotRange.min}-${loader.slotRange.max} for ${model.info.displayName}.` }],
          isError: true,
        };
      }

      await loader.loadProgram(midi, bank, slot);

      return {
        content: [{ type: "text" as const, text: `Loaded program ${bank}:${slot}` }],
      };
    },
  );
}
