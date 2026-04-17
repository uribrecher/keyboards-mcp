/**
 * Nord Electro 5D device instance.
 * Implements the KeyboardDevice interface — owns connection, state, and all tool logic.
 */

import type {
  KeyboardModel,
  KeyboardDevice,
  KeyboardModelInfo,
  ParameterMap,
  StateManager,
  BackupData,
  ProgramLoaderCapability,
  SongLoaderCapability,
} from "../../../shared/keyboard-model.js";
import type { MidiSender } from "../../../shared/midi-sender.js";
import type { MidiConnection } from "../../../shared/midi-connection.js";
import type { ToolResult } from "../../../shared/tool-result.js";
import { textResult } from "../../../shared/tool-result.js";
import { formatValue } from "../../../shared/parameter-resolution.js";
import { validateParameterBatch } from "./validation.js";
import { NordElectro5DState } from "./state-manager.js";

export interface NordDeviceDeps {
  parameterMap: ParameterMap;
  programLoader: ProgramLoaderCapability;
  songLoader: SongLoaderCapability;
  systemPromptTemplate: string;
}

export class NordElectro5DDevice implements KeyboardDevice {
  readonly model: KeyboardModel;
  label?: string;
  backupData?: BackupData;

  private connection: MidiConnection | null = null;
  private state: StateManager;
  private parameterMap: ParameterMap;
  private programLoader: ProgramLoaderCapability;
  private songLoader: SongLoaderCapability;
  private systemPromptTemplate: string;

  constructor(model: KeyboardModel, deps: NordDeviceDeps) {
    this.model = model;
    this.parameterMap = deps.parameterMap;
    this.programLoader = deps.programLoader;
    this.songLoader = deps.songLoader;
    this.systemPromptTemplate = deps.systemPromptTemplate;
    this.state = new NordElectro5DState(this.parameterMap);
  }

  // ── Connection lifecycle ──

