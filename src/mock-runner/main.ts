/**
 * Tabbed Mock Runner — Electron main process.
 *
 * The shell window is loaded once at startup and never reloaded. Each tab in
 * the shell hosts an iframe (model chooser → model UI). The main process
 * owns one MockTransport per tab on its own WebSocket port; ports are allocated
 * sequentially from BASE_WS_PORT and freed on tab close.
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, type WebContents } from "electron";
import { join, dirname, basename } from "node:path";
import { statSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, openSync, readSync, closeSync, realpathSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AudioAnalysisClient, type ImportRequest, type ImportAudioResult, type StemsRequest, type StructureRequest, type TranscribeRequest } from "../audio-analysis-client/index.js";
import { discoverModels, loadModelById } from "../shared/model-registry.js";
import type { KeyboardModel, KeyboardModelInfo } from "../shared/keyboard-model.js";
import { MockTransport, type MidiEventPayload } from "./transport.js";
import * as mockRegistry from "../shared/mock-registry.js";
import { listAllDevices, setOnBrokerLivenessChange, getBrokerLiveness } from "../shared/mcb-client.js";
import {
  parseMockrack,
  writeMockrackAtomic,
  MOCKRACK_VERSION,
  type MockrackV1,
  type MockrackTab,
} from "../shared/mockrack-format.js";
import { emitEvent, emitEventLogClear } from "./event-log-ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set the app name early so the macOS app menu (the leftmost item in the
// menu bar — which Electron auto-generates from app.name when no app menu
// is in the template) reads "Mock Runner" rather than "Electron".
app.setName("Mock Runner");

// Resolve paths back to src/ (from dist/mock-runner/)
const srcDir = join(__dirname, "..", "..", "src", "mock-runner");
const SHELL_DIR = join(srcDir, "shell");
const PRELOAD_PATH = join(srcDir, "preload.cjs");

const BASE_WS_PORT = 3000;
const LOWER_CH = parseInt(process.env.LOWER_CHANNEL ?? "0");
const UPPER_CH = parseInt(process.env.UPPER_CHANNEL ?? "1");

// ── Tab registry ──

interface TabEntry {
  tabId: string;
  model: KeyboardModel | null;     // null until the user selects a model
  transport: MockTransport | null;
  wsPort: number | null;
  label: string | null;             // user-assigned (defaults to "_default")
}

const tabs = new Map<string, TabEntry>();
let nextTabSeq = 1;

// ── File-menu session state (plan #9) ──
let currentFilePath: string | null = null;
let isDirty = false;
let restoring = false;
let lastActiveTabId: string | null = null;
let dirtyDebounceTimer: NodeJS.Timeout | null = null;

function markDirty(): void {
  if (restoring) return;
  if (isDirty) return;
  isDirty = true;
  pushDirtyChanged();
  refreshMenuEnabledState();
}

function clearDirty(): void {
  if (!isDirty) return;
  isDirty = false;
  pushDirtyChanged();
  refreshMenuEnabledState();
}

function pushDirtyChanged(): void {
  // Send a precomputed file name so the renderer doesn't have to parse
  // OS-specific paths (which would mishandle Windows `C:\\…` separators).
  const currentFileName = currentFilePath ? basename(currentFilePath) : null;
  mainWindow?.webContents.send("file:dirty-changed", {
    isDirty, currentFilePath, currentFileName,
  });
}

/**
 * Wire both transport listeners for a tab: dirty-debounce on state-changed,
 * IPC forward on midi-event. Centralizes the pair so the two attach sites
 * (initial selectModelForTab + restore-snapshot) stay in sync.
 */
function attachTransportListeners(tabId: string, transport: MockTransport): void {
  transport.on("state-changed", onTransportStateChanged);
  transport.on("midi-event", (payload: MidiEventPayload) => {
    mainWindow?.webContents.send("midi:event", { tabId, ts: Date.now(), ...payload });
  });
}

/** Debounced state-changed handler for transport broadcasts. */
function onTransportStateChanged(): void {
  if (restoring) return;
  if (dirtyDebounceTimer) return;
  dirtyDebounceTimer = setTimeout(() => {
    dirtyDebounceTimer = null;
    markDirty();
  }, 250);
  if (dirtyDebounceTimer.unref) dirtyDebounceTimer.unref();
}

// ── Save / Open flows ──────────────────────────────────────────────

/**
 * True iff at least one tab has both a model and a transport — i.e. the
 * rack would produce a non-empty `tabs` array in the snapshot. Used to
 * gate Save / Save As so we never write an empty .mockrack (which is
 * useless at best and overwrites a valid saved file at worst).
 */
function hasContentToSave(): boolean {
  for (const t of tabs.values()) {
    if (t.model && t.transport) return true;
  }
  return false;
}

/**
 * Surface to the user why a save was refused. The menu items are
 * already disabled in this state (Layer 1), so this only fires from
 * keyboard accelerators or programmatic callers — but it's important
 * those don't fail silently.
 */
function notifyEmptySaveRefused(): void {
  emitEvent(mainWindow, {
    severity: "warn",
    source:   "setup",
    text:     "Nothing to save — add a tab and pick a model first.",
  });
}

