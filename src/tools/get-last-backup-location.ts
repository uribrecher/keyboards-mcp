import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";
import { findLastBackupPath } from "../shared/model-registry.js";

export function registerGetLastBackupLocation(server: McpServer, holder: ModelHolder): void {
  server.registerTool(
    "get_last_backup_location",
    {
      description: "Return the file path of the last keyboard backup that was extracted. " +
        "Use this to suggest the same path when the user asks to extract a backup again.",
    },
    async () => {
      // Try connected model first
      if (holder.isLoaded) {
        const model = holder.requireModel();
        const cache = model.backupCache;
        if (cache) {
          const path = cache.getLastBackupPath();
          if (path) return { content: [{ type: "text", text: path }] };
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
