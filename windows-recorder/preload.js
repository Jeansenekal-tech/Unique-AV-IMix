// Narrow bridge between the recorder UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorder', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openFolder: (folder) => ipcRenderer.invoke('folder:open', folder),
  showFile: (file) => ipcRenderer.invoke('file:show', file),
  diskFree: (folder) => ipcRenderer.invoke('disk:free', folder),
  start: (opts) => ipcRenderer.invoke('rec:start', opts),
  chunk: (buf) => ipcRenderer.invoke('rec:chunk', buf),
  stop: () => ipcRenderer.invoke('rec:stop'),
});
