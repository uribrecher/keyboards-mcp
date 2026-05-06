/**
 * Electron preload script — exposes a safe IPC bridge to the renderer.
 * Must be CommonJS (.cjs) because Electron preload scripts don't support ESM.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mockRunnerAPI", {
  // Catalog
  getModels: () => ipcRenderer.invoke("get-models"),

  // Tab lifecycle
  createTab: () => ipcRenderer.invoke("create-tab"),
  closeTab: (tabId) => ipcRenderer.invoke("close-tab", tabId),
  selectModelForTab: (tabId, modelId, label) =>
    ipcRenderer.invoke("select-model-for-tab", tabId, modelId, label),
  renameTab: (tabId, label) => ipcRenderer.invoke("rename-tab", tabId, label),
  listTabs: () => ipcRenderer.invoke("list-tabs"),

  // Backup workflow
  openBackupDialog: () => ipcRenderer.invoke("open-backup-dialog"),
  extractBackup: (args) => ipcRenderer.invoke("extract-backup", args),

  // Phase 3 — per-tab MCB lease state. Returns Record<tabId, "primary" | "shadow" | "none">.
  getTabLeaseStates: () => ipcRenderer.invoke("get-tab-lease-states"),

  // Menu → renderer events (relayed by main.ts via webContents.send)
  onMenuNewTab: (cb) => ipcRenderer.on("menu:new-tab", cb),
  onMenuExtractBackup: (cb) => ipcRenderer.on("menu:extract-backup", cb),

  // Plan #9 — file menu plumbing
  setActiveTab: (tabId) => ipcRenderer.invoke("set-active-tab", tabId),
  onDirtyChanged: (cb) => ipcRenderer.on("file:dirty-changed", (_e, payload) => cb(payload)),
  onCloseTab: (cb) => ipcRenderer.on("file:close-tab", (_e, payload) => cb(payload)),
  onMountTab: (cb) => ipcRenderer.on("file:mount-tab", (_e, payload) => cb(payload)),
  onConsoleNote: (cb) => ipcRenderer.on("menu:console-note", (_e, payload) => cb(payload)),
});
