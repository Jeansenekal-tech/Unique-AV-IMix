// Unique AV Streaming GuRu – renderer bootstrap.
import { Mixer } from './engine/mixer.js';
import { Compositor } from './engine/compositor.js';
import { Outputs } from './engine/outputs.js';
import { VideoOutputs } from './engine/video-outputs.js';
import { Api } from './engine/api.js';
import { Shortcuts, Scripts } from './engine/automation.js';
import { h, $, toast, modal, fmtTime, contextMenu } from './ui/dom.js';
import { initInputs } from './ui/inputs-ui.js';
import { initTransitions, initMonitors, initAudioMixer, initOverlayStatus } from './ui/controls-ui.js';
import { showAddInput } from './ui/add-input.js';
import { openSettings } from './ui/settings.js';
import { openReplay, openScripts, openShortcuts, openLog, openHelp, openApiHelp } from './ui/panels.js';
import { openOutputsPanel } from './ui/outputs-panel.js';

const imix = window.imix;
const AUTOSAVE_KEY = 'imix.autosave';

const app = { isElectron: !!imix?.isElectron };
window.imixApp = app;

function confirmDialog(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: h('p', null, message),
      width: 440,
      onClose: () => { if (!answered) resolve(false); },
      buttons: [
        { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
        { label: okLabel, primary: true, onClick: () => { answered = true; resolve(true); } },
      ],
    });
  });
}

// ------------------------------------------------------------------ project
function projectManager() {
  const { mixer } = app;
  let currentPath = null;
  const filters = [{ name: 'Unique AV Streaming GuRu Project', extensions: ['guru', 'imix'] }];

  async function save(asNew = false) {
    const json = JSON.stringify(mixer.toProject(), null, 2);
    if (imix) {
      let p = currentPath;
      if (!p || asNew) p = await imix.saveDialog({ title: 'Save Project', defaultPath: `${app.info.documentsDir}/Untitled.guru`, filters });
      if (!p) return;
      if (!/\.(guru|imix)$/i.test(p)) p += '.guru';
      await imix.writeText(p, json);
      currentPath = p;
      toast(`Project saved: ${p}`);
    } else {
      const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: 'project.guru' });
      a.click();
    }
  }

  async function load(text, path) {
    try {
      await mixer.loadProject(JSON.parse(text));
      currentPath = path || null;
      toast(`Project loaded${path ? `: ${path}` : ''}`);
    } catch (e) {
      toast(`Could not open project: ${e.message}`, 'error');
    }
  }

  async function open() {
    if (imix) {
      const [p] = await imix.openDialog({ title: 'Open Project', filters, properties: ['openFile'] });
      if (p) await load(await imix.readText(p), p);
    } else {
      const inp = h('input', { type: 'file', accept: '.guru,.imix,application/json' });
      inp.onchange = () => openFile(inp.files[0]);
      inp.click();
    }
  }

  async function openFile(file) {
    if (!file) return;
    load(await file.text(), imix?.pathForFile(file));
  }

  async function newProject() {
    if (mixer.inputs.length && !(await confirmDialog('New Project', 'Remove all inputs and start a new project?', 'New Project'))) return;
    await mixer.clearProject();
    currentPath = null;
  }

  let timer = null;
  const autosave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(mixer.toProject()));
      } catch {
        /* quota */
      }
    }, 1500);
  };
  mixer.on('any', (evt) => {
    if (['inputs', 'state', 'input', 'transitions', 'stingers', 'project', 'project-changed'].includes(evt)) autosave();
  });
  window.addEventListener('beforeunload', () => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(mixer.toProject()));
    } catch {
      /* ignore */
    }
  });

  return { save, open, openFile, newProject, load };
}

