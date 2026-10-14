// Input types. Every input exposes:
//   videoSource()  -> what the compositor should draw (or null)
//   audioElement / audioStream -> what the audio engine should mix
//   serialize() / static restore
import { TITLE_TEMPLATES, DEFAULT_TITLE_STYLE, renderTitle, parseDuration } from './titles.js';
import { defaultEq, normalizeEq } from './eq.js';

let idSeq = 0;
export const newId = () => `${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const INPUT_TYPES = {
  camera: { label: 'Camera', icon: '🎥' },
  audio: { label: 'Audio Input', icon: '🎙' },
  screen: { label: 'Screen Capture', icon: '🖥' },
  video: { label: 'Video', icon: '🎞' },
  list: { label: 'Video List', icon: '📃' },
  image: { label: 'Image', icon: '🖼' },
  audiofile: { label: 'Audio File', icon: '🎵' },
  title: { label: 'Title', icon: '🅃' },
  colour: { label: 'Colour', icon: '🎨' },
  browser: { label: 'Web Browser', icon: '🌐' },
  url: { label: 'Stream URL', icon: '📡' },
  replay: { label: 'Instant Replay', icon: '⏪' },
};

export function defaultSettings() {
  return {
    fit: 'fit',
    zoom: 1,
    panX: 0,
    panY: 0,
    crop: { l: 0, r: 0, t: 0, b: 0 },
    opacity: 1,
    color: { brightness: 0, contrast: 1, saturation: 1, hue: 0, gamma: 1 },
    key: { mode: 'none', color: [0, 1, 0], similarity: 0.4, smoothness: 0.08, spill: 0.1, lumaLow: 0.05, lumaHigh: 0.2 },
    layers: [0, 1, 2, 3].map((i) => ({
      enabled: false, inputId: null, x: 0.62 - i * 0.02, y: 0.06 + i * 0.25, w: 0.33, h: 0.33, border: 0, borderColor: [1, 1, 1, 1],
    })),
    loop: false,
    autoPlay: true,
    autoPause: true,
    autoRestart: false,
    audio: {
      volume: 100,
      balance: 0,
      gain: 0,
      muted: false,
      afv: false,
      delay: 0,
      eq: defaultEq(),
      comp: { on: false, threshold: -18, ratio: 4 },
      gate: { on: false, threshold: -50 },
      buses: { M: true, A: false, B: false, C: false, D: false, E: false, F: false },
    },
  };
}

function merge(target, src) {
  if (!src) return target;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
    else if (Array.isArray(v) && Array.isArray(target[k]) && k === 'layers') {
      v.forEach((l, i) => {
        if (target[k][i]) Object.assign(target[k][i], l);
      });
    } else target[k] = v;
  }
  return target;
}

const imix = () => window.imix;

export function mediaUrl(path) {
  return `imix://media/${encodeURIComponent(path)}`;
}

