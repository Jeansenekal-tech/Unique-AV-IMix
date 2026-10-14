// Bridge for the Countdown operator window (window.uav), as in Unique AV
// Countdown, with IPC channels namespaced "cd:" inside Streaming GuRu.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(`cd:${channel}`, ...args);

contextBridge.exposeInMainWorld('uav', {
  appInfo: invoke('app:info'),
  getConfig: invoke('config:get'),
  cmd: (command, argument, source) => ipcRenderer.invoke('cd:cmd', command, argument ?? null, source || ''),
  updateSettings: invoke('settings:update'),
  updateSegment: invoke('segment:update'),
  addSegment: invoke('segment:add'),
  duplicateSegment: invoke('segment:duplicate'),
  deleteSegment: invoke('segment:delete'),
  moveSegment: invoke('segment:move'),
  gotoSegment: invoke('segment:goto'),
  quickTimer: invoke('quick'),
  newRundown: invoke('rundown:new'),
  openRundown: invoke('rundown:open'),
  saveRundown: invoke('rundown:save'),
  getDisplays: invoke('displays:get'),
  placePresenter: invoke('presenter:place'),
  setPresenterDisplay: invoke('presenter:setDisplay'),
  remoteInfo: invoke('remote:info'),
  desktopSources: invoke('video:desktopSources'),
  screenAccess: invoke('video:screenAccess'),
  openScreenSettings: invoke('video:openScreenSettings'),
  askCamera: invoke('video:askCamera'),
  checkUpdates: invoke('updates:check'),
  updateStatus: invoke('updates:status'),
  openExternal: invoke('open:external'),
  on: (channel, fn) => {
    const allowed = ['tick', 'config', 'sound', 'menu', 'presenter:closed', 'displays:changed'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(`cd:${channel}`, listener);
    return () => ipcRenderer.removeListener(`cd:${channel}`, listener);
  },
});