// ------------------------------------------------------------------ top bar
function initTopbar() {
  const { mixer, outputs } = app;
  const clock = $('#clock');
  const fps = $('#fpsLabel');
  const fmt = $('#formatLabel');
  const updateFmt = () => {
    const s = mixer.settings;
    fmt.textContent = `${s.width}×${s.height} ${s.fps}p`;
  };
  mixer.on('settings', updateFmt);
  updateFmt();
  setInterval(() => {
    const d = new Date();
    clock.textContent = d.toLocaleTimeString([], { hour12: false });
    fps.textContent = `${mixer.stats.fps.toFixed(1)} fps · ${mixer.stats.frameMs.toFixed(1)} ms`;
    fps.style.color = mixer.stats.fps < mixer.settings.fps * 0.9 ? 'var(--warn)' : '';
    const st = outputs.status();
    $('#recPill').classList.toggle('hidden', !st.recording);
    if (st.recording) $('#recTime').textContent = fmtTime(Date.now() - st.recordStarted);
    $('#streamPill').classList.toggle('hidden', !st.streaming);
    if (st.streaming) {
      $('#streamTime').textContent = fmtTime(Date.now() - st.streamStarted);
      $('#streamRate').textContent = st.streamStats ? `${st.streamStats.bitrate} ${st.streamStats.speed}` : '';
    }
    $('#extPill').classList.toggle('hidden', !st.external);
    $('#ftbPill').classList.toggle('hidden', !mixer.ftb.on);
  }, 250);
}

// ------------------------------------------------------- CPU / GPU / RAM bar
function initSystemStats() {
  const { mixer } = app;
  const set = (id, pct, text, title) => {
    const el = $(id);
    el.querySelector('.v').textContent = text;
    const bar = el.querySelector('.meter i');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
    el.classList.toggle('warn', pct >= 60 && pct < 85);
    el.classList.toggle('hot', pct >= 85);
    el.title = title;
  };
  const renderStat = () => {
    const s = mixer.stats;
    const target = mixer.settings.fps;
    const pct = (s.frameMs / (1000 / target)) * 100; // share of the frame budget
    set('#statRender', s.fps < target * 0.9 ? 100 : pct, `${s.fps.toFixed(0)}/${target} fps`,
      `Render loop: ${s.fps.toFixed(1)} fps (target ${target}), ${s.frameMs.toFixed(1)} ms per frame`);
  };
  setInterval(renderStat, 1000);
  const left = $('#statusLeft');
  const upLeft = () => {
    const st = mixer.settings;
    const o = app.outputs.status();
    const parts = [`Unique AV Streaming GuRu ${app.info?.version ? `v${app.info.version}` : ''}`.trim(), `${st.width}×${st.height} ${st.fps}p`, `${mixer.inputs.length} inputs`];
    if (o.recording) parts.push(`● Recording ${o.recordFile.split('/').pop()}`);
    if (o.streaming) parts.push(`● Live${o.streamStats ? ` ${o.streamStats.bitrate}` : ''}`);
    left.textContent = parts.join('   ·   ');
  };
  setInterval(upLeft, 1000);
  upLeft();
  if (!imix?.onSysmon) {
    set('#statCpu', 0, 'n/a', 'CPU usage is available in the desktop app');
    set('#statGpu', 0, 'n/a', 'GPU usage is available in the desktop app');
    set('#statMem', 0, 'n/a', '');
    return;
  }
  imix.onSysmon((st) => {
    app.system = st;
    set('#statCpu', st.cpu, `${st.cpu}%`, `System CPU ${st.cpu}% (${st.cores} cores)\nUnique AV Streaming GuRu: ${st.appCpu}%`);
    if (st.gpu == null) set('#statGpu', 0, 'n/a', `GPU utilisation not available on this system\nGPU process CPU: ${st.gpuProcessCpu}%`);
    else set('#statGpu', st.gpu, `${st.gpu}%`, `${st.gpuName || 'GPU'} ${st.gpu}%${st.gpuMemoryMB ? `\nGPU memory in use: ${st.gpuMemoryMB} MB` : ''}`);
    const memPct = st.totalMemoryMB ? (st.memoryMB / st.totalMemoryMB) * 100 : 0;
    set('#statMem', memPct, st.memoryMB >= 1024 ? `${(st.memoryMB / 1024).toFixed(1)} GB` : `${st.memoryMB} MB`,
      `App memory ${st.memoryMB} MB of ${Math.round(st.totalMemoryMB / 1024)} GB`);
  });
}

