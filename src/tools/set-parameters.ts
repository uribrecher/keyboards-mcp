import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerSetParameters(
  server: McpServer,
  midi: MidiManager,
  holder: ModelHolder,
): void {
  server.registerTool(
    "set_parameters",
    {
      description: "Set one or more keyboard parameters. " +
        "Accepts parameter names (e.g. 'drawbar_1', 'reverb_dry_wet', 'organ_model') with numeric values or string labels (e.g. 'B3', 'Hall', 'Fast'). " +
        "Drawbar values are 0-8 (Farfisa uses 0/1 toggles); other continuous parameters are 0-127. " +
        "Drawbar CCs modify the currently selected preset's registration — select a preset first, then set drawbars. " +
        "Piano and Sample Synth share model/sample selection across parts — only one piano model and one sample at a time. " +
        "Organ preset routing: In split mode, Preset 1 maps to the Lower part and Preset 2 to the Upper part. " +
        "To set different organ registrations per part: select Preset 1, set its drawbars, then select Preset 2 and set different drawbars. " +
        "Avoid using vibrato/chorus together with the rotary speaker (Leslie) — they clash sonically.",
      inputSchema: {
        parameters: z
          .array(
            z.object({
              name: z.string().describe("Parameter key or name, e.g. 'drawbar_1', 'organ_model', 'reverb_type'"),
              value: z.union([z.number(), z.string()]).describe("Numeric value or string label, e.g. 8, 'B3', 'Hall', 'Fast'"),
            }),
          )
          .describe("Array of parameter name/value pairs to set"),
        part: z
          .enum(["lower", "upper"])
          .optional()
          .describe("Target part for per-part params (default: upper)"),
      },
    },
    async ({ parameters, part }) => {
      let model, state;
      try { model = holder.requireModel(); state = holder.requireState(); }
      catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }

      if (!midi.isConnected()) {
        return {
          content: [{ type: "text", text: "Not connected to any MIDI device. Use connect_to_keyboard first." }],
          isError: true,
        };
      }

      const { parameterMap } = model;
      const results: string[] = [];
      const errors: string[] = [];
      const resolvedKeys: Array<{ key: string; value: number | string }> = [];

      for (const { name, value } of parameters) {
        const found = parameterMap.findParam(name);
        if (!found) {
          errors.push(`Unknown parameter: "${name}"`);
          continue;
        }

        try {
          const midiValue = parameterMap.resolveValue(found.param, value);
          const targetPart = part ?? "upper";
          const prevMidi = state.get(found.key, parameterMap.isPerPart(found.key) ? targetPart : undefined);

          midi.sendCC(found.param.cc, midiValue);
          state.set(found.key, midiValue, parameterMap.isPerPart(found.key) ? targetPart : undefined);
          resolvedKeys.push({ key: found.key, value });

          const displayValue = parameterMap.formatValue(found.param, midiValue);
          const prevDisplay = prevMidi !== undefined ? parameterMap.formatValue(found.param, prevMidi) : "unset";
          results.push(`  ${found.param.name}: ${prevDisplay} → ${displayValue}`);
        } catch (err) {
          errors.push(`${found.param.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const warnings = model.validateParameterBatch?.(resolvedKeys, state, part ?? "upper") ?? [];

      let text = "";
      if (results.length > 0) {
        text += "Parameters set:\n" + results.join("\n");
      }
      if (warnings.length > 0) {
        text += (text ? "\n\n" : "") + warnings.join("\n");
      }
      if (errors.length > 0) {
        text += (text ? "\n\n" : "") + "Errors:\n" + errors.join("\n");
      }

      return {
        content: [{ type: "text", text }],
        isError: errors.length > 0 && results.length === 0,
      };
    },
  );
}
