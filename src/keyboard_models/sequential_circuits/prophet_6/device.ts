/**
 * Prophet-6 device instance.
 * Mono-timbral, no parts, no backup, no program/song loading.
 */

import type {
  KeyboardModel,
  KeyboardDevice,
  ParameterMap,
  StateManager,
  BackupData,
} from "../../../shared/keyboard-model.js";
import type { MidiConnection } from "../../../shared/midi-connection.js";
import type { ToolResult } from "../../../shared/tool-result.js";
import { textResult } from "../../../shared/tool-result.js";
import { GenericParameterState } from "../../../shared/parameter-state.js";

export interface Prophet6DeviceDeps {
  parameterMap: ParameterMap;
  systemPromptTemplate?: string;
}

export class Prophet6Device implements KeyboardDevice {
  readonly model: KeyboardModel;
  label?: string;
  backupData?: BackupData;

  private connection: MidiConnection | null = null;
  private state: StateManager;
  private parameterMap: ParameterMap;
  private systemPromptTemplate?: string;

  constructor(model: KeyboardModel, deps: Prophet6DeviceDeps) {
    this.model = model;
    this.parameterMap = deps.parameterMap;
    this.systemPromptTemplate = deps.systemPromptTemplate;
    this.state = new GenericParameterState([], this.parameterMap);
  }

  attach(connection: MidiConnection): void {
    this.connection = connection;

    // Listen for incoming CCs to update internal state
    connection.onCC((cc, value) => {
      const entry = this.parameterMap.getParamByCC(cc);
      if (!entry) return;
      this.state.set(entry.key, value);
    });
  }

  detach(): void {
    this.connection = null;
    this.state.reset();
  }

  private requireConnection(): MidiConnection {
    if (!this.connection) {
      throw new Error("Not connected to any MIDI device. Use connect_to_keyboard first.");
    }
    return this.connection;
  }

  listParameters(section?: string): ToolResult {
    const params = section
      ? this.parameterMap.getParamsBySection(section)
      : this.parameterMap.params;

    if (Object.keys(params).length === 0) {
      return textResult(
        section
          ? `No parameters found for section "${section}". Available sections: ${this.parameterMap.getSections().join(", ")}`
          : "No parameters defined.",
      );
    }

    const lines: string[] = [];
    let currentSection = "";

    for (const [key, param] of Object.entries(params)) {
      if (param.section !== currentSection) {
        currentSection = param.section;
        lines.push(`\n## ${currentSection.toUpperCase()}`);
      }

      let info = `  **${key}** — ${param.description}`;
      info += `\n    Type: ${param.type}`;

      if (param.encoding.kind === "drawbar") {
        info += ` | Range: 0-${param.encoding.positions - 1} (drawbar position)`;
      } else if (param.labels) {
        const labelStr = Object.entries(param.labels)
          .map(([v, l]) => `${l}=${v}`)
          .join(", ");
        info += ` | Values: ${labelStr}`;
      } else {
        info += ` | Range: ${param.min}-${param.max}`;
      }

      info += ` | CC: ${param.cc}`;
      lines.push(info);
    }

    return textResult(lines.join("\n"));
  }

  setParameters(
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
        const midiValue = this.parameterMap.resolveValue(found.param, value);
        const prevMidi = this.state.get(found.key);

        this.connection!.sendCC(found.param.cc, midiValue);
        this.state.set(found.key, midiValue);

        const displayValue = this.parameterMap.formatValue(found.param, midiValue);
        const prevDisplay =
          prevMidi !== undefined
            ? this.parameterMap.formatValue(found.param, prevMidi)
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

  getState(section?: string): ToolResult {
    return textResult(this.state.format(section));
  }

  loadProgram(_bank: number, _slot: number): ToolResult {
    return textResult(`${this.model.info.displayName} does not support program loading via MIDI.`);
  }

  loadSong(_bank: number, _slot: number, _part?: string): ToolResult {
    return textResult(`${this.model.info.displayName} does not support set list loading.`);
  }

  listPrograms(_filter?: string, _bank?: number): ToolResult {
    return textResult(`${this.model.info.displayName} does not support program inventory.`);
  }

  listSongs(_filter?: string, _bank?: number): ToolResult {
    return textResult(`${this.model.info.displayName} does not support set list inventory.`);
  }

  getSystemPrompt(): ToolResult {
    const template = this.systemPromptTemplate;
    if (!template) {
      return textResult(
        `${this.model.info.displayName} does not provide a system prompt.`,
      );
    }

    let prompt = template;

    prompt +=
      "\n\nTERMINOLOGY: In keyboard jargon, 'program', 'preset', and 'patch' " +
      "are near-synonymous — they all refer to a stored sound configuration. " +
      "Online resources use these interchangeably.";

    if (this.label) {
      prompt += `\n\nDEVICE LABEL: "${this.label}"`;
    }

    return textResult(prompt);
  }
}
