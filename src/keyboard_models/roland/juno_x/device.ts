/** Roland JUNO-X device. Outgoing param writes go through the codec
 *  (DT1 SysEx for sysex-addressed params, CC otherwise). `getState`
 *  fans out RQ1 reads and renders the live device values. */

import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import { BaseKeyboardDevice, type BaseDeviceDeps } from "../../../shared/base-keyboard-device.js";
import type { ToolResult } from "../../../shared/tool-result.js";
import { textResult } from "../../../shared/tool-result.js";
import { addAddresses, requestRolandValue } from "../../../shared/roland-dt1.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import type { MidiCodec, ParamRef } from "../../../shared/midi-codec.js";
import {
  JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID,
  SCENE_BASE,
} from "./engines/engine-types.js";
export class JunoXDevice extends BaseKeyboardDevice {
  constructor(model: KeyboardModel, deps: BaseDeviceDeps) {
    super(model, deps);
  }

  /** The model's codec (lazy from the base class). Throws if missing. */
  private get junoCodec(): MidiCodec {
    const c = this.codec;
    if (!c) throw new Error("JUNO-X model is missing createCodec()");
    return c;
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
      const found = this.parameterMap.findParam(name);
      if (!found) {
        errors.push(`Unknown parameter: "${name}"`);
        continue;
      }

      try {
        const statePart = this.resolvePartForParam(found.key, part);
        // Only set part for perPart params — global params should leave the
        // channel undefined so the connection's default channel is used.
        const ref: ParamRef = statePart !== undefined
          ? { name: found.key, value, part: parseInt(statePart, 10) }
          : { name: found.key, value };
        const messages = this.junoCodec.encodeParams([ref]);
        for (const msg of messages) this.sendEncodedMessage(msg);
        results.push(`  ${found.param.name}: ${this.junoCodec.formatValue(found.key, value)}`);
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

  /** Sections that have live RQ1 read support. */
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
        `Currently supported: ${supported.join(", ")}.`,
      );
    }

    // Sysex-addressed params in the requested sections.
    const paramsToRead: Array<{ key: string; param: KeyboardParameter }> = [];
    for (const [key, param] of Object.entries(this.parameterMap.params)) {
      if (!sectionsToRead.includes(param.section)) continue;
      if (!param.sysexAddress) continue;
      paramsToRead.push({ key, param });
    }

    // Fire one RQ1 per param in parallel; per-param timeouts surface in
    // the rendered text but don't fail the whole call. `requestRolandValue`
    // owns the request/response orchestration; the codec decodes each reply.
    const PER_PARAM_TIMEOUT_MS = 500;
    const results = await Promise.all(paramsToRead.map(async ({ key, param }) => {
      const fullAddr = addAddresses(SCENE_BASE, param.sysexAddress!);
      const sysexSize = param.sysexSize ?? 1;
      try {
        const data = await requestRolandValue(
          conn, JUNO_X_MODEL_ID, JUNO_X_DEVICE_ID, fullAddr,
          sysexSize, PER_PARAM_TIMEOUT_MS,
        );
        const replyMsg = this.junoCodec.buildResponse(
          { protocol: "roland-rq1", address: fullAddr, size: sysexSize, deviceId: JUNO_X_DEVICE_ID },
          data,
        );
        const events = this.junoCodec.decode(replyMsg);
        const paramEvent = events.find(e => e.kind === "param" && e.name === key);
        // Fallback wire→user is only reached when decode misses the
        // expected key (shouldn't happen for known params).
        const userValue = paramEvent && paramEvent.kind === "param"
          ? paramEvent.value
          : this.junoCodec.wireToUserValue(key, data[0] ?? 0);
        const display = this.junoCodec.formatValue(key, userValue);
        return { key, line: `  ${param.name}: ${display}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { key, line: `  ${param.name}: ${/timeout/i.test(msg) ? "timeout" : `error (${msg})`}` };
      }
    }));

    if (results.length === 0) {
      return textResult(`No SysEx-addressed parameters in section "${section ?? "(all)"}".`);
    }

    // Group by section for the rendered output.
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
