import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./extract-backup.js";

const lastBackupFile = join(dataDir, "last_backup_path.txt");

export function registerGetLastBackupLocation(server: McpServer): void {
  server.tool(
    "get_last_backup_location",
    "Return the file path of the last Nord backup (.ne5b) that was extracted. " +
      "Use this to suggest the same path when the user asks to extract a backup again.",
    {},
    async () => {
      if (!existsSync(lastBackupFile)) {
        return {
          content: [
            {
              type: "text",
              text: "No previous backup path stored. Ask the user for the .ne5b file path.",
            },
          ],
        };
      }

      const path = readFileSync(lastBackupFile, "utf-8").trim();
      return {
        content: [
          {
            type: "text",
            text: path,
          },
        ],
      };
    }
  );
}
