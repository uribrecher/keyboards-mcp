import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MidiManager } from "../midi/midi-manager.js";
import type { ParameterState } from "../nord/parameter-state.js";
import {
  findParam,
  resolveValue,
  midiToDrawbar,
  midiToDiscrete,
  midiToModelIndex,
  isPerPartParam,
} from "../nord/nord-electro-5d-map.js";
import type { NordParameter } from "../nord/nord-electro-5d-map.js";
import type { Part } from "../nord/parameter-state.js";

function formatDisplay(param: NordParameter, midiValue: number): string {
  if (param.drawbar) return `${midiToDrawbar(midiValue)}`;
  if (param.modelIndex) return `${midiToModelIndex(midiValue)}`;
  if ((param.type === "discrete" || param.type === "toggle") && param.labels) {
    return param.labels[midiToDiscrete(midiValue, param.max)] ?? `${midiValue}`;
  }
  return `${midiValue}`;
}

export function registerSetParameters(
  server: McpServer,
  midi: MidiManager,
  state: ParameterState
): void {
  server.tool(
    "set_parameters",
    "Set one or more Nord Electro 5D parameters. " +
      "Accepts parameter names (e.g. 'drawbar_1', 'reverb_dry_wet', 'organ_model') with numeric values or string labels (e.g. 'B3', 'Hall', 'Fast'). " +
      "Drawbar values are 0-8; other continuous parameters are 0-127. " +
      "Per-part params (organ/piano/sample_synth) accept an optional 'part' field ('lower' or 'upper', default: 'upper'). " +
      "Note: Organ is fully bi-timbral (independent per part). Piano and Sample Synth share model/sample selection across parts — only one piano model and one sample at a time.",
    {
      parameters: z
        .array(
          z.object({
            name: z
              .string()
              .describe(
                "Parameter key or name, e.g. 'drawbar_1', 'organ_model', 'reverb_type'"
              ),
            value: z
              .union([z.number(), z.string()])
              .describe(
                "Numeric value or string label, e.g. 8, 'B3', 'Hall', 'Fast'"
              ),
          })
        )
        .describe("Array of parameter name/value pairs to set"),
      part: z
        .enum(["lower", "upper"])
        .optional()
        .describe("Target part for per-part params (default: upper)"),
    },
    async ({ parameters, part }) => {
      if (!midi.isConnected()) {
        return {
          content: [
            {
              type: "text",
              text: "Not connected to any MIDI device. Use connect_to_nord first.",
            },
          ],
          isError: true,
        };
      }

      const results: string[] = [];
      const errors: string[] = [];

      for (const { name, value } of parameters) {
        const found = findParam(name);
        if (!found) {
          errors.push(`Unknown parameter: "${name}"`);
          continue;
        }

        try {
          // For piano_model, resolve the current piano type for correct MIDI encoding
          let pianoType: string | undefined;
          if (found.param.modelIndex) {
            const pianoTypeParam = findParam("piano_type");
            if (pianoTypeParam) {
              const ptMidi = state.get("piano_type");
              if (ptMidi !== undefined) {
                pianoType = pianoTypeParam.param.labels?.[midiToDiscrete(ptMidi, pianoTypeParam.param.max)];
              }
            }
          }
          const midiValue = resolveValue(found.param, value, pianoType);
          const targetPart: Part = part ?? "upper";
          const prevMidi = state.get(found.key, isPerPartParam(found.key) ? targetPart : undefined);

          // All CCs are sent on the global channel — the Nord receives CC
          // messages only on the global channel. Per-part channels are used
          // by the hardware for note routing only.
          midi.sendCC(found.param.cc, midiValue);
          state.set(found.key, midiValue, isPerPartParam(found.key) ? targetPart : undefined);

          const displayValue = formatDisplay(found.param, midiValue);
          const prevDisplay = prevMidi !== undefined ? formatDisplay(found.param, prevMidi) : "unset";

          results.push(
            `  ${found.param.name}: ${prevDisplay} → ${displayValue}`
          );
        } catch (err) {
          errors.push(
            `${found.param.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Check for bi-timbral warnings
      const warnings: string[] = [];
      const targetPart: Part = part ?? "upper";
      const otherPart: Part = targetPart === "upper" ? "lower" : "upper";
      const splitMode = state.get("kb_split_mode");
      const isLayerMode = !splitMode || splitMode === 0;

      const targetEngineKey = targetPart === "lower" ? "part_lower_engine_select" : "part_upper_engine_select";
      const otherEngineKey = otherPart === "lower" ? "part_lower_engine_select" : "part_upper_engine_select";
      const targetEngine = state.get(targetEngineKey);
      const otherEngine = state.get(otherEngineKey);

      // Check if engine select is being set to same engine in layer mode
      for (const { name, value } of parameters) {
        const found = findParam(name);
        if (!found) continue;

        if ((found.key === "part_lower_engine_select" || found.key === "part_upper_engine_select") && isLayerMode) {
          const newVal = resolveValue(found.param, value);
          const otherVal = found.key === targetEngineKey ? otherEngine : targetEngine;
          if (otherVal !== undefined && newVal === otherVal) {
            const engineNames: Record<number, string> = { 0: "Organ", 1: "Piano", 2: "Sample Synth" };
            warnings.push(
              `WARNING: In layer mode (split off), both parts CANNOT use the same engine. ` +
              `Both would be set to ${engineNames[newVal] ?? newVal}. ` +
              `Enable split mode first, or choose a different engine for one part.`
            );
          }
        }
      }

      // Check for shared piano/sample warnings in split mode
      const sharedParams = new Set(["piano_type", "piano_model", "piano_variation", "sample_synth_sample"]);
      for (const { name } of parameters) {
        const found = findParam(name);
        if (!found || !sharedParams.has(found.key)) continue;

        if (targetEngine !== undefined && targetEngine === otherEngine) {
          const engineName = found.key.startsWith("piano") ? "Piano" : "Sample Synth";
          warnings.push(
            `WARNING: Both parts are using ${engineName}. Changing ${found.param.name} will affect BOTH parts ` +
            `(hardware limitation — ${engineName} shares model/sample selection across parts).`
          );
          break;
        }
      }

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
    }
  );
}
