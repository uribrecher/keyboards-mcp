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

/**
 * data/ root. Resolved at every call so tests can redirect via
 * KEYBOARDS_MCP_DATA_DIR (matching the cache layer).
 */
function getDataDir(): string {
  return process.env.KEYBOARDS_MCP_DATA_DIR
    ?? join(__dirname, "..", "..", "data");
}

const DEFAULT_LABEL = "_default";

/** Same sanitizer as backup-cache.ts. Kept duplicated to avoid a model-internal import from shared tools. */
function sanitizeLabel(label: string | undefined | null): string {
  if (!label) return DEFAULT_LABEL;
  let slug = label.trim().toLowerCase();
  slug = slug.replace(/\s+/g, "-");
  slug = slug.replace(/[^a-z0-9._-]/g, "");
  if (slug === "" || slug === "." || slug === ".." || slug.includes("..")) {
    return DEFAULT_LABEL;
  }
  return slug;
}

function defaultOutputPath(model: KeyboardModel, label: string): string {
  const slug = model.info.id.replace(/[^a-z0-9]+/gi, "_");
  return join(getDataDir(), "backups", label, `${slug}_backup_inventory.md`);
}

export function registerExtractBackup(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "extract_backup",
    {
      description: "Read a keyboard backup file and generate a comprehensive inventory of all sounds, " +
        "programs, and settings stored on the keyboard. Automatically detects the mode based " +
        "on whether the path is a file (full backup) or a directory (programs-only). " +
        "Backup data is keyed by `label` so two units of the same model don't share one cache. " +
        "When multiple matching devices are connected, pass `device` (1-based) or `label` to choose " +
        "which instance receives the inventory.",
      inputSchema: {
        file_path: z.string().describe(
          "Absolute path to a backup file or a folder of program files",
        ),
        output_path: z
          .string()
          .optional()
          .describe(
            "Optional path to write the generated markdown file. " +
              "Defaults to data/backups/<label>/<model_id>_backup_inventory.md.",
          ),
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("Optional 1-based device index to update with the parsed inventory."),
        label: z
          .string()
          .optional()
          .describe(
            "Optional label this backup belongs to (e.g. 'studio nord'). " +
              "If omitted, the connected device's label is used; otherwise '_default'.",
          ),
      },
    },
    async ({ file_path, output_path, device, label }) => {
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

      // Resolve effective label (matches plan §"Resolution"):
      //   1. explicit `label` arg
      //   2. label of the explicit `device`, or of the lone matching device
      //   3. _default
      let effectiveLabel: string;
      if (label !== undefined) {
        effectiveLabel = sanitizeLabel(label);
      } else if (device !== undefined) {
        const entry = pool.get(device);
        effectiveLabel = sanitizeLabel(entry?.device.label);
      } else {
        const matching = pool.list().filter((e) => e.device.model.info.id === model!.info.id);
        effectiveLabel = matching.length === 1 ? sanitizeLabel(matching[0].device.label) : DEFAULT_LABEL;
      }

      // Make sure this label's cache is loaded before programs-only resolution.
      cache?.load(effectiveLabel);

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
          const cached = cache?.get(effectiveLabel);
          if (!cached) {
            return {
              content: [
                {
                  type: "text",
                  text: `Programs-only extraction requires a previously cached full backup ` +
                    `for piano/sample name resolution under label "${effectiveLabel}". ` +
                    `Please run extract_backup on a full backup file first.`,
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

        cache?.set(data, effectiveLabel);

        // Decide which devices receive this inventory.
        //   - explicit `device` param  → only that device
        //   - exactly one connected device of this model with matching label → that one
        //   - otherwise → leave all devices untouched (cache is updated for the label)
        let updatedIndices: number[] = [];
        if (device !== undefined) {
          const entry = pool.get(device);
          if (entry && entry.device.model.info.id === model.info.id) {
            entry.device.backupData = data;
            updatedIndices = [entry.index];
          }
        } else {
          const matching = pool.list().filter((e) =>
            e.device.model.info.id === model!.info.id
              && sanitizeLabel(e.device.label) === effectiveLabel,
          );
          if (matching.length === 1) {
            matching[0].device.backupData = data;
            updatedIndices = [matching[0].index];
          }
          // else: zero (nothing connected with this label) or multiple — leave devices alone.
        }

        const dateMatch = basename(file_path).match(/(\d{4}-\d{2}-\d{2})/);
        const backupDate = dateMatch ? dateMatch[1] : undefined;

        const markdown = backup.formatAsMarkdown(data, backupDate);

        const outPath = output_path || defaultOutputPath(model, effectiveLabel);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, markdown, "utf-8");

        cache?.setLastBackupPath(file_path, effectiveLabel);

        const pianos = data.pianos?.length ?? 0;
        const samples = data.samples?.length ?? 0;
        const programs = data.programs?.length ?? 0;
        const setLists = data.setLists?.length ?? 0;
        const livePresets = data.livePresets?.length ?? 0;
        const banks = new Set((data.programs ?? []).map((p: any) => p.bank)).size;

        const mode = stat.isDirectory() ? "programs-only" : "full";
        let appliedTo: string;
        if (updatedIndices.length === 1) {
          appliedTo = `Inventory applied to device ${updatedIndices[0]} under label "${effectiveLabel}".`;
        } else if (device !== undefined) {
          appliedTo = `Note: device ${device} is not a ${model.info.displayName} — cache stored under "${effectiveLabel}" but no device updated.`;
        } else {
          appliedTo = `Cached under label "${effectiveLabel}". Devices with that label will pick it up on next connect.`;
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
