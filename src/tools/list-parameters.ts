import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerListParameters(server: McpServer, holder: ModelHolder): void {
  server.registerTool(
    "list_parameters",
    {
      description: "List all available keyboard parameters with their names, types, ranges, and descriptions. " +
        "Use this to understand what you can control on the keyboard. " +
        "Omit the section parameter to list ALL parameters across all sections.",
      inputSchema: {
        section: z
          .string()
          .optional()
          .describe("Optional section filter (e.g. organ, piano, effect1, reverb, etc.). Omit to list all parameters."),
      },
    },
    async ({ section }) => {
      let model;
      try { model = holder.requireModel(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      const { parameterMap } = model;
      const params = section
        ? parameterMap.getParamsBySection(section)
        : parameterMap.params;

      if (Object.keys(params).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: section
                ? `No parameters found for section "${section}". Available sections: ${parameterMap.getSections().join(", ")}`
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

        if (param.encoding.kind === "drawbar") {
          info += ` | Range: 0-${param.encoding.positions - 1} (drawbar position)`;
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

        if (key === "piano_model" && model.backupCache) {
          const backup = model.backupCache.get();
          if (backup && "pianos" in backup) {
            const pianos = (backup as any).pianos as Array<{ category: string; location: number; name: string }>;
            const typeToCategory: Record<string, string> = {
              Grand: "Grand", Upright: "Upright", EP1: "EPiano1",
              EP2: "EPiano2", Clav: "Clavinet", Harpsichord: "Harps",
            };
            for (const type of ["Grand", "Upright", "EP1", "EP2", "Clav", "Harpsichord"]) {
              const category = typeToCategory[type];
              const models = pianos
                .filter((p) => p.category === category)
                .sort((a, b) => a.location - b.location);
              if (models.length > 0) {
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
    },
  );
}
