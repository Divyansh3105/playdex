// The page's only access to the system: these calls, no Node, no raw ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('library', {
  scan: () => ipcRenderer.invoke('scan'),
  launch: id => ipcRenderer.invoke('launch', String(id)),
  uninstall: id => ipcRenderer.invoke('uninstall', String(id)),
  exportLibrary: () => ipcRenderer.invoke('export'),
  details: id => ipcRenderer.invoke('details', String(id)),
  prefs: () => ipcRenderer.invoke('prefs-get'),
  savePrefs: prefs => ipcRenderer.invoke('prefs-set', prefs),
  settings: () => ipcRenderer.invoke('settings-get'),
  saveSettings: s => ipcRenderer.invoke('settings-set', s),
  openKeyPage: () => ipcRenderer.invoke('open-key-page'),
});