function fileName(p) {
  return String(p || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------- base class
export class Input {
  constructor(type, opts = {}) {
    this.id = opts.id || newId();
    this.type = type;
    this.title = opts.title || INPUT_TYPES[type]?.label || type;
    this.settings = merge(defaultSettings(), opts.settings);
    this.settings.audio.eq = normalizeEq(opts.settings?.audio?.eq);
    this.hasVideo = true;
    this.hasAudio = false;
    this.version = 0;
    this.error = null;
    this.thumbCtx = null;
    this.onAir = false;
    this.listeners = new Set();
  }

  // Overridden by subclasses
  async init() {}

  videoSource() {
    return null;
  }

  hasLayers() {
    return this.settings.layers.some((l) => l.enabled && l.inputId);
  }

  get state() {
    return 'Running';
  }

  get duration() {
    return 0;
  }

  get position() {
    return 0;
  }

  play() {}

  pause() {}

  restart() {}

  seek() {}

  tick() {}

  setOnAir(on) {
    this.onAir = on;
  }

  changed() {
    this.version++;
    for (const l of this.listeners) l(this);
  }

  serialize() {
    return { id: this.id, type: this.type, title: this.title, settings: this.settings };
  }

  destroy() {
    this.listeners.clear();
  }
}

// --------------------------------------------------------- media elements
class MediaFileInput extends Input {
  constructor(type, opts) {
    super(type, opts);
    this.path = opts.path || '';
    this.url = opts.url || (opts.path ? mediaUrl(opts.path) : '');
    if (!opts.title && (opts.path || opts.name)) this.title = fileName(opts.name || opts.path);
    this.el = null;
  }

  makeElement(tag) {
    const el = document.createElement(tag);
    el.preload = 'auto';
    el.playsInline = true;
    el.loop = this.settings.loop;
    el.addEventListener('seeked', () => this.version++);
    el.addEventListener('loadeddata', () => {
      this.version++;
      this.changed();
    });
    el.addEventListener('ended', () => this.onEnded());
    el.addEventListener('error', () => {
      this.error = `Cannot play ${this.title}`;
      this.changed();
    });
    el.addEventListener('play', () => this.changed());
    el.addEventListener('pause', () => this.changed());
    return el;
  }

  onEnded() {
    this.changed();
  }

  get state() {
    if (!this.el) return 'Paused';
    if (this.el.ended) return 'Completed';
    return this.el.paused ? 'Paused' : 'Running';
  }

  get duration() {
    return this.el && Number.isFinite(this.el.duration) ? this.el.duration * 1000 : 0;
  }

  get position() {
    return this.el ? this.el.currentTime * 1000 : 0;
  }

  get audioElement() {
    return this.el;
  }

  play() {
    if (this.el) this.el.play().catch(() => {});
  }

  pause() {
    if (this.el) this.el.pause();
  }

  restart() {
    if (this.el) {
      this.el.currentTime = 0;
      this.version++;
    }
  }

  seek(ms) {
    if (this.el) {
      this.el.currentTime = Math.max(0, ms / 1000);
      this.version++;
    }
  }

  setLoop(on) {
    this.settings.loop = on;
    if (this.el) this.el.loop = on;
    this.changed();
  }

  serialize() {
    return { ...super.serialize(), path: this.path, url: this.path ? '' : this.url };
  }

  destroy() {
    super.destroy();
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
  }
}

export class VideoInput extends MediaFileInput {
  constructor(opts = {}) {
    super('video', opts);
    this.hasAudio = true;
    this.settings.audio.afv = opts.settings?.audio?.afv ?? true;
  }

  async init() {
    this.el = this.makeElement('video');
    this.el.src = this.url;
  }

  videoSource() {
    const v = this.el;
    if (!v || v.readyState < 2) return null;
    return { kind: 'element', el: v, width: v.videoWidth, height: v.videoHeight, always: !v.paused, version: this.version };
  }
}

export class AudioFileInput extends MediaFileInput {
  constructor(opts = {}) {
    super('audiofile', opts);
    this.hasVideo = false;
    this.hasAudio = true;
    this.settings.audio.afv = opts.settings?.audio?.afv ?? false;
  }

  async init() {
    this.el = this.makeElement('audio');
    this.el.src = this.url;
  }
}

export class UrlInput extends MediaFileInput {
  constructor(opts = {}) {
    super('url', opts);
    this.hasAudio = true;
    if (!opts.title) this.title = 'Stream URL';
  }

  async init() {
    this.el = this.makeElement('video');
    this.el.crossOrigin = 'anonymous';
    this.el.src = this.url;
    this.el.loop = true;
  }

  videoSource() {
    const v = this.el;
    if (!v || v.readyState < 2) return null;
    return { kind: 'element', el: v, width: v.videoWidth, height: v.videoHeight, always: true, version: this.version };
  }

  serialize() {
    return { ...super.serialize(), url: this.url };
  }
}

export class ListInput extends Input {
  constructor(opts = {}) {
    super('list', opts);
    this.items = opts.items || []; // { name, path, url }
    this.index = opts.index || 0;
    this.hasAudio = true;
    this.settings.audio.afv = opts.settings?.audio?.afv ?? true;
    this.settings.loop = opts.settings?.loop ?? true;
    this.shuffle = !!opts.shuffle;
    if (!opts.title) this.title = 'Video List';
  }

  async init() {
    this.el = document.createElement('video');
    this.el.preload = 'auto';
    this.el.playsInline = true;
    this.el.addEventListener('loadeddata', () => {
      this.version++;
      this.changed();
    });
    this.el.addEventListener('seeked', () => this.version++);
    this.el.addEventListener('ended', () => this.next(true));
    this.el.addEventListener('play', () => this.changed());
    this.el.addEventListener('pause', () => this.changed());
    this.load(this.index, false);
  }

  load(i, autoplay) {
    if (!this.items.length) return;
    this.index = ((i % this.items.length) + this.items.length) % this.items.length;
    const item = this.items[this.index];
    this.el.src = item.url || mediaUrl(item.path);
    if (autoplay) this.el.play().catch(() => {});
    this.changed();
  }

  next(fromEnded = false) {
    if (!this.items.length) return;
    if (fromEnded && !this.settings.loop && this.index === this.items.length - 1) return this.changed();
    const nextIndex = this.shuffle ? Math.floor(Math.random() * this.items.length) : this.index + 1;
    this.load(nextIndex, fromEnded || !this.el.paused);
  }

  previous() {
    this.load(this.index - 1, !this.el.paused);
  }

  addItems(items) {
    this.items.push(...items);
    if (this.items.length === items.length) this.load(0, false);
    this.changed();
  }

  removeItem(i) {
    this.items.splice(i, 1);
    if (this.index >= this.items.length) this.index = 0;
    this.changed();
  }

  get audioElement() {
    return this.el;
  }

  get state() {
    if (!this.el) return 'Paused';
    return this.el.paused ? 'Paused' : 'Running';
  }

  get duration() {
    return this.el && Number.isFinite(this.el.duration) ? this.el.duration * 1000 : 0;
  }

  get position() {
    return this.el ? this.el.currentTime * 1000 : 0;
  }

  play() {
    this.el?.play().catch(() => {});
  }

  pause() {
    this.el?.pause();
  }

  restart() {
    if (this.el) this.el.currentTime = 0;
  }

  seek(ms) {
    if (this.el) this.el.currentTime = ms / 1000;
  }

  setLoop(on) {
    this.settings.loop = on;
    this.changed();
  }

  videoSource() {
    const v = this.el;
    if (!v || v.readyState < 2) return null;
    return { kind: 'element', el: v, width: v.videoWidth, height: v.videoHeight, always: !v.paused, version: this.version };
  }

  serialize() {
    return { ...super.serialize(), items: this.items.filter((i) => i.path).map(({ name, path }) => ({ name, path })), index: this.index, shuffle: this.shuffle };
  }

  destroy() {
    super.destroy();
    this.el?.pause();
  }
}

export class ImageInput extends Input {
  constructor(opts = {}) {
    super('image', opts);
    this.path = opts.path || '';
    this.url = opts.url || (opts.path ? mediaUrl(opts.path) : '');
    if (!opts.title && (opts.path || opts.name)) this.title = fileName(opts.name || opts.path);
  }

  async init() {
    this.el = new Image();
    this.animated = /\.(gif|webp|apng)$/i.test(this.path || this.url || '');
    await new Promise((resolve) => {
      this.el.onload = () => {
        this.version++;
        this.changed();
        resolve();
      };
      this.el.onerror = () => {
        this.error = 'Cannot load image';
        resolve();
      };
      this.el.src = this.url;
    });
  }

  videoSource() {
    if (!this.el || !this.el.naturalWidth) return null;
    return { kind: 'element', el: this.el, width: this.el.naturalWidth, height: this.el.naturalHeight, always: this.animated, version: this.version };
  }

  serialize() {
    return { ...super.serialize(), path: this.path, url: this.path ? '' : this.url };
  }
}

export class ColourInput extends Input {
  constructor(opts = {}) {
    super('colour', opts);
    this.color = opts.color || '#1d3557';
    if (!opts.title) this.title = `Colour ${this.color}`;
  }

  setColor(hex) {
    this.color = hex;
    this.changed();
  }

  videoSource() {
    const n = parseInt(this.color.replace('#', ''), 16);
    return { kind: 'colour', color: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1] };
  }

  serialize() {
    return { ...super.serialize(), color: this.color };
  }
}

export class TitleInput extends Input {
  constructor(opts = {}) {
    super('title', opts);
    this.template = opts.template || 'Lower Third';
    const tpl = TITLE_TEMPLATES[this.template] || TITLE_TEMPLATES['Plain Text'];
    this.fields = {};
    for (const [k, v] of tpl.fields) this.fields[k] = opts.fields?.[k] ?? v;
    this.style = { ...DEFAULT_TITLE_STYLE, ...(opts.style || {}) };
    this.state2 = { cdElapsed: opts.countdown?.elapsed || 0, cdRunning: false, cdStartedAt: 0 };
    this.shownAt = performance.now() - 10000;
    if (!opts.title) this.title = `${this.template}`;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.dirty = true;
  }

  get tpl() {
    return TITLE_TEMPLATES[this.template] || TITLE_TEMPLATES['Plain Text'];
  }

  setSize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dirty = true;
    }
  }

  setOnAir(on) {
    if (on && !this.onAir) this.shownAt = performance.now();
    super.setOnAir(on);
    this.dirty = true;
  }

  setTemplate(name) {
    if (!TITLE_TEMPLATES[name]) return;
    const old = this.fields;
    this.template = name;
    this.fields = {};
    for (const [k, v] of this.tpl.fields) this.fields[k] = old[k] ?? v;
    this.dirty = true;
    this.changed();
  }

  setText(field, value) {
    const names = Object.keys(this.fields);
    let key = field;
    if (typeof field === 'number' || /^\d+$/.test(String(field))) key = names[Number(field)];
    else if (field && !(field in this.fields)) {
      // accept "Name.Text" style names used by other title systems
      key = names.find((n) => String(field).toLowerCase().startsWith(n.toLowerCase())) || names[0];
    } else if (!field) key = names[0];
    if (!key) return false;
    this.fields[key] = String(value ?? '');
    this.dirty = true;
    this.changed();
    return true;
  }

  setStyle(patch) {
    Object.assign(this.style, patch);
    this.dirty = true;
    this.changed();
  }

  // Countdown control
  countdown(cmd, value) {
    const s = this.state2;
    const now = performance.now();
    if (cmd === 'start' && !s.cdRunning) {
      s.cdRunning = true;
      s.cdStartedAt = now;
    } else if (cmd === 'stop') {
      s.cdRunning = false;
      s.cdElapsed = 0;
    } else if (cmd === 'pause' && s.cdRunning) {
      s.cdElapsed += now - s.cdStartedAt;
      s.cdRunning = false;
    } else if (cmd === 'set') {
      if ('Duration' in this.fields) this.fields.Duration = value;
      s.cdElapsed = 0;
      if (s.cdRunning) s.cdStartedAt = now;
    } else if (cmd === 'adjust') {
      s.cdElapsed -= parseDuration(value);
    }
    this.dirty = true;
    this.changed();
  }

  tick(now) {
    const tpl = this.tpl;
    const animating = this.style.animate && tpl.animated && now - this.shownAt < 700;
    if (this.dirty || tpl.continuous || animating) {
      const a = this.style.animate && tpl.animated ? (now - this.shownAt) / 500 : 1;
      renderTitle(this.ctx, this.canvas.width, this.canvas.height, this.template, this.fields, this.style, { a, now, state: this.state2 });
      this.dirty = false;
      this.version++;
    }
  }

  videoSource() {
    return { kind: 'element', el: this.canvas, width: this.canvas.width, height: this.canvas.height, always: false, version: this.version };
  }

  serialize() {
    return { ...super.serialize(), template: this.template, fields: this.fields, style: this.style };
  }
}

