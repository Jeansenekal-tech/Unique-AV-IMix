// Unique AV Recorder – Electron main process.
// The renderer captures the devices (getUserMedia) and records them with
// MediaRecorder; chunks are streamed here and written straight to disk, then
// FFmpeg turns the raw capture into the chosen format when recording stops.
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('./ffmpeg');

const APP_NAME = 'Unique AV Recorder';
app.setName(APP_NAME);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.env.UAR_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

let win = null;
let rec = null; // { stream, raw, output, format, codec, bytes }

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch {
    /* ignore */
  }
}

function defaultFolder() {
  return process.env.UAR_OUTPUT_DIR || path.join(app.getPath('videos'), APP_NAME);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function uniquePath(dir, base, ext) {
  let file = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i}).${ext}`);
  return file;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#15171c',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!rec) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep recording', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A recording is in progress.',
      detail: 'Quitting now stops the recording. The raw file is kept in the recordings folder.',
    });
    if (choice === 0) e.preventDefault();
  });
}

app.whenReady().then(() => {
  // Cameras, capture cards and microphones only – nothing else is requested.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  createWindow();
});
app.on('window-all-closed', () => {
  if (rec) {
    rec.stream.end();
    rec = null;
  }
  app.quit();
});

// ---------------------------------------------------------------- IPC
ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  return { ...s, folder: s.folder || defaultFolder(), ffmpeg: !!ffmpeg.findFfmpeg(), formats: ffmpeg.FORMATS };
});
ipcMain.handle('settings:set', (_e, patch) => {
  saveSettings({ ...loadSettings(), ...patch });
  return true;
});

ipcMain.handle('folder:choose', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose recordings folder',
    defaultPath: loadSettings().folder || defaultFolder(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  saveSettings({ ...loadSettings(), folder: r.filePaths[0] });
  return r.filePaths[0];
});
ipcMain.handle('folder:open', (_e, folder) => {
  fs.mkdirSync(folder, { recursive: true });
  return shell.openPath(folder);
});
ipcMain.handle('file:show', (_e, file) => shell.showItemInFolder(file));

ipcMain.handle('disk:free', (_e, folder) => {
  try {
    fs.mkdirSync(folder, { recursive: true });
    const s = fs.statfsSync(folder);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
});

ipcMain.handle('rec:start', (_e, { folder, format, codec, name }) => {
  if (rec) throw new Error('Already recording');
  const fmt = ffmpeg.FORMATS[format];
  if (!fmt) throw new Error(`Unknown format ${format}`);
  fs.mkdirSync(folder, { recursive: true });
  const base = `${(name || 'Recording').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Recording'} ${stamp()}`;
  const output = uniquePath(folder, base, fmt.ext);
  // The raw capture is kept next to the output until conversion succeeds, so
  // a crash or power cut still leaves a playable file behind.
  const raw = uniquePath(folder, `${path.basename(output, `.${fmt.ext}`)} (raw)`, fmt.audioOnly ? 'webm' : 'mkv');
  rec = { stream: fs.createWriteStream(raw), raw, output, format, codec, bytes: 0, error: null };
  rec.stream.on('error', (err) => {
    if (rec) rec.error = err.message;
  });
  return { raw, output };
});

ipcMain.handle('rec:chunk', (_e, buf) => {
  if (!rec) return { ok: false };
  if (rec.error) return { ok: false, error: rec.error };
  const data = Buffer.from(buf);
  rec.bytes += data.length;
  rec.stream.write(data);
  return { ok: true, bytes: rec.bytes };
});

ipcMain.handle('rec:stop', async () => {
  if (!rec) return { ok: false, reason: 'Not recording' };
  const r = rec;
  rec = null;
  await new Promise((resolve) => r.stream.end(resolve));
  if (r.bytes === 0) {
    try { fs.unlinkSync(r.raw); } catch { /* ignore */ }
    return { ok: false, reason: 'Nothing was recorded.' };
  }
  return ffmpeg.convert(r.raw, r.output, r.format, r.codec);
});
