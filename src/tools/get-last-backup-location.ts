import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevicePool } from "../shared/device-pool.js";
import { findLastBackupPath } from "../shared/model-registry.js";

export function registerGetLastBackupLocation(server: McpServer, pool: DevicePool): void {
  server.registerTool(
    "get_last_backup_location",
    {
      description: "Return the file path of the last keyboard backup that was extracted. " +
        "Use this to suggest the same path when the user asks to extract a backup again. " +
        "When multiple devices are connected, pass `device` to pick a specific one — " +
        "otherwise this falls back to the only connected device, or to a disk scan.",
      inputSchema: {
        device: z.coerce.number()
          .int()
          .min(1)
          .optional()
          .describe("Optional 1-based device index whose model's cached path should be returned."),
      },
    },
    async ({ device }) => {
      // Explicit device wins
      if (device !== undefined) {
        const entry = pool.get(device);
        if (!entry) {
          return {
            content: [{ type: "text", text: `No device at index ${device}.` }],
            isError: true,
          };
        }
        const path = entry.device.model.backupCache?.getLastBackupPath();
        if (path) return { content: [{ type: "text", text: path }] };
        return {
          content: [{ type: "text", text: `No previous backup path stored for device ${device} (${entry.device.model.info.displayName}).` }],
        };
      }

      const entries = pool.list();

      // Single device: unambiguous
      if (entries.length === 1) {
        const path = entries[0].device.model.backupCache?.getLastBackupPath();
        if (path) return { content: [{ type: "text", text: path }] };
      }

      // Multiple devices, no `device` param: return all paths or ask to disambiguate
      if (entries.length > 1) {
        const seen = new Set<string>();
        const lines: string[] = [];
        for (const entry of entries) {
          const id = entry.device.model.info.id;
          if (seen.has(id)) continue;
          seen.add(id);
          const path = entry.device.model.backupCache?.getLastBackupPath();
          if (path) {
            lines.push(`  device ${entry.index} (${entry.device.model.info.displayName}): ${path}`);
          }
        }
        if (lines.length > 0) {
          return {
            content: [{
              type: "text",
              text: `Multiple devices connected — pass \`device\` to pick one. Cached paths:\n${lines.join("\n")}`,
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
