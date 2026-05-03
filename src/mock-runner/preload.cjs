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

  // Menu → renderer events (relayed by main.ts via webContents.send)
  onMenuNewTab: (cb) => ipcRenderer.on("menu:new-tab", cb),
  onMenuExtractBackup: (cb) => ipcRenderer.on("menu:extract-backup", cb),
});
