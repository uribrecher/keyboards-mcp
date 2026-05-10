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
import type { MidiCodec, ParamRef } from "./midi-codec.js";

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
}

/* Stage 4 (#30) note:
 *
 * MockHandlerResult used to carry `sysexOut` / `ccOut` / `programOut`
 * channels for the engine to emit on the device's MIDI Out. Those
 * channels are gone — emission is now the engine's responsibility:
 *   - UI setParam: engine calls handler.set_params for state, then asks
 *     codec.encodeParams to produce the wire bytes and emits.
 *   - RQ1: engine sees the request directly (codec.parseRequest), reads
 *     state via handler.read_bytes, builds the reply via codec, emits.
 *   - External MIDI in: handler updates state; engine never echoes
 *     external input back out (loop prevention).
 */

/**
 * Mock handler interface for the thin engine architecture.
 * The handler owns ALL state and logic — the engine is just MIDI I/O + WebSocket.
 */
export interface MockHandler {
  /**
   * The codec the handler uses for param ↔ MIDI translation. Stage-4
   * engines read this to handle RQ1 directly and to encode UI setParam
   * writes for outbound emission. Optional for backward compat with
   * handlers that don't have a codec.
   */
  readonly codec?: MidiCodec;
  /**
   * Called once when the mock engine starts.
   * `label` (optional) selects which per-instance backup cache to load —
   * see `BackupCacheCapability`. Defaults to `"_default"`.
   */
  init(lowerChannel: number, upperChannel: number, label?: string): void;
  /** Process any MIDI message. Returns state to broadcast and/or a log line. */
  onMIDI(msg: MidiMessage): MockHandlerResult;
  /**
   * Param-domain write (#30 stages 3–4). The canonical way for the engine
   * (and UI WS messages of shape `{type:"setParam", name, value, part?}`)
   * to update a parameter on the mock. The handler updates internal state
   * and returns a `MockHandlerResult` with `state` and `log` only.
   *
   * Outbound MIDI emission is the engine's responsibility (stage 4).
   * For UI-source writes the engine asks the codec to encode the same
   * write and writes the bytes to the device's MIDI Out (panel-knob
   * analogue). The handler MUST NOT carry MIDI bytes in the result —
   * those channels are gone.
   */
  set_params?(refs: ParamRef[]): MockHandlerResult;
  /**
   * Param-domain read. Returns wire-byte values keyed by canonical
   * parameter name. Pass `part` for per-part params.
   */
  get_params?(names: string[], part?: number): Record<string, number>;
  /**
   * Bytes-level read used by the engine to fulfill protocol-level
   * requests (e.g. Roland RQ1) without the handler having to know
   * anything about the protocol. Returns `size` bytes starting at
   * `address` from the handler's internal address-keyed storage.
   * Bytes the handler hasn't seen are reported as 0.
   *
   * Stage 4: replaces the handler-side RQ1→DT1 sysexOut path. The
   * engine now does codec.parseRequest → handler.read_bytes → codec.buildResponse
   * and emits the reply on the device's MIDI Out itself.
   */
  read_bytes?(address: number[], size: number): number[];
  /**
   * @deprecated Use `set_params` instead. Kept for backward compatibility
   * with engine WS handlers that still emit `{type:"param"}`.
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

  /**
   * Create a per-model `MidiCodec`. Single source of truth for param ↔ MIDI
   * translation, used by both the mock-runner (incoming MIDI → set_params)
   * and the MCP-side device (outgoing set_params → MIDI bytes). Plan #30.
   */
  createCodec?(): MidiCodec;

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
