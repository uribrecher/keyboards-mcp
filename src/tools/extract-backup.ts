import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelHolder } from "../shared/model-holder.js";
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

export function registerExtractBackup(server: McpServer, holder: ModelHolder): void {
  server.registerTool(
    "extract_backup",
    {
      description: "Read a keyboard backup file and generate a comprehensive inventory of all sounds, " +
        "programs, and settings stored on the keyboard. Automatically detects the mode based " +
        "on whether the path is a file (full backup) or a directory (programs-only).",
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
      },
    },
    async ({ file_path, output_path }) => {
      let model: KeyboardModel;
      if (holder.isLoaded) {
        model = holder.requireModel();
      } else {
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

        // Update device instance's backup data if connected
        if (holder.device) {
          holder.device.backupData = data;
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
        const summary =
          `Extracted ${mode} backup inventory:\n` +
          `- ${pianos} piano models\n` +
          `- ${samples} samples\n` +
          `- ${programs} programs (${banks} banks)\n` +
          `- ${setLists} set list entries\n` +
          `- ${livePresets} live presets\n\n` +
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
