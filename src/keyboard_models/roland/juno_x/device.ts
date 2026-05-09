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
import { buildDT1, addAddresses, packNibbles } from "../../../shared/roland-dt1.js";
import {
  JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID,
  SCENE_BASE, SCENE_PART_OFFSETS, PART_NAMES,
  ENGINE_DISPLAY_NAMES,
} from "./engines/engine-types.js";
import { JunoXState } from "./state-manager.js";
import type { JunoXParameterMap } from "./midi-map.js";

export class JunoXDevice extends BaseKeyboardDevice {
  private junoMap: JunoXParameterMap;
  private junoState: JunoXState;

  constructor(model: KeyboardModel, deps: BaseDeviceDeps) {
    const junoMap = deps.parameterMap as JunoXParameterMap;
    const junoState = new JunoXState(junoMap);
    super(model, deps, junoState);
    this.junoMap = junoMap;
    this.junoState = junoState;
  }

  /** Parts 1-5 are per-part; all others are global. Default to part "1". */
  protected override resolvePartForParam(key: string, part?: string): string | undefined {
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
        const prevMidi = this.junoState.get(found.key, statePart);

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

        this.junoState.set(found.key, midiValue, statePart);

        const displayValue = this.junoMap.formatValue(found.param, midiValue);
        const prevDisplay =
          prevMidi !== undefined
            ? this.junoMap.formatValue(found.param, prevMidi)
            : "unset";
        results.push(`  ${found.param.name}: ${prevDisplay} → ${displayValue}`);
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

  override listParameters(section?: string): ToolResult {
    const engines = this.junoState.getAllEngines();
    const engineLines = PART_NAMES.map(
      (name, i) => `Part ${name}: ${ENGINE_DISPLAY_NAMES[engines[i]]}`,
    );
    const header = "## ACTIVE ENGINES\n" + engineLines.join("\n");

    const base = super.listParameters(section);
    const baseText = base.content[0]?.text ?? "";

    return textResult(header + "\n\n" + baseText);
  }

  override getState(_section?: string): ToolResult {
    return textResult(
      "JUNO-X get_current_state via Roland RQ1 is not yet implemented (planned in todo #21). " +
      "The agent owns its memory of what it set in the meantime.",
    );
  }
}
