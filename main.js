// Unique AV IMix – Electron main process.
const {
  app, BrowserWindow, ipcMain, dialog, Menu, shell, screen, desktopCapturer,
  session, systemPreferences, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { registerSchemePrivileges, handleProtocol, SCHEME } = require('./main/protocol');
const ffmpeg = require('./main/ffmpeg');
const { ApiServer } = require('./main/api-server');
const { BrowserInputs } = require('./main/browser-input');

const APP_NAME = 'Unique AV IMix';
app.setName(APP_NAME);
registerSchemePrivileges();

// Keep the mixer running at full rate even when the window is covered.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.IMIX_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

let mainWindow = null;
let outputTarget = { displayId: null, fullscreen: true };
let selectedScreenSource = null;
let appStatus = { recording: false, streaming: false };
const recordings = new Map();
let quitting = false;

const streamer = new ffmpeg.Streamer((ev) => send('stream-event', ev));
const browserInputs = new BrowserInputs(() => mainWindow && mainWindow.webContents);

// ---------------------------------------------------------------- API bridge
const pending = new Map();
let reqSeq = 0;
function askRenderer(kind, payload = {}) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve({ ok: false, message: 'Mixer not ready' });
    const reqId = ++reqSeq;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ ok: false, message: 'Timed out' });
    }, 5000);
    pending.set(reqId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    mainWindow.webContents.send('api-request', { reqId, kind, ...payload });
  });
}
ipcMain.on('api-response', (_e, { reqId, result }) => {
  const cb = pending.get(reqId);
  if (cb) {
    pending.delete(reqId);
    cb(result);
  }
});
const apiServer = new ApiServer(
  {
    call: (fn, params) => askRenderer('call', { fn, params }),
    xml: async () => (await askRenderer('xml')).data || '<vmix></vmix>',
    json: async () => (await askRenderer('json')).data || {},
    snapshot: async (input) => (await askRenderer('snapshot', { input })).data,
  },
  (msg) => send('log', msg)
);
ipcMain.on('api-tally', (_e, tally) => apiServer.pushTally(tally));

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

// ------------------------------------------------------------------- windows
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    title: APP_NAME,
    backgroundColor: '#15171c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
    },
  });
  mainWindow.loadURL(`${SCHEME}://app/index.html`);
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // External output window, opened from the renderer with window.open so it
  // can share the program MediaStream directly.
  mainWindow.webContents.setWindowOpenHandler(({ frameName, url }) => {
    if (frameName === 'imix-output' || frameName === 'imix-multiview') {
      const displays = screen.getAllDisplays();
      const d = displays.find((x) => String(x.id) === String(outputTarget.displayId))
        || displays.find((x) => x.id !== screen.getPrimaryDisplay().id)
        || screen.getPrimaryDisplay();
      const fullscreen = outputTarget.fullscreen && displays.length > 1;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x: d.bounds.x + (fullscreen ? 0 : 80),
          y: d.bounds.y + (fullscreen ? 0 : 80),
          width: fullscreen ? d.bounds.width : 960,
          height: fullscreen ? d.bounds.height : 540,
          fullscreen,
          backgroundColor: '#000000',
          title: frameName === 'imix-output' ? `${APP_NAME} – Output` : `${APP_NAME} – Multiview`,
          autoHideMenuBar: true,
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    if (appStatus.recording || appStatus.streaming) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Quit'],
        defaultId: 0,
        message: 'You are currently ' + [appStatus.recording && 'recording', appStatus.streaming && 'streaming'].filter(Boolean).join(' and ') + '.',
        detail: 'Quitting now will stop all outputs.',
      });
      if (choice === 0) {
        e.preventDefault();
        return;
      }
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    streamer.stop();
    browserInputs.closeAll();
  });
}

