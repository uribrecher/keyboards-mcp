/**
 * Mock runtime registry — an at-rest index of "what mocks are running."
 *
 * The mock-runner main process and the headless CLI write entries when
 * each MockEngine starts; the MCP server reads them so `list_midi_devices`
 * can show labels and `connect_to_keyboard` can auto-adopt a label without
 * the caller passing one.
 *
 * Storage: `<dataDir>/runtime/mocks.json`. Atomic write via tmp+rename.
 * Stale entries (process gone or `lastTouched` older than STALE_AFTER_MS)
 * are filtered by `readActive()`. Honors `KEYBOARDS_MCP_DATA_DIR`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Heartbeat older than this is considered stale (5 minutes). */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export interface MockRegistryEntry {
  /** Virtual MIDI port name (e.g. "Nord Electro 5D Mock"). */
  midiPort: string;
  /** WebSocket port the mock engine listens on. */
  wsPort: number;
  /** Model id (e.g. "nord-electro-5d"). */
  modelId: string;
  /** Human-friendly model name (e.g. "Nord Electro 5D"). */
  displayName: string;
  /** Per-instance backup label (sanitized, lower-case). */
  label: string;
  /** OS pid of the process that owns this entry. */
  pid: number;
  /** ISO timestamp of when this engine started. */
  startedAt: string;
  /** ISO timestamp of the last heartbeat. */
  lastTouched: string;
}

function getDataDir(): string {
  return process.env.KEYBOARDS_MCP_DATA_DIR
    ?? join(__dirname, "..", "..", "data");
}

function registryPath(): string {
  return join(getDataDir(), "runtime", "mocks.json");
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // signal 0 doesn't deliver a signal, just checks for existence
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(entry: MockRegistryEntry): boolean {
  if (!isPidAlive(entry.pid)) return true;
  const ts = Date.parse(entry.lastTouched);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > STALE_AFTER_MS;
}

/** Read the raw on-disk list. Returns an empty array if missing or invalid. */
export function readAll(): MockRegistryEntry[] {
  const path = registryPath();
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(data)) return [];
    return data.filter((e): e is MockRegistryEntry =>
      typeof e === "object" && e !== null
        && typeof e.midiPort === "string"
        && typeof e.wsPort === "number"
        && typeof e.modelId === "string"
        && typeof e.label === "string"
        && typeof e.pid === "number"
        && typeof e.startedAt === "string"
        && typeof e.lastTouched === "string");
  } catch {
    return [];
  }
}

/** Read only entries whose owning process is alive and recently heart-beat. */
export function readActive(): MockRegistryEntry[] {
  return readAll().filter((e) => !isStale(e));
}

/** Atomic write of the full list. */
function writeAll(entries: MockRegistryEntry[]): void {
  const path = registryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
    renameSync(tmp, path);
  } catch {
    // Non-fatal — the registry is best-effort signalling.
  }
}

/**
 * Insert or update an entry, keyed by `midiPort` (each virtual MIDI port
 * is unique per Core MIDI). Used by MockEngine.start() and on relabel.
 */
export function register(entry: MockRegistryEntry): void {
  const list = readAll().filter((e) => e.midiPort !== entry.midiPort);
  list.push(entry);
  writeAll(list);
}

/** Refresh `lastTouched` for an entry owned by this process. No-op if missing. */
export function touch(midiPort: string): void {
  const list = readAll();
  const entry = list.find((e) => e.midiPort === midiPort && e.pid === process.pid);
  if (!entry) return;
  entry.lastTouched = new Date().toISOString();
  writeAll(list);
}

/** Update label for an existing entry. */
export function relabel(midiPort: string, label: string): void {
  const list = readAll();
  const entry = list.find((e) => e.midiPort === midiPort && e.pid === process.pid);
  if (!entry) return;
  entry.label = label;
  entry.lastTouched = new Date().toISOString();
  writeAll(list);
}

/** Remove an entry, keyed by `midiPort` + own pid. */
export function unregister(midiPort: string): void {
  const list = readAll().filter((e) => !(e.midiPort === midiPort && e.pid === process.pid));
  writeAll(list);
}

/** Drop every entry owned by the current process. Useful at startup. */
export function dropOwnedByThisProcess(): void {
  const list = readAll().filter((e) => e.pid !== process.pid);
  writeAll(list);
}

/** Drop every entry whose owning PID is no longer alive. */
export function purgeStale(): void {
  const list = readAll().filter((e) => isPidAlive(e.pid));
  writeAll(list);
}

/** Look up by exact MIDI port name. */
export function findByMidiPort(midiPort: string): MockRegistryEntry | undefined {
  return readActive().find((e) => e.midiPort === midiPort);
}

/** Test-only: wipe the registry file. */
export function _clearForTests(): void {
  try {
    unlinkSync(registryPath());
  } catch { /* missing is fine */ }
}
