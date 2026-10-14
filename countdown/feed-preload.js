// Bridge for the Countdown mixer feed (offscreen page rendered as an input).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uavFeed', {
  getConfig: () => ipcRenderer.invoke('cd:config:get'),
  on: (channel, fn) => {
    if (!['tick', 'config'].includes(channel)) return () => {};
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(`cd:${channel}`, listener);
    return () => ipcRenderer.removeListener(`cd:${channel}`, listener);
  },
});
