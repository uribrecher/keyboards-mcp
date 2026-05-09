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
export type BackupData = Record<string, any>;

/**
 * Per-instance backup cache. Each device has a `label` (e.g. "studio nord");
 * the cache stores its inventory under that label so two units of the same
 * model don't clobber each other's programs and samples.
 *
 * `label` defaults to `"_default"` when omitted — this preserves
 * single-device, no-label backwards compatibility.
 */
export interface BackupCacheCapability {
  /** Load this label's cache from disk into memory. No-op if already loaded. */
  load(label?: string): void;
  /** Return the in-memory cache for this label, or null if absent. */
  get(label?: string): BackupData | null;
  /** Persist data to this label's cache file. */
  set(data: BackupData, label?: string): void;
  /** Force re-read of this label's cache from disk. Returns true if a file was found. */
  reload(label?: string): boolean;
  /** Last source backup file path stored under this label. */
  getLastBackupPath(label?: string): string | null;
  /** Persist the source backup file path for this label. */
  setLastBackupPath(path: string, label?: string): void;
  /** All labels with a stored cache (excluding `_default` if it has no data). */
  listLabels(): string[];
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
  /**
   * Outgoing SysEx messages emitted by the handler. Each entry is one
   * full SysEx packet (F0..F7). The engine writes each packet to the
   * mock's virtual MIDI Out port (the device's MIDI Out socket).
   */
  sysexOut?: number[][];
  /**
   * Outgoing CC messages emitted by the handler. The engine writes each
   * to the mock's virtual MIDI Out port. Handler-explicit emissions are
   * always written, regardless of input source.
   */
  ccOut?: Array<{ controller: number; value: number; channel: number }>;
  /**
   * Outgoing program-change messages emitted by the handler. The engine
   * writes each to the mock's virtual MIDI Out port.
   */
  programOut?: Array<{ number: number; channel: number }>;
}

/**
 * Mock handler interface for the thin engine architecture.
 * The handler owns ALL state and logic — the engine is just MIDI I/O + WebSocket.
 */
export interface MockHandler {
  /**
   * Called once when the mock engine starts.
   * `label` (optional) selects which per-instance backup cache to load —
   * see `BackupCacheCapability`. Defaults to `"_default"`.
   */
  init(lowerChannel: number, upperChannel: number, label?: string): void;
  /** Process any MIDI message. Returns state to broadcast and/or a log line. */
  onMIDI(msg: MidiMessage): MockHandlerResult;
  /**
   * Called when the mock UI fires `{type:"param", name, value, channel?}` for
   * params that have no CC mapping (typically SysEx-addressed). The handler
   * MUST encode the named param to MIDI bytes, apply state by routing through
   * its own `onMIDI`, and return the encoded packet(s) in `sysexOut` / `ccOut`
   * so the engine can emit them on the device's MIDI Out (panel-knob analogue).
   *
   * Models whose UI never sends `{type:"param"}` can leave this unimplemented.
   */
  onUIParam?(name: string, value: number | string, channel?: number): MockHandlerResult;
  /** Return the complete current state (for new WebSocket clients) */
  getFullState(includeInventory: boolean): Record<string, any>;
  /** Reload cached data (e.g., backup cache) */
  onCacheReload?(): void;
  /**
   * Restore the handler's internal state from a snapshot previously
   * produced by `getFullState(false)`.
   *
   * Implementers MUST treat the input as best-effort:
   *   - missing fields → keep current defaults (don't throw)
   *   - unknown extra fields → ignore
   *   - malformed shapes → log and partially recover, never throw
   *
   * Implementers MUST NOT broadcast — the engine emits a single
   * `getFullState(true)` broadcast after this call returns, so the UI
   * sees one consistent transition.
   */
  setFullState?(snapshot: Record<string, any>): void;
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
  getState(section?: string): ToolResult | Promise<ToolResult>;
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
