// Hosts Unique AV Countdown (Jeansenekal-tech/UniqueAVCountdown) inside
// Streaming GuRu: the timer engine, its operator window + presenter screen,
// phone remote (HTTP), OSC, and the bridge to the mixer (Countdown input,
// API functions, top-bar status). Ported from the countdown's main.js.
const {
  app, BrowserWindow, ipcMain, screen, dialog, shell, desktopCapturer, systemPreferences, webContents,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { TimerEngine } = require('../countdown/main/engine');
const { OSCServer } = require('../countdown/main/osc');
const { WebRemoteServer, localIPv4 } = require('../countdown/main/web-remote');

const IS_MAC = process.platform === 'darwin';
const COUNTDOWN_DIR = path.join(__dirname, '..', 'countdown');

class CountdownHost {
  constructor({ getMainWindow, onUpdateCheck, updateStatus }) {
    this.getMainWindow = getMainWindow;
    this.onUpdateCheck = onUpdateCheck;
    this.updateStatus = updateStatus;
    this.operator = null;
    this.presenter = null;
    this.placedKey = '';
    this.saveTimer = null;
    this.quitting = false;
  }

  get stateFile() {
    return path.join(app.getPath('userData'), 'countdown-state.json');
  }

  // Use our own saved state, or import the standalone Unique AV Countdown app's.
  loadState() {
    const candidates = [this.stateFile, path.join(app.getPath('appData'), 'Unique AV Countdown', 'state.json')];
    for (const f of candidates) {
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (data && Array.isArray(data.segments)) return data;
      } catch {
        /* not there */
      }
    }
    return {};
  }

  start() {
    this.engine = new TimerEngine(this.loadState());
    this.web = new WebRemoteServer({ state: () => this.engine.remoteState(), command: (c, v) => this.engine.perform(c, v, 'Web') });
    this.osc = new OSCServer((c, v) => this.engine.perform(c, v, 'OSC'));
    this.engine.on('config', () => {
      this.broadcast('cd:config', this.engine.getConfig());
      this.applyServices();
      this.scheduleSave();
    });
    this.engine.on('sound', (kind) => this.sendOperator('cd:sound', kind));
    this.ticker = setInterval(() => {
      this.engine.tick();
      this.broadcast('cd:tick', this.engine.snapshot());
    }, 100);
    this.registerIpc();
    this.applyServices();
    const onDisplays = () => {
      if (this.presenter) this.placePresenter();
      this.sendOperator('cd:displays:changed');
    };
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
  }

  stop() {
    this.quitting = true;
    clearInterval(this.ticker);
    this.saveNow();
    this.web?.stop();
    this.osc?.stop();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    if (!this.engine) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const data = { segments: this.engine.segments, settings: this.engine.settings };
      fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (e) {
      console.error('Could not save countdown state', e);
    }
  }

  applyServices() {
    const s = this.engine.settings;
    if (s.webEnabled) {
      if (this.web.port !== s.webPort) this.web.start(s.webPort);
    } else if (this.web.port !== null) this.web.stop();
    if (s.oscEnabled) {
      if (this.osc.port !== s.oscPort) this.osc.start(s.oscPort);
    } else if (this.osc.port !== null) this.osc.stop();
  }

  // Ticks/config go to the operator, the mixer window and every Countdown feed.
  broadcast(channel, data) {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      const url = wc.getURL();
      if (url.startsWith('app://ui/operator') || url.startsWith('app://ui/feed') || url.startsWith('imix://app/index')) wc.send(channel, data);
    }
  }

  sendOperator(channel, ...args) {
    if (this.operator && !this.operator.isDestroyed()) this.operator.webContents.send(channel, ...args);
  }

  // ------------------------------------------------------------ displays
  displayList() {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().map((d, i) => {
      const name = d.label || (d.internal ? 'Built-in display' : `Display ${i + 1}`);
      return { id: d.id, name: `${name} — ${d.size.width}×${d.size.height}${d.id === primary.id ? ' (main)' : ''}`, primary: d.id === primary.id };
    });
  }

  targetDisplay() {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return all.find((d) => d.id === this.engine.settings.presenterDisplayId) || all.find((d) => d.id !== primary.id) || primary;
  }

  placePresenter() {
    const p = this.presenter;
    if (!p || p.isDestroyed()) return { windowed: true, open: false };
    const d = this.targetDisplay();
    const windowed = screen.getAllDisplays().length < 2 || d.id === screen.getPrimaryDisplay().id;
    const key = `${d.id}|${windowed}|${JSON.stringify(d.bounds)}`;
    if (key === this.placedKey && p.isVisible()) return { windowed, open: true };
    this.placedKey = key;
    if (IS_MAC) p.setSimpleFullScreen(false);
    else p.setFullScreen(false);
    if (windowed) {
      const wa = d.workArea;
      const w = Math.min(960, wa.width);
      const h = Math.round((w * 9) / 16);
      p.setAlwaysOnTop(true, 'floating');
      p.setResizable(true);
      p.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h });
      p.setAspectRatio(16 / 9);
    } else {
      p.setAspectRatio(0);
      p.setBounds(d.bounds);
      p.setAlwaysOnTop(true, 'screen-saver');
      if (IS_MAC) p.setSimpleFullScreen(true);
      else p.setFullScreen(true);
    }
    if (!p.isVisible()) p.showInactive();
    return { windowed, open: true };
  }

  // ------------------------------------------------------- operator window
  // Created hidden at launch and kept alive (closing hides it) so the
  // presenter screen, warning sounds and MIDI keep working.
  createOperator() {
    if (this.operator && !this.operator.isDestroyed()) return this.operator;
    const win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 1040,
      minHeight: 680,
      title: 'Countdown – Unique AV Streaming GuRu',
      backgroundColor: '#111317',
      show: false,
      webPreferences: {
        preload: path.join(COUNTDOWN_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('app://ui/presenter.html')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            show: false,
            frame: false,
            title: 'Presenter',
            backgroundColor: '#000000',
            autoHideMenuBar: true,
            fullscreenable: true,
            webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-create-window', (child) => {
      this.presenter = child;
      this.placedKey = '';
      child.once('ready-to-show', () => this.placePresenter());
      child.on('closed', () => {
        this.presenter = null;
        this.placedKey = '';
        this.sendOperator('cd:presenter:closed');
      });
    });
    win.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      this.operator = null;
    });
    win.loadURL('app://ui/operator.html');
    this.operator = win;
    return win;
  }

  showOperator() {
    const win = this.createOperator();
    if (win.webContents.isLoading()) win.once('ready-to-show', () => win.show());
    else win.show();
    win.focus();
    return true;
  }

  menuAction(what) {
    this.createOperator();
    this.sendOperator('cd:menu', what);
  }

  // ------------------------------------------------------------- rundowns
  async newRundown() {
    const { response } = await dialog.showMessageBox(this.operator || undefined, {
      type: 'question',
      buttons: ['New Rundown', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Start a new rundown?',
      detail: 'The current rundown will be replaced. Save it first if you need it.',
    });
    if (response === 0) this.engine.newRundown();
  }

  async openRundown() {
    const r = await dialog.showOpenDialog(this.operator || undefined, { title: 'Open Rundown', filters: [{ name: 'Rundown', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return;
    try {
      this.engine.loadRundown(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
    } catch (e) {
      dialog.showErrorBox("Couldn't open rundown", e.message);
    }
  }

  async saveRundown() {
    const r = await dialog.showSaveDialog(this.operator || undefined, { title: 'Save Rundown', defaultPath: 'Rundown.json', filters: [{ name: 'Rundown', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return;
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(this.engine.rundownFile(), null, 2));
    } catch (e) {
      dialog.showErrorBox("Couldn't save rundown", e.message);
    }
  }

  // ------------------------------------------------------------------ IPC
  registerIpc() {
    const e = this.engine;
    const h = (ch, fn) => ipcMain.handle(`cd:${ch}`, fn);
    h('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
    h('config:get', () => e.getConfig());
    h('cmd', (_e, c, a, source) => e.perform(c, a, source || ''));
    h('settings:update', (_e, patch) => e.updateSettings(patch));
    h('segment:update', (_e, id, patch) => e.updateSegment(id, patch));
    h('segment:add', (_e, afterId) => e.addSegment(afterId));
    h('segment:duplicate', (_e, id) => e.duplicateSegment(id));
    h('segment:delete', (_e, id) => e.deleteSegment(id));
    h('segment:move', (_e, id, to) => e.moveSegment(id, to));
    h('segment:goto', (_e, id, autostart) => e.goTo(id, !!autostart));
    h('quick', (_e, seconds) => e.quickTimer(Number(seconds)));
    h('rundown:new', () => this.newRundown());
    h('rundown:open', () => this.openRundown());
    h('rundown:save', () => this.saveRundown());
    h('displays:get', () => ({ displays: this.displayList(), selected: this.targetDisplay().id }));
    h('presenter:place', () => this.placePresenter());
    h('presenter:setDisplay', (_e, id) => {
      e.updateSettings({ presenterDisplayId: id });
      return this.placePresenter();
    });
    h('remote:info', () => ({
      web: this.web.status,
      osc: this.osc.status,
      urls: e.settings.webEnabled ? localIPv4().map((ip) => `http://${ip}:${e.settings.webPort}`) : [],
    }));
    h('video:desktopSources', async () => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getTitle()));
        return sources.filter((s) => !(s.id.startsWith('window') && own.has(s.name)))
          .map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window' }));
      } catch {
        return [];
      }
    });
    h('video:screenAccess', () => (IS_MAC ? systemPreferences.getMediaAccessStatus('screen') : 'granted'));
    h('video:openScreenSettings', () => {
      if (IS_MAC) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    });
    h('video:askCamera', async () => {
      if (!IS_MAC) return true;
      if (systemPreferences.getMediaAccessStatus('camera') === 'granted') return true;
      return systemPreferences.askForMediaAccess('camera');
    });
    // Countdown updates now come with Streaming GuRu's own updater.
    h('updates:check', () => this.onUpdateCheck());
    h('updates:status', () => this.updateStatus());
    h('open:external', (_e, url) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
    });
    // From the mixer window
    h('open', () => this.showOperator());
    h('snapshot', () => e.snapshot());
    h('mixer-cmd', (_e, c, v) => e.perform(c, v, 'Streaming GuRu'));
    h('presenter:toggle', () => this.menuAction('toggle-presenter'));
  }

  // Items for the "Countdown" menu in the app menu bar.
  menuTemplate() {
    const cmd = (c, a) => () => this.engine.perform(c, a, 'Menu');
    return {
      label: 'Countdown',
      submenu: [
        { label: 'Open Countdown Operator…', accelerator: 'CmdOrCtrl+Shift+T', click: () => this.showOperator() },
        { label: 'Show / Hide Presenter Screen', accelerator: 'CmdOrCtrl+Shift+D', click: () => this.menuAction('toggle-presenter') },
        { type: 'separator' },
        { label: 'Start / Pause', accelerator: 'CmdOrCtrl+Enter', click: cmd('toggle') },
        { label: 'Reset Segment', click: cmd('reset') },
        { label: 'Next Segment', click: cmd('next') },
        { label: 'Previous Segment', click: cmd('prev') },
        { type: 'separator' },
        { label: 'Add 1 Minute', accelerator: 'CmdOrCtrl+=', click: cmd('add', 60) },
        { label: 'Remove 1 Minute', accelerator: 'CmdOrCtrl+-', click: cmd('sub', 60) },
        { type: 'separator' },
        { label: 'Flash Message', accelerator: 'CmdOrCtrl+Shift+F', click: cmd('flash') },
        { label: 'Hide Message', accelerator: 'CmdOrCtrl+Shift+H', click: cmd('message-hide') },
        { label: 'Toggle Blackout', accelerator: 'CmdOrCtrl+Shift+B', click: cmd('blackout') },
        { type: 'separator' },
        { label: 'Video PIP On / Off', accelerator: 'CmdOrCtrl+Shift+V', click: cmd('video') },
        { label: 'Next Video Layout', accelerator: 'CmdOrCtrl+Shift+L', click: cmd('layout') },
        { type: 'separator' },
        { label: 'New Rundown', click: () => this.newRundown() },
        { label: 'Open Rundown…', click: () => this.openRundown() },
        { label: 'Save Rundown As…', click: () => this.saveRundown() },
        { label: 'Countdown Settings…', click: () => { this.showOperator(); this.menuAction('settings'); } },
      ],
    };
  }
}

module.exports = { CountdownHost };