// ------------------------------------------------------- live devices
class StreamInput extends Input {
  constructor(type, opts) {
    super(type, opts);
    this.stream = null;
    this.deviceId = opts.deviceId || '';
    this.deviceLabel = opts.deviceLabel || '';
  }

  attachStream(stream) {
    this.stream = stream;
    const v = stream.getVideoTracks()[0];
    if (v) {
      this.el = document.createElement('video');
      this.el.muted = true;
      this.el.playsInline = true;
      this.el.autoplay = true;
      this.el.srcObject = new MediaStream([v]);
      this.el.addEventListener('loadeddata', () => this.changed());
      this.el.play().catch(() => {});
      v.addEventListener('ended', () => {
        this.error = 'Device disconnected';
        this.changed();
      });
    }
    this.hasAudio = stream.getAudioTracks().length > 0;
  }

  get audioStream() {
    return this.stream && this.stream.getAudioTracks().length ? new MediaStream(this.stream.getAudioTracks()) : null;
  }

  videoSource() {
    const v = this.el;
    if (!v || v.readyState < 2 || !v.videoWidth) return null;
    return { kind: 'element', el: v, width: v.videoWidth, height: v.videoHeight, always: true, version: 0 };
  }

  destroy() {
    super.destroy();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
  }

  serialize() {
    return { ...super.serialize(), deviceId: this.deviceId, deviceLabel: this.deviceLabel };
  }
}

