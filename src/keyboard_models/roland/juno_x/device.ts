/**
 * Roland JUNO-X device implementation.
 *
 * Routes parameter sends to either Roland DT1 SysEx or MIDI CC based on
 * the parameter's addressing. SysEx-addressed params use the DT1 protocol;
 * CC-addressed params are sent on the channel matching the part index (0-4).
 */

import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import { BaseKeyboardDevice, type BaseDeviceDeps } from "../../../shared/base-keyboard-device.js";
import type { ToolResult } from "../../../shared/tool-result.js";
import { textResult } from "../../../shared/tool-result.js";
import { buildDT1, addAddresses, packNibbles, requestRolandValue } from "../../../shared/roland-dt1.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import {
  JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID,
  SCENE_BASE, SCENE_PART_OFFSETS,
} from "./engines/engine-types.js";
import type { JunoXParameterMap } from "./midi-map.js";

export class JunoXDevice extends BaseKeyboardDevice {
  private junoMap: JunoXParameterMap;

  constructor(model: KeyboardModel, deps: BaseDeviceDeps) {
    super(model, deps);
    this.junoMap = deps.parameterMap as JunoXParameterMap;
  }

  /** Parts 1-5 are per-part; all others are global. Default to part "1". */
  private resolvePartForParam(key: string, part?: string): string | undefined {
    if (!this.parameterMap.isPerPart(key)) return undefined;
    return part ?? "1";
  }

  override setParameters(
    params: Array<{ name: string; value: number | string }>,
    part?: string,
  ): ToolResult {
    this.requireConnection();

    const results: string[] = [];
    const errors: string[] = [];

    for (const { name, value } of params) {
      const found = this.junoMap.findParam(name);
      if (!found) {
        errors.push(`Unknown parameter: "${name}"`);
        continue;
      }

      try {
        const midiValue = this.junoMap.resolveValue(found.param, value);
        const statePart = this.resolvePartForParam(found.key, part);

        if (found.param.sysexAddress !== undefined) {
          // DT1 SysEx path
          const partIndex = statePart !== undefined ? (parseInt(statePart, 10) - 1) : 0;
          let fullAddress: number[];
          if (found.param.perPart) {
            const partOffset = SCENE_PART_OFFSETS[partIndex] ?? SCENE_PART_OFFSETS[0];
            fullAddress = addAddresses(addAddresses(SCENE_BASE, partOffset), found.param.sysexAddress);
          } else {
            fullAddress = addAddresses(SCENE_BASE, found.param.sysexAddress);
          }

          const sysexSize = found.param.sysexSize ?? 1;
          const data = sysexSize > 1 ? packNibbles(midiValue, sysexSize * 2) : [midiValue];
          this.connection!.sendSysEx(buildDT1(JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddress, data));

        } else if (found.param.cc !== undefined) {
          // CC path — part index maps to MIDI channel (parts 1-5 → channels 0-4)
          const partIndex = statePart !== undefined ? (parseInt(statePart, 10) - 1) : 0;
          this.connection!.sendCC(found.param.cc, midiValue, partIndex);

        } else {
          errors.push(`${found.param.name}: no transport address (no sysexAddress or cc)`);
          continue;
        }

        const displayValue = this.junoMap.formatValue(found.param, midiValue);
        results.push(`  ${found.param.name}: ${displayValue}`);
      } catch (err) {
        errors.push(
          `${found.param.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let text = "";
    if (results.length > 0) {
      text += "Parameters set:\n" + results.join("\n");
    }
    if (errors.length > 0) {
      text += (text ? "\n\n" : "") + "Errors:\n" + errors.join("\n");
    }

    return { content: [{ type: "text", text }] };
  }

  /** Sections that #23 wired to live RQ1 reads. Other sections return a
   *  "not yet supported" tool result. */
  private static readonly RQ1_SUPPORTED_SECTIONS: readonly string[] = [
    "scene-chorus", "scene-delay", "scene-reverb", "scene-drive",
  ];

  override async getState(section?: string): Promise<ToolResult> {
    const conn = this.requireConnection();

    const supported = JunoXDevice.RQ1_SUPPORTED_SECTIONS;
    let sectionsToRead: string[];
    if (section === undefined) {
      sectionsToRead = [...supported];
    } else if (supported.includes(section)) {
      sectionsToRead = [section];
    } else {
      return textResult(
        `JUNO-X get_current_state is not yet supported for section "${section}". ` +
        `Currently supported: ${supported.join(", ")}. ` +
        `Other sections (scene-common, scene-part, scene-modify, partials, etc.) ` +
        `are tracked as follow-ups beyond this PR.`,
      );
    }

    // Look up every param in the requested sections that has a sysexAddress.
    const paramsToRead: Array<{ key: string; param: KeyboardParameter }> = [];
    for (const [key, param] of Object.entries(this.parameterMap.params)) {
      if (!sectionsToRead.includes(param.section)) continue;
      if (!param.sysexAddress) continue;
      paramsToRead.push({ key, param });
    }

    // Fire one RQ1 per param in parallel. Per-param timeouts surface in
    // the result text but don't fail the whole call.
    const PER_PARAM_TIMEOUT_MS = 500;
    const results = await Promise.all(paramsToRead.map(async ({ key, param }) => {
      const fullAddr = addAddresses(SCENE_BASE, param.sysexAddress!);
      try {
        const data = await requestRolandValue(
          conn, JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddr,
          param.sysexSize ?? 1, PER_PARAM_TIMEOUT_MS,
        );
        const value = data[0] ?? 0;
        const display = this.parameterMap.formatValue(param, value);
        return { key, line: `  ${param.name}: ${display}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { key, line: `  ${param.name}: ${/timeout/i.test(msg) ? "timeout" : `error (${msg})`}` };
      }
    }));

    if (results.length === 0) {
      return textResult(`No SysEx-addressed parameters in section "${section ?? "(all)"}".`);
    }

    // Group by section for readable output.
    const bySection = new Map<string, string[]>();
    for (const { key, line } of results) {
      const sec = this.parameterMap.params[key]!.section;
      if (!bySection.has(sec)) bySection.set(sec, []);
      bySection.get(sec)!.push(line);
    }

    const lines: string[] = ["Current state (live from device):"];
    for (const sec of sectionsToRead) {
      const sectionLines = bySection.get(sec);
      if (!sectionLines) continue;
      lines.push("");
      lines.push(`## ${sec}`);
      lines.push(...sectionLines);
    }

    return textResult(lines.join("\n"));
  }
}
