import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerLoadSong(
  server: McpServer,
  midi: MidiManager,
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
      let model;
      try { model = holder.requireModel(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      if (!model.songLoader) {
        return {
          content: [{ type: "text", text: `${model.info.displayName} does not support set list loading.` }],
          isError: true,
        };
      }

      if (!midi.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Not connected. Use connect_to_keyboard first." }],
          isError: true,
        };
      }

      const loader = model.songLoader;
      const parts = loader.parts ?? ["A", "B", "C", "D"];
      const partLabel = part ?? parts[0];

      await loader.loadSong(midi, bank, slot, partLabel);

      // Build response with song/program info from backup cache
      const backup = model.backupCache?.get();
      let text = `Set list ${bank}, song ${slot}, part ${partLabel}`;

      if (backup && "setLists" in backup && "programs" in backup) {
        const setLists = (backup as any).setLists as Array<{ bank: number; slot: number; name: string; programs: Array<{ bank: number; slot: number }> }>;
        const programs = (backup as any).programs as Array<{ bank: number; slot: number; name: string }>;
        const entry = setLists.find((s) => s.bank === bank && s.slot === slot - 1);

        if (entry) {
          text = `Loaded "${entry.name}" — set list ${bank}, song ${slot}, part ${partLabel}`;
          const progByBankSlot = new Map(programs.map((p) => [`${p.bank}:${p.slot}`, p.name]));
          const partNames = entry.programs.map((ref, i) => {
            const name = progByBankSlot.get(`${ref.bank}:${ref.slot}`) ?? `B${ref.bank}:${ref.slot + 1}`;
            const marker = parts[i] === partLabel ? " ←" : "";
            return `  ${parts[i]}: ${name}${marker}`;
          });
          text += "\n" + partNames.join("\n");
        }
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
