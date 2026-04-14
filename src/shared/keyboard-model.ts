/**
 * The contract every keyboard model must implement.
 *
 * Tools and entry points depend only on this interface —
 * never on a specific model's internals.
 */

import type { KeyboardParameter, Preset } from "./types.js";
import type { MidiSender } from "./midi-sender.js";

// ── Model metadata ──

export interface KeyboardModelInfo {
  /** Unique ID: "nord-electro-5d", "yamaha-cp88", etc. */
  id: string;
  /** Human-readable name: "Nord Electro 5D" */
  displayName: string;
  /** Manufacturer: "Nord", "Yamaha", etc. */
  manufacturer: string;
  /** Substrings to match against MIDI port names for auto-detection */
  midiPortPatterns: string[];
}

// ── Parameter map ──

export interface ParameterMap {
  /** All parameters keyed by canonical key name */
  readonly params: Record<string, KeyboardParameter>;

  /** Resolve a user-provided value (number or label string) to MIDI 0-127 */
  resolveValue(param: KeyboardParameter, value: number | string): number;

  /** Format a MIDI value back to a human-readable display string */
  formatValue(param: KeyboardParameter, midiValue: number): string;

  /** Find a parameter by fuzzy name match */
  findParam(name: string): { key: string; param: KeyboardParameter } | undefined;

  /** Reverse lookup: CC number → param */
  getParamByCC(cc: number): { key: string; param: KeyboardParameter } | undefined;

  /** All section names in definition order */
  getSections(): string[];

  /** All params in a given section */
  getParamsBySection(section: string): Record<string, KeyboardParameter>;

  /** Whether a param key is per-part */
  isPerPart(key: string): boolean;
}

// ── State manager ──

export interface StateManager {
  set(paramKey: string, midiValue: number, part?: string): void;
  get(paramKey: string, part?: string): number | undefined;
  getAll(part?: string): Record<string, number>;
  getBySection(section: string, part?: string): Record<string, number>;
  reset(): void;
  format(section?: string): string;
}

// ── Optional capabilities ──

export interface BackupCapability {
  /** Return true if this file/folder is a backup belonging to this model */
  detectBackup?(filePath: string): Promise<boolean>;
  parseBackup(filePath: string): Promise<BackupData>;
  parseProgramsFolder?(folderPath: string): Promise<BackupData>;
  formatAsMarkdown(data: BackupData, date?: string): string;
}

/**
 * Base type for backup data. Keyboard models extend this with their own fields.
 * Using Record<string, any> to allow model-specific interfaces to be assignable.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export type BackupData = Record<string, any>;

export interface BackupCacheCapability {
  load(): void;
  get(): BackupData | null;
  set(data: BackupData): void;
  reload(): boolean;
  getLastBackupPath(): string | null;
  setLastBackupPath(path: string): void;
}

export interface ProgramLoaderCapability {
  loadProgram(midi: MidiSender, bank: number, slot: number): void | Promise<void>;
  bankRange: { min: number; max: number };
  slotRange: { min: number; max: number };
}

export interface SongLoaderCapability {
  loadSong(midi: MidiSender, bank: number, slot: number, part?: string): void | Promise<void>;
  bankRange: { min: number; max: number };
  slotRange: { min: number; max: number };
  parts?: string[];
}

// ── Mock device handler ──

export interface MockContext {
  channelState: Map<number, Map<number, number>>;
  lowerChannel: number;
  upperChannel: number;
  parameterMap: ParameterMap;
}

export interface MockHandler {
  /** Called once when the mock engine starts */
  init(ctx: MockContext): void;
  /** Process a CC message. Return { handled: true } to skip generic state update. */
  onCC(cc: number, value: number, channel: number, ctx: MockContext): { handled?: boolean } | void;
  /** Process a Program Change message */
  onProgramChange(program: number, channel: number, ctx: MockContext): void;
  /** Return model-specific extra state to merge into WebSocket broadcasts */
  getExtraState(includeInventory: boolean, ctx: MockContext): Record<string, any>;
  /** Reload cached data (e.g., backup cache) */
  onCacheReload?(ctx: MockContext): void;
}

// ── The main interface ──

export interface KeyboardModel {
  info: KeyboardModelInfo;
  parameterMap: ParameterMap;

  /** Create a fresh state manager instance for this model */
  createStateManager(): StateManager;

  /** Built-in presets (may be empty) */
  presets: Preset[];
  findPreset(name: string): Preset | undefined;
  getPresetsByGenre(genre: string): Preset[];

  /** Optional: backup file parsing */
  backup?: BackupCapability;

  /** Optional: program loading (bank select + program change) */
  programLoader?: ProgramLoaderCapability;

  /** Optional: set list / song loading */
  songLoader?: SongLoaderCapability;

  /** Optional: backup data cache */
  backupCache?: BackupCacheCapability;

  /** Optional: model-specific validation warnings for parameter batches */
  validateParameterBatch?(
    parameters: Array<{ key: string; value: number | string }>,
    state: StateManager,
    targetPart: string,
  ): string[];

  /** Model-specific system prompt for AI agents (signal path, engine capabilities, etc.) */
  agentSystemPrompt?: string;

  /** Path to the web/ UI directory for the mock device */
  mockUiDir?: string;

  /** Optional: create a mock device handler for model-specific behavior */
  createMockHandler?(): MockHandler;
}
