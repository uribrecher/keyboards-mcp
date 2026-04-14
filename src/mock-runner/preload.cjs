/**
 * Electron preload script — exposes a safe IPC bridge to the renderer.
 * Must be CommonJS (.cjs) because Electron preload scripts don't support ESM.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mockRunnerAPI", {
  getModels: () => ipcRenderer.invoke("get-models"),
  selectModel: (id) => ipcRenderer.invoke("select-model", id),
  getCurrentModel: () => ipcRenderer.invoke("get-current-model"),
  openBackupDialog: () => ipcRenderer.invoke("open-backup-dialog"),
});
