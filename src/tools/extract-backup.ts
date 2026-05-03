import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DevicePool } from "../shared/device-pool.js";
import type { KeyboardModel } from "../shared/keyboard-model.js";
import { detectModelFromBackup } from "../shared/model-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** data/ folder in the repo root (from src/tools/ or dist/tools/, two levels up). */
export const dataDir = join(__dirname, "..", "..", "data");

function defaultOutputPath(model: KeyboardModel): string {
  const slug = model.info.id.replace(/[^a-z0-9]+/gi, "_");
  return join(dataDir, `${slug}_backup_inventory.md`);
}

export function registerExtractBackup(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "extract_backup",
    {
      description: "Read a keyboard backup file and generate a comprehensive inventory of all sounds, " +
        "programs, and settings stored on the keyboard. Automatically detects the mode based " +
        "on whether the path is a file (full backup) or a directory (programs-only). " +
        "If a connected device matches the file's model, its inventory is updated. " +
        "When multiple matching devices are connected, pass `device` to choose which.",
      inputSchema: {
        file_path: z.string().describe(
          "Absolute path to a backup file or a folder of program files",
        ),
        output_path: z
          .string()
          .optional()
          .describe(
            "Optional path to write the generated markdown file. " +
              "Defaults to the Claude project memory folder.",
          ),
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("Optional 1-based device index to update with the parsed inventory."),
      },
    },
    async ({ file_path, output_path, device }) => {
      // Pick model: explicit device > pool's only device > backup detection
      let model: KeyboardModel | null = null;

      if (device !== undefined) {
        try {
          model = pool.require(device).device.model;
        } catch (err) {
          return {
            content: [{ type: "text", text: (err as Error).message }],
            isError: true,
          };
        }
      } else if (pool.size() === 1) {
        model = pool.list()[0].device.model;
      }

      if (!model) {
        const detected = await detectModelFromBackup(file_path);
        if (!detected) {
          return {
            content: [{
              type: "text",
              text: "Could not detect keyboard model from the backup file. " +
                "Either connect a keyboard first, or ensure the file is a supported backup format.",
            }],
            isError: true,
          };
        }
        detected.backupCache?.load();
        model = detected;
      }

      const backup = model.backup;
      const cache = model.backupCache;

      if (!backup) {
        return {
          content: [{ type: "text", text: `${model.info.displayName} does not support backup extraction.` }],
          isError: true,
        };
      }

      try {
        const stat = statSync(file_path);
        let data: Record<string, any>;

        if (stat.isDirectory()) {
          if (!backup.parseProgramsFolder) {
            return {
              content: [{ type: "text", text: "This keyboard model does not support programs-only extraction." }],
              isError: true,
            };
          }
          const cached = cache?.get();
          if (!cached) {
            return {
              content: [
                {
                  type: "text",
                  text: "Programs-only extraction requires a previously cached full backup " +
                    "for piano/sample name resolution. Please run extract_backup on a " +
                    "full backup file first.",
                },
              ],
              isError: true,
            };
          }
          const programsData = await backup.parseProgramsFolder(file_path);
          data = { ...cached, ...programsData };
        } else {
          data = await backup.parseBackup(file_path);
        }

        cache?.set(data);

        // Decide which devices receive this inventory.
        //   - explicit `device` param  → only that device
        //   - exactly one connected device of this model → just that one
        //   - multiple connected devices of this model and no `device` param
        //     → none, to avoid silently overwriting per-instance inventory.
        // Per-instance backup keying lands in plan #5; until then this errs
        // on the side of "do not clobber".
        let updatedIndices: number[] = [];
        if (device !== undefined) {
          const entry = pool.get(device);
          if (entry && entry.device.model.info.id === model.info.id) {
            entry.device.backupData = data;
            updatedIndices = [entry.index];
          }
        } else {
          const matching = pool.list().filter((e) => e.device.model.info.id === model.info.id);
          if (matching.length === 1) {
            matching[0].device.backupData = data;
            updatedIndices = [matching[0].index];
          }
          // else: zero (nothing connected) or multiple — leave devices untouched.
        }

        const dateMatch = basename(file_path).match(/(\d{4}-\d{2}-\d{2})/);
        const backupDate = dateMatch ? dateMatch[1] : undefined;

        const markdown = backup.formatAsMarkdown(data, backupDate);

        const outPath = output_path || defaultOutputPath(model);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, markdown, "utf-8");

        cache?.setLastBackupPath(file_path);

        const pianos = data.pianos?.length ?? 0;
        const samples = data.samples?.length ?? 0;
        const programs = data.programs?.length ?? 0;
        const setLists = data.setLists?.length ?? 0;
        const livePresets = data.livePresets?.length ?? 0;
        const banks = new Set((data.programs ?? []).map((p: any) => p.bank)).size;

        const mode = stat.isDirectory() ? "programs-only" : "full";
        const matchingCount = pool.list().filter((e) => e.device.model.info.id === model.info.id).length;
        let appliedTo: string;
        if (updatedIndices.length === 1) {
          appliedTo = `Inventory applied to device ${updatedIndices[0]}.`;
        } else if (device !== undefined) {
          appliedTo = `Note: device ${device} is not a ${model.info.displayName} — inventory cached but not bound to any device.`;
        } else if (matchingCount > 1) {
          appliedTo = `Note: ${matchingCount} connected ${model.info.displayName} devices — pass \`device\` to bind the inventory to a specific one. Cache updated, no device modified.`;
        } else {
          appliedTo = "No matching connected device — cache updated only.";
        }

        const summary =
          `Extracted ${mode} backup inventory:\n` +
          `- ${pianos} piano models\n` +
          `- ${samples} samples\n` +
          `- ${programs} programs (${banks} banks)\n` +
          `- ${setLists} set list entries\n` +
          `- ${livePresets} live presets\n\n` +
          `${appliedTo}\n` +
          `Written to: ${outPath}\n\n` +
          markdown;

        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to extract backup: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