  attach(connection: MidiConnection): void {
    this.connection = connection;

    // Listen for incoming CCs (from hardware input) to update internal state
    connection.onCC((cc, value, channel) => {
      const entry = this.parameterMap.getParamByCC(cc);
      if (!entry) return;
      this.state.set(
        entry.key,
        value,
        this.parameterMap.isPerPart(entry.key) ? "upper" : undefined,
      );
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

      // Piano model discovery from backup data
      if (key === "piano_model" && this.backupData && "pianos" in this.backupData) {
        const pianos = this.backupData.pianos as Array<{
          category: string;
          location: number;
          name: string;
        }>;
        const typeToCategory: Record<string, string> = {
          Grand: "Grand",
          Upright: "Upright",
          EP1: "EPiano1",
          EP2: "EPiano2",
          Clav: "Clavinet",
          Harpsichord: "Harps",
        };
        for (const type of ["Grand", "Upright", "EP1", "EP2", "Clav", "Harpsichord"]) {
          const category = typeToCategory[type];
          const models = pianos
            .filter((p) => p.category === category)
            .sort((a, b) => a.location - b.location);
          if (models.length > 0) {
            const modelList = models.map((m) => `${m.location}=${m.name}`).join(", ");
            lines.push(`    ${type}: ${modelList}`);
          }
        }
      } else if (key === "piano_model" && !this.backupData) {
        lines.push(`    (Run extract_backup to see available model names)`);
      }
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
    const resolvedKeys: Array<{ key: string; value: number | string }> = [];

    for (const { name, value } of params) {
      const found = this.parameterMap.findParam(name);
      if (!found) {
        errors.push(`Unknown parameter: "${name}"`);
        continue;
      }

      try {
        const midiValue = this.parameterMap.resolveValue(found.param, value);
        const targetPart = part ?? "upper";
        const prevMidi = this.state.get(
          found.key,
          this.parameterMap.isPerPart(found.key) ? targetPart : undefined,
        );

        this.connection!.sendCC(found.param.cc, midiValue);
        this.state.set(
          found.key,
          midiValue,
          this.parameterMap.isPerPart(found.key) ? targetPart : undefined,
        );
        resolvedKeys.push({ key: found.key, value });

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

    const warnings = validateParameterBatch(
      resolvedKeys,
      this.state,
      part ?? "upper",
      this.parameterMap,
    );

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

    return { content: [{ type: "text", text }] };
  }

  getState(section?: string): ToolResult {
    return textResult(this.state.format(section));
  }

  async loadProgram(bank: number, slot: number): Promise<ToolResult> {
    const conn = this.requireConnection();
    const loader = this.programLoader;

    if (!loader) {
      return textResult(`${this.model.info.displayName} does not support program loading.`);
    }

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
    const conn = this.requireConnection();
    const loader = this.songLoader;

    if (!loader) {
      return textResult(`${this.model.info.displayName} does not support set list loading.`);
    }

    const parts = loader.parts ?? ["A", "B", "C", "D"];
    const partLabel = part ?? parts[0];

    await loader.loadSong(conn, bank, slot, partLabel);

    // Build response with song/program info from backup data
    let text = `Set list ${bank}, song ${slot}, part ${partLabel}`;

    if (this.backupData && "setLists" in this.backupData && "programs" in this.backupData) {
      const setLists = this.backupData.setLists as Array<{
        bank: number;
        slot: number;
        name: string;
        programs: Array<{ bank: number; slot: number }>;
      }>;
      const programs = this.backupData.programs as Array<{
        bank: number;
        slot: number;
        name: string;
      }>;
      const entry = setLists.find((s) => s.bank === bank && s.slot === slot - 1);

      if (entry) {
        text = `Loaded "${entry.name}" — set list ${bank}, song ${slot}, part ${partLabel}`;
        const progByBankSlot = new Map(
          programs.map((p) => [`${p.bank}:${p.slot}`, p.name]),
        );
        const partNames = entry.programs.map((ref, i) => {
          const name =
            progByBankSlot.get(`${ref.bank}:${ref.slot}`) ??
            `B${ref.bank}:${ref.slot + 1}`;
          const marker = parts[i] === partLabel ? " ←" : "";
          return `  ${parts[i]}: ${name}${marker}`;
        });
        text += "\n" + partNames.join("\n");
      }
    }

    return textResult(text);
  }

  listPrograms(filter?: string, bank?: number): ToolResult {
    if (!this.backupData || !("programs" in this.backupData)) {
      return textResult(
        "No backup data loaded. Use extract_backup first to load this device's inventory.",
      );
    }

    const programs = this.backupData.programs as Array<{
      bank: number;
      slot: number;
      name: string;
    }>;

    let filtered = programs;
    if (bank !== undefined) {
      filtered = filtered.filter((p) => p.bank === bank);
    }
    if (filter) {
      const lower = filter.toLowerCase();
      filtered = filtered.filter((p) => p.name.toLowerCase().includes(lower));
    }

    if (filtered.length === 0) {
      const parts: string[] = [];
      if (bank !== undefined) parts.push(`bank ${bank}`);
      if (filter) parts.push(`name "${filter}"`);
      return textResult(
        `No programs matching ${parts.join(", ")}. Total programs: ${programs.length}`,
      );
    }

    const lines = filtered.map(
      (p) => `  ${p.bank}:${p.slot + 1}  ${p.name}`,
    );
    const parts: string[] = [];
    if (filter) parts.push(`name "${filter}"`);
    if (bank !== undefined) parts.push(`bank ${bank}`);
    const header = parts.length > 0
      ? `Programs matching ${parts.join(", ")} (${filtered.length}/${programs.length}):`
      : `All programs (${programs.length}):`;

    return textResult(header + "\n" + lines.join("\n"));
  }

  listSongs(filter?: string, bank?: number): ToolResult {
    if (!this.backupData || !("setLists" in this.backupData)) {
      return textResult(
        "No backup data loaded. Use extract_backup first to load this device's inventory.",
      );
    }

    const setLists = this.backupData.setLists as Array<{
      bank: number;
      slot: number;
      name: string;
      programs: Array<{ bank: number; slot: number }>;
    }>;

    const programs = (this.backupData.programs ?? []) as Array<{
      bank: number;
      slot: number;
      name: string;
    }>;
    const progByBankSlot = new Map(
      programs.map((p) => [`${p.bank}:${p.slot}`, p.name]),
    );
    const parts = ["A", "B", "C", "D"];

    let filtered = setLists;
    if (bank !== undefined) {
      filtered = filtered.filter((s) => s.bank === bank);
    }
    if (filter) {
      const lower = filter.toLowerCase();
      filtered = filtered.filter((s) => s.name.toLowerCase().includes(lower));
    }

    if (filtered.length === 0) {
      const filterParts: string[] = [];
      if (bank !== undefined) filterParts.push(`bank ${bank}`);
      if (filter) filterParts.push(`name "${filter}"`);
      return textResult(
        `No songs matching ${filterParts.join(", ")}. Total songs: ${setLists.length}`,
      );
    }

    const lines: string[] = [];
    for (const song of filtered) {
      lines.push(`  ${song.bank}:${song.slot + 1}  ${song.name}`);
      for (let i = 0; i < song.programs.length; i++) {
        const ref = song.programs[i];
        const name =
          progByBankSlot.get(`${ref.bank}:${ref.slot}`) ??
          `B${ref.bank}:${ref.slot + 1}`;
        lines.push(`    ${parts[i]}: ${name}`);
      }
    }

    const filterParts2: string[] = [];
    if (filter) filterParts2.push(`name "${filter}"`);
    if (bank !== undefined) filterParts2.push(`bank ${bank}`);
    const header = filterParts2.length > 0
      ? `Songs matching ${filterParts2.join(", ")} (${filtered.length}/${setLists.length}):`
      : `All songs (${setLists.length}):`;

    return textResult(header + "\n" + lines.join("\n"));
  }

  getSystemPrompt(): ToolResult {
    const template = this.systemPromptTemplate;
    if (!template) {
      return textResult(
        `${this.model.info.displayName} does not provide a system prompt.`,
      );
    }

    // Start with the model's template
    let prompt = template;

    // Append terminology glossary
    prompt +=
      "\n\nTERMINOLOGY: In keyboard jargon, 'program', 'preset', and 'patch' " +
      "are near-synonymous — they all refer to a stored sound configuration. " +
      "Online resources use these interchangeably. In this system, stored sounds " +
      "are called programs and are managed via list_programs / load_program.";

    // Append instance-specific backup inventory summary
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
