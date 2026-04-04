import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import { getBackupData } from "../nord/backup-cache.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PART_LABELS = ["A", "B", "C", "D"] as const;
type PartLabel = (typeof PART_LABELS)[number];

export function registerLoadSong(
  server: McpServer,
  midi: MidiManager
): void {
  server.tool(
    "load_song",
    "Load a song from a Nord Electro 5D set list. Switches to set list mode, " +
      "selects the set list bank and song slot, and optionally picks a part (A/B/C/D). " +
      "Bank 1-5, slot 1-50 (matching hardware display).",
    {
      bank: z.number().min(1).max(5).describe("Set list number (1-5)"),
      slot: z.number().min(1).max(50).describe("Song number within the set list (1-50)"),
      part: z
        .enum(["A", "B", "C", "D"])
        .optional()
        .describe("Part to select: A, B, C, or D (default A)"),
    },
    async ({ bank, slot, part }) => {
      if (!midi.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Not connected. Use connect_to_nord first." }],
          isError: true,
        };
      }

      const partLabel: PartLabel = part ?? "A";
      const partIndex = PART_LABELS.indexOf(partLabel);

      // Send the full set list sequence with delays for hardware reliability
      const partMidiValues = [0, 43, 85, 127];
      const messages: Array<{ controller: number; value: number }> = [
        { controller: 48, value: 127 },       // 1. Enter set list mode
        { controller: 0, value: 0 },           // 2. Bank Select MSB
        { controller: 32, value: bank - 1 },   // 3. Bank Select LSB
      ];
      await midi.sendCCBatch(messages);

      // 4. Program Change (song slot)
      midi.sendProgramChange(slot - 1);

      // 5. Part select (CC49) — delay to let hardware process song load
      await delay(50);
      midi.sendCC(49, partMidiValues[partIndex]);

      // Build response with song/program info from backup cache
      const backup = getBackupData();
      const entry = backup?.setLists.find(
        (s) => s.bank === bank && s.slot === slot - 1
      );

      let text = `Set list ${bank}, song ${slot}, part ${partLabel}`;
      if (entry) {
        text = `Loaded "${entry.name}" — set list ${bank}, song ${slot}, part ${partLabel}`;

        // Resolve program names for each part
        const progByBankSlot = new Map(
          (backup?.programs ?? []).map((p) => [`${p.bank}:${p.slot}`, p.name])
        );
        const partNames = entry.programs.map(
          (ref, i) => {
            const name = progByBankSlot.get(`${ref.bank}:${ref.slot}`) ?? `B${ref.bank}:${ref.slot + 1}`;
            const marker = PART_LABELS[i] === partLabel ? " ←" : "";
            return `  ${PART_LABELS[i]}: ${name}${marker}`;
          }
        );
        text += "\n" + partNames.join("\n");
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
