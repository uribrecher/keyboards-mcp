import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";
import { findLastBackupPath } from "../shared/model-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_LABEL = "_default";

function getDataDir(): string {
  return process.env.KEYBOARDS_MCP_DATA_DIR
    ?? join(__dirname, "..", "..", "data");
}

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

/**
 * Read `data/backups/<label>/last_backup_path.txt` directly off disk.
 * Used as a fallback when no device of the matching model is connected
 * (the connected-device path goes through model.backupCache).
 */
function diskLookup(label: string): string | null {
  try {
    const file = join(getDataDir(), "backups", label, "last_backup_path.txt");
    if (existsSync(file)) {
      const path = readFileSync(file, "utf-8").trim();
      if (path.length > 0) return path;
    }
  } catch { /* non-fatal */ }
  return null;
}

export function registerGetLastBackupLocation(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "get_last_backup_location",
    {
      description: "Return the file path of the last keyboard backup that was extracted. " +
        "Use this to suggest the same path when the user asks to extract a backup again. " +
        "Backup paths are keyed by label — pass `label` (or `device` to use that device's label) " +
        "to disambiguate when multiple labels have stored paths.",
      inputSchema: {
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("Optional 1-based device index. Uses that device's model + label."),
        label: z
          .string()
          .optional()
          .describe("Optional label whose cached path should be returned (overrides `device`'s label)."),
      },
    },
    async ({ device, label }) => {
      // Resolve target label and (when device is given) the model to scope to
      let targetLabel: string | undefined;
      let scopedModelId: string | undefined;
      if (device !== undefined) {
        const entry = pool.get(device);
        if (!entry) {
          return {
            content: [{ type: "text", text: `No device at index ${device}.` }],
            isError: true,
          };
        }
        scopedModelId = entry.device.model.info.id;
        targetLabel = label !== undefined ? sanitizeLabel(label) : sanitizeLabel(entry.device.label);
      } else if (label !== undefined) {
        targetLabel = sanitizeLabel(label);
      }

      // Explicit label/device wins
      if (targetLabel !== undefined) {
        // 1. Prefer the scoped device's model (when device was given) so a
        //    same-named label on a different model doesn't masquerade.
        if (scopedModelId !== undefined) {
          const scopedEntry = pool.list().find((e) => e.device.model.info.id === scopedModelId);
          const scopedPath = scopedEntry?.device.model.backupCache?.getLastBackupPath(targetLabel);
          if (scopedPath) return { content: [{ type: "text", text: scopedPath }] };
        } else {
          // 2. Otherwise check every connected unique model
          const seenModels = new Set<string>();
          for (const entry of pool.list()) {
            const id = entry.device.model.info.id;
            if (seenModels.has(id)) continue;
            seenModels.add(id);
            const path = entry.device.model.backupCache?.getLastBackupPath(targetLabel);
            if (path) return { content: [{ type: "text", text: path }] };
          }
        }
        // 3. Disk fallback so an unconnected label still resolves
        const onDisk = diskLookup(targetLabel);
        if (onDisk) return { content: [{ type: "text", text: onDisk }] };
        return {
          content: [{ type: "text", text: `No previous backup path stored under label "${targetLabel}".` }],
        };
      }

      // No `label`, no `device`. Single-device or list available.
      const entries = pool.list();
      if (entries.length === 1) {
        const entryLabel = sanitizeLabel(entries[0].device.label);
        const path = entries[0].device.model.backupCache?.getLastBackupPath(entryLabel);
        if (path) return { content: [{ type: "text", text: path }] };
      }

      if (entries.length > 1) {
        const seen = new Set<string>();
        const lines: string[] = [];
        for (const entry of entries) {
          const key = `${entry.device.model.info.id}|${sanitizeLabel(entry.device.label)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const lbl = sanitizeLabel(entry.device.label);
          const path = entry.device.model.backupCache?.getLastBackupPath(lbl);
          if (path) {
            lines.push(`  device ${entry.index} (${entry.device.model.info.displayName}, label "${lbl}"): ${path}`);
          }
        }
        if (lines.length > 0) {
          return {
            content: [{
              type: "text",
              text: `Multiple devices connected — pass \`device\` or \`label\` to pick one. Cached paths:\n${lines.join("\n")}`,
            }],
          };
        }
      }

      // No connected device path was useful — try the registry-based scan,
      // then enumerate any labels persisted on disk.
      const registryPath = await findLastBackupPath();
      if (registryPath) return { content: [{ type: "text", text: registryPath }] };

      const allLabels = scanDiskLabels();
      if (allLabels.length > 0) {
        const lines = allLabels.map((l) => `  label "${l}": ${diskLookup(l)}`).filter((s) => !s.endsWith(": null"));
        if (lines.length > 0) {
          return {
            content: [{
              type: "text",
              text: `No connected device, but cached paths exist on disk:\n${lines.join("\n")}`,
            }],
          };
        }
      }

      return {
        content: [
          { type: "text", text: "No previous backup path stored. Ask the user for the backup file path." },
        ],
      };
    },
  );
}

function scanDiskLabels(): string[] {
  try {
    const root = join(getDataDir(), "backups");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((entry) => {
        try { return statSync(join(root, entry)).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}