function buildSetupSnapshot(): MockrackV1 {
  const entries = [...tabs.values()].filter((t) => t.model && t.transport);
  const tabsOut: MockrackTab[] = entries.map((t) => ({
    modelId: t.model!.info.id,
    label:   t.label ?? "_default",
    state:   t.transport!.getFullState(false),
  }));
  let activeTabIndex = 0;
  if (lastActiveTabId) {
    const i = entries.findIndex((t) => t.tabId === lastActiveTabId);
    if (i >= 0) activeTabIndex = i;
  }
  return {
    $schema: "mockrack/v1",
    version: MOCKRACK_VERSION,
    savedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    activeTabIndex,
    tabs: tabsOut,
  };
}

async function saveCurrent(): Promise<void> {
  if (!hasContentToSave()) {
    notifyEmptySaveRefused();
    return;
  }
  if (!currentFilePath) { await saveAs(); return; }
  try {
    writeMockrackAtomic(currentFilePath, buildSetupSnapshot());
    app.addRecentDocument(currentFilePath);
    clearDirty();
  } catch (err) {
    dialog.showErrorBox("Save failed", err instanceof Error ? err.message : String(err));
  }
}

async function saveAs(): Promise<void> {
  if (!hasContentToSave()) {
    notifyEmptySaveRefused();
    return;
  }
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  const result = await dialog.showSaveDialog(win, {
    title: "Save Studio Setup",
    defaultPath: currentFilePath ?? "untitled.mockrack",
    filters: [{ name: "Mock Runner Setup", extensions: ["mockrack"] }],
  });
  if (result.canceled || !result.filePath) return;
  try {
    writeMockrackAtomic(result.filePath, buildSetupSnapshot());
    currentFilePath = result.filePath;
    app.addRecentDocument(result.filePath);
    clearDirty();
    pushDirtyChanged();
    refreshMenuEnabledState();
  } catch (err) {
    dialog.showErrorBox("Save failed", err instanceof Error ? err.message : String(err));
  }
}

/** Returns true if the user wants to proceed. False on Cancel. */
async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!isDirty) return true;
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return true;
  const fileLabel = currentFilePath
    ? basename(currentFilePath)
    : "current setup";
  // When the rack has nothing to save, drop the "Save" button — the
  // semantically correct dialog is just "Discard | Cancel". Offering
  // Save here would either create a useless empty file or overwrite
  // an opened-then-emptied rack with nothing.
  const canSave = hasContentToSave();
  const buttons = canSave
    ? ["Save", "Don't Save", "Cancel"]
    : ["Discard", "Cancel"];
  const cancelId = canSave ? 2 : 1;
  const message = canSave
    ? `Save changes to "${fileLabel}"?`
    : `Discard changes to "${fileLabel}"?`;
  const detail = canSave
    ? "Your changes will be lost if you don't save them."
    : "The rack is empty — there is nothing to save. Continue and discard the change?";
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    buttons,
    defaultId: 0,
    cancelId,
    message,
    detail,
  });
  if (result.response === cancelId) return false;
  if (canSave && result.response === 0) {   // Save
    if (currentFilePath) await saveCurrent();
    else await saveAs();
    if (isDirty) return false;              // Save dialog was cancelled
  }
  return true;                              // Discard / Don't Save / Save succeeded
}

async function tearDownAllTabs(): Promise<void> {
  for (const entry of [...tabs.values()]) {
    if (entry.transport) {
      try { await entry.transport.stop(); } catch { /* swallow */ }
    }
    mainWindow?.webContents.send("file:close-tab", { tabId: entry.tabId });
    tabs.delete(entry.tabId);
  }
}

