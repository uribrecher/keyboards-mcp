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
  if (param.oneBased) return `${midiValue + 1}`;
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
      "Drawbar values are 0-8 (Farfisa uses 0/1 toggles); other continuous parameters are 0-127. " +
      "Drawbar CCs modify the currently selected preset's registration — select a preset first, then set drawbars. " +
      "Piano and Sample Synth share model/sample selection across parts — only one piano model and one sample at a time. " +
      "Organ preset routing: In split mode, Preset 1 maps to the Lower part and Preset 2 to the Upper part. " +
      "To set different organ registrations per part: select Preset 1, set its drawbars, then select Preset 2 and set different drawbars. " +
      "Avoid using vibrato/chorus together with the rotary speaker (Leslie) — they clash sonically.",
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
          const midiValue = resolveValue(found.param, value);
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

      // Check if both parts use the same engine
      {
        // Resolve final engine values after all params in this batch
        let finalLower = state.get("part_lower_engine_select");
        let finalUpper = state.get("part_upper_engine_select");
        for (const { name, value } of parameters) {
          const found = findParam(name);
          if (!found) continue;
          if (found.key === "part_lower_engine_select") finalLower = resolveValue(found.param, value);
          if (found.key === "part_upper_engine_select") finalUpper = resolveValue(found.param, value);
        }

        if (finalLower !== undefined && finalUpper !== undefined && finalLower === finalUpper) {
          const engineIdx = midiToDiscrete(finalLower, 2);
          const engineNames: Record<number, string> = { 0: "Organ", 1: "Piano", 2: "Sample Synth" };
          const engineName = engineNames[engineIdx] ?? String(finalLower);

          if (isLayerMode) {
            // Layer mode: no engine can be shared
            warnings.push(
              `WARNING: In layer mode (split off), both parts CANNOT use the same engine. ` +
              `Both would be set to ${engineName}. ` +
              `Enable split mode first, or choose a different engine for one part.`
            );
          } else if (engineIdx !== 0) {
            // Split mode: Piano and Sample Synth cannot be shared (Organ is OK via presets)
            warnings.push(
              `WARNING: In split mode, both parts CANNOT use ${engineName} simultaneously. ` +
              `${engineName} shares model/sample selection across parts. ` +
              `Only Organ supports independent per-part configuration (via Preset 1/2).`
            );
          }
        }
      }

      // Check for shared piano/sample warnings in split mode
      const sharedParams = new Set(["piano_type", "piano_model", "sample_synth_sample"]);
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

      // Check for vibrato + rotary speaker clash
      const spkrType = state.get("spkr_comp_type");
      const spkrEnabled = state.get("spkr_comp_enable");
      const rotaryTypeValue = resolveValue(
        findParam("spkr_comp_type")!.param, "Rotary"
      );
      const isRotaryActive = spkrEnabled !== undefined && spkrEnabled > 0
        && spkrType !== undefined && spkrType === rotaryTypeValue;

      for (const { name, value } of parameters) {
        const found = findParam(name);
        if (!found) continue;

        // Warn if enabling vibrato while rotary is active
        if (found.key === "vibrato_enable" && resolveValue(found.param, value) > 0 && isRotaryActive) {
          warnings.push(
            `WARNING: Vibrato/chorus and the rotary speaker tend to clash. ` +
            `Consider disabling vibrato when using the Leslie/rotary effect.`
          );
        }
        // Warn if enabling rotary while vibrato is active
        if (found.key === "spkr_comp_type") {
          const vibratoEnabled = state.get("vibrato_enable");
          if (vibratoEnabled !== undefined && vibratoEnabled > 0
            && resolveValue(found.param, value) === rotaryTypeValue) {
            warnings.push(
              `WARNING: Vibrato/chorus and the rotary speaker tend to clash. ` +
              `Consider disabling vibrato when using the Leslie/rotary effect.`
            );
          }
        }
      }

      // Hint about organ preset routing in split mode
      if (splitMode && splitMode > 0) {
        for (const { name } of parameters) {
          const found = findParam(name);
          if (!found) continue;
          if (found.key === "organ_preset_select") {
            warnings.push(
              `NOTE: In split mode, Organ Preset 1 routes to the Lower part and ` +
              `Preset 2 routes to the Upper part. Set drawbars on each preset ` +
              `to configure different registrations per part.`
            );
            break;
          }
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
