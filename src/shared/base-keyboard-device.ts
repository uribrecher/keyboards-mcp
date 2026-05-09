/**
 * Base class for KeyboardDevice implementations.
 * Provides generic defaults for all tool methods. Models extend and override
 * only what differs (e.g., per-part routing, validation, backup inventory).
 */

import type {
  KeyboardModel,
  KeyboardDevice,
  ParameterMap,
  StateManager,
  BackupData,
  ProgramLoaderCapability,
  SongLoaderCapability,
} from "./keyboard-model.js";
import type { KeyboardParameter } from "./types.js";
import type { MidiConnection } from "./midi-connection.js";
import type { ToolResult } from "./tool-result.js";
import { textResult } from "./tool-result.js";

export interface BaseDeviceDeps {
  parameterMap: ParameterMap;
  systemPromptTemplate?: string;
  programLoader?: ProgramLoaderCapability;
  songLoader?: SongLoaderCapability;
}

export abstract class BaseKeyboardDevice implements KeyboardDevice {
  readonly model: KeyboardModel;
  label?: string;
  backupData?: BackupData;

  protected connection: MidiConnection | null = null;
  protected state: StateManager;
  protected parameterMap: ParameterMap;
  protected programLoader?: ProgramLoaderCapability;
  protected songLoader?: SongLoaderCapability;
  protected systemPromptTemplate?: string;

  constructor(model: KeyboardModel, deps: BaseDeviceDeps, state: StateManager) {
    this.model = model;
    this.parameterMap = deps.parameterMap;
    this.programLoader = deps.programLoader;
    this.songLoader = deps.songLoader;
    this.systemPromptTemplate = deps.systemPromptTemplate;
    this.state = state;
  }

  // ── Connection lifecycle ──

  attach(connection: MidiConnection): void {
    this.connection = connection;
    connection.onCC((cc, value, channel) => {
      this.onIncomingCC(cc, value, channel);
    });
  }

  detach(): void {
    this.connection = null;
    this.state.reset();
  }

  protected requireConnection(): MidiConnection {
    if (!this.connection) {
      throw new Error("Not connected to any MIDI device. Use connect_to_keyboard first.");
    }
    return this.connection;
  }

  /** Override for model-specific CC routing (e.g., per-part state updates) */
  protected onIncomingCC(cc: number, value: number, _channel: number): void {
    const entry = this.parameterMap.getParamByCC(cc);
    if (!entry) return;
    this.state.set(entry.key, value);
  }

  // ── Tool implementations ──

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
      const nameLine = param.displayName && param.displayName !== param.name
        ? `${param.name} (UI: ${param.displayName})`
        : param.name;
      info += `\n    Name: ${nameLine}`;
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

      if (param.cc !== undefined) info += ` | CC: ${param.cc}`;
      lines.push(info);

