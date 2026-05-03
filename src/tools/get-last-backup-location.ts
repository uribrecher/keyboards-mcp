import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";
import { findLastBackupPath } from "../shared/model-registry.js";

const DEFAULT_LABEL = "_default";

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
          .describe("Optional 1-based device index. Uses that device's label."),
        label: z
          .string()
          .optional()
          .describe("Optional label whose cached path should be returned (overrides `device`'s label)."),
      },
    },
    async ({ device, label }) => {
      // Resolve the target label
      let targetLabel: string | undefined;
      if (label !== undefined) {
        targetLabel = sanitizeLabel(label);
      } else if (device !== undefined) {
        const entry = pool.get(device);
        if (!entry) {
          return {
            content: [{ type: "text", text: `No device at index ${device}.` }],
            isError: true,
          };
        }
        targetLabel = sanitizeLabel(entry.device.label);
      }

      // Explicit label/device wins
      if (targetLabel !== undefined) {
        // Look up the path on any model whose backupCache supports it.
        const seenModels = new Set<string>();
        for (const entry of pool.list()) {
          const id = entry.device.model.info.id;
          if (seenModels.has(id)) continue;
          seenModels.add(id);
          const path = entry.device.model.backupCache?.getLastBackupPath(targetLabel);
          if (path) return { content: [{ type: "text", text: path }] };
        }
        // Fall back to disk scan
        const path = await findLastBackupPath();
        if (path) return { content: [{ type: "text", text: path }] };
        return {
          content: [{ type: "text", text: `No previous backup path stored under label "${targetLabel}".` }],
        };
      }

      // No `label`, no `device`. Use single-device or list available.
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

      // Fall back: scan all models for a stored backup path
      const path = await findLastBackupPath();
      if (path) return { content: [{ type: "text", text: path }] };

      return {
        content: [
          { type: "text", text: "No previous backup path stored. Ask the user for the backup file path." },
        ],
      };
    },
  );
}