async function resolveDevice(kind, deviceId, label) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const list = devices.filter((d) => d.kind === kind);
    if (deviceId && list.some((d) => d.deviceId === deviceId)) return deviceId;
    const byLabel = label && list.find((d) => d.label === label);
    return byLabel ? byLabel.deviceId : deviceId;
  } catch {
    return deviceId;
  }
}

export class CameraInput extends StreamInput {
  constructor(opts = {}) {
    super('camera', opts);
    this.width = opts.width || 1920;
    this.height = opts.height || 1080;
    this.fps = opts.fps || 30;
    this.audioDeviceId = opts.audioDeviceId || '';
    this.audioDeviceLabel = opts.audioDeviceLabel || '';
    if (!opts.title && this.deviceLabel) this.title = this.deviceLabel.replace(/\s*\(.*\)$/, '');
  }

  async init() {
    if (imix()?.mediaAccess) await imix().mediaAccess('camera');
    const deviceId = await resolveDevice('videoinput', this.deviceId, this.deviceLabel);
    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: this.width },
        height: { ideal: this.height },
        frameRate: { ideal: this.fps },
      },
      audio: false,
    };
    if (this.audioDeviceId || this.audioDeviceLabel) {
      if (imix()?.mediaAccess) await imix().mediaAccess('microphone');
      const aid = await resolveDevice('audioinput', this.audioDeviceId, this.audioDeviceLabel);
      constraints.audio = { deviceId: aid ? { exact: aid } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.attachStream(stream);
      const track = stream.getVideoTracks()[0];
      const s = track?.getSettings() || {};
      this.deviceId = s.deviceId || this.deviceId;
      if (track && !this.deviceLabel) this.deviceLabel = track.label;
    } catch (e) {
      this.error = `Camera unavailable: ${e.message}`;
    }
  }

  serialize() {
    return { ...super.serialize(), width: this.width, height: this.height, fps: this.fps, audioDeviceId: this.audioDeviceId, audioDeviceLabel: this.audioDeviceLabel };
  }
}

