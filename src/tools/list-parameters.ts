import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NORD_ELECTRO_5D_PARAMS,
  getParamsBySection,
  getSections,
} from "../nord/nord-electro-5d-map.js";
import { getBackupData, getPianoModelsForType } from "../nord/backup-cache.js";

export function registerListParameters(server: McpServer): void {
  server.tool(
    "list_parameters",
    "List all available Nord Electro 5D parameters with their names, types, ranges, and descriptions. " +
      "Use this to understand what you can control on the keyboard.",
    {
      section: z
        .string()
        .optional()
        .describe(
          `Optional section filter: ${getSections().join(", ")}`
        ),
    },
    async ({ section }) => {
      const params = section
        ? getParamsBySection(section)
        : NORD_ELECTRO_5D_PARAMS;

      if (Object.keys(params).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: section
                ? `No parameters found for section "${section}". Available sections: ${getSections().join(", ")}`
                : "No parameters defined.",
            },
          ],
        };
      }

      const lines: string[] = [];
      let currentSection = "";

      for (const [key, param] of Object.entries(params)) {
        if (param.section !== currentSection) {
          currentSection = param.section;
          lines.push(`\n## ${currentSection.toUpperCase()}`);
        }

        let info = `  **${key}** — ${param.description}`;
        info += `\n    Type: ${param.type}`;

        if (param.drawbar) {
          info += ` | Range: 0-8 (drawbar position)`;
        } else if (param.labels) {
          const labelStr = Object.entries(param.labels)
            .map(([v, l]) => `${l}=${v}`)
            .join(", ");
          info += ` | Values: ${labelStr}`;
        } else {
          info += ` | Range: ${param.min}-${param.max}`;
        }

        info += ` | CC: ${param.cc}`;
        lines.push(info);

        // Append dynamic piano model names from inventory
        if (key === "piano_model") {
          const backup = getBackupData();
          if (backup) {
            for (const type of ["Grand", "Upright", "EP1", "EP2", "Clav", "Harpsichord"]) {
              const models = getPianoModelsForType(type);
              if (models && models.length > 0) {
                const modelList = models.map((m) => `${m.location}=${m.name}`).join(", ");
                lines.push(`    ${type}: ${modelList}`);
              }
            }
          } else {
            lines.push(`    (Run extract_backup to see available model names)`);
          }
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