// --------------------------------------------------------------- bottom bar
function initBottombar() {
  const { mixer, outputs } = app;
  const run = (p) => Promise.resolve(p).catch((e) => toast(e.message, 'error', 6000));
  $('#bbAdd').onclick = () => showAddInput(app);
  $('#bbRecord').onclick = () => run(outputs.toggleRecording());
  $('#bbStream').onclick = () => run(outputs.toggleStreaming());
  $('#bbExternal').onclick = () => openOutputsPanel(app);
  if (!imix) $('#bbCountdown').onclick = () => toast('The Countdown timer is part of the desktop app', 'error');
  $('#bbMultiview').onclick = () => run(outputs.status().multiview ? outputs.multiviewWin.close() : chooseDisplay('Multiview Output', (id) => outputs.openMultiview(id)));
  $('#bbSnapshot').onclick = () => run(outputs.snapshot());
  $('#bbReplay').onclick = () => openReplay(app);
  $('#bbTools').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.top - 120, [
      { label: 'Scripts…', action: () => openScripts(app) },
      { label: 'Shortcuts & MIDI…', action: () => openShortcuts(app) },
      { label: 'Output Log…', action: () => openLog(app) },
      { label: 'Web Controller & API…', action: () => openSettings(app, 'api') },
    ]);
  };
  $('#bbSettings').onclick = () => openSettings(app);
  $('#bbProject').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.top - 170, [
      { label: 'New Project', action: () => app.project.newProject() },
      { label: 'Open Project…', action: () => app.project.open() },
      { label: 'Save Project', action: () => app.project.save() },
      { label: 'Save Project As…', action: () => app.project.save(true) },
      '-',
      { label: 'Keyboard Shortcuts', action: openHelp },
      { label: 'API Reference', action: () => openApiHelp(app) },
    ]);
  };
  $('#apiStatus').onclick = () => openSettings(app, 'api');
  const upd = () => {
    const st = outputs.status();
    $('#bbRecord').classList.toggle('active', st.recording);
    $('#bbStream').classList.toggle('active', st.streaming);
    $('#bbExternal').classList.toggle('active', st.external || app.videoOutputs.runtime.size > 0);
    $('#bbExternal').textContent = app.videoOutputs.runtime.size ? `🖥 Outputs (${app.videoOutputs.runtime.size})` : '🖥 Outputs';
    $('#bbMultiview').classList.toggle('active', st.multiview);
  };
  mixer.on('outputs', upd);
  setInterval(upd, 1000);
  mixer.on('toast', (msg) => toast(msg));
}

async function chooseDisplay(title, open) {
  if (!imix?.displays) return open(null);
  const displays = await imix.displays();
  if (displays.length <= 1) {
    toast('Only one display connected – opening the output in a window.');
    return open(null);
  }
  const sel = h('select', null, displays.map((d) => h('option', { value: d.id, selected: !d.primary }, `${d.label} (${d.width}×${d.height})${d.primary ? ' – main' : ''}`)));
  modal({
    title,
    body: h('div', { class: 'form' }, h('label', null, 'Display'), sel),
    width: 460,
    buttons: [{ label: 'Cancel' }, { label: 'Open full screen', primary: true, onClick: () => open(sel.value).catch((e) => toast(e.message, 'error')) }],
  });
  return null;
}

