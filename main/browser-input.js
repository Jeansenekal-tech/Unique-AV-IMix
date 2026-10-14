// Browser (web page) inputs, rendered offscreen and streamed as raw BGRA
// frames to the mixer window over IPC.
const { BrowserWindow } = require('electron');

class BrowserInputs {
  constructor(getTarget) {
    this.getTarget = getTarget; // () => webContents of the mixer
    this.windows = new Map();
  }

  open({ id, url, width = 1280, height = 720, fps = 25, transparent = true, css = '' }) {
    this.close(id);
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      transparent,
      frame: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setFrameRate(Math.max(1, Math.min(60, fps)));
    if (css) win.webContents.on('did-finish-load', () => win.webContents.insertCSS(css).catch(() => {}));
    win.webContents.on('paint', (_e, _dirty, image) => {
      const target = this.getTarget();
      if (!target || target.isDestroyed()) return;
      const size = image.getSize();
      if (!size.width || !size.height) return;
      target.send('browser-frame', { id, width: size.width, height: size.height, data: image.toBitmap() });
    });
    win.loadURL(url).catch(() => {});
    this.windows.set(id, win);
    return { ok: true };
  }

  navigate(id, url) {
    const win = this.windows.get(id);
    if (win) win.loadURL(url).catch(() => {});
  }

  reload(id) {
    const win = this.windows.get(id);
    if (win) win.webContents.reload();
  }

  close(id) {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) win.destroy();
    this.windows.delete(id);
  }

  closeAll() {
    for (const id of [...this.windows.keys()]) this.close(id);
  }
}

module.exports = { BrowserInputs };
