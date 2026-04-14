import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import type { ModelHolder } from "../shared/model-holder.js";

export function registerApplyPatch(
  server: McpServer,
  midi: MidiManager,
  holder: ModelHolder,
): void {
  server.registerTool(
    "apply_patch",
    {
      description: "Apply a complete keyboard patch. You can use a built-in preset name, custom parameters, or both " +
        "(preset as base + custom overrides). This sends all parameter changes to the keyboard in sequence.",
      inputSchema: {
        preset_name: z
          .string()
          .optional()
          .describe("Name of a built-in preset to use as base, e.g. 'Jazz Organ', 'Rhodes Ballad'"),
        parameters: z
          .record(z.union([z.number(), z.string()]))
          .optional()
          .describe("Custom parameters to set (or override preset values). Keys are parameter names, values are numbers or labels."),
        part: z
          .enum(["lower", "upper"])
          .optional()
          .describe("Target part for per-part parameters (default: upper)"),
      },
    },
    async ({ preset_name, parameters, part }) => {
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
      const combined: Record<string, number | string> = {};

      if (preset_name) {
        const preset = model.findPreset(preset_name);
        if (!preset) {
          const available = model.presets.map((p) => p.name).join(", ");
          return {
            content: [{ type: "text", text: `Preset "${preset_name}" not found. Available presets: ${available}` }],
            isError: true,
          };
        }
        Object.assign(combined, preset.parameters);
      }

      if (parameters) {
        Object.assign(combined, parameters);
      }

      if (Object.keys(combined).length === 0) {
        return {
          content: [{ type: "text", text: "No preset or parameters specified. Provide a preset_name and/or parameters." }],
          isError: true,
        };
      }

      const messages: Array<{ key: string; cc: number; value: number; name: string; perPart: boolean }> = [];
      const errors: string[] = [];
      const targetPart = part ?? "upper";

      for (const [name, value] of Object.entries(combined)) {
        const found = parameterMap.findParam(name);
        if (!found) {
          errors.push(`Unknown parameter: "${name}"`);
          continue;
        }
        try {
          const midiValue = parameterMap.resolveValue(found.param, value);
          messages.push({
            key: found.key,
            cc: found.param.cc,
            value: midiValue,
            name: found.param.name,
            perPart: parameterMap.isPerPart(found.key),
          });
        } catch (err) {
          errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await midi.sendCCBatch(messages.map((m) => ({ controller: m.cc, value: m.value })));

      for (const msg of messages) {
        state.set(msg.key, msg.value, msg.perPart ? targetPart : undefined);
      }

      let text = `Patch applied (${messages.length} parameters sent)`;
      if (preset_name) {
        const preset = model.findPreset(preset_name);
        text = `Preset "${preset?.name}" applied (${messages.length} parameters sent)`;
      }
      text += "\n\nCurrent state:\n" + state.format();

      if (errors.length > 0) {
        text += "\n\nWarnings:\n" + errors.join("\n");
      }

      return { content: [{ type: "text", text }] };
    },
  );
}