export class AudioDeviceInput extends StreamInput {
  constructor(opts = {}) {
    super('audio', opts);
    this.hasVideo = false;
    this.hasAudio = true;
    this.channels = opts.channels || 'stereo'; // stereo | left | right
    if (!opts.title && this.deviceLabel) this.title = this.deviceLabel.replace(/\s*\(.*\)$/, '');
  }

  async init() {
    if (imix()?.mediaAccess) await imix().mediaAccess('microphone');
    const deviceId = await resolveDevice('audioinput', this.deviceId, this.deviceLabel);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
      });
      this.stream = stream;
      const t = stream.getAudioTracks()[0];
      if (t && !this.deviceLabel) this.deviceLabel = t.label;
      this.hasAudio = true;
    } catch (e) {
      this.error = `Audio device unavailable: ${e.message}`;
    }
  }

  videoSource() {
    return null;
  }

  serialize() {
    return { ...super.serialize(), channels: this.channels };
  }
}

export class ScreenInput extends StreamInput {
  constructor(opts = {}) {
    super('screen', opts);
    this.sourceId = opts.sourceId || '';
    if (!opts.title) this.title = opts.sourceName || 'Screen Capture';
  }

  async init() {
    try {
      if (imix()?.selectScreenSource && this.sourceId) await imix().selectScreenSource(this.sourceId);
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      this.attachStream(stream);
    } catch (e) {
      this.error = `Screen capture unavailable: ${e.message}`;
    }
  }

