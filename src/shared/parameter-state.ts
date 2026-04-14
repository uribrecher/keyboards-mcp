/**
 * Generic parameter state manager.
 * Tracks global + per-part state. Keyboard models can extend this
 * for additional routing (e.g. Nord preset-drawbar routing).
 */

import type { ParameterMap, StateManager } from "./keyboard-model.js";
import { formatValue } from "./parameter-resolution.js";

export class GenericParameterState implements StateManager {
  protected globalState = new Map<string, number>();
  protected partState = new Map<string, Map<string, number>>();

  constructor(
    protected parts: string[],
    protected parameterMap: ParameterMap,
  ) {
    for (const p of parts) {
      this.partState.set(p, new Map());
    }
  }

  set(paramKey: string, midiValue: number, part?: string): void {
    if (this.parameterMap.isPerPart(paramKey)) {
      const targetPart = part ?? this.parts[this.parts.length - 1];
      this.partState.get(targetPart)?.set(paramKey, midiValue);
    } else {
      this.globalState.set(paramKey, midiValue);
    }
  }

  get(paramKey: string, part?: string): number | undefined {
    if (this.parameterMap.isPerPart(paramKey)) {
      const targetPart = part ?? this.parts[this.parts.length - 1];
      return this.partState.get(targetPart)?.get(paramKey);
    }
    return this.globalState.get(paramKey);
  }

  getAll(part?: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of this.globalState) {
      result[key] = value;
    }
    if (part) {
      const pState = this.partState.get(part);
      if (pState) {
        for (const [key, value] of pState) {
          result[key] = value;
        }
      }
    } else {
      for (const [, pState] of this.partState) {
        for (const [key, value] of pState) {
          result[key] = value;
        }
      }
    }
    return result;
  }

  getBySection(section: string, part?: string): Record<string, number> {
    const result: Record<string, number> = {};
    const params = this.parameterMap.params;

    for (const [key, value] of this.globalState) {
      if (params[key]?.section === section) {
        result[key] = value;
      }
    }
    if (part) {
      const pState = this.partState.get(part);
      if (pState) {
        for (const [key, value] of pState) {
          if (params[key]?.section === section) {
            result[key] = value;
          }
        }
      }
    } else {
      for (const [, pState] of this.partState) {
        for (const [key, value] of pState) {
          if (params[key]?.section === section) {
            result[key] = value;
          }
        }
      }
    }
    return result;
  }

  reset(): void {
    this.globalState.clear();
    for (const [, pState] of this.partState) {
      pState.clear();
    }
  }

  format(section?: string): string {
    const lines: string[] = [];
    const params = this.parameterMap.params;

    // Global
    const globalEntries: Array<[string, number]> = [];
    for (const [key, value] of this.globalState) {
      const param = params[key];
      if (param && (!section || param.section === section)) {
        globalEntries.push([key, value]);
      }
    }
    if (globalEntries.length > 0) {
      lines.push("Global:");
      for (const [key, midiValue] of globalEntries) {
        const param = params[key];
        if (param) lines.push(`  ${param.name} [${key}]: ${formatValue(param, midiValue)}`);
      }
    }

    // Per-part
    for (const partName of this.parts) {
      const pState = this.partState.get(partName)!;
      const entries: Array<[string, number]> = [];
      for (const [key, value] of pState) {
        const param = params[key];
        if (param && (!section || param.section === section)) {
          entries.push([key, value]);
        }
      }
      if (entries.length > 0) {
        const label = partName.charAt(0).toUpperCase() + partName.slice(1);
        lines.push(`${label} Part:`);
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
