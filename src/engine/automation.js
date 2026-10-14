// Keyboard shortcuts, MIDI control and JavaScript scripting.

export const DEFAULT_SHORTCUTS = [
  { trigger: { type: 'key', key: 'Space' }, fn: 'Transition1', params: '' },
  { trigger: { type: 'key', key: 'Enter' }, fn: 'Cut', params: '' },
  { trigger: { type: 'key', key: 'KeyB' }, fn: 'FadeToBlack', params: '' },
  { trigger: { type: 'key', key: 'F1' }, fn: 'PreviewOverlayInput1', params: '' },
  { trigger: { type: 'key', key: 'F2' }, fn: 'PreviewOverlayInput2', params: '' },
  { trigger: { type: 'key', key: 'F3' }, fn: 'PreviewOverlayInput3', params: '' },
  { trigger: { type: 'key', key: 'F4' }, fn: 'PreviewOverlayInput4', params: '' },
  { trigger: { type: 'key', key: 'KeyQ' }, fn: 'Transition2', params: '' },
  { trigger: { type: 'key', key: 'KeyW' }, fn: 'Transition3', params: '' },
  { trigger: { type: 'key', key: 'KeyE' }, fn: 'Transition4', params: '' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ trigger: { type: 'key', key: `Digit${n}` }, fn: 'PreviewInput', params: `Input=${n}` })),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ trigger: { type: 'key', key: `Digit${n}`, shift: true }, fn: 'CutDirect', params: `Input=${n}` })),
];

export function describeTrigger(t) {
  if (!t) return '';
  if (t.type === 'midi') return `MIDI ${t.kind === 'cc' ? 'CC' : 'Note'} ${t.data1} ch${t.channel + 1}`;
  const mods = [t.ctrl && '⌃', t.alt && '⌥', t.shift && '⇧', t.meta && '⌘'].filter(Boolean).join('');
  const key = String(t.key || '').replace(/^Key/, '').replace(/^Digit/, '');
  return mods + key;
}

