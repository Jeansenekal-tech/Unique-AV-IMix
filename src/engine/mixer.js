// The Mixer owns all production state: inputs, preview/program, transitions,
// overlay channels, fade-to-black, T-bar, and drives the render loop.
import { createInput, newId } from './inputs.js';
import { findTransition, TRANSITION_BY_NAME, ease } from './transitions.js';
import { AudioEngine } from './audio.js';
import { Replay } from './replay.js';

export const DEFAULT_SETTINGS = {
  width: 1920,
  height: 1080,
  fps: 30,
  previewOverlays: false,
  thumbFps: 10,
  recordDir: '',
  recordFormat: 'mp4',
  recordBitrate: 16000,
  remux: true,
  filenamePattern: 'Unique AV Streaming GuRu {date} {time}',
  recordBus: 'M',
  streamBus: 'M',
  streamBitrate: 6000,
  audioBitrate: 160,
  encoder: 'auto',
  ffmpegPath: '',
  monitor: true,
  monitorBus: 'M',
  api: { enabled: true, httpPort: 8088, tcpPort: 8099, lan: false, password: '' },
  replaySeconds: 20,
  replayQuality: '960x540',
  autoRestoreSession: true,
  updates: { auto: true, autoDownload: true, url: '' },
};

const SETTINGS_KEY = 'imix.settings';

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...structuredClone(DEFAULT_SETTINGS), ...raw, api: { ...DEFAULT_SETTINGS.api, ...(raw.api || {}) }, updates: { ...DEFAULT_SETTINGS.updates, ...(raw.updates || {}) } };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export class Mixer {
  constructor() {
    this.settings = loadSettings();
    this.inputs = [];
    this.programId = null;
    this.previewId = null;
    this.overlays = [0, 1, 2, 3].map(() => ({ inputId: null, state: 'off', start: 0, effect: 'Fade', duration: 500 }));
    this.transitionSlots = [
      { type: 'Fade', duration: 1000 },
      { type: 'Wipe Right', duration: 1000 },
      { type: 'Zoom', duration: 800 },
      { type: 'Dip to Black', duration: 1500 },
    ];
    this.quickPlay = { type: 'Fade', duration: 500 };
    this.stingers = [0, 1].map(() => ({ path: '', url: '', cutPoint: 500, el: null }));
    this.trans = null;
    this.tbar = { value: 0, base: 0 };
    this.ftb = { on: false, start: -1e9, duration: 1000 };
    this.extraRenders = new Set();
    this.listeners = new Map();
    this.onAirSet = new Set();
    this.streamDestinations = [
      { name: 'Destination 1', url: '', key: '', enabled: true },
      { name: 'Destination 2', url: '', key: '', enabled: false },
      { name: 'Destination 3', url: '', key: '', enabled: false },
    ];
    this.shortcuts = [];
    this.scripts = [];
    this.lastTally = '';
    this.stats = { fps: 0, frameMs: 0 };
    this.audio = new AudioEngine();
    this.audio.setMonitor(this.settings.monitor, this.settings.monitorBus);
    this.replay = new Replay(this);
    this.applyReplaySettings();
    this.compositor = null;
    this.outputs = null;
  }

  // ---------------------------------------------------------------- events
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt).delete(fn);
  }

  emit(evt, data) {
    for (const fn of this.listeners.get(evt) || []) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    }
    if (evt !== 'any' && evt !== 'frame') for (const fn of this.listeners.get('any') || []) fn(evt);
  }

  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.emit('settings');
  }

  applyReplaySettings() {
    const [w, h] = String(this.settings.replayQuality || '960x540').split('x').map(Number);
    if (w && h && (w !== this.replay.w || h !== this.replay.h)) {
      this.replay.clear();
      this.replay.setQuality(w, h);
    }
    this.replay.seconds = this.settings.replaySeconds || 20;
    this.replay.fps = this.settings.fps;
  }

  // ---------------------------------------------------------------- inputs
  getInput(ref) {
    if (ref == null || ref === '') return null;
    if (typeof ref === 'object') return ref;
    const s = String(ref);
    const byId = this.inputs.find((i) => i.id === s);
    if (byId) return byId;
    // Control-surface conventions: 0 = the preview input, -1 = the program input
    if (s === '0') return this.inputs.find((i) => i.id === this.previewId) || null;
    if (s === '-1') return this.inputs.find((i) => i.id === this.programId) || null;
    if (/^\d+$/.test(s)) return this.inputs[Number(s) - 1] || null;
    const lower = s.toLowerCase();
    return this.inputs.find((i) => i.title.toLowerCase() === lower) || null;
  }

  inputNumber(input) {
    return this.inputs.indexOf(input) + 1;
  }

  async addInput(data, { select = true } = {}) {
    if (data.type === 'replay' && this.inputs.some((i) => i.type === 'replay')) {
      return this.inputs.find((i) => i.type === 'replay');
    }
    const input = createInput(data, { replay: this.replay });
    if (input.type === 'title') input.setSize(this.settings.width, this.settings.height);
    this.inputs.push(input);
    this.emit('inputs');
    try {
      await input.init();
    } catch (e) {
      input.error = e.message;
    }
    if (input.type === 'replay' && !this.replay.recording) this.replay.start();
    this.audio.resume();
    this.audio.addInput(input);
    input.listeners.add(() => this.emit('input', input));
    if (select) {
      if (!this.programId && input.hasVideo) this.programId = input.id;
      else if (!this.previewId && input.hasVideo) this.previewId = input.id;
    }
    this.emit('inputs');
    this.emit('state');
    return input;
  }

  removeInput(ref) {
    const input = this.getInput(ref);
    if (!input) return;
    this.inputs = this.inputs.filter((i) => i !== input);
    if (this.programId === input.id) this.programId = null;
    if (this.previewId === input.id) this.previewId = null;
    if (this.trans && (this.trans.from === input.id || this.trans.to === input.id)) this.trans = null;
    for (const ov of this.overlays) if (ov.inputId === input.id) Object.assign(ov, { inputId: null, state: 'off' });
    for (const other of this.inputs) for (const l of other.settings.layers) if (l.inputId === input.id) l.inputId = null;
    this.audio.removeInput(input.id);
    this.compositor?.dispose(input.id);
    this.onAirSet.delete(input.id);
    input.destroy();
    this.emit('inputs');
    this.emit('state');
  }

  moveInput(ref, toIndex) {
    const input = this.getInput(ref);
    if (!input) return;
    const from = this.inputs.indexOf(input);
    this.inputs.splice(from, 1);
    this.inputs.splice(Math.max(0, Math.min(this.inputs.length, toIndex)), 0, input);
    this.emit('inputs');
  }

  async duplicateInput(ref) {
    const input = this.getInput(ref);
    if (!input || input.type === 'replay') return null;
    const data = structuredClone(input.serialize());
    data.id = newId();
    data.title = `${input.title} (copy)`;
    if (input.url && !input.path) data.url = input.url;
    if (input.type === 'list') data.items = input.items.map((x) => ({ ...x }));
    return this.addInput(data, { select: false });
  }

  inputChanged(input) {
    this.audio.apply(input);
    this.emit('input', input);
  }

  // ------------------------------------------------------------ switching
  setPreview(ref) {
    const input = this.getInput(ref);
    if (!input) return false;
    this.previewId = input.id;
    this.emit('state');
    return true;
  }

  cut(ref) {
    if (ref != null && ref !== '') {
      const input = this.getInput(ref);
      if (!input) return false;
      if (input.id === this.programId) return true;
      this.trans = null;
      const old = this.programId;
      this.programId = input.id;
      if (this.previewId === input.id) this.previewId = old;
      this.emit('state');
      return true;
    }
    if (this.trans) this.completeTransition();
    const to = this.previewId;
    if (!to) return false;
    this.previewId = this.programId;
    this.programId = to;
    this.resetTbar();
    this.emit('state');
    return true;
  }

  transition(name, duration, ref) {
    if (this.trans) return false;
    if (ref != null && ref !== '') {
      const input = this.getInput(ref);
      if (!input) return false;
      if (input.id === this.programId) return true;
      this.previewId = input.id;
    }
    let def = typeof name === 'object' ? name : findTransition(name) || TRANSITION_BY_NAME.fade;
    if (!this.previewId) return false;
    if (def.id === -1 || !this.programId) return this.cut();
    let dur = Number(duration) || 1000;
    if (def.id === 'stinger') {
      const st = this.stingers[def.stinger];
      if (!st || !st.el || !st.el.duration) {
        def = TRANSITION_BY_NAME.fade;
      } else {
        dur = st.el.duration * 1000;
        st.el.currentTime = 0;
        st.el.play().catch(() => {});
      }
    }
    this.trans = { def, from: this.programId, to: this.previewId, start: performance.now(), duration: dur, manual: false };
    this.emit('state');
    return true;
  }

  transitionSlot(i) {
    const slot = this.transitionSlots[i];
    if (!slot) return false;
    return this.transition(slot.type, slot.duration);
  }

  transProgress(now) {
    const tr = this.trans;
    if (!tr) return 0;
    if (tr.manual) return Math.abs(this.tbar.value - this.tbar.base);
    return ease(Math.min(1, (now - tr.start) / tr.duration));
  }

  completeTransition() {
    const tr = this.trans;
    if (!tr) return;
    this.trans = null;
    if (tr.def.id === 'stinger') this.stingers[tr.def.stinger]?.el?.pause();
    this.previewId = tr.from;
    this.programId = tr.to;
    this.emit('state');
  }

  resetTbar() {
    this.tbar.value = 0;
    this.tbar.base = 0;
    this.emit('tbar');
  }

  // T-bar position 0..1 (or 0..255 via the API)
  setTbar(v) {
    v = Math.max(0, Math.min(1, v));
    this.tbar.value = v;
    if (!this.trans) {
      if (Math.abs(v - this.tbar.base) < 0.001 || !this.previewId || !this.programId) {
        this.emit('tbar');
        return;
      }
      const slot = this.transitionSlots[0];
      let def = findTransition(slot.type) || TRANSITION_BY_NAME.fade;
      if (def.id === -1 || def.id === 'stinger') def = TRANSITION_BY_NAME.fade;
      this.trans = { def, from: this.programId, to: this.previewId, start: performance.now(), duration: 1, manual: true };
    }
    if (this.trans.manual) {
      const p = Math.abs(v - this.tbar.base);
      if (p >= 0.999) {
        this.tbar.base = v > 0.5 ? 1 : 0;
        this.tbar.value = this.tbar.base;
        this.completeTransition();
      } else if (p <= 0.001) {
        this.trans = null;
        this.emit('state');
      }
    }
    this.emit('tbar');
  }

  stingerState(now) {
    const tr = this.trans;
    if (!tr || tr.def.id !== 'stinger') return null;
    const st = this.stingers[tr.def.stinger];
    return { cut: now - tr.start >= (st.cutPoint || 0) };
  }

  stingerVideo(i) {
    return this.stingers[i]?.el || null;
  }

  setStinger(i, { path, url, cutPoint }) {
    const st = this.stingers[i];
    if (!st) return;
    if (cutPoint != null) st.cutPoint = Number(cutPoint) || 0;
    if (path !== undefined || url !== undefined) {
      st.path = path || '';
      st.url = url || (path ? `imix://media/${encodeURIComponent(path)}` : '');
      if (!st.el) {
        st.el = document.createElement('video');
        st.el.muted = false;
        st.el.preload = 'auto';
        st.el.playsInline = true;
        st.el.addEventListener('loadedmetadata', () => this.emit('stingers'));
        // stinger audio goes to master
        try {
          const src = this.audio.ctx.createMediaElementSource(st.el);
          src.connect(this.audio.buses.M.input);
        } catch {
          /* ignore */
        }
      }
      if (st.url) st.el.src = st.url;
      else st.el.removeAttribute('src');
    }
    this.emit('stingers');
  }

  // --------------------------------------------------------------- overlays
  overlay(i, ref, mode = 'toggle') {
    const ov = this.overlays[i];
    if (!ov) return false;
    const now = performance.now();
    const input = ref != null && ref !== '' ? this.getInput(ref) : this.getInput(ov.inputId);
    const showing = ov.state === 'in' || ov.state === 'on';
    const sameInput = input && ov.inputId === input.id;
    if (mode === 'off') {
      Object.assign(ov, { state: 'off' });
    } else if (mode === 'out' || (mode === 'toggle' && showing && (sameInput || !input))) {
      if (!showing) return true;
      const p = this.overlayProgress(ov, now);
      ov.state = 'out';
      ov.start = now - (1 - p) * ov.duration;
    } else {
      if (!input) return false;
      if (showing && sameInput) return true;
      ov.inputId = input.id;
      ov.state = ov.effect === 'Cut' ? 'on' : 'in';
      ov.start = now;
    }
    this.emit('state');
    return true;
  }

  overlayProgress(ov, now) {
    if (ov.state === 'on') return 1;
    if (ov.state === 'off') return 0;
    if (ov.effect === 'Cut') return ov.state === 'in' ? 1 : 0;
    const p = Math.min(1, (now - ov.start) / ov.duration);
    return ov.state === 'in' ? p : 1 - p;
  }

  overlayVisual(i, now) {
    const ov = this.overlays[i];
    if (!ov.inputId || ov.state === 'off') return null;
    const p = ease(this.overlayProgress(ov, now));
    const v = { alpha: 1, scale: 1, dx: 0, dy: 0 };
    switch (ov.effect) {
      case 'Zoom':
        v.alpha = p;
        v.scale = 0.0001 + p;
        break;
      case 'Slide Left':
        v.dx = 1 - p;
        break;
      case 'Slide Right':
        v.dx = p - 1;
        break;
      case 'Slide Up':
        v.dy = 1 - p;
        break;
      case 'Slide Down':
        v.dy = p - 1;
        break;
      case 'Cut':
        v.alpha = 1;
        break;
      default:
        v.alpha = p;
    }
    return v;
  }

  overlayAllOff() {
    this.overlays.forEach((_, i) => this.overlay(i, null, 'out'));
  }

  // ------------------------------------------------------------ fade to black
  toggleFtb(on = !this.ftb.on) {
    if (on === this.ftb.on) return;
    const now = performance.now();
    const p = this.ftbRaw(now);
    this.ftb.on = on;
    this.ftb.start = now - (on ? p : 1 - p) * this.ftb.duration;
    this.emit('state');
  }

  ftbRaw(now) {
    const p = Math.min(1, (now - this.ftb.start) / this.ftb.duration);
    return this.ftb.on ? p : 1 - p;
  }

  ftbAlpha(now) {
    return Math.max(0, this.ftbRaw(now));
  }

  // ------------------------------------------------------------ on-air logic
  computeOnAir() {
    const set = new Set();
    const add = (id) => {
      const inp = id && this.getInput(id);
      if (!inp || set.has(inp.id)) return;
      set.add(inp.id);
      for (const l of inp.settings.layers) if (l.enabled && l.inputId) add(l.inputId);
    };
    add(this.programId);
    if (this.trans) add(this.trans.to);
    for (const ov of this.overlays) if (ov.inputId && ov.state !== 'off') add(ov.inputId);
    return set;
  }

  isOnAir(input) {
    return this.onAirSet.has(input.id);
  }

  updateOnAir() {
    const next = this.computeOnAir();
    let changed = false;
    for (const id of next) {
      if (this.onAirSet.has(id)) continue;
      changed = true;
      const inp = this.getInput(id);
      if (!inp) continue;
      inp.setOnAir(true);
      if (inp.settings.autoRestart) inp.restart();
      if (inp.settings.autoPlay && inp.state !== 'Running' && ['video', 'list', 'audiofile'].includes(inp.type)) inp.play();
    }
    for (const id of this.onAirSet) {
      if (next.has(id)) continue;
      changed = true;
      const inp = this.getInput(id);
      if (!inp) continue;
      inp.setOnAir(false);
      if (inp.settings.autoPause && ['video', 'list', 'audiofile'].includes(inp.type)) inp.pause();
    }
    this.onAirSet = next;
    if (changed) this.emit('onair');
  }

  tally() {
    // per input: 0 = off, 1 = program (on air), 2 = preview
    return this.inputs.map((i) => (this.onAirSet.has(i.id) ? '1' : i.id === this.previewId ? '2' : '0')).join('');
  }

  // --------------------------------------------------------------- the loop
  tick(now) {
    const t0 = performance.now();
    // transitions & overlays state machines
    if (this.trans && !this.trans.manual) {
      const tr = this.trans;
      const stingerDone = tr.def.id === 'stinger' && this.stingers[tr.def.stinger]?.el?.ended;
      if (now - tr.start >= tr.duration || stingerDone) {
        this.completeTransition();
        this.resetTbar();
      }
    }
    for (const ov of this.overlays) {
      if (ov.state === 'in' && now - ov.start >= ov.duration) ov.state = 'on';
      if (ov.state === 'out' && (now - ov.start >= ov.duration || ov.effect === 'Cut')) {
        ov.state = 'off';
        this.emit('state');
      }
    }
    this.updateOnAir();
    for (const inp of this.inputs) {
      if (inp.type === 'title') inp.setSize(this.settings.width, this.settings.height);
      inp.tick(now);
    }
    this.replay.tick(now);
    this.audio.update((inp) => this.isOnAir(inp));

    if (this.compositor) {
      const thumbEvery = Math.max(1, Math.round(this.settings.fps / (this.settings.thumbFps || 10)));
      this.compositor.frame(now, { thumbs: this.compositor.frameCount % thumbEvery === 0 });
    }
    this.replay.capture(now);

    const tally = this.tally();
    if (tally !== this.lastTally) {
      this.lastTally = tally;
      this.emit('tally', tally);
    }
    this.stats.frameMs = this.stats.frameMs * 0.9 + (performance.now() - t0) * 0.1;
    this.emit('frame', now);
  }

  startLoop() {
    if (this.worker) return;
    const code = `let iv=null;onmessage=(e)=>{clearInterval(iv);const ms=1000/e.data;let next=performance.now();
      const loop=()=>{const now=performance.now();if(now>=next-1){postMessage(now);next+=ms;if(now-next>ms*4)next=now+ms;}
      iv=setTimeout(loop,Math.max(0,next-performance.now()-1));};loop();};`;
    this.worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    let last = 0;
    let frames = 0;
    let fpsStart = performance.now();
    this.worker.onmessage = () => {
      const now = performance.now();
      if (now - last < 1000 / this.settings.fps / 2) return; // backlog: drop
      last = now;
      try {
        this.tick(now);
      } catch (e) {
        console.error(e);
      }
      frames++;
      if (now - fpsStart >= 1000) {
        this.stats.fps = (frames * 1000) / (now - fpsStart);
        frames = 0;
        fpsStart = now;
      }
    };
    this.worker.postMessage(this.settings.fps);
  }

  setFormat(width, height, fps) {
    this.settings.width = width;
    this.settings.height = height;
    this.settings.fps = fps;
    this.compositor?.resize(width, height);
    this.outputs?.onFormatChanged();
    this.worker?.postMessage(fps);
    this.replay.fps = fps;
    this.saveSettings();
  }

  // ---------------------------------------------------------------- project
  toProject() {
    const keep = (i) => !(i.url && i.url.startsWith('blob:') && !i.path);
    return {
      app: 'Unique AV Streaming GuRu',
      version: 1,
      format: { width: this.settings.width, height: this.settings.height, fps: this.settings.fps },
      inputs: this.inputs.filter(keep).map((i) => i.serialize()),
      programId: this.programId,
      previewId: this.previewId,
      overlays: this.overlays.map((o) => ({ inputId: o.inputId, effect: o.effect, duration: o.duration })),
      transitions: this.transitionSlots,
      quickPlay: this.quickPlay,
      stingers: this.stingers.map((s) => ({ path: s.path, cutPoint: s.cutPoint })),
      streamDestinations: this.streamDestinations,
      shortcuts: this.shortcuts,
      scripts: this.scripts.map(({ name, code }) => ({ name, code })),
      replay: { source: this.replay.source, speed: this.replay.speed, lastSeconds: this.replay.lastSeconds },
      audioBuses: this.audio.serializeBuses(),
    };
  }

  async clearProject() {
    for (const i of [...this.inputs]) this.removeInput(i.id);
    this.overlays.forEach((o) => Object.assign(o, { inputId: null, state: 'off' }));
    this.trans = null;
    this.programId = null;
    this.previewId = null;
    this.ftb.on = false;
    this.ftb.start = -1e9;
    this.emit('state');
  }

  async loadProject(p) {
    if (!p || !Array.isArray(p.inputs)) throw new Error('Not a Unique AV Streaming GuRu project');
    await this.clearProject();
    if (p.format) this.setFormat(p.format.width, p.format.height, p.format.fps);
    for (const data of p.inputs) {
      try {
        await this.addInput(data, { select: false });
      } catch (e) {
        console.warn('input restore failed', e);
      }
    }
    this.programId = this.getInput(p.programId)?.id || null;
    this.previewId = this.getInput(p.previewId)?.id || null;
    (p.overlays || []).forEach((o, i) => {
      if (this.overlays[i]) Object.assign(this.overlays[i], { effect: o.effect || 'Fade', duration: o.duration || 500, inputId: this.getInput(o.inputId)?.id || null });
    });
    if (p.transitions) this.transitionSlots = p.transitions;
    if (p.quickPlay) this.quickPlay = p.quickPlay;
    (p.stingers || []).forEach((s, i) => this.setStinger(i, { path: s.path, cutPoint: s.cutPoint }));
    if (p.streamDestinations) this.streamDestinations = p.streamDestinations;
    if (p.shortcuts) this.shortcuts = p.shortcuts;
    if (p.scripts) this.scripts = p.scripts;
    if (p.replay) Object.assign(this.replay, p.replay);
    if (p.audioBuses) this.audio.restoreBuses(p.audioBuses);
    this.emit('inputs');
    this.emit('state');
    this.emit('project');
  }
}