      // Hook for model-specific extras (e.g., piano model list from backup)
      const extra = this.formatParameterExtra(key, param);
      if (extra) {
        for (const line of extra) lines.push(line);
      }
    }

    return textResult(lines.join("\n"));
  }

  /** Override to add extra lines after a specific parameter in listParameters */
  protected formatParameterExtra(_key: string, _param: KeyboardParameter): string[] | null {
    return null;
  }

  setParameters(
    params: Array<{ name: string; value: number | string }>,
    part?: string,
  ): ToolResult {
    this.requireConnection();

    const results: string[] = [];
    const errors: string[] = [];
    const resolvedKeys: Array<{ key: string; value: number | string }> = [];
    type ApplyEntry = {
      found: { key: string; param: KeyboardParameter };
      midiValue: number;
      value: number | string;
      statePart: string | undefined;
    };
    const applyQueue: ApplyEntry[] = [];

    // Phase 1: resolve parameters without applying. Resolution failures go
    // straight to errors.
    for (const { name, value } of params) {
      const found = this.parameterMap.findParam(name);
      if (!found) {
        errors.push(`Unknown parameter: "${name}"`);
        continue;
      }

      try {
        const midiValue = this.parameterMap.resolveValue(found.param, value);
        const statePart = this.resolvePartForParam(found.key, part);
        applyQueue.push({ found, midiValue, value, statePart });
        resolvedKeys.push({ key: found.key, value });
      } catch (err) {
        errors.push(
          `${found.param.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Phase 2: preflight — let the model refuse changes (e.g. params in a
    // disabled section). Blocked keys must NOT be sent to the device.
    const preflight = this.preflightBatch(resolvedKeys, part ?? "upper");

    // Phase 3: apply non-blocked params.
    for (const entry of applyQueue) {
      if (preflight.blockedKeys.has(entry.found.key)) continue;
      const prevMidi = this.state.get(entry.found.key, entry.statePart);
      if (entry.found.param.cc !== undefined) {
        this.connection!.sendCC(entry.found.param.cc, entry.midiValue);
      }
      this.state.set(entry.found.key, entry.midiValue, entry.statePart);

      const displayValue = this.parameterMap.formatValue(entry.found.param, entry.midiValue);
      const prevDisplay =
        prevMidi !== undefined
          ? this.parameterMap.formatValue(entry.found.param, prevMidi)
          : "unset";
      results.push(`  ${entry.found.param.name}: ${prevDisplay} → ${displayValue}`);
    }

    // Phase 4: post-apply advisory warnings. Skip keys that the preflight
    // refused — they were never sent, so warnings about them would mislead.
    const appliedKeys = preflight.blockedKeys.size === 0
      ? resolvedKeys
      : resolvedKeys.filter((k) => !preflight.blockedKeys.has(k.key));
    const warnings = this.validateAfterSet(appliedKeys, part ?? "upper");

    if (preflight.errors.length > 0) errors.push(...preflight.errors);

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

    const result: ToolResult = { content: [{ type: "text", text }] };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /** Override for per-part state routing. Return undefined for global-only models. */
  protected resolvePartForParam(_key: string, _part?: string): string | undefined {
    return undefined;
  }

  /**
   * Override to refuse parameter changes before they are sent to the device.
   * Keys returned in `blockedKeys` are skipped during the apply phase, and
   * `errors` are surfaced in the tool result. Default: no blocking.
   */
  protected preflightBatch(
    _resolvedKeys: Array<{ key: string; value: number | string }>,
    _part: string,
  ): { errors: string[]; blockedKeys: Set<string> } {
    return { errors: [], blockedKeys: new Set() };
  }

  /** Override to return advisory warnings after setParameters has applied. */
  protected validateAfterSet(
    _resolvedKeys: Array<{ key: string; value: number | string }>,
    _part: string,
  ): string[] {
    return [];
  }

  getState(section?: string): ToolResult {
    return textResult(this.state.format(section));
  }

  async loadProgram(bank: number, slot: number): Promise<ToolResult> {
    if (!this.programLoader) {
      return textResult(`${this.model.info.displayName} does not support program loading.`);
    }
    const conn = this.requireConnection();
    const loader = this.programLoader;

    if (bank < loader.bankRange.min || bank > loader.bankRange.max) {
      return textResult(
        `Bank must be ${loader.bankRange.min}-${loader.bankRange.max} for ${this.model.info.displayName}.`,
      );
    }
    if (slot < loader.slotRange.min || slot > loader.slotRange.max) {
      return textResult(
        `Slot must be ${loader.slotRange.min}-${loader.slotRange.max} for ${this.model.info.displayName}.`,
      );
    }

    await loader.loadProgram(conn, bank, slot);
    return textResult(`Loaded program ${bank}:${slot}`);
  }

  async loadSong(bank: number, slot: number, part?: string): Promise<ToolResult> {
    if (!this.songLoader) {
      return textResult(`${this.model.info.displayName} does not support set list loading.`);
    }
    const conn = this.requireConnection();
    const loader = this.songLoader;
    const parts = loader.parts ?? ["A", "B", "C", "D"];
    const partLabel = part ?? parts[0];

    await loader.loadSong(conn, bank, slot, partLabel);
    return textResult(`Set list ${bank}, song ${slot}, part ${partLabel}`);
  }

  listPrograms(_filter?: string, _bank?: number): ToolResult {
    return textResult(
      "No backup data loaded. Use extract_backup first to load this device's inventory.",
    );
  }

  listSongs(_filter?: string, _bank?: number): ToolResult {
    return textResult(
      "No backup data loaded. Use extract_backup first to load this device's inventory.",
    );
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
      "Online resources use these interchangeably. In this system, stored sounds " +
      "are called programs and are managed via list_programs / load_program.";

    if (this.backupData) {
      const parts: string[] = [];
      if ("pianos" in this.backupData) {
        parts.push(`${(this.backupData.pianos as any[]).length} pianos`);
      }
      if ("samples" in this.backupData) {
        parts.push(`${(this.backupData.samples as any[]).length} samples`);
      }
      if ("programs" in this.backupData) {
        parts.push(`${(this.backupData.programs as any[]).length} programs`);
      }
      if ("setLists" in this.backupData) {
        parts.push(`${(this.backupData.setLists as any[]).length} set list songs`);
      }
      if (parts.length > 0) {
        prompt += `\n\nBACKUP INVENTORY: ${parts.join(", ")}. Use list_programs and list_songs to browse.`;
      }
    }

    if (this.label) {
      prompt += `\n\nDEVICE LABEL: "${this.label}"`;
    }

    return textResult(prompt);
  }
}