// --------------------------------------------------------------- API bridge
function initBridge() {
  const { mixer, api, outputs } = app;
  if (!imix) return;
  imix.onApiRequest(async (req) => {
    let result;
    try {
      if (req.kind === 'call') result = await api.call(req.fn, req.params);
      else if (req.kind === 'xml') result = { ok: true, data: api.stateXml() };
      else if (req.kind === 'json') result = { ok: true, data: api.stateJson() };
      else if (req.kind === 'snapshot') result = { ok: true, data: outputs.snapshotDataUrl(req.input ? mixer.getInput(req.input) : null, 'image/jpeg', 0.8) };
      else result = { ok: false, message: 'Unknown request' };
    } catch (e) {
      result = { ok: false, message: e.message };
    }
    imix.apiRespond(req.reqId, result);
  });
  mixer.on('tally', (t) => imix.apiTally(t));
  // Real-time activator feedback for control surfaces (TCP "SUBSCRIBE ACTS")
  let lastActs = '';
  let lastActsAt = 0;
  mixer.on('frame', (now) => {
    if (now - lastActsAt < 100) return;
    lastActsAt = now;
    const acts = api.acts();
    const json = JSON.stringify(acts);
    if (json !== lastActs) {
      lastActs = json;
      imix.apiActs(acts);
    }
  });
  imix.onBrowserFrame((f) => mixer.getInput(f.id)?.onFrame(f));
  imix.onLog((msg) => outputs.addLog(msg));
  imix.onMenu(({ cmd, arg }) => {
    const run = (p) => Promise.resolve(p).catch((e) => toast(e.message, 'error'));
    switch (cmd) {
      case 'new': return app.project.newProject();
      case 'open': return app.project.open();
      case 'save': return app.project.save();
      case 'saveAs': return app.project.save(true);
      case 'snapshot': return run(outputs.snapshot());
      case 'settings': return openSettings(app, arg);
      case 'addInput': return showAddInput(app, arg);
      case 'record': return run(outputs.toggleRecording());
      case 'stream': return run(outputs.toggleStreaming());
      case 'external': return openOutputsPanel(app);
      case 'multiview': return $('#bbMultiview').click();
      case 'scripts': return openScripts(app);
      case 'shortcuts': return openShortcuts(app);
      case 'help': return openHelp();
      case 'apihelp': return openApiHelp(app);
      default: return null;
    }
  });
  const updateApi = (st) => {
    const el = $('#apiStatus');
    el.classList.toggle('ok', !!st.running);
    el.textContent = st.running ? `API :${st.httpPort}${st.lan ? ' LAN' : ''}` : 'API off';
    el.title = st.running ? `Web controller: http://${st.lan ? '<this-mac-ip>' : '127.0.0.1'}:${st.httpPort}/` : st.error || 'API disabled';
    if (st.error) toast(`API: ${st.error}`, 'error');
  };
  app.updateApiStatus = updateApi;
  // Countdown (Unique AV Countdown) status in the top bar
  const cdPill = $('#cdPill');
  cdPill.onclick = () => imix.countdownOpen();
  $('#bbCountdown').onclick = () => imix.countdownOpen();
  let cdLast = 0;
  imix.onCountdownTick((snap) => {
    app.countdown = snap;
    const now = performance.now();
    if (now - cdLast < 200) return;
    cdLast = now;
    const show = snap.running || snap.phase === 'overtime' || snap.messageVisible;
    cdPill.classList.toggle('hidden', !show);
    if (!show) return;
    cdPill.textContent = `⏱ ${snap.time}${snap.title ? ` · ${snap.title}` : ''}${snap.running ? '' : ' ❚❚'}`;
    cdPill.className = `pill countdown ${snap.running ? 'running' : ''} ${snap.phase}`;
  });
  initUpdates();
  imix.apiConfigure(mixer.settings.api).then(updateApi);
}

// ------------------------------------------------------------------ updates
function initUpdates() {
  const { mixer } = app;
  const pill = $('#updatePill');
  let lastStatus = null;
  const promptInstall = () => {
    modal({
      title: `Update to ${app.updateState.latest}`,
      body: h('div', null,
        h('p', null, `Unique AV Streaming GuRu ${app.updateState.latest} is ready to install. The app will restart (about 5 seconds).`),
        app.updateState.notes ? h('div', { class: 'log', style: { height: '140px' } }, app.updateState.notes) : null,
        h('p', { class: 'help' }, 'Not now? The update is installed automatically the next time you quit.')),
      width: 520,
      buttons: [
        { label: 'Later' },
        {
          label: 'Restart & Update',
          primary: true,
          onClick: async () => {
            const r = await imix.updateInstall();
            if (!r.ok) toast(r.message, 'error', 8000);
          },
        },
      ],
    });
  };
  app.promptInstallUpdate = promptInstall;
  const render = (st) => {
    app.updateState = st;
    mixer.emit('update', st);
    let text = '';
    if (st.status === 'available') text = `Update ${st.latest} available`;
    if (st.status === 'downloading') text = `Downloading update ${Math.round((st.progress || 0) * 100)}%`;
    if (st.status === 'ready') text = `Restart to update to ${st.latest}`;
    if (st.status === 'installing') text = 'Installing update…';
    pill.textContent = text;
    pill.classList.toggle('hidden', !text);
    pill.classList.toggle('ready', st.status === 'ready');
    if (st.status !== lastStatus) {
      if (st.status === 'ready') toast(`Update ${st.latest} downloaded – click “Restart to update” when you’re off air.`, 'info', 10000);
      if (st.status === 'available' && !st.supported) toast(`Update ${st.latest} is available.`);
      if (st.status === 'uptodate' && st.manual) toast(`You’re up to date (version ${st.current}).`);
      if (st.status === 'error' && st.manual) toast(`Update check failed: ${st.error}`, 'error', 8000);
    }
    lastStatus = st.status;
  };
  pill.onclick = () => (app.updateState?.status === 'ready' ? promptInstall() : openSettings(app, 'updates'));
  imix.onUpdateStatus(render);
  imix.updateConfigure(mixer.settings.updates).then(render);
}