export class Shortcuts {
  constructor(app) {
    this.app = app;
    this.learning = null;
    this.midiAccess = null;
    this.midiInputs = [];
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  get list() {
    return this.app.mixer.shortcuts;
  }

  ensureDefaults() {
    if (!this.app.mixer.shortcuts || !this.app.mixer.shortcuts.length) this.app.mixer.shortcuts = structuredClone(DEFAULT_SHORTCUTS);
  }

  onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (e.repeat) return;
    const t = { type: 'key', key: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
    if (this.learning) {
      e.preventDefault();
      this.finishLearn(t);
      return;
    }
    if (e.metaKey && !['Space', 'Enter'].includes(e.code)) return; // leave ⌘ shortcuts to the menu
    const hit = this.list.find((s) => s.trigger && s.trigger.type === 'key' && s.trigger.key === t.key
      && !!s.trigger.shift === t.shift && !!s.trigger.ctrl === t.ctrl && !!s.trigger.alt === t.alt && !!s.trigger.meta === t.meta);
    if (hit) {
      e.preventDefault();
      this.app.api.callString(`${hit.fn} ${hit.params || ''}`);
    }
  }

  learn(cb) {
    this.learning = cb;
    this.enableMidi();
  }

  cancelLearn() {
    this.learning = null;
  }

  finishLearn(trigger) {
    const cb = this.learning;
    this.learning = null;
    if (cb) cb(trigger);
  }

  async enableMidi() {
    if (this.midiAccess || !navigator.requestMIDIAccess) return;
    try {
      this.midiAccess = await navigator.requestMIDIAccess();
      const bind = () => {
        this.midiInputs = [...this.midiAccess.inputs.values()];
        for (const inp of this.midiInputs) inp.onmidimessage = (ev) => this.onMidi(ev);
        this.app.mixer.emit('midi');
      };
      this.midiAccess.onstatechange = bind;
      bind();
    } catch (e) {
      console.warn('MIDI unavailable', e);
    }
  }

  onMidi(ev) {
    const [status, data1, data2] = ev.data;
    const kind = (status & 0xf0) === 0x90 ? 'note' : (status & 0xf0) === 0xb0 ? 'cc' : null;
    if (!kind) return;
    if (kind === 'note' && data2 === 0) return; // note off
    const channel = status & 0x0f;
    const t = { type: 'midi', kind, channel, data1 };
    if (this.learning) {
      this.finishLearn(t);
      return;
    }
    for (const s of this.list) {
      const st = s.trigger;
      if (!st || st.type !== 'midi' || st.kind !== kind || st.channel !== channel || st.data1 !== data1) continue;
      let params = s.params || '';
      // CC values can drive faders: {value} → 0..255, {value100} → 0..100
      params = params.replace('{value}', String(Math.round((data2 / 127) * 255))).replace('{value100}', String(Math.round((data2 / 127) * 100)));
      if (kind === 'cc' && !/\{value/.test(s.params || '') && data2 < 64 && !/SetFader|SetVolume/i.test(s.fn)) continue;
      this.app.api.callString(`${s.fn} ${params}`);
    }
  }
}

// ---------------------------------------------------------------- scripting
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

export class Scripts {
  constructor(app) {
    this.app = app;
    this.running = new Map(); // name -> { cancel }
  }

  get list() {
    return this.app.mixer.scripts;
  }

  find(name) {
    return this.list.find((s) => s.name === name) || this.list[Number(name) - 1];
  }

  start(name) {
    const script = this.find(name);
    if (!script) throw new Error(`Script not found: ${name}`);
    if (this.running.has(script.name)) return true;
    const token = { cancelled: false };
    const app = this.app;
    const log = (...a) => app.mixer.emit('scriptlog', `[${script.name}] ${a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')}`);
    const check = () => {
      if (token.cancelled) throw new Error('__stopped__');
    };
    const API = {
      Function: async (fn, params = {}) => {
        check();
        const r = typeof params === 'string' ? await app.api.callString(`${fn} ${params}`) : await app.api.call(fn, params);
        if (!r.ok) log(`${fn}: ${r.message}`);
        return r.ok;
      },
      state: () => app.api.stateJson(),
      input: (ref) => app.mixer.getInput(ref),
    };
    const sleep = (ms) => new Promise((resolve, reject) => {
      const t = setTimeout(() => (token.cancelled ? reject(new Error('__stopped__')) : resolve()), ms);
      token.timers = token.timers || new Set();
      token.timers.add(t);
    });
    let fn;
    try {
      fn = new AsyncFunction('API', 'sleep', 'log', 'mixer', script.code);
    } catch (e) {
      log(`Syntax error: ${e.message}`);
      return false;
    }
    this.running.set(script.name, token);
    app.mixer.emit('scripts');
    log('started');
    fn(API, sleep, log, app.mixer)
      .then(() => log('finished'))
      .catch((e) => log(e.message === '__stopped__' ? 'stopped' : `Error: ${e.message}`))
      .finally(() => {
        this.running.delete(script.name);
        app.mixer.emit('scripts');
      });
    return true;
  }

  stop(name) {
    const script = this.find(name);
    const token = script && this.running.get(script.name);
    if (!token) return true;
    token.cancelled = true;
    for (const t of token.timers || []) clearTimeout(t);
    this.running.delete(script.name);
    this.app.mixer.emit('scriptlog', `[${script.name}] stopped`);
    this.app.mixer.emit('scripts');
    return true;
  }

  stopAll() {
    for (const name of [...this.running.keys()]) this.stop(name);
    return true;
  }
}

export const EXAMPLE_SCRIPT = `// Scripts run JavaScript with these helpers:
//   await API.Function('Fade', { Input: 2, Duration: 1000 })
//   await sleep(ms)      log('message')      API.state()
// Example: rotate between inputs 1-3 every 5 seconds
for (let i = 0; i < 1000; i++) {
  await API.Function('Fade', { Input: (i % 3) + 1, Duration: 800 });
  await sleep(5000);
}`;