function menuCommand(cmd, arg) {
  return () => send('menu', { cmd, arg });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
        label: APP_NAME,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Cmd+,', click: menuCommand('settings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: menuCommand('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: menuCommand('open') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: menuCommand('save') },
        { label: 'Save Project As…', accelerator: 'CmdOrCtrl+Shift+S', click: menuCommand('saveAs') },
        { type: 'separator' },
        { label: 'Snapshot Program', accelerator: 'CmdOrCtrl+Shift+P', click: menuCommand('snapshot') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Settings…', click: menuCommand('settings') }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Input',
      submenu: [
        ['Camera / Capture Device…', 'camera'],
        ['Microphone / Audio Device…', 'audio'],
        ['Screen / Window Capture…', 'screen'],
        ['Video File…', 'video'],
        ['Video List / Playlist…', 'list'],
        ['Image…', 'image'],
        ['Audio File…', 'audiofile'],
        ['Title / Graphics…', 'title'],
        ['Colour…', 'colour'],
        ['Web Browser…', 'browser'],
        ['Stream URL…', 'url'],
        ['Instant Replay', 'replay'],
      ].map(([label, type]) => ({ label, click: menuCommand('addInput', type) })),
    },
    {
      label: 'Output',
      submenu: [
        { label: 'Start / Stop Recording', accelerator: 'CmdOrCtrl+R', click: menuCommand('record') },
        { label: 'Start / Stop Streaming', accelerator: 'CmdOrCtrl+Shift+R', click: menuCommand('stream') },
        { label: 'External Output…', click: menuCommand('external') },
        { label: 'Multiview Output…', click: menuCommand('multiview') },
        { type: 'separator' },
        { label: 'Recording & Streaming Settings…', click: menuCommand('settings', 'outputs') },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Scripting…', click: menuCommand('scripts') },
        { label: 'Shortcuts & MIDI…', click: menuCommand('shortcuts') },
        { label: 'Web Controller & API…', click: menuCommand('settings', 'api') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: menuCommand('help') },
        { label: 'API Reference', click: menuCommand('apihelp') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    moviesDir: path.join(app.getPath('videos'), APP_NAME),
    documentsDir: app.getPath('documents'),
  }));

  ipcMain.handle('dialog:open', async (_e, opts) => {
    const r = await dialog.showOpenDialog(mainWindow, opts || {});
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:save', async (_e, opts) => {
    const r = await dialog.showSaveDialog(mainWindow, opts || {});
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('fs:readText', (_e, p) => fs.promises.readFile(p, 'utf8'));
  ipcMain.handle('fs:writeText', async (_e, p, text) => {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, text, 'utf8');
    return true;
  });
  ipcMain.handle('fs:writeBinary', async (_e, p, data) => {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, Buffer.from(data));
    return p;
  });
  ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));

  // Recording – chunks from MediaRecorder are appended to disk as they arrive.
  ipcMain.handle('record:start', async (_e, { dir, filename }) => {
    const folder = dir || path.join(app.getPath('videos'), APP_NAME);
    await fs.promises.mkdir(folder, { recursive: true });
    const file = path.join(folder, filename);
    const id = `rec${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    recordings.set(id, { file, stream: fs.createWriteStream(file) });
    return { id, file };
  });
  ipcMain.on('record:chunk', (_e, id, data) => {
    const r = recordings.get(id);
    if (r) r.stream.write(Buffer.from(data));
  });
  ipcMain.handle('record:stop', async (_e, id, { remux } = {}) => {
    const r = recordings.get(id);
    if (!r) return null;
    recordings.delete(id);
    await new Promise((res) => r.stream.end(res));
    if (remux) {
      const ext = path.extname(r.file).slice(1);
      const out = await ffmpeg.remux(r.file, remux === true ? ext : remux);
      return out.file;
    }
    return r.file;
  });

  // Streaming
  ipcMain.handle('stream:start', (_e, opts) => {
    try {
      return streamer.start(opts);
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
  ipcMain.on('stream:chunk', (_e, data) => streamer.write(data));
  ipcMain.handle('stream:stop', () => {
    streamer.stop();
    return true;
  });

  ipcMain.handle('ffmpeg:info', () => ffmpeg.ffmpegInfo());
  ipcMain.handle('ffmpeg:setPath', (_e, p) => {
    ffmpeg.setCustomPath(p);
    return ffmpeg.ffmpegInfo();
  });

  ipcMain.handle('displays:list', () => screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === screen.getPrimaryDisplay().id,
  })));
  ipcMain.handle('output:target', (_e, target) => {
    outputTarget = { ...outputTarget, ...target };
    return outputTarget;
  });

  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  ipcMain.handle('screen:select', (_e, id) => {
    selectedScreenSource = id;
    return true;
  });

  ipcMain.handle('media:access', async (_e, type) => {
    if (process.platform !== 'darwin') return true;
    if (type === 'screen') return systemPreferences.getMediaAccessStatus('screen');
    const status = systemPreferences.getMediaAccessStatus(type);
    if (status === 'granted') return true;
    return systemPreferences.askForMediaAccess(type);
  });

  ipcMain.handle('browser:open', (_e, opts) => browserInputs.open(opts));
  ipcMain.handle('browser:navigate', (_e, id, url) => browserInputs.navigate(id, url));
  ipcMain.handle('browser:reload', (_e, id) => browserInputs.reload(id));
  ipcMain.handle('browser:close', (_e, id) => browserInputs.close(id));

  ipcMain.handle('api:configure', (_e, config) => apiServer.apply(config));
  ipcMain.handle('net:addresses', () => {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
  });

  ipcMain.on('app:status', (_e, status) => {
    appStatus = { ...appStatus, ...status };
  });
  ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return false;
  });
}

// --------------------------------------------------------------------- start
app.whenReady().then(async () => {
  handleProtocol();

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    const allowed = ['media', 'display-capture', 'midi', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications'];
    cb(wc.getURL().startsWith(`${SCHEME}://`) && allowed.includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    const url = wc ? wc.getURL() : '';
    return url.startsWith(`${SCHEME}://`) || permission === 'media';
  });
  // getDisplayMedia() → use the source picked in the in-app screen picker.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const src = sources.find((s) => s.id === selectedScreenSource) || sources[0];
    if (!src) return cb({});
    cb({ video: src, audio: process.platform === 'darwin' ? undefined : 'loopback' });
  });

  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    if (fs.existsSync(iconPath) && app.dock) app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Unique AV',
    credits: 'Live production: inputs, transitions, overlays, titles, audio, record, stream, replay.',
  });

  registerIpc();
  buildMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  streamer.stop();
  browserInputs.closeAll();
  apiServer.stop();
});

app.on('window-all-closed', () => {
  app.quit();
});
