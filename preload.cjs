// The page's only access to the system: four calls, no Node, no raw ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('library', {
  scan: () => ipcRenderer.invoke('scan'),
  launch: id => ipcRenderer.invoke('launch', String(id)),
  details: id => ipcRenderer.invoke('details', String(id)),
  openSettings: () => ipcRenderer.invoke('open-settings'),
});
