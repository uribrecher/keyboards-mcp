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

  // MCB broker-liveness — fetched once on renderer load, then push-updated on
  // every transition. State is "up" | "down" | "unknown" (the latter only
  // before the first probe lands).
  getBrokerLiveness: () => ipcRenderer.invoke("get-broker-liveness"),
  onBrokerLiveness: (cb) =>
    ipcRenderer.on("mcb:broker-liveness", (_e, state) => cb(state)),

  // Menu → renderer events (relayed by main.ts via webContents.send)
  onMenuNewTab: (cb) => ipcRenderer.on("menu:new-tab", cb),
  onMenuExtractBackup: (cb) => ipcRenderer.on("menu:extract-backup", cb),
  onMenuChatReset: (cb) => ipcRenderer.on("menu:chat-reset", () => cb()),

  // Plan #9 — file menu plumbing
  setActiveTab: (tabId) => ipcRenderer.invoke("set-active-tab", tabId),
  onDirtyChanged: (cb) => ipcRenderer.on("file:dirty-changed", (_e, payload) => cb(payload)),
  onCloseTab: (cb) => ipcRenderer.on("file:close-tab", (_e, payload) => cb(payload)),
  onMountTab: (cb) => ipcRenderer.on("file:mount-tab", (_e, payload) => cb(payload)),
  onEventLog: (cb) => ipcRenderer.on("menu:event-log", (_e, payload) => cb(payload)),
  onEventLogClear: (cb) => ipcRenderer.on("menu:event-log-clear", () => cb()),

  // Todo #5 — per-tab MIDI traffic forwarded from each tab's MockTransport.
  // Payload shape: { tabId, ts, direction, kind, ...kindSpecificFields }.
  onMidiEvent: (cb) => ipcRenderer.on("midi:event", (_e, payload) => cb(payload)),
});
