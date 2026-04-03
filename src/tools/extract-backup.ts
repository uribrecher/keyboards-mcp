import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBackup, parseProgramsFolder, formatBackupAsMarkdown } from "../nord/backup-parser.js";
import type { BackupMetadata } from "../nord/backup-parser.js";
import { setBackupData, getBackupData } from "../nord/backup-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** data/ folder in the repo root (from src/tools/ or dist/tools/, two levels up). */
export const dataDir = join(__dirname, "..", "..", "data");

function defaultOutputPath(): string {
  return join(dataDir, "nord_backup_inventory.md");
}

export function registerExtractBackup(server: McpServer): void {
  server.tool(
    "extract_backup",
    "Read a Nord Electro 5D backup file (.ne5b) or a folder of program files (.ne5p) " +
      "and generate a comprehensive inventory of all sounds, programs, and settings " +
      "stored on the keyboard. Automatically detects the mode based on whether the path " +
      "is a file (full backup) or a directory (programs-only). Programs-only mode requires " +
      "a previously extracted full backup for piano/sample name resolution.",
    {
      file_path: z.string().describe(
        "Absolute path to a .ne5b backup file or a folder of .ne5p program files"
      ),
      output_path: z
        .string()
        .optional()
        .describe(
          "Optional path to write the generated markdown file. " +
            "Defaults to the Claude project memory folder."
        ),
    },
    async ({ file_path, output_path }) => {
      try {
        const stat = statSync(file_path);
        let data: BackupMetadata;

        if (stat.isDirectory()) {
          // Programs-only mode: folder of .ne5p files
          const cached = getBackupData();
          if (!cached) {
            return {
              content: [
                {
                  type: "text",
                  text: "Programs-only extraction requires a previously cached full backup " +
                    "for piano/sample name resolution. Please run extract_backup on a " +
                    "full .ne5b backup file first.",
                },
              ],
              isError: true,
            };
          }
          const programs = parseProgramsFolder(file_path);
          data = {
            ...cached,
            programs,
          };
        } else {
          // Full backup mode
          data = parseBackup(file_path);
        }

        setBackupData(data);

        // Try to extract date from path (e.g. "nord-e-5d-Backup 2026-03-28.ne5b" or folder name)
        const dateMatch = basename(file_path).match(/(\d{4}-\d{2}-\d{2})/);
        const backupDate = dateMatch ? dateMatch[1] : undefined;

        const markdown = formatBackupAsMarkdown(data, backupDate);

        // Write to file
        const outPath = output_path || defaultOutputPath();
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, markdown, "utf-8");

        // Persist the backup source path for get_last_backup_location
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, "last_backup_path.txt"), file_path, "utf-8");

        const mode = stat.isDirectory() ? "programs-only" : "full";
        const summary =
          `Extracted ${mode} backup inventory:\n` +
          `- ${data.pianos.length} piano models\n` +
          `- ${data.samples.length} samples\n` +
          `- ${data.programs.length} programs (${new Set(data.programs.map((p) => p.bank)).size} banks)\n` +
          `- ${data.setLists.length} set list entries\n` +
          `- ${data.livePresets.length} live presets\n\n` +
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
    }
  );
}
