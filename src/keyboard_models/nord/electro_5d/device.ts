/**
 * Nord Electro 5D device instance.
 * Extends BaseKeyboardDevice with per-part routing, validation,
 * piano model discovery, and backup inventory queries.
 */

import type {
  KeyboardModel,
  ProgramLoaderCapability,
  SongLoaderCapability,
} from "../../../shared/keyboard-model.js";
import type { KeyboardParameter } from "../../../shared/types.js";
import type { ToolResult } from "../../../shared/tool-result.js";
import { textResult } from "../../../shared/tool-result.js";
import { BaseKeyboardDevice, type BaseDeviceDeps } from "../../../shared/base-keyboard-device.js";
import { validateParameterBatch, preflightDisabledSections } from "./validation.js";
import { NordElectro5DState } from "./state-manager.js";

export interface NordDeviceDeps extends BaseDeviceDeps {
  programLoader: ProgramLoaderCapability;
  songLoader: SongLoaderCapability;
  systemPromptTemplate: string;
}

export class NordElectro5DDevice extends BaseKeyboardDevice {
  constructor(model: KeyboardModel, deps: NordDeviceDeps) {
    super(model, deps, new NordElectro5DState(deps.parameterMap));
  }

  // ── Per-part CC routing ──

  protected override onIncomingCC(cc: number, value: number, _channel: number): void {
    const entry = this.parameterMap.getParamByCC(cc);
    if (!entry) return;
    this.state.set(
      entry.key,
      value,
      this.parameterMap.isPerPart(entry.key) ? "upper" : undefined,
    );
  }

  // ── Per-part state routing for setParameters ──

  protected override resolvePartForParam(key: string, part?: string): string | undefined {
    return this.parameterMap.isPerPart(key) ? (part ?? "upper") : undefined;
  }

  protected override preflightBatch(
    resolvedKeys: Array<{ key: string; value: number | string }>,
    part: string,
  ): { errors: string[]; blockedKeys: Set<string> } {
    return preflightDisabledSections(resolvedKeys, this.state, this.parameterMap, part);
  }

  protected override validateAfterSet(
    resolvedKeys: Array<{ key: string; value: number | string }>,
    part: string,
  ): string[] {
    return validateParameterBatch(resolvedKeys, this.state, part, this.parameterMap);
  }

  // ── Piano model discovery in listParameters ──

  protected override formatParameterExtra(key: string, _param: KeyboardParameter): string[] | null {
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
      const lines: string[] = [];
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
      return lines;
    }
    if (key === "piano_model" && !this.backupData) {
      return [`    (Run extract_backup to see available model names)`];
    }
    return null;
  }

  // ── Song loading with backup info ──

  override async loadSong(bank: number, slot: number, part?: string): Promise<ToolResult> {
    if (!this.songLoader) {
      return textResult(`${this.model.info.displayName} does not support set list loading.`);
    }
    const conn = this.requireConnection();
    const loader = this.songLoader;
    const parts = loader.parts ?? ["A", "B", "C", "D"];
    const partLabel = part ?? parts[0];

    await loader.loadSong(conn, bank, slot, partLabel);

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

  // ── Backup inventory queries ──

  override listPrograms(filter?: string, bank?: number): ToolResult {
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

  override listSongs(filter?: string, bank?: number): ToolResult {
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
}
