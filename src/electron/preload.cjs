/**
 * Electron preload script — exposes a safe IPC bridge to the renderer.
 * Must be CommonJS (.cjs) because Electron preload scripts don't support ESM.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openBackupDialog: () => ipcRenderer.invoke("open-backup-dialog"),
});
