// Unique AV IMix – renderer bootstrap.
import { Mixer } from './engine/mixer.js';
import { Compositor } from './engine/compositor.js';
import { Outputs } from './engine/outputs.js';
import { Api } from './engine/api.js';
import { Shortcuts, Scripts } from './engine/automation.js';
import { h, $, toast, modal, fmtTime, contextMenu } from './ui/dom.js';
import { initInputs } from './ui/inputs-ui.js';
import { initTransitions, initMonitors, initAudioMixer, initOverlayStatus } from './ui/controls-ui.js';
import { showAddInput } from './ui/add-input.js';
import { openSettings } from './ui/settings.js';
import { openReplay, openScripts, openShortcuts, openLog, openHelp, openApiHelp } from './ui/panels.js';

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
  const filters = [{ name: 'Unique AV IMix Project', extensions: ['imix'] }];

  async function save(asNew = false) {
    const json = JSON.stringify(mixer.toProject(), null, 2);
    if (imix) {
      let p = currentPath;
      if (!p || asNew) p = await imix.saveDialog({ title: 'Save Project', defaultPath: `${app.info.documentsDir}/Untitled.imix`, filters });
      if (!p) return;
      if (!/\.imix$/i.test(p)) p += '.imix';
      await imix.writeText(p, json);
      currentPath = p;
      toast(`Project saved: ${p}`);
    } else {
      const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: 'project.imix' });
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
      const inp = h('input', { type: 'file', accept: '.imix,application/json' });
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

// --------------------------------------------------------------- bottom bar
function initBottombar() {
  const { mixer, outputs } = app;
  const run = (p) => Promise.resolve(p).catch((e) => toast(e.message, 'error', 6000));
  $('#bbAdd').onclick = () => showAddInput(app);
  $('#bbRecord').onclick = () => run(outputs.toggleRecording());
  $('#bbStream').onclick = () => run(outputs.toggleStreaming());
  $('#bbExternal').onclick = () => run(outputs.status().external ? outputs.closeExternal() : chooseDisplay('External Output', (id) => outputs.openExternal(id)));
  $('#bbMultiview').onclick = () => run(outputs.status().multiview ? outputs.multiviewWin.close() : chooseDisplay('Multiview Output', (id) => outputs.openMultiview(id)));
  $('#bbSnapshot').onclick = () => run(outputs.snapshot());
  $('#bbReplay').onclick = () => openReplay(app);
  $('#bbScripts').onclick = () => openScripts(app);
  $('#bbShortcuts').onclick = () => openShortcuts(app);
  $('#bbLog').onclick = () => openLog(app);
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
    $('#bbExternal').classList.toggle('active', st.external);
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
      case 'external': return $('#bbExternal').click();
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
  imix.apiConfigure(mixer.settings.api).then(updateApi);
}

// ------------------------------------------------------------------- start
async function main() {
  if (!app.isElectron) document.body.classList.add('web');
  app.info = imix ? await imix.info() : null;
  if (imix) document.title = 'Unique AV IMix';

  const mixer = new Mixer();
  app.mixer = mixer;
  const canvas = $('#programCanvas');
  canvas.width = mixer.settings.width;
  canvas.height = mixer.settings.height;
  try {
    app.compositor = new Compositor(canvas, mixer);
  } catch (e) {
    document.body.replaceChildren(h('div', { style: { padding: '40px', fontSize: '16px' } }, `Unique AV IMix needs GPU (WebGL) support: ${e.message}`));
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
    await mixer.addInput({ type: 'title', template: 'Full Screen Slate', fields: { Title: 'Unique AV IMix', Message: 'Add cameras, videos and graphics to get started' } });
    await mixer.addInput({ type: 'title', template: 'Lower Third' }, { select: false });
    await mixer.addInput({ type: 'title', template: 'Clock', fields: { Label: '' } }, { select: false });
    mixer.cut(2);
  }
  app.ready = true;
  mixer.emit('ready');
}

main().catch((e) => {
  console.error(e);
  toast(`Startup error: ${e.message}`, 'error', 20000);
});
