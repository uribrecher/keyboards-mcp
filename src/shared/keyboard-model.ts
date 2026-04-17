/**
 * The contract every keyboard model must implement.
 *
 * Tools and entry points depend only on this interface —
 * never on a specific model's internals.
 */

import type { KeyboardParameter } from "./types.js";
import type { MidiSender } from "./midi-sender.js";
import type { MidiConnection } from "./midi-connection.js";
import type { ToolResult } from "./tool-result.js";

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

/** Raw MIDI message received by the mock handler */
export type MidiMessage =
  | { type: "cc"; controller: number; value: number; channel: number }
  | { type: "program"; number: number; channel: number }
  | { type: "sysex"; bytes: number[] };

/** What the handler returns after processing a MIDI message */
export interface MockHandlerResult {
  /** Full state message to broadcast to UI (if changed) */
  state?: Record<string, any>;
  /** Console log line */
  log?: string;
}

/**
 * Mock handler interface for the thin engine architecture.
 * The handler owns ALL state and logic — the engine is just MIDI I/O + WebSocket.
 */
export interface MockHandler {
  /** Called once when the mock engine starts */
  init(lowerChannel: number, upperChannel: number): void;
  /** Process any MIDI message. Returns state to broadcast and/or a log line. */
  onMIDI(msg: MidiMessage): MockHandlerResult;
  /** Return the complete current state (for new WebSocket clients) */
  getFullState(includeInventory: boolean): Record<string, any>;
  /** Reload cached data (e.g., backup cache) */
  onCacheReload?(): void;
}

// ── Device instance (new architecture) ──

/**
 * A specific physical unit or mock instance of a keyboard model.
 * Each device has its own MIDI connection, state, and optionally backup data.
 * Multiple devices of the same model can coexist.
 */
export interface KeyboardDevice {
  /** Back-reference to the model type */
  readonly model: KeyboardModel;

  /** User-assigned instance name (e.g. "studio Nord", "gig Nord") */
  label?: string;

  /** This instance's backup inventory (programs, samples, etc.) */
  backupData?: BackupData;

  // ── Connection lifecycle ──
  attach(connection: MidiConnection): void;
  detach(): void;

  // ── Tool implementations ──
  listParameters(section?: string): ToolResult;
  setParameters(
    params: Array<{ name: string; value: number | string }>,
    part?: string,
  ): ToolResult;
  getState(section?: string): ToolResult;
  loadProgram(bank: number, slot: number): ToolResult | Promise<ToolResult>;
  loadSong(
    bank: number,
    slot: number,
    part?: string,
  ): ToolResult | Promise<ToolResult>;
  listPrograms(filter?: string, bank?: number): ToolResult;
  listSongs(filter?: string, bank?: number): ToolResult;
  getSystemPrompt(): ToolResult;
}

// ── The main interface ──

export interface KeyboardModel {
  info: KeyboardModelInfo;

  // ── Factories ──

  /** Create a new device instance for this model */
  createDevice?(): KeyboardDevice;

  /** Create a mock device handler for this model */
  createMockHandler?(): MockHandler;

  /** Path to the web/ UI directory for the mock device */
  mockUiDir?: string;

  // ── Backup (no connection required) ──

  /** Optional: backup file parsing */
  backup?: BackupCapability;

  /** Optional: backup data cache (persisted to disk) */
  backupCache?: BackupCacheCapability;

  // ── Internal (used by model's own index.ts and createDevice, not by external consumers) ──

  /** Program loading capability — used by device internally */
  programLoader?: ProgramLoaderCapability;

  /** Set list / song loading capability — used by device internally */
  songLoader?: SongLoaderCapability;

  /** System prompt template — used by device's getSystemPrompt() */
  agentSystemPrompt?: string;
}