  serialize() {
    return { ...super.serialize(), sourceId: this.sourceId };
  }
}

export class BrowserInput extends Input {
  constructor(opts = {}) {
    super('browser', opts);
    this.url = opts.url || 'https://example.com';
    this.width = opts.width || 1280;
    this.height = opts.height || 720;
    this.fps = opts.fps || 25;
    this.css = opts.css || '';
    this.frame = null;
    if (!opts.title) this.title = this.url.replace(/^https?:\/\//, '').slice(0, 40);
  }

  async init() {
    if (imix()?.browserOpen) {
      await imix().browserOpen({ id: this.id, url: this.url, width: this.width, height: this.height, fps: this.fps, css: this.css });
    } else {
      this.error = 'Web browser inputs require the desktop app';
    }
  }

  onFrame(f) {
    this.frame = f;
    this.version++;
  }

  navigate(url) {
    this.url = url;
    imix()?.browserNavigate(this.id, url);
    this.changed();
  }

  reload() {
    imix()?.browserReload(this.id);
  }

  videoSource() {
    const f = this.frame;
    if (!f) return null;
    return { kind: 'pixels', data: new Uint8Array(f.data.buffer || f.data, f.data.byteOffset || 0, f.width * f.height * 4), width: f.width, height: f.height, bgra: true, version: this.version };
  }

  serialize() {
    return { ...super.serialize(), url: this.url, width: this.width, height: this.height, fps: this.fps, css: this.css };
  }

  destroy() {
    super.destroy();
    imix()?.browserClose(this.id);
  }
}

export class ReplayInput extends Input {
  constructor(opts = {}, replay) {
    super('replay', opts);
    this.replay = replay;
    if (!opts.title) this.title = 'Instant Replay';
  }

  videoSource() {
    const r = this.replay;
    if (!r || !r.canvas) return null;
    return { kind: 'element', el: r.canvas, width: r.canvas.width, height: r.canvas.height, always: false, version: r.version };
  }

  get state() {
    return this.replay?.playing ? 'Running' : 'Paused';
  }

  play() {
    this.replay?.playLast(this.replay.lastSeconds);
  }

  pause() {
    this.replay?.pause();
  }

  restart() {
    this.replay?.playLast(this.replay.lastSeconds);
  }
}

export function createInput(data, ctx = {}) {
  switch (data.type) {
    case 'camera': return new CameraInput(data);
    case 'audio': return new AudioDeviceInput(data);
    case 'screen': return new ScreenInput(data);
    case 'video': return new VideoInput(data);
    case 'audiofile': return new AudioFileInput(data);
    case 'list': return new ListInput(data);
    case 'image': return new ImageInput(data);
    case 'title': return new TitleInput(data);
    case 'colour': return new ColourInput(data);
    case 'browser': return new BrowserInput(data);
    case 'url': return new UrlInput(data);
    case 'replay': return new ReplayInput(data, ctx.replay);
    default: throw new Error(`Unknown input type ${data.type}`);
  }
}
