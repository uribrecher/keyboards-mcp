/**
 * Event-log IPC — main-process side.
 *
 * Single emit surface for non-agent lifecycle/status notes that flow
 * from main to the renderer's Event Log pane. Replaces the old
 * `menu:console-note` channel for everything except agent dialog
 * (which doesn't go through IPC at all — it's an in-renderer fetch
 * stream).
 *
 * `import type` — no runtime import of electron, so the unit tests
 * can run under plain `tsx --test` without an Electron host.
 */

import type { BrowserWindow } from "electron";

export const EVENT_LOG_CHANNEL       = "menu:event-log";
export const EVENT_LOG_CLEAR_CHANNEL = "menu:event-log-clear";

export type EventSeverity = "info" | "warn" | "error";

export interface EventLogPayload {
  severity: EventSeverity;
  /** Optional originating subsystem or device, e.g. `${displayName} ("${label}")` or `setup`. */
  source?: string;
  /** Body line, plain text. */
  text: string;
  /** Wall-clock millis. Filled in automatically by emitEvent if omitted. */
  ts: number;
}

type Win   = Pick<BrowserWindow, "webContents">;
type Input = Omit<EventLogPayload, "ts"> & { ts?: number };

/**
 * Emit one event-log row to the renderer. No-op if `win` is null
 * (the renderer hasn't been created yet, e.g. during cold startup).
 */
export function emitEvent(win: Win | null | undefined, input: Input): void {
  if (!win) return;
  const payload: EventLogPayload = {
    severity: input.severity,
    text:     input.text,
    ts:       input.ts ?? Date.now(),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  win.webContents.send(EVENT_LOG_CHANNEL, payload);
}

/** Tell the renderer to empty the Event Log pane. */
export function emitEventLogClear(win: Win | null | undefined): void {
  if (!win) return;
  win.webContents.send(EVENT_LOG_CLEAR_CHANNEL);
}
