/**
 * Mock runtime registry — an at-rest index of "what mocks are running."
 *
 * The mock-runner main process and the headless CLI write entries when
 * each MockEngine starts; the MCP server reads them so `list_midi_devices`
 * can show labels and `connect_to_keyboard` can auto-adopt a label without
 * the caller passing one.
 *
 * Entries are keyed by `wsPort`, which is unique per running engine. Two
 * mocks of the same model on the same machine will share a virtual MIDI
 * port name (Core MIDI auto-suffixes the second as `… Mock1`, etc.); the
 * registry stores the actual OS-assigned `midiPort` for both, distinct
 * by their wsPort.
 *
 * Storage: `<dataDir>/runtime/mocks.json`. Atomic write via a per-process
 * tmp file + rename so concurrent mocks heart-beating at the same time
 * never collide on the temp path. Honors `KEYBOARDS_MCP_DATA_DIR`.
 *
 * Stale entries (process gone or `lastTouched` older than STALE_AFTER_MS)
 * are filtered by `readActive()`. `readAllWithStaleFlag()` keeps them and
 * marks `stale: true` for diagnostic surfaces (`list_midi_devices`).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Heartbeat older than this is considered stale (5 minutes). */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export interface MockRegistryEntry {
  /** Virtual MIDI port name as seen by Core MIDI / easymidi. */
  midiPort: string;
  /** WebSocket port — also the registry key. Unique per running engine. */
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

/** Read all entries with a `stale` flag — used by diagnostic UIs that want to surface dead mocks. */
export function readAllWithStaleFlag(): Array<MockRegistryEntry & { stale: boolean }> {
  return readAll().map((e) => ({ ...e, stale: isStale(e) }));
}

/**
 * Atomic write of the full list. Uses a per-process tmp file so multiple
 * concurrent writers (e.g. a tab heart-beating while another tab is
 * registering) don't collide on the same `<path>.tmp`.
 */
function writeAll(entries: MockRegistryEntry[]): void {
  const path = registryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
    renameSync(tmp, path);
  } catch {
    // Non-fatal — the registry is best-effort signalling.
  }
}

/**
 * Insert or update an entry, keyed by `wsPort`. Two engines may share a
 * `midiPort` (Core MIDI may auto-suffix duplicates), so the wsPort is the
 * stable handle.
 */
export function register(entry: MockRegistryEntry): void {
  const list = readAll().filter((e) => e.wsPort !== entry.wsPort);
  list.push(entry);
  writeAll(list);
}

/** Refresh `lastTouched` for an entry owned by this process. No-op if missing. */
export function touch(wsPort: number): void {
  const list = readAll();
  const entry = list.find((e) => e.wsPort === wsPort && e.pid === process.pid);
  if (!entry) return;
  entry.lastTouched = new Date().toISOString();
  writeAll(list);
}

/** Update label for an existing entry. */
export function relabel(wsPort: number, label: string): void {
  const list = readAll();
  const entry = list.find((e) => e.wsPort === wsPort && e.pid === process.pid);
  if (!entry) return;
  entry.label = label;
  entry.lastTouched = new Date().toISOString();
  writeAll(list);
}

/** Remove an entry, keyed by `wsPort` + own pid. */
export function unregister(wsPort: number): void {
  const list = readAll().filter((e) => !(e.wsPort === wsPort && e.pid === process.pid));
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

/**
 * Look up the active entry for a MIDI port name. Two engines may share
 * a midiPort (rare, race), in which case the most-recently-touched one
 * wins so a fresh restart shadows a half-dead duplicate.
 */
export function findByMidiPort(midiPort: string): MockRegistryEntry | undefined {
  const matches = readActive().filter((e) => e.midiPort === midiPort);
  if (matches.length === 0) return undefined;
  return matches.reduce((a, b) =>
    Date.parse(a.lastTouched) > Date.parse(b.lastTouched) ? a : b);
}

/** Look up by wsPort (always unique). */
export function findByWsPort(wsPort: number): MockRegistryEntry | undefined {
  return readActive().find((e) => e.wsPort === wsPort);
}

/** Test-only: wipe the registry file. */
export function _clearForTests(): void {
  try {
    unlinkSync(registryPath());
  } catch { /* missing is fine */ }
}
