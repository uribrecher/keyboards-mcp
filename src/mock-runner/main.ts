/**
 * Generic Mock Runner — Electron main process.
 *
 * Starts with a model picker, then loads the selected keyboard model's
 * mock device engine and web UI. No model-specific code here.
 *
 * Usage: npm run mock:runner
 */

import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverModels, loadModelById } from "../shared/model-registry.js";
import type { KeyboardModel, KeyboardModelInfo, MockHandler } from "../shared/keyboard-model.js";
import { MockEngine } from "./engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths back to src/ (from dist/mock-runner/)
const srcDir = join(__dirname, "..", "..", "src", "mock-runner");
const SHELL_DIR = join(srcDir, "shell");
const PRELOAD_PATH = join(srcDir, "preload.cjs");

const WS_PORT = 3000;
const LOWER_CH = parseInt(process.env.LOWER_CHANNEL ?? "0");
const UPPER_CH = parseInt(process.env.UPPER_CHANNEL ?? "1");

let mainWindow: BrowserWindow | null = null;
let engine: MockEngine | null = null;
let currentModel: KeyboardModel | null = null;
let switching = false;

// ── Window ──

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Keyboard Mock Runner",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(join(SHELL_DIR, "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Model switching ──

async function switchModel(modelId: string): Promise<void> {
  if (switching) return;
  switching = true;
  try {
    await switchModelInner(modelId);
  } finally {
    switching = false;
  }
}

async function switchModelInner(modelId: string): Promise<void> {
  // Stop existing engine
  if (engine) {
    console.log(`Unloading model ${currentModel?.info.displayName ?? "unknown"}...`);
    await engine.stop();
    engine = null;
    currentModel = null;
  }

  console.log(`User picked ${modelId}, loading model...`);
  const model = await loadModelById(modelId);
  currentModel = model;

  // Create handler and engine
  const handler = model.createMockHandler?.();
  if (!handler) {
    console.error(`Model ${model.info.displayName} does not provide a mock handler.`);
    return;
  }
  engine = new MockEngine(handler, {
    lowerChannel: LOWER_CH,
    upperChannel: UPPER_CH,
    wsPort: WS_PORT,
    portName: `${model.info.displayName} Mock`,
  });
  engine.start();

  // Update window
  if (mainWindow) {
    mainWindow.setTitle(`${model.info.displayName} — Mock Device`);

    if (model.mockUiDir) {
      mainWindow.loadFile(join(model.mockUiDir, "index.html"));
    }
  }
}

async function goToModelPicker(): Promise<void> {
  if (switching) return;
  switching = true;
  try {
    if (engine) {
      console.log(`Unloading model ${currentModel?.info.displayName ?? "unknown"}, switching to model picker...`);
      await engine.stop();
      engine = null;
      currentModel = null;
    }
    if (mainWindow) {
      mainWindow.setTitle("Keyboard Mock Runner");
      mainWindow.loadFile(join(SHELL_DIR, "index.html"));
    }
  } finally {
    switching = false;
  }
}

// ── Menu ──

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Switch Model…",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => goToModelPicker(),
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

// ── IPC handlers ──

ipcMain.handle("get-models", async (): Promise<KeyboardModelInfo[]> => {
  return discoverModels();
});

ipcMain.handle("select-model", async (_event, modelId: string): Promise<void> => {
  await switchModel(modelId);
});

ipcMain.handle("get-current-model", (): KeyboardModelInfo | null => {
  return currentModel?.info ?? null;
});

ipcMain.handle("open-backup-dialog", async () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;

  const result = await dialog.showOpenDialog(win, {
    title: "Select Backup",
    properties: ["openFile", "openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── App lifecycle ──

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  console.log("\nShutting down...");
  if (engine) await engine.stop();
  app.quit();
});