// ------------------------------------------------------------------- start
async function main() {
  if (!app.isElectron) document.body.classList.add('web');
  app.info = imix ? await imix.info() : null;
  if (imix) document.title = 'Unique AV Streaming GuRu';

  const mixer = new Mixer();
  app.mixer = mixer;
  const canvas = $('#programCanvas');
  canvas.width = mixer.settings.width;
  canvas.height = mixer.settings.height;
  try {
    app.compositor = new Compositor(canvas, mixer);
  } catch (e) {
    document.body.replaceChildren(h('div', { style: { padding: '40px', fontSize: '16px' } }, `Unique AV Streaming GuRu needs GPU (WebGL) support: ${e.message}`));
    return;
  }
  mixer.compositor = app.compositor;
  const pv = $('#previewCanvas');
  const sizePreview = () => {
    pv.width = Math.round(mixer.settings.width / 2);
    pv.height = Math.round(mixer.settings.height / 2);
    app.compositor.previewCanvas = { ctx: pv.getContext('2d'), width: pv.width, height: pv.height };
  };
  sizePreview();
  mixer.on('settings', sizePreview);

  app.outputs = new Outputs(mixer, canvas);
  mixer.outputs = app.outputs;
  mixer.app = app;
  app.videoOutputs = new VideoOutputs(app);
  app.api = new Api(app);
  app.shortcuts = new Shortcuts(app);
  app.scripts = new Scripts(app);
  app.project = projectManager();

  initInputs(app);
  initTransitions(app);
  initMonitors(app);
  initAudioMixer(app);
  initOverlayStatus(app);
  initTopbar();
  initBottombar();
  initSystemStats();
  initBridge();
  if (imix && mixer.settings.ffmpegPath) imix.ffmpegSetPath(mixer.settings.ffmpegPath);

  // Browsers block audio until a user gesture
  const resume = () => mixer.audio.resume();
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);

  mixer.startLoop();

  // restore last session, or create a starter project
  let restored = false;
  if (mixer.settings.autoRestoreSession) {
    try {
      const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null');
      if (saved && saved.inputs && saved.inputs.length) {
        await mixer.loadProject(saved);
        restored = true;
      } else if (saved) {
        mixer.shortcuts = saved.shortcuts || [];
        mixer.scripts = saved.scripts || [];
        if (saved.streamDestinations) mixer.streamDestinations = saved.streamDestinations;
      }
    } catch (e) {
      console.warn('restore failed', e);
    }
  }
  app.shortcuts.ensureDefaults();
  if (!restored && !localStorage.getItem('imix.welcomed')) {
    localStorage.setItem('imix.welcomed', '1');
    await mixer.addInput({ type: 'colour', color: '#14213d', title: 'Background' });
    await mixer.addInput({ type: 'title', template: 'Full Screen Slate', fields: { Title: 'Unique AV Streaming GuRu', Message: 'Add cameras, videos and graphics to get started' } });
    await mixer.addInput({ type: 'title', template: 'Lower Third' }, { select: false });
    await mixer.addInput({ type: 'title', template: 'Clock', fields: { Label: '' } }, { select: false });
    mixer.cut(2);
  }
  app.ready = true;
  mixer.emit('ready');
  app.videoOutputs.openAutoStart();
}

main().catch((e) => {
  console.error(e);
  toast(`Startup error: ${e.message}`, 'error', 20000);
});
