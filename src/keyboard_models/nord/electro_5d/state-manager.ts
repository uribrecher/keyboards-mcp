/**
 * Nord Electro 5D state manager.
 * Extends the generic state manager with preset-drawbar routing.
 */

import type { ParameterMap } from "../../../shared/keyboard-model.js";
import { GenericParameterState } from "../../../shared/parameter-state.js";
import { formatValue, midiToDiscrete } from "../../../shared/parameter-resolution.js";

type Preset = "preset1" | "preset2";

export class NordElectro5DState extends GenericParameterState {
  private presetDrawbars = new Map<Preset, Map<string, number>>([
    ["preset1", new Map()],
    ["preset2", new Map()],
  ]);

  constructor(parameterMap: ParameterMap) {
    super(["lower", "upper"], parameterMap);
  }

  private isDrawbar(paramKey: string): boolean {
    return this.parameterMap.params[paramKey]?.encoding.kind === "drawbar";
  }

  private getCurrentPreset(): Preset {
    const presetVal = this.globalState.get("organ_preset_select");
    if (presetVal !== undefined && midiToDiscrete(presetVal, 1) === 1) return "preset2";
    return "preset1";
  }

  override set(paramKey: string, midiValue: number, part?: string): void {
    if (this.isDrawbar(paramKey)) {
      const preset = this.getCurrentPreset();
      this.presetDrawbars.get(preset)!.set(paramKey, midiValue);
    } else {
      super.set(paramKey, midiValue, part);
    }
  }

  override get(paramKey: string, part?: string): number | undefined {
    if (this.isDrawbar(paramKey)) {
      const preset = this.getCurrentPreset();
      return this.presetDrawbars.get(preset)!.get(paramKey);
    }
    return super.get(paramKey, part);
  }

  getPresetDrawbars(preset: Preset): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of this.presetDrawbars.get(preset)!) {
      result[key] = value;
    }
    return result;
  }

  override reset(): void {
    super.reset();
    this.presetDrawbars.get("preset1")!.clear();
    this.presetDrawbars.get("preset2")!.clear();
  }

  override format(section?: string): string {
    // Get base format (global + per-part)
    const baseParts = super.format(section);
    const lines: string[] = [];
    if (baseParts !== "No parameters have been set yet." &&
        baseParts !== `No parameters set for section "${section}".`) {
      lines.push(baseParts);
    }

    // Preset drawbar sections
    const params = this.parameterMap.params;
    for (const preset of ["preset1", "preset2"] as const) {
      const pDrawbars = this.presetDrawbars.get(preset)!;
      const entries: Array<[string, number]> = [];
      for (const [key, value] of pDrawbars) {
        const param = params[key];
        if (param && (!section || param.section === section)) {
          entries.push([key, value]);
        }
      }
      if (entries.length > 0) {
        const label = preset === "preset1" ? "Organ Preset 1" : "Organ Preset 2";
        const isCurrent = this.getCurrentPreset() === preset;
        lines.push(`${label}${isCurrent ? " (active)" : ""}:`);
        for (const [key, midiValue] of entries) {
          const param = params[key];
          if (param) lines.push(`  ${param.name} [${key}]: ${formatValue(param, midiValue)}`);
        }
      }
    }

    if (lines.length === 0) {
      return section
        ? `No parameters set for section "${section}".`
        : "No parameters have been set yet.";
    }

    return lines.join("\n");
  }
}
