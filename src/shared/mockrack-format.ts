/**
 * `.mockrack` v1 JSON schema — used by File → Save / Open in the
 * Electron mock-runner to round-trip a complete studio rack.
 *
 * Spec: docs/superpowers/specs/2026-05-04-file-menu-design.md
 */

import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const MOCKRACK_VERSION = 1;

export interface MockrackTab {
  /** Keyboard model id (e.g. "nord-electro-5d"). */
  modelId: string;
  /** Per-instance backup-cache key. */
  label: string;
  /** Per-model getFullState(false) snapshot, or null for graceful degradation. */
  state: Record<string, any> | null;
}

export interface MockrackV1 {
  $schema: "mockrack/v1";
  version: 1;
  /** Informational. */
  savedAt: string;
  /** Informational. */
  appVersion: string;
  /** Foregrounded tab on restore. Clamped on parse. */
  activeTabIndex: number;
  tabs: MockrackTab[];
}

/** Parse + validate a `.mockrack` JSON string. Throws with a user-friendly error. */
export function parseMockrack(text: string): MockrackV1 {
  let raw: any;
  try { raw = JSON.parse(text); }
  catch (err) {
    throw new Error(`Failed to parse .mockrack JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid .mockrack: top-level value must be an object.");
  }
  if (typeof raw.version !== "number") {
    throw new Error("Invalid .mockrack: missing or non-numeric `version` field.");
  }
  if (raw.version !== MOCKRACK_VERSION) {
    throw new Error(`This setup requires Mock Runner v${raw.version}; you're on v${MOCKRACK_VERSION}.`);
  }
  if (!Array.isArray(raw.tabs)) {
    throw new Error("Invalid .mockrack: `tabs` must be an array.");
  }
  const tabs: MockrackTab[] = raw.tabs.map((t: any, i: number) => {
    if (!t || typeof t !== "object") {
      throw new Error(`Invalid .mockrack: tabs[${i}] must be an object.`);
    }
    if (typeof t.modelId !== "string" || t.modelId.length === 0) {
      throw new Error(`Invalid .mockrack: tabs[${i}].modelId must be a non-empty string.`);
    }
    if (typeof t.label !== "string" || t.label.length === 0) {
      throw new Error(`Invalid .mockrack: tabs[${i}].label must be a non-empty string.`);
    }
    if (t.state !== null && (typeof t.state !== "object")) {
      throw new Error(`Invalid .mockrack: tabs[${i}].state must be an object or null.`);
    }
    return { modelId: t.modelId, label: t.label, state: t.state ?? null };
  });

  // Clamp activeTabIndex
  let active = typeof raw.activeTabIndex === "number" ? Math.floor(raw.activeTabIndex) : 0;
  if (tabs.length === 0 || active < 0 || active >= tabs.length) active = 0;

  return {
    $schema: "mockrack/v1",
    version: MOCKRACK_VERSION,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : new Date(0).toISOString(),
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "unknown",
    activeTabIndex: active,
    tabs,
  };
}

/** Serialize a `MockrackV1` to a deterministic, pretty JSON string. */
export function serializeMockrack(file: MockrackV1): string {
  return JSON.stringify(file, null, 2);
}

/**
 * Atomically write a `.mockrack` file. Uses a per-process tmp file +
 * rename so two writers (e.g., a quick double-save) never collide on
 * `<path>.tmp`.
 */
export function writeMockrackAtomic(path: string, file: MockrackV1): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, serializeMockrack(file), "utf-8");
  renameSync(tmp, path);
}
