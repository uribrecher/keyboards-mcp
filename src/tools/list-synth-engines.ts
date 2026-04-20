import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModelHolder } from "../shared/model-holder.js";
import { textResult } from "../shared/tool-result.js";

export function registerListSynthEngines(server: McpServer, holder: ModelHolder): void {
  server.registerTool(
    "list_synth_engines",
    {
      description: "List the synthesis engines available on the connected keyboard. " +
        "Returns each engine's ID, category, description, and whether it is eligible " +
        "for inverse synthesis (ML-based parameter prediction). Use this to determine " +
        "which sounds a device can produce and how to reproduce them.",
    },
    async () => {
      let model;
      try { model = holder.requireModel(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      const engines = model.synthEngines ?? [];
      if (engines.length === 0) {
        return textResult(
          `${model.info.displayName}: No synthesis engine metadata defined for this model.`,
        );
      }

      const lines = [
        `# ${model.info.displayName} — Synthesis Engines\n`,
        ...engines.map((e) => {
          const eligible = e.inverseSynthEligible ? "YES" : "NO (use preset/sample matching)";
          return [
            `## ${e.displayName} (${e.id})`,
            `- **Category:** ${e.category}`,
            `- **Inverse synthesis eligible:** ${eligible}`,
            `- ${e.description}`,
            "",
          ].join("\n");
        }),
      ];

      return textResult(lines.join("\n"));
    },
  );
}
