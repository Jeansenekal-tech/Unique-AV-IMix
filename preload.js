// Exposes a small, explicit API to the mixer UI (window.imix).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('imix', {
  isElectron: true,
  info: () => ipcRenderer.invoke('app:info'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  readText: (p) => ipcRenderer.invoke('fs:readText', p),
  writeText: (p, text) => ipcRenderer.invoke('fs:writeText', p, text),
  writeBinary: (p, data) => ipcRenderer.invoke('fs:writeBinary', p, data),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),

  recordStart: (opts) => ipcRenderer.invoke('record:start', opts),
  recordChunk: (id, data) => ipcRenderer.send('record:chunk', id, data),
  recordStop: (id, opts) => ipcRenderer.invoke('record:stop', id, opts),

  streamStart: (opts) => ipcRenderer.invoke('stream:start', opts),
  streamChunk: (data) => ipcRenderer.send('stream:chunk', data),
  streamStop: () => ipcRenderer.invoke('stream:stop'),
  onStreamEvent: on('stream-event'),

  ffmpegInfo: () => ipcRenderer.invoke('ffmpeg:info'),
  ffmpegSetPath: (p) => ipcRenderer.invoke('ffmpeg:setPath', p),

  displays: () => ipcRenderer.invoke('displays:list'),
  setOutputTarget: (t) => ipcRenderer.invoke('output:target', t),
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id) => ipcRenderer.invoke('screen:select', id),
  mediaAccess: (type) => ipcRenderer.invoke('media:access', type),

  browserOpen: (opts) => ipcRenderer.invoke('browser:open', opts),
  browserNavigate: (id, url) => ipcRenderer.invoke('browser:navigate', id, url),
  browserReload: (id) => ipcRenderer.invoke('browser:reload', id),
  browserClose: (id) => ipcRenderer.invoke('browser:close', id),
  onBrowserFrame: on('browser-frame'),

  apiConfigure: (cfg) => ipcRenderer.invoke('api:configure', cfg),
  onApiRequest: on('api-request'),
  apiRespond: (reqId, result) => ipcRenderer.send('api-response', { reqId, result }),
  apiTally: (tally) => ipcRenderer.send('api-tally', tally),
  apiActs: (acts) => ipcRenderer.send('api-acts', acts),
  onSysmon: on('sysmon'),
  netAddresses: () => ipcRenderer.invoke('net:addresses'),

  setStatus: (status) => ipcRenderer.send('app:status', status),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  updateConfigure: (cfg) => ipcRenderer.invoke('update:configure', cfg),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: (opts) => ipcRenderer.invoke('update:install', opts),
  onUpdateStatus: on('update-status'),

  onMenu: on('menu'),
  onLog: on('log'),
});
