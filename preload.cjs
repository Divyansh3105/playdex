// The page's only access to the system: three calls, no Node, no raw ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('library', {
  scan: () => ipcRenderer.invoke('scan'),
  launch: id => ipcRenderer.invoke('launch', String(id)),
  openSettings: () => ipcRenderer.invoke('open-settings'),
});