async function loadSetupFromPath(path: string): Promise<void> {
  let text: string;
  try { text = readFileSync(path, "utf-8"); }
  catch (err) {
    dialog.showErrorBox("Open failed", err instanceof Error ? err.message : String(err));
    return;
  }
  let parsed;
  try { parsed = parseMockrack(text); }
  catch (err) {
    dialog.showErrorBox("Open failed", err instanceof Error ? err.message : String(err));
    return;
  }

  restoring = true;
  try {
    await tearDownAllTabs();

    let activeTabId: string | null = null;
    for (let i = 0; i < parsed.tabs.length; i++) {
      const t = parsed.tabs[i];
      let model;
      try { model = await loadModelById(t.modelId); }
      catch {
        emitEvent(mainWindow, {
          severity: "warn",
          source:   "setup",
          text:     `Skipped tab "${t.label}": model "${t.modelId}" not registered.`,
        });
        continue;
      }
      const handler = model.createMockHandler?.();
      if (!handler) continue;
      const wsPort = nextFreePort();
      const portName = `${model.info.displayName} Mock`;
      const transport = new MockTransport(handler, {
        lowerChannel: LOWER_CH,
        upperChannel: UPPER_CH,
        wsPort, portName,
        modelId: model.info.id,
        displayName: model.info.displayName,
        label: t.label,
      });
      try { await transport.start(); }
      catch (err) {
        console.error(`Transport start failed for ${t.label}:`, err);
        emitEvent(mainWindow, {
          severity: "error",
          source:   `${model.info.displayName} ("${t.label}")`,
          text:     `transport failed to start — ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const tabId = nextTabId();
      attachTransportListeners(tabId, transport);
      tabs.set(tabId, { tabId, model, transport, wsPort, label: t.label });

      const restored = transport.restoreSnapshot(t.state);
      if (!restored && t.state !== null) {
        emitEvent(mainWindow, {
          severity: "warn",
          source:   `${model.info.displayName} ("${t.label}")`,
          text:     "full state restore not yet implemented — knobs reset to defaults.",
        });
      }

      const isActive = i === parsed.activeTabIndex;
      mainWindow?.webContents.send("file:mount-tab", {
        tabId, modelInfoId: model.info.id, displayName: model.info.displayName,
        label: t.label, wsPort, modelUiDir: model.mockUiDir ?? null,
        isActive,
      });
      if (isActive) activeTabId = tabId;
    }

    if (activeTabId) lastActiveTabId = activeTabId;
    currentFilePath = path;
    app.addRecentDocument(path);
  } finally {
    restoring = false;
    clearDirty();
    pushDirtyChanged();
    refreshMenuEnabledState();
  }
}

async function openDialog(): Promise<void> {
  if (!await confirmDiscardIfDirty()) return;
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    title: "Open Studio Setup",
    properties: ["openFile"],
    filters: [{ name: "Mock Runner Setup", extensions: ["mockrack"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await loadSetupFromPath(result.filePaths[0]);
}

async function newSetup(): Promise<void> {
  if (!await confirmDiscardIfDirty()) return;
  restoring = true;
  try {
    await tearDownAllTabs();
    lastActiveTabId = null;
    currentFilePath = null;
  } finally {
    restoring = false;
    clearDirty();
    pushDirtyChanged();
    refreshMenuEnabledState();
  }
}

/**
 * Update the dynamic enabled state of File-menu items that depend on
 * session state (tab count, attached file path). Call this after any
 * state transition that can flip those conditions.
 */
function refreshMenuEnabledState(): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const newItem = menu.getMenuItemById("file.new");
  // Enable New whenever it would perform a meaningful reset: there are
  // tabs to clear, a file is attached, OR there's a dirty flag to drop
  // (the last case covers "user created a tab then closed it without
  // saving" — empty rack but still dirty).
  if (newItem) newItem.enabled = tabs.size > 0 || currentFilePath !== null || isDirty;
  const hasContent = hasContentToSave();
  const saveItem = menu.getMenuItemById("file.save");
  // Save needs both a destination file AND something to put in it,
  // otherwise Cmd+S would silently overwrite a saved file with empty
  // content (data loss on closing all tabs of an opened rack).
  if (saveItem) saveItem.enabled = currentFilePath !== null && hasContent;
  const saveAsItem = menu.getMenuItemById("file.saveAs");
  // Save As needs only content — no point creating a destination file
  // when there's nothing to put in it.
  if (saveAsItem) saveAsItem.enabled = hasContent;
}

function nextTabId(): string {
  return `tab-${nextTabSeq++}`;
}

function nextFreePort(): number {
  const used = new Set<number>();
  for (const t of tabs.values()) if (t.wsPort !== null) used.add(t.wsPort);
  let port = BASE_WS_PORT;
  while (used.has(port)) port++;
  return port;
}

/**
 * Auto-generate the next monotonic label for a model — `<model-id>-1`,
 * `<model-id>-2`, etc. Skips numbers already in use by other tabs of
 * the same model. The user can override via the rename-tab IPC.
 *
 * Format matches the backup-cache sanitization rule (lowercase
 * `[a-z0-9._-]` only) so display === storage.
 */
function nextLabelForModel(model: KeyboardModel): string {
  const slug = model.info.id;
  const taken = new Set<string>();
  for (const t of tabs.values()) {
    if (t.model?.info.id === slug && t.label) taken.add(t.label);
  }
  for (let n = 1; n < 1000; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-1`;
}

/** Sanitization mirrors the model-side backup-cache rule. */
function sanitizeLabel(label: string): string {
  let slug = label.trim().toLowerCase();
  slug = slug.replace(/\s+/g, "-");
  slug = slug.replace(/[^a-z0-9._-]/g, "");
  if (slug === "" || slug === "." || slug === ".." || slug.includes("..")) {
    return "_default";
  }
  return slug;
}

let mainWindow: BrowserWindow | null = null;

// ── Window ──

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1640,
    height: 980,
    minWidth: 1200,
    minHeight: 700,
    title: "Mock Runner",
    backgroundColor: "#101012",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // Allow iframe → parent postMessage; Electron applies sandbox per-frame
      webviewTag: false,
    },
  });

  void mainWindow.loadFile(join(SHELL_DIR, "index.html"));

  // Open renderer DevTools in detached mode when launched via
  // `npm run mock:runner:debug`. Detached so the DevTools window keeps
  // working even if the main window freezes.
  if (process.env.MOCK_RUNNER_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Intercept the window-close path (red X / Cmd+W) before the window
  // is destroyed, so confirmDiscardIfDirty has a parent window to anchor
  // its dialog to. Without this, by the time `before-quit` fires the
  // window is already gone and the prompt silently no-ops.
  mainWindow.on("close", (event) => {
    if (pendingQuit) return;       // user already confirmed
    if (!isDirty) return;
    event.preventDefault();
    void (async () => {
      if (await confirmDiscardIfDirty()) {
        pendingQuit = true;
        mainWindow?.destroy();
      }
    })();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Menu ──

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS: explicit app menu so the SUBMENU items read "About / Hide
    // / Quit Mock Runner". The BOLD menu-bar label still reads
    // "Electron" in dev because that's the running binary's
    // CFBundleName — it'll switch to "Mock Runner" once the app is
    // packaged via electron-builder (plan: macos-packager).
    ...(isMac ? [{ role: "appMenu" as const, label: app.name }] : []),
    {
      label: "File",
      submenu: [
        {
          id: "file.new",
          label: "New",
          accelerator: "CmdOrCtrl+N",
          enabled: false,
          click: () => { void newSetup(); },
        },
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => mainWindow?.webContents.send("menu:new-tab"),
        },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => { void openDialog(); },
        },
        { role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] },
        { type: "separator" },
        {
          id: "file.save",
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          enabled: false,
          click: () => { void saveCurrent(); },
        },
        {
          id: "file.saveAs",
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          enabled: false,
          click: () => { void saveAs(); },
        },
        { type: "separator" },
        {
          label: "Extract Backup…",
          accelerator: "CmdOrCtrl+E",
          click: () => mainWindow?.webContents.send("menu:extract-backup"),
        },
        {
          label: "Clear Event Log",
          accelerator: "CmdOrCtrl+K",
          // Always-enabled. The renderer ignores the event when CHAT is
          // active — that's simpler than syncing menu enablement with
          // renderer pane state.
          click: () => emitEventLogClear(mainWindow),
        },
        {
          // No accelerator — discoverable via menu only. Backlog #19 will
          // give it a permanent home (toolbar / composer-row / palette).
          label: "Reset Chat",
          click: () => mainWindow?.webContents.send("menu:chat-reset"),
        },
        // Quit lives in the app menu on macOS (no duplicate here). On
        // Windows/Linux there's no app menu, so the File menu owns Quit.
        ...(isMac ? [] : [
          { type: "separator" as const },
          { role: "quit" as const },
        ]),
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Tab lifecycle ──

async function destroyTab(entry: TabEntry): Promise<void> {
  if (entry.transport) {
    try { await entry.transport.stop(); } catch { /* swallow */ }
    entry.transport = null;
  }
  entry.wsPort = null;
  entry.model = null;
}

// ── IPC handlers ──

ipcMain.handle("get-models", async (): Promise<KeyboardModelInfo[]> => {
  return discoverModels();
});

ipcMain.handle("create-tab", (): { tabId: string } => {
  const tabId = nextTabId();
  tabs.set(tabId, { tabId, model: null, transport: null, wsPort: null, label: null });
  markDirty();
  refreshMenuEnabledState();
  return { tabId };
});

ipcMain.handle("close-tab", async (_event, tabId: string): Promise<{ ok: boolean }> => {
  const entry = tabs.get(tabId);
  if (!entry) return { ok: false };
  await destroyTab(entry);
  tabs.delete(tabId);
  markDirty();
  refreshMenuEnabledState();
  return { ok: true };
});

ipcMain.handle(
  "select-model-for-tab",
  async (_event, tabId: string, modelId: string, label?: string): Promise<{
    wsPort: number;
    modelUiDir: string | null;
    displayName: string;
    manufacturer: string;
    modelInfoId: string;
    label: string;
  }> => {
    const entry = tabs.get(tabId);
    if (!entry) throw new Error(`Unknown tab ${tabId}`);

    // If this tab already had a model, tear it down first
    if (entry.transport) await destroyTab(entry);

    const model = await loadModelById(modelId);
    const handler = model.createMockHandler?.();
    if (!handler) {
      throw new Error(`Model ${model.info.displayName} does not provide a mock handler.`);
    }

    const wsPort = nextFreePort();
    const resolvedLabel = label && label.trim().length > 0
      ? sanitizeLabel(label)
      : nextLabelForModel(model);
    const portName = `${model.info.displayName} Mock`;

    const transport = new MockTransport(handler, {
      lowerChannel: LOWER_CH,
      upperChannel: UPPER_CH,
      wsPort,
      portName,
      label: resolvedLabel,
      modelId: model.info.id,
      displayName: model.info.displayName,
    });
    await transport.start();
    attachTransportListeners(entry.tabId, transport);

    entry.model = model;
    entry.transport = transport;
    entry.wsPort = wsPort;
    entry.label = resolvedLabel;
    markDirty();
    // The tab just transitioned from "no model" to "has transport",
    // which flips hasContentToSave() — refresh Save / Save As enabled.
    refreshMenuEnabledState();

    return {
      wsPort,
      modelUiDir: model.mockUiDir ?? null,
      displayName: model.info.displayName,
      manufacturer: model.info.manufacturer,
      modelInfoId: model.info.id,
      label: resolvedLabel,
    };
  },
);

ipcMain.handle(
  "rename-tab",
  async (_event, tabId: string, newLabel: string): Promise<{ ok: boolean; label?: string; error?: string }> => {
    const entry = tabs.get(tabId);
    if (!entry) return { ok: false, error: `Unknown tab ${tabId}` };

    const slug = sanitizeLabel(newLabel);
    if (slug.length === 0 || slug === "_default") {
      return { ok: false, error: "Label can't be empty or '_default'" };
    }

    // Reject collisions with other tabs of the same model
    for (const other of tabs.values()) {
      if (other.tabId === tabId) continue;
      if (other.model?.info.id === entry.model?.info.id && other.label === slug) {
        return { ok: false, error: `Label "${slug}" already used by another tab.` };
      }
    }

    entry.label = slug;

    // Tell the live transport to re-init under the new label so the right
    // backup cache loads. Cheapest path: handler.init() with the new label,
    // then broadcast a fresh state snapshot.
    if (entry.transport && entry.model?.createMockHandler) {
      try { entry.transport.relabel(slug, LOWER_CH, UPPER_CH); } catch (err) {
        console.error("relabel failed:", err);
      }
    }

    markDirty();
    return { ok: true, label: slug };
  },
);

ipcMain.handle("list-tabs", (): Array<{
  tabId: string;
  modelInfoId: string | null;
  displayName: string | null;
  label: string | null;
  wsPort: number | null;
}> => {
  return [...tabs.values()].map((t) => ({
    tabId: t.tabId,
    modelInfoId: t.model?.info.id ?? null,
    displayName: t.model?.info.displayName ?? null,
    label: t.label,
    wsPort: t.wsPort,
  }));
});

// Lets a freshly-loaded renderer fetch the current liveness without waiting
// for the next transition. mcb-client owns the state — main is just relaying.
ipcMain.handle("get-broker-liveness", () => getBrokerLiveness());

// Phase 3 — per-tab MCB lease state. Returns one of "primary" | "shadow" |
// "none" per live tab so the renderer can color each tab's LED. MCB
// unreachable (not running, stale socket, etc.) or stalled past the
// timeout collapses to "none" for every tab — the mock-runner is not a
// hard dependent of MCB.
//
// Match key: wsPort alone. wsPort is the mock-registry's primary key
// and uniquely identifies a mock instance. Comparing portName is
// unsafe because Core MIDI auto-suffixes duplicate virtual port names
// (a second "Roland JUNO-X Mock" becomes "Roland JUNO-X Mock1"), and
// the transport doesn't see that rename — only the lease's portName
// (sourced from the OS) reflects it.
type TabLeaseState = "primary" | "shadow" | "none";
const MCB_LIST_TIMEOUT_MS = 1500;
ipcMain.handle("get-tab-lease-states", async (): Promise<Record<string, TabLeaseState>> => {
  const result: Record<string, TabLeaseState> = {};
  for (const t of tabs.values()) result[t.tabId] = "none";

  // Skip the UDS roundtrip when no tab has anything to match against.
  const candidates = [...tabs.values()].filter((t) => t.model && t.wsPort !== null);
  if (candidates.length === 0) return result;

  let leases;
  try {
    leases = await Promise.race([
      listAllDevices(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("mcb-list-timeout")), MCB_LIST_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch { return result; }

  for (const t of candidates) {
    for (const lease of leases) {
      if (lease.primary.wsPort === t.wsPort) {
        result[t.tabId] = "primary";
        break;
      }
      if (lease.shadow?.wsPort === t.wsPort) {
        result[t.tabId] = "shadow";
        break;
      }
    }
  }
  return result;
});

// Plan #9: renderer pushes the active tab id whenever it changes so main
// can persist it on save. Tab changes ARE persisted into the .mockrack
// file (as `activeTabIndex`), so they count as a dirty change — gated by
// `restoring` so the Open flow doesn't flip dirty as it foregrounds the
// restored tab.
ipcMain.handle("set-active-tab", (_event, tabId: string): void => {
  if (typeof tabId !== "string") return;
  if (lastActiveTabId === tabId) return;          // no-op
  lastActiveTabId = tabId;
  markDirty();
});

ipcMain.handle("open-backup-dialog", async (): Promise<string | null> => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: "Select Backup",
    properties: ["openFile", "openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle(
  "extract-backup",
  async (
    _event,
    args: { filePath: string; tabId?: string; label?: string },
  ): Promise<{ ok: boolean; message: string }> => {
    const { filePath } = args;
    let entry: TabEntry | undefined;
    if (args.tabId) entry = tabs.get(args.tabId);

    // Resolution: explicit tab → its model + label. Otherwise try unique tab.
    let model: KeyboardModel | null = null;
    let label: string;
    if (entry?.model) {
      model = entry.model;
      label = entry.label ?? "_default";
    } else if (args.label && args.label.trim().length > 0) {
      label = args.label;
      // Pick the first tab with backup capability (best-effort fallback)
      for (const t of tabs.values()) {
        if (t.model?.backup) { model = t.model; break; }
      }
    } else {
      // Single tab with a loaded model?
      const loaded = [...tabs.values()].filter((t) => t.model);
      if (loaded.length === 1) {
        model = loaded[0].model;
        label = loaded[0].label ?? "_default";
      } else {
        return { ok: false, message: "Specify a tab — multiple or no tabs are loaded." };
      }
    }

    if (!model?.backup) {
      return { ok: false, message: `${model?.info.displayName ?? "This model"} does not support backup extraction.` };
    }

    try {
      const stat = statSync(filePath);
      let data: Record<string, any>;
      if (stat.isDirectory()) {
        if (!model.backup.parseProgramsFolder) {
          return { ok: false, message: "This model does not support programs-only extraction." };
        }
        const cached = model.backupCache?.get(label);
        if (!cached) {
          return {
            ok: false,
            message: `Programs-only extraction needs an existing full-backup cache under "${label}".`,
          };
        }
        const programs = await model.backup.parseProgramsFolder(filePath);
        data = { ...cached, ...programs };
      } else {
        data = await model.backup.parseBackup(filePath);
      }

      model.backupCache?.set(data, label);
      model.backupCache?.setLastBackupPath(filePath, label);

      // Write the markdown inventory next to the cache
      const dataRoot = process.env.KEYBOARDS_MCP_DATA_DIR
        ?? join(__dirname, "..", "..", "data");
      const slug = model.info.id.replace(/[^a-z0-9]+/gi, "_");
      const labelDir = join(dataRoot, "backups", label.replace(/[^a-z0-9._-]/gi, "-"));
      mkdirSync(labelDir, { recursive: true });
      const dateMatch = basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
      const md = model.backup.formatAsMarkdown(data, dateMatch ? dateMatch[1] : undefined);
      writeFileSync(join(labelDir, `${slug}_backup_inventory.md`), md, "utf-8");

      // Tell the live mock(s) of this model + label to reload from disk
      for (const t of tabs.values()) {
        if (t.model?.info.id === model.info.id && (t.label ?? "_default") === label) {
          t.transport?.reloadCache?.();
        }
      }

      const programs = (data as any).programs?.length ?? 0;
      const samples = (data as any).samples?.length ?? 0;
      markDirty();
      return {
        ok: true,
        message: `Extracted under "${label}": ${programs} programs, ${samples} samples.`,
      };
    } catch (err) {
      return { ok: false, message: `Failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
);

// ── Song-analysis panel: workspace scan + file dialog + service URL ──
//
// The audio-analysis service writes jobs under
//   ~/.audio-analysis-mcp/workspace/jobs/<job_name>/source.wav
//   ~/.audio-analysis-mcp/workspace/jobs/<job_name>/stems/<preset>/*.wav
//   ~/.audio-analysis-mcp/workspace/jobs/<job_name>/song_structure/*.json
// Override workspace root via AUDIO_ANALYSIS_WORKSPACE; service URL via
// AUDIO_ANALYSIS_SERVICE_URL (default http://127.0.0.1:8765).

interface AnalysisJobSummary {
  name: string;
  path: string;
  displayName: string | null;     // unsanitized song title from .mock-runner.json
  hasSource: boolean;
  hasStems: boolean;
  hasStructure: boolean;
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
}

// Per-job sidecar written by the renderer right after a successful import.
// The audio-analysis service only knows the sanitized slug; the renderer
// preserves the human-readable title here so the UI can show "Kind Of Blue"
// instead of "kind-of-blue". Leading dot keeps it out of casual ls output.
const JOB_META_FILE = ".mock-runner.json";

interface JobMetadata {
  displayName?: string;
  originalFilename?: string;
  importedAt?: string;
}

function readJobMetadata(jobPath: string): JobMetadata | null {
  try {
    const raw = readFileSync(join(jobPath, JOB_META_FILE), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as JobMetadata;
  } catch {
    return null;
  }
}

function audioWorkspaceJobsDir(): string {
  const root = process.env.AUDIO_ANALYSIS_WORKSPACE
    ?? join(homedir(), ".audio-analysis-mcp", "workspace");
  return join(root, "jobs");
}

// Read sample rate, channels, and duration from a canonical PCM WAV produced
// by the audio-analysis-mcp normalizer (44.1kHz 16-bit mono). Returns null
// fields on any parse failure — the panel just renders them as blank.
//
// Scans chunk headers via small fd reads so we don't slurp the entire file
// (a 5-minute 44.1k/16-bit mono source.wav is ~26MB) just to grab the format
// chunk and the data-chunk size. The fmt chunk and the data header almost
// always live in the first few KB.
function probeWavHeader(filePath: string): { sampleRate: number; channels: number; durationSeconds: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, 12, 0) < 12) return null;
    if (header.toString("ascii", 0, 4) !== "RIFF") return null;
    if (header.toString("ascii", 8, 12) !== "WAVE") return null;

    let off = 12;
    let sampleRate = 0;
    let channels = 0;
    let byteRate = 0;
    let dataSize = 0;
    const chunkHdr = Buffer.alloc(8);
    const fmtBuf = Buffer.alloc(16);
    while (true) {
      if (readSync(fd, chunkHdr, 0, 8, off) < 8) break;
      const id = chunkHdr.toString("ascii", 0, 4);
      const size = chunkHdr.readUInt32LE(4);
      if (id === "fmt ") {
        const wanted = Math.min(size, fmtBuf.length);
        if (readSync(fd, fmtBuf, 0, wanted, off + 8) < wanted) break;
        channels   = fmtBuf.readUInt16LE(2);
        sampleRate = fmtBuf.readUInt32LE(4);
        byteRate   = fmtBuf.readUInt32LE(8);
      } else if (id === "data") {
        dataSize = size;
        break;
      }
      off += 8 + size + (size % 2); // pad to even
    }
    if (!byteRate || !dataSize || !sampleRate || !channels) return null;
    return { sampleRate, channels, durationSeconds: dataSize / byteRate };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function listAnalysisJobs(): AnalysisJobSummary[] {
  const jobsDir = audioWorkspaceJobsDir();
  let entries: string[];
  try {
    entries = readdirSync(jobsDir);
  } catch {
    return []; // jobs dir doesn't exist yet → empty workspace
  }
  const out: AnalysisJobSummary[] = [];
  for (const name of entries) {
    const path = join(jobsDir, name);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    const sourcePath = join(path, "source.wav");
    const stemsDir = join(path, "stems");
    const structureDir = join(path, "song_structure");

    const hasSource = existsSync(sourcePath);
    const hasStems = existsSync(stemsDir) && (() => {
      try { return readdirSync(stemsDir).length > 0; } catch { return false; }
    })();
    const hasStructure = existsSync(structureDir) && (() => {
      try { return readdirSync(structureDir).some((f) => f.endsWith(".json")); } catch { return false; }
    })();

    const probe = hasSource ? probeWavHeader(sourcePath) : null;
    const meta = readJobMetadata(path);
    out.push({
      name,
      path,
      displayName: typeof meta?.displayName === "string" && meta.displayName.trim().length > 0
        ? meta.displayName
        : null,
      hasSource,
      hasStems,
      hasStructure,
      durationSeconds: probe?.durationSeconds ?? null,
      sampleRate: probe?.sampleRate ?? null,
      channels: probe?.channels ?? null,
    });
  }
  // Alphabetical for stable rendering. The renderer can re-sort if needed.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

ipcMain.handle("list-analysis-jobs", (): AnalysisJobSummary[] => listAnalysisJobs());

// Renderer writes this right after a successful import so the operator
// sees the song title rather than the sanitized slug. jobPath must be
// inside the workspace jobs dir; we re-check containment via realpath
// (defeats `/jobs-evil` prefix tricks, symlink escapes, `..` segments) so
// a malicious renderer can't aim this at arbitrary filesystem locations.
ipcMain.handle("write-job-metadata", (
  _event,
  args: { jobPath: string; displayName?: string; originalFilename?: string },
): { ok: boolean; message?: string } => {
  const target = args.jobPath;
  if (typeof target !== "string") {
    return { ok: false, message: "Job path is outside the workspace." };
  }
  let resolvedRoot: string;
  let resolvedTarget: string;
  try {
    resolvedRoot = realpathSync(audioWorkspaceJobsDir());
    resolvedTarget = realpathSync(target);
  } catch {
    return { ok: false, message: "Job path does not exist." };
  }
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    return { ok: false, message: "Job path is outside the workspace." };
  }
  try {
    if (!statSync(resolvedTarget).isDirectory()) {
      return { ok: false, message: "Job path is not a directory." };
    }
  } catch {
    return { ok: false, message: "Job path does not exist." };
  }
  // Merge with any existing metadata so we don't clobber fields that a
  // future code path might have added.
  const existing = readJobMetadata(resolvedTarget) ?? {};
  const merged: JobMetadata = {
    ...existing,
    ...(args.displayName     !== undefined && { displayName:      args.displayName }),
    ...(args.originalFilename !== undefined && { originalFilename: args.originalFilename }),
    importedAt: existing.importedAt ?? new Date().toISOString(),
  };
  try {
    writeFileSync(join(resolvedTarget, JOB_META_FILE), JSON.stringify(merged, null, 2), "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("open-audio-import-dialog", async (): Promise<string | null> => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: "Import Audio",
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "flac", "aiff", "aif", "m4a", "ogg"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// fs.watch on the jobs dir, debounced — fires "audio-analysis:jobs-changed"
// at most every 250ms. The watcher is recreated if the directory appears
// after launch (first import creates it).
{
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;

  const emit = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("audio-analysis:jobs-changed");
    }
  };

  const armDebounced = (): void => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emit();
    }, 250);
  };

  const tryAttach = (): void => {
    if (watcher) return;
    const dir = audioWorkspaceJobsDir();
    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* tolerate; watch will fail and retry later */ }
    try {
      watcher = fsWatch(dir, { persistent: false }, () => armDebounced());
      watcher.on("error", () => {
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  };

  // Retry attach every 5s in case the dir didn't exist at launch or the
  // watch failed transiently. Cheap; only kicks while detached.
  setInterval(() => { if (!watcher) tryAttach(); }, 5000).unref();
  tryAttach();
}

// ── Audio-analysis IPC relay ──
//
// The renderer is sandboxed (file:// origin, contextIsolation on) so we
// don't let it talk HTTP directly. Main owns the AudioAnalysisClient;
// renderer goes through these IPC handlers. Streaming methods get a job
// id back and listen on `audio:analyze:event:<id>` / `audio:analyze:done:<id>`.
{
  let _client: AudioAnalysisClient | null = null;
  const getClient = (): AudioAnalysisClient => {
    if (!_client) {
      const serverUrl = process.env.AUDIO_ANALYSIS_SERVICE_URL ?? "http://127.0.0.1:8765";
      _client = new AudioAnalysisClient({ serverUrl });
    }
    return _client;
  };

  ipcMain.handle("audio:healthz", (): Promise<boolean> => getClient().healthz());

  ipcMain.handle("audio:import-audio", (_event, req: ImportRequest): Promise<ImportAudioResult> =>
    getClient().importAudio(req),
  );

  // Each active stream remembers its AbortController AND the WebContents
  // id of the renderer that started it, so audio:analyze:cancel can reject
  // requests coming from a different sender (defense against id-guessing
  // across renderer windows).
  const activeStreams = new Map<string, { ctrl: AbortController; ownerWcId: number }>();

  ipcMain.handle("audio:analyze:start", (
    event,
    args:
      | { kind: "stems"; req: StemsRequest }
      | { kind: "structure"; req: StructureRequest }
      | { kind: "transcribe"; req: TranscribeRequest },
  ): string => {
    // TypeScript erases the union tag at runtime — a malformed renderer
    // call could otherwise land an arbitrary `kind` value, fall through
    // the `=== "stems"` check, and silently invoke analyzeStructure on a
    // StemsRequest. Reject anything we don't recognize upfront.
    const rawKind = (args as { kind?: unknown } | null | undefined)?.kind;
    if (rawKind !== "stems" && rawKind !== "structure" && rawKind !== "transcribe") {
      throw new Error(`audio:analyze:start: unknown kind ${JSON.stringify(rawKind)}`);
    }

    const id = randomUUID();
    const ctrl = new AbortController();
    const wc: WebContents = event.sender;
    activeStreams.set(id, { ctrl, ownerWcId: wc.id });
    const eventCh = `audio:analyze:event:${id}`;
    const doneCh = `audio:analyze:done:${id}`;

    // If the renderer goes away mid-stream, abort the SSE read instead
    // of just bailing on the for-await — otherwise the HTTP connection
    // and the SSE generator on the service side would linger.
    const onDestroyed = (): void => ctrl.abort();
    wc.once("destroyed", onDestroyed);

    // Iterate in the background; don't block the handler return. The
    // renderer's invoke() resolves with the id immediately so it can
    // subscribe before the first event lands.
    void (async () => {
      try {
        const iter = args.kind === "stems"
          ? getClient().separateStems(args.req, { signal: ctrl.signal })
          : args.kind === "structure"
            ? getClient().analyzeStructure(args.req, { signal: ctrl.signal })
            : getClient().transcribeNotes(args.req, { signal: ctrl.signal });
        for await (const ev of iter) {
          if (wc.isDestroyed()) break;
          wc.send(eventCh, ev);
        }
        if (!wc.isDestroyed()) wc.send(doneCh, { ok: true });
      } catch (err) {
        if (!wc.isDestroyed()) {
          const message = err instanceof Error ? err.message : String(err);
          const name = err instanceof Error ? err.name : "Error";
          wc.send(doneCh, { ok: false, error: message, errorName: name });
        }
      } finally {
        activeStreams.delete(id);
        if (!wc.isDestroyed()) {
          try { wc.removeListener("destroyed", onDestroyed); } catch { /* ignore */ }
        }
      }
    })();

    return id;
  });

  ipcMain.handle("audio:analyze:cancel", (event, id: string): void => {
    const entry = activeStreams.get(id);
    if (!entry) return;
    // Only the renderer that started the stream can cancel it. Prevents
    // a misbehaving / compromised secondary window from killing another
    // window's in-flight analysis.
    if (entry.ownerWcId !== event.sender.id) return;
    entry.ctrl.abort();
  });
}

// ── App lifecycle ──

// macOS hands paths to the running app via this event — fired by the
// dock, by Open Recent, and by file-association double-click. The event
// can arrive before app.whenReady() / createWindow() (cold-launch via
// double-click), at which point loadSetupFromPath would create transports
// but no window exists to receive file:mount-tab events. Queue the path
// and replay it from the renderer's did-finish-load handler.
let pendingOpenPath: string | null = null;

app.on("open-file", (event, path) => {
  event.preventDefault();
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingOpenPath = path;
    return;
  }
  void (async () => {
    if (!await confirmDiscardIfDirty()) return;
    if (!existsSync(path)) {
      emitEvent(mainWindow, {
        severity: "error",
        source:   "setup",
        text:     `File not found: ${path}`,
      });
      return;
    }
    await loadSetupFromPath(path);
  })();
});

void app.whenReady().then(() => {
  // Drop registry entries left behind by a previous crashed mock-runner.
  // (Heart-beat-based stale detection handles the rest at read time.)
  mockRegistry.purgeStale();
  buildMenu();
  createWindow();

  // Subscribe to MCB broker-liveness — when MCB goes down/up, fan the
  // transition out to every renderer so the shell can flip tab LEDs into
  // a blinking-amber "MCB-down" state and back. mcb-client owns the polling
  // and state machine; the main process is just an IPC bridge.
  setOnBrokerLivenessChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("mcb:broker-liveness", state);
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Plan #9: auto-load. A pending `open-file` (cold-launch) wins over
  // the recents fallback. Wait for the renderer to be ready so
  // file:mount-tab events have a listener.
  mainWindow?.webContents.once("did-finish-load", () => {
    void (async () => {
      if (pendingOpenPath) {
        const path = pendingOpenPath;
        pendingOpenPath = null;
        if (existsSync(path)) {
          await loadSetupFromPath(path);
          return;
        }
        emitEvent(mainWindow, {
          severity: "warn",
          source:   "setup",
          text:     `File not found: ${path}`,
        });
      }
      const recents = app.getRecentDocuments();
      for (const path of recents) {
        if (existsSync(path)) {
          await loadSetupFromPath(path);
          return;
        }
      }
      // No surviving recents → empty rack (today's behavior).
    })();
  });
});

// Plan #9: dirty prompt on Quit (⌘Q / window-close on macOS).
let pendingQuit = false;
app.on("before-quit", (event) => {
  if (pendingQuit) return;        // we already confirmed; let the quit proceed
  if (!isDirty) return;
  event.preventDefault();
  void (async () => {
    if (await confirmDiscardIfDirty()) {
      pendingQuit = true;
      app.quit();
    }
  })();
});

app.on("window-all-closed", async () => {
  console.log("\nShutting down all tab transports...");
  for (const t of tabs.values()) {
    if (t.transport) {
      try { await t.transport.stop(); } catch { /* swallow */ }
    }
  }
  tabs.clear();
  app.quit();
});
