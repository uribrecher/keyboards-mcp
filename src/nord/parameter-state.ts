import {
  NORD_ELECTRO_5D_PARAMS,
  type NordParameter,
  midiToDrawbar,
  midiToDiscrete,
  midiToModelIndex,
  isPerPartParam,
} from "./nord-electro-5d-map.js";

export type Part = "lower" | "upper";

export class ParameterState {
  private globalState = new Map<string, number>();
  private partState = new Map<Part, Map<string, number>>([
    ["lower", new Map()],
    ["upper", new Map()],
  ]);

  /** Set a parameter's MIDI value, routing to global or per-part state */
  set(paramKey: string, midiValue: number, part?: Part): void {
    if (isPerPartParam(paramKey)) {
      const targetPart = part ?? "upper";
      this.partState.get(targetPart)!.set(paramKey, midiValue);
    } else {
      this.globalState.set(paramKey, midiValue);
    }
  }

  /** Get a parameter's current MIDI value */
  get(paramKey: string, part?: Part): number | undefined {
    if (isPerPartParam(paramKey)) {
      const targetPart = part ?? "upper";
      return this.partState.get(targetPart)!.get(paramKey);
    }
    return this.globalState.get(paramKey);
  }

  /** Get all current state as key -> value */
  getAll(part?: Part): Record<string, number> {
    const result: Record<string, number> = {};

    // Always include global state
    for (const [key, value] of this.globalState) {
      result[key] = value;
    }

    // Include per-part state if a part is specified
    if (part) {
      const pState = this.partState.get(part)!;
      for (const [key, value] of pState) {
        result[key] = value;
      }
    } else {
      // Include both parts' state
      for (const [, pState] of this.partState) {
        for (const [key, value] of pState) {
          result[key] = value;
        }
      }
    }

    return result;
  }

  /** Get state for a specific section */
  getBySection(section: string, part?: Part): Record<string, number> {
    const result: Record<string, number> = {};

    // Check global state
    for (const [key, value] of this.globalState) {
      const param = NORD_ELECTRO_5D_PARAMS[key];
      if (param && param.section === section) {
        result[key] = value;
      }
    }

    // Check per-part state
    if (part) {
      const pState = this.partState.get(part)!;
      for (const [key, value] of pState) {
        const param = NORD_ELECTRO_5D_PARAMS[key];
        if (param && param.section === section) {
          result[key] = value;
        }
      }
    } else {
      for (const [, pState] of this.partState) {
        for (const [key, value] of pState) {
          const param = NORD_ELECTRO_5D_PARAMS[key];
          if (param && param.section === section) {
            result[key] = value;
          }
        }
      }
    }

    return result;
  }

  /** Reset all state */
  reset(): void {
    this.globalState.clear();
    this.partState.get("lower")!.clear();
    this.partState.get("upper")!.clear();
  }

  /** Format the current state as a human-readable string */
  format(section?: string): string {
    const lines: string[] = [];

    // Global section
    const globalEntries: Array<[string, number]> = [];
    for (const [key, value] of this.globalState) {
      const param = NORD_ELECTRO_5D_PARAMS[key];
      if (param && (!section || param.section === section)) {
        globalEntries.push([key, value]);
      }
    }
    if (globalEntries.length > 0) {
      lines.push("Global:");
      for (const [key, midiValue] of globalEntries) {
        const param = NORD_ELECTRO_5D_PARAMS[key];
        if (param) lines.push(formatParamValue(key, param, midiValue));
      }
    }

    // Lower Part section
    const lowerState = this.partState.get("lower")!;
    const lowerEntries: Array<[string, number]> = [];
    for (const [key, value] of lowerState) {
      const param = NORD_ELECTRO_5D_PARAMS[key];
      if (param && (!section || param.section === section)) {
        lowerEntries.push([key, value]);
      }
    }
    if (lowerEntries.length > 0) {
      lines.push("Lower Part:");
      for (const [key, midiValue] of lowerEntries) {
        const param = NORD_ELECTRO_5D_PARAMS[key];
        if (param) lines.push(formatParamValue(key, param, midiValue));
      }
    }

    // Upper Part section
    const upperState = this.partState.get("upper")!;
    const upperEntries: Array<[string, number]> = [];
    for (const [key, value] of upperState) {
      const param = NORD_ELECTRO_5D_PARAMS[key];
      if (param && (!section || param.section === section)) {
        upperEntries.push([key, value]);
      }
    }
    if (upperEntries.length > 0) {
      lines.push("Upper Part:");
      for (const [key, midiValue] of upperEntries) {
        const param = NORD_ELECTRO_5D_PARAMS[key];
        if (param) lines.push(formatParamValue(key, param, midiValue));
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

function formatParamValue(key: string, param: NordParameter, midiValue: number): string {
  let displayValue: string;

  if (param.drawbar) {
    displayValue = `${midiToDrawbar(midiValue)} (MIDI: ${midiValue})`;
  } else if (param.modelIndex) {
    displayValue = `index ${midiToModelIndex(midiValue)} (MIDI: ${midiValue})`;
  } else if (param.labels && (param.type === "discrete" || param.type === "toggle")) {
    const index = midiToDiscrete(midiValue, param.max);
    const label = param.labels[index];
    displayValue = label ? `${label} (${midiValue})` : `${midiValue}`;
  } else {
    displayValue = `${midiValue}`;
  }

  return `  ${param.name} [${key}]: ${displayValue}`;
}
