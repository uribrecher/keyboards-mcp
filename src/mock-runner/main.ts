/**
 * Tabbed Mock Runner — Electron main process.
 *
 * The shell window is loaded once at startup and never reloaded. Each tab in
 * the shell hosts an iframe (model chooser → model UI). The main process
 * owns one MockEngine per tab on its own WebSocket port; ports are allocated
 * sequentially from BASE_WS_PORT and freed on tab close.
 */

import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { join, dirname, basename } from "node:path";
import { statSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverModels, loadModelById } from "../shared/model-registry.js";
import type { KeyboardModel, KeyboardModelInfo } from "../shared/keyboard-model.js";
import { MockEngine } from "./engine.js";
import * as mockRegistry from "../shared/mock-registry.js";
import {
  parseMockrack,
  writeMockrackAtomic,
  MOCKRACK_VERSION,
  type MockrackV1,
  type MockrackTab,
} from "../shared/mockrack-format.js";

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
  engine: MockEngine | null;
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
}

function clearDirty(): void {
  if (!isDirty) return;
  isDirty = false;
  pushDirtyChanged();
}

function pushDirtyChanged(): void {
  mainWindow?.webContents.send("file:dirty-changed", { isDirty, currentFilePath });
}

/** Debounced state-changed handler for engine broadcasts. */
function onEngineStateChanged(): void {
  if (restoring) return;
  if (dirtyDebounceTimer) return;
  dirtyDebounceTimer = setTimeout(() => {
    dirtyDebounceTimer = null;
    markDirty();
  }, 250);
  if (dirtyDebounceTimer.unref) dirtyDebounceTimer.unref();
}

// ── Save / Open flows ──────────────────────────────────────────────

function buildSetupSnapshot(): MockrackV1 {
  const entries = [...tabs.values()].filter((t) => t.model && t.engine);
  const tabsOut: MockrackTab[] = entries.map((t) => ({
    modelId: t.model!.info.id,
    label:   t.label ?? "_default",
    state:   t.engine!.getFullState(false),
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
    ? currentFilePath.split("/").pop() ?? "current setup"
    : "current setup";
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: `Save changes to "${fileLabel}"?`,
    detail: "Your changes will be lost if you don't save them.",
  });
  if (result.response === 2) return false; // Cancel
  if (result.response === 0) {              // Save
    if (currentFilePath) await saveCurrent();
    else await saveAs();
    if (isDirty) return false;              // Save dialog was cancelled
  }
  return true;                              // Don't Save (or Save succeeded)
}

async function tearDownAllTabs(): Promise<void> {
  for (const entry of [...tabs.values()]) {
    if (entry.engine) {
      try { await entry.engine.stop(); } catch { /* swallow */ }
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
        mainWindow?.webContents.send("menu:console-note",
          { text: `Skipped tab "${t.label}": model "${t.modelId}" not registered.` });
        continue;
      }
      const handler = model.createMockHandler?.();
      if (!handler) continue;
      const wsPort = nextFreePort();
      const portName = `${model.info.displayName} Mock`;
      const engine = new MockEngine(handler, {
        lowerChannel: LOWER_CH,
        upperChannel: UPPER_CH,
        wsPort, portName,
        modelId: model.info.id,
        displayName: model.info.displayName,
        label: t.label,
      });
      try { await engine.start(); }
      catch (err) {
        console.error(`Engine start failed for ${t.label}:`, err);
        continue;
      }
      engine.on("state-changed", onEngineStateChanged);

      const tabId = nextTabId();
      tabs.set(tabId, { tabId, model, engine, wsPort, label: t.label });

      const restored = engine.restoreSnapshot(t.state);
      if (!restored && t.state !== null) {
        mainWindow?.webContents.send("menu:console-note",
          { text: `${model.info.displayName} ("${t.label}"): full state restore not yet implemented — knobs reset to defaults.` });
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
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Menu ──

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS: explicit app menu so the leftmost item reads "Mock Runner"
    // (with About / Hide / Quit) instead of Electron's default fallback.
    ...(isMac ? [{ role: "appMenu" as const, label: app.name }] : []),
    {
      label: "File",
      submenu: [
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
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => { void saveCurrent(); },
        },
        {
          label: "Save As…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => { void saveAs(); },
        },
        { type: "separator" },
        {
          label: "Extract Backup…",
          accelerator: "CmdOrCtrl+E",
          click: () => mainWindow?.webContents.send("menu:extract-backup"),
        },
        { type: "separator" },
        { role: "quit" },
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
  if (entry.engine) {
    try { await entry.engine.stop(); } catch { /* swallow */ }
    entry.engine = null;
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
  tabs.set(tabId, { tabId, model: null, engine: null, wsPort: null, label: null });
  markDirty();
  return { tabId };
});

ipcMain.handle("close-tab", async (_event, tabId: string): Promise<{ ok: boolean }> => {
  const entry = tabs.get(tabId);
  if (!entry) return { ok: false };
  await destroyTab(entry);
  tabs.delete(tabId);
  markDirty();
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
    if (entry.engine) await destroyTab(entry);

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

    const engine = new MockEngine(handler, {
      lowerChannel: LOWER_CH,
      upperChannel: UPPER_CH,
      wsPort,
      portName,
      label: resolvedLabel,
      modelId: model.info.id,
      displayName: model.info.displayName,
    });
    await engine.start();
    engine.on("state-changed", onEngineStateChanged);

    entry.model = model;
    entry.engine = engine;
    entry.wsPort = wsPort;
    entry.label = resolvedLabel;
    markDirty();

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

    // Tell the live engine to re-init under the new label so the right
    // backup cache loads. Cheapest path: handler.init() with the new label,
    // then broadcast a fresh state snapshot.
    if (entry.engine && entry.model?.createMockHandler) {
      try { entry.engine.relabel(slug, LOWER_CH, UPPER_CH); } catch (err) {
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

// Plan #9: renderer pushes the active tab id whenever it changes so main
// can persist it on save. Switching tabs is pure navigation — NOT a dirty
// trigger.
ipcMain.handle("set-active-tab", (_event, tabId: string): void => {
  if (typeof tabId === "string") {
    lastActiveTabId = tabId;
  }
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
          t.engine?.reloadCache?.();
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

// ── App lifecycle ──

// macOS hands paths to the running app via this event — fired by the
// dock, by Open Recent, and by file-association double-click.
app.on("open-file", (event, path) => {
  event.preventDefault();
  void (async () => {
    if (!await confirmDiscardIfDirty()) return;
    if (!existsSync(path)) {
      mainWindow?.webContents.send("menu:console-note",
        { text: `File not found: ${path}` });
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Plan #9: auto-load the most-recent surviving setup. Wait for the
  // renderer to be ready so file:mount-tab events have a listener.
  mainWindow?.webContents.once("did-finish-load", () => {
    void (async () => {
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
  console.log("\nShutting down all tab engines...");
  for (const t of tabs.values()) {
    if (t.engine) {
      try { await t.engine.stop(); } catch { /* swallow */ }
    }
  }
  tabs.clear();
  app.quit();
});
