// Function dispatcher shared by the HTTP/TCP API, keyboard shortcuts, MIDI,
// the web controller and scripts. Function names follow the conventions
// widely used by switcher control surfaces (Cut, Fade, PreviewInput,
// OverlayInput1In, SetText, StartRecording, …).
import { TRANSITIONS, findTransition } from './transitions.js';
import { faderToGain } from './audio.js';

const num = (v, d = 0) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v) => /^(1|true|on|yes)$/i.test(String(v));

function needInput(m, p) {
  const ref = p.Input ?? p.input;
  const input = m.getInput(ref);
  if (!input) throw new Error(`Input not found: ${ref ?? '(none)'}`);
  return input;
}

function optInput(m, p) {
  const ref = p.Input ?? p.input;
  return ref == null || ref === '' ? null : m.getInput(ref);
}

function setAudio(m, input, patch) {
  Object.assign(input.settings.audio, patch);
  m.inputChanged(input);
}

function busKey(v) {
  const b = String(v || 'M').toUpperCase();
  if (b === 'MASTER' || b === 'M') return 'M';
  return b;
}

// Build the function table. Keys are case-insensitive.
function buildFunctions(app) {
  const m = app.mixer;
  const o = () => app.outputs;
  const F = {
    // ---------------------------------------------------------- switching
    PreviewInput: (p) => m.setPreview(needInput(m, p).id),
    PreviewInputNext: () => {
      const i = m.inputs.findIndex((x) => x.id === m.previewId);
      return m.setPreview(m.inputs[(i + 1) % m.inputs.length]?.id);
    },
    PreviewInputPrevious: () => {
      const i = m.inputs.findIndex((x) => x.id === m.previewId);
      return m.setPreview(m.inputs[(i - 1 + m.inputs.length) % m.inputs.length]?.id);
    },
    ActiveInput: (p) => m.cut(needInput(m, p).id),
    CutDirect: (p) => m.cut(needInput(m, p).id),
    Cut: (p) => (optInput(m, p) ? m.cut(needInput(m, p).id) : m.cut()),
    Transition1: () => m.transitionSlot(0),
    Transition2: () => m.transitionSlot(1),
    Transition3: () => m.transitionSlot(2),
    Transition4: () => m.transitionSlot(3),
    Stinger1: (p) => m.transition('Stinger 1', 0, optInput(m, p)?.id),
    Stinger2: (p) => m.transition('Stinger 2', 0, optInput(m, p)?.id),
    QuickPlay: (p) => m.transition(m.quickPlay.type, m.quickPlay.duration, needInput(m, p).id),
    SetFader: (p) => m.setTbar(num(p.Value) / 255),
    SetTransitionEffect1: (p) => setSlot(0, p),
    SetTransitionEffect2: (p) => setSlot(1, p),
    SetTransitionEffect3: (p) => setSlot(2, p),
    SetTransitionEffect4: (p) => setSlot(3, p),
    SetTransitionDuration1: (p) => setSlotDur(0, p),
    SetTransitionDuration2: (p) => setSlotDur(1, p),
    SetTransitionDuration3: (p) => setSlotDur(2, p),
    SetTransitionDuration4: (p) => setSlotDur(3, p),
    FadeToBlack: () => m.toggleFtb(),
    FadeToBlackOn: () => m.toggleFtb(true),
    FadeToBlackOff: () => m.toggleFtb(false),

    // ---------------------------------------------------------- overlays
    OverlayInputAllOff: () => m.overlayAllOff(),

    // ------------------------------------------------------------ playback
    Play: (p) => needInput(m, p).play(),
    Pause: (p) => needInput(m, p).pause(),
    PlayPause: (p) => {
      const i = needInput(m, p);
      return i.state === 'Running' ? i.pause() : i.play();
    },
    Restart: (p) => needInput(m, p).restart(),
    SetPosition: (p) => needInput(m, p).seek(num(p.Value)),
    LoopOn: (p) => needInput(m, p).setLoop?.(true),
    LoopOff: (p) => needInput(m, p).setLoop?.(false),
    Loop: (p) => {
      const i = needInput(m, p);
      return i.setLoop?.(!i.settings.loop);
    },
    NextItem: (p) => needInput(m, p).next?.(),
    PreviousItem: (p) => needInput(m, p).previous?.(),
    SelectIndex: (p) => needInput(m, p).load?.(num(p.Value, 1) - 1, true),

    // --------------------------------------------------------------- audio
    Audio: (p) => {
      const i = needInput(m, p);
      setAudio(m, i, { muted: !i.settings.audio.muted });
    },
    AudioOn: (p) => setAudio(m, needInput(m, p), { muted: false }),
    AudioOff: (p) => setAudio(m, needInput(m, p), { muted: true }),
    AudioAuto: (p) => {
      const i = needInput(m, p);
      setAudio(m, i, { afv: !i.settings.audio.afv });
    },
    AudioAutoOn: (p) => setAudio(m, needInput(m, p), { afv: true }),
    AudioAutoOff: (p) => setAudio(m, needInput(m, p), { afv: false }),
    SetVolume: (p) => setAudio(m, needInput(m, p), { volume: rel(needInput(m, p).settings.audio.volume, p.Value) }),
    SetVolumeFade: (p) => fadeVolume(needInput(m, p), p),
    SetBalance: (p) => setAudio(m, needInput(m, p), { balance: num(p.Value) }),
    SetGain: (p) => setAudio(m, needInput(m, p), { gain: num(p.Value) }),
    SetAudioDelay: (p) => setAudio(m, needInput(m, p), { delay: num(p.Value) }),
    AudioBus: (p) => {
      const i = needInput(m, p);
      const b = busKey(p.Value);
      i.settings.audio.buses[b] = !i.settings.audio.buses[b];
      m.inputChanged(i);
    },
    AudioBusOn: (p) => {
      const i = needInput(m, p);
      i.settings.audio.buses[busKey(p.Value)] = true;
      m.inputChanged(i);
    },
    AudioBusOff: (p) => {
      const i = needInput(m, p);
      i.settings.audio.buses[busKey(p.Value)] = false;
      m.inputChanged(i);
    },
    Solo: (p) => m.audio.setSolo(needInput(m, p).id),
    SetMasterVolume: (p) => m.audio.buses.M.set(rel(m.audio.buses.M.volume, p.Value)),
    MasterAudio: () => m.audio.buses.M.set(undefined, !m.audio.buses.M.muted),
    MasterAudioOn: () => m.audio.buses.M.set(undefined, false),
    MasterAudioOff: () => m.audio.buses.M.set(undefined, true),
    SetBusAVolume: (p) => m.audio.buses.A.set(rel(m.audio.buses.A.volume, p.Value)),
    SetBusBVolume: (p) => m.audio.buses.B.set(rel(m.audio.buses.B.volume, p.Value)),
    BusXAudio: (p) => {
      const b = m.audio.buses[busKey(p.Value)];
      if (b) b.set(undefined, !b.muted);
    },
    MonitorOn: () => m.audio.setMonitor(true),
    MonitorOff: () => m.audio.setMonitor(false),

    // ------------------------------------------------------- input settings
    SetPanX: (p) => setPos(p, 'panX'),
    SetPanY: (p) => setPos(p, 'panY'),
    SetZoom: (p) => setPos(p, 'zoom'),
    SetAlpha: (p) => setPos(p, 'opacity', 255),
    SetCrop: (p) => {
      const i = needInput(m, p);
      const [l, t, r, b] = String(p.Value || '0,0,0,0').split(',').map(Number);
      Object.assign(i.settings.crop, { l: l || 0, t: t || 0, r: r || 0, b: b || 0 });
      m.inputChanged(i);
    },
    SetColourCorrection: (p) => {
      const i = needInput(m, p);
      const key = String(p.Name || p.SelectedName || 'brightness').toLowerCase();
      if (key in i.settings.color) i.settings.color[key] = num(p.Value);
      m.inputChanged(i);
    },
    KeyOn: (p) => setKey(p, needInput(m, p).settings.key.mode === 'none' ? 'chroma' : needInput(m, p).settings.key.mode),
    KeyOff: (p) => setKey(p, 'none'),
    SetLayer: (p) => {
      const i = needInput(m, p);
      const idx = num(p.Layer ?? p.Index, 1) - 1;
      const l = i.settings.layers[idx];
      if (!l) throw new Error('Layer must be 1-4');
      const ref = p.Value ?? p.LayerInput;
      const li = ref ? m.getInput(ref) : null;
      l.inputId = li ? li.id : null;
      l.enabled = !!li;
      m.inputChanged(i);
    },
    LayerOff: (p) => {
      const i = needInput(m, p);
      const l = i.settings.layers[num(p.Value ?? p.Layer, 1) - 1];
      if (l) l.enabled = false;
      m.inputChanged(i);
    },
    LayerOn: (p) => {
      const i = needInput(m, p);
      const l = i.settings.layers[num(p.Value ?? p.Layer, 1) - 1];
      if (l && l.inputId) l.enabled = true;
      m.inputChanged(i);
    },
    SetInputName: (p) => {
      const i = needInput(m, p);
      i.title = String(p.Value || i.title);
      m.emit('inputs');
    },
    RemoveInput: (p) => m.removeInput(needInput(m, p).id),
    MoveInput: (p) => m.moveInput(needInput(m, p).id, num(p.Value, 1) - 1),
    SetColour: (p) => needInput(m, p).setColor?.(p.Value),
    BrowserNavigate: (p) => needInput(m, p).navigate?.(p.Value),
    BrowserReload: (p) => needInput(m, p).reload?.(),

    // --------------------------------------------------------------- titles
    SetText: (p) => {
      const i = needInput(m, p);
      if (!i.setText) throw new Error('Input is not a title');
      return i.setText(p.SelectedName ?? p.SelectedIndex ?? '', p.Value ?? '');
    },
    SetTextColour: (p) => needInput(m, p).setStyle?.({ text: p.Value }),
    SetTitleStyle: (p) => {
      const i = needInput(m, p);
      const key = p.SelectedName || p.Name;
      if (!key) throw new Error('Name required');
      i.setStyle?.({ [key]: key === 'bgOpacity' ? num(p.Value, 0.9) : key === 'animate' ? bool(p.Value) : p.Value });
    },
    StartCountdown: (p) => needInput(m, p).countdown?.('start'),
    StopCountdown: (p) => needInput(m, p).countdown?.('stop'),
    PauseCountdown: (p) => needInput(m, p).countdown?.('pause'),
    SetCountdown: (p) => needInput(m, p).countdown?.('set', p.Value),
    AdjustCountdown: (p) => needInput(m, p).countdown?.('adjust', p.Value),

    // -------------------------------------------------------------- outputs
    StartRecording: () => o().startRecording(),
    StopRecording: () => o().stopRecording(),
    StartStopRecording: () => o().toggleRecording(),
    StartStreaming: (p) => o().startStreaming(p.Value),
    StopStreaming: () => o().stopStreaming(),
    StartStopStreaming: (p) => o().toggleStreaming(p.Value),
    StartExternal: (p) => o().openExternal(p.Value),
    StopExternal: () => o().closeExternal(),
    StartStopExternal: (p) => (o().status().external ? o().closeExternal() : o().openExternal(p.Value)),
    StartMultiview: (p) => o().openMultiview(p.Value),
    Snapshot: () => o().snapshot(),

    // --------------------------------------------------------------- replay
    ReplayStartRecording: () => m.replay.start(),
    ReplayStopRecording: () => m.replay.stop(),
    ReplayStartStopRecording: () => (m.replay.recording ? m.replay.stop() : m.replay.start()),
    ReplayMarkIn: () => m.replay.markIn(),
    ReplayMarkOut: (p) => m.replay.markOut(p.Value),
    ReplayPlayLast: (p) => m.replay.playLast(num(p.Value, m.replay.lastSeconds)),
    ReplayPlayLastEvent: () => m.replay.playEvent(),
    ReplayPlay: () => m.replay.resume(),
    ReplayPause: () => m.replay.pause(),
    ReplaySetSpeed: (p) => {
      m.replay.speed = Math.max(0.05, Math.min(2, num(p.Value, 0.5)));
      m.emit('replay');
    },

    // -------------------------------------------------------------- scripts
    ScriptStart: (p) => app.scripts.start(p.Value),
    ScriptStop: (p) => app.scripts.stop(p.Value),
    ScriptStopAll: () => app.scripts.stopAll(),
  };

  // Overlay channel functions OverlayInput1..4 (+In/Out/Off/Zoom)
  for (let n = 1; n <= 4; n++) {
    F[`OverlayInput${n}`] = (p) => m.overlay(n - 1, optInput(m, p)?.id, 'toggle');
    F[`OverlayInput${n}In`] = (p) => m.overlay(n - 1, optInput(m, p)?.id ?? m.previewId, 'in');
    F[`OverlayInput${n}Out`] = () => m.overlay(n - 1, null, 'out');
    F[`OverlayInput${n}Off`] = () => m.overlay(n - 1, null, 'off');
    F[`PreviewOverlayInput${n}`] = (p) => m.overlay(n - 1, optInput(m, p)?.id ?? m.previewId, 'toggle');
    F[`SetOverlayEffect${n}`] = (p) => {
      m.overlays[n - 1].effect = p.Value || 'Fade';
      m.emit('state');
    };
  }

  // Generic transitions by name: Fade, Wipe, Slide, Zoom, Merge, …  (Input / Duration)
  for (const t of TRANSITIONS) {
    const fname = t.name.replace(/\s+/g, '');
    if (F[fname]) continue;
    F[fname] = (p) => m.transition(t, num(p.Duration, 1000), optInput(m, p)?.id);
  }
  for (const alias of ['Wipe', 'Slide', 'Push', 'Merge', 'Fly', 'BarnDoor', 'CubeZoom', 'VerticalWipe', 'VerticalSlide']) {
    if (!F[alias]) F[alias] = (p) => m.transition(findTransition(alias), num(p.Duration, 1000), optInput(m, p)?.id);
  }

  function rel(current, value) {
    const s = String(value ?? '');
    if (/^[+-]/.test(s)) return Math.max(0, Math.min(100, current + Number(s)));
    return Math.max(0, Math.min(100, num(s, current)));
  }

  function fadeVolume(input, p) {
    // Value "target,ms" e.g. "50,2000"
    const [target, ms] = String(p.Value || '0,1000').split(',').map(Number);
    const from = input.settings.audio.volume;
    const start = performance.now();
    const dur = ms || 1000;
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / dur);
      setAudio(m, input, { volume: from + (target - from) * k });
      if (k < 1) setTimeout(step, 30);
    };
    step();
  }

  function setSlot(i, p) {
    const t = findTransition(p.Value);
    if (!t) throw new Error(`Unknown transition ${p.Value}`);
    m.transitionSlots[i].type = t.name;
    m.emit('transitions');
  }

  function setSlotDur(i, p) {
    m.transitionSlots[i].duration = num(p.Value, 1000);
    m.emit('transitions');
  }

  function setPos(p, key, scale = 1) {
    const i = needInput(m, p);
    const s = String(p.Value ?? '');
    let v = num(s) / scale;
    if (/^[+-]/.test(s) && key !== 'opacity') v = i.settings[key] + num(s);
    i.settings[key] = key === 'zoom' ? Math.max(0, v) : v;
    m.inputChanged(i);
  }

  function setKey(p, mode) {
    const i = needInput(m, p);
    i.settings.key.mode = mode;
    m.inputChanged(i);
  }

  const table = {};
  for (const [k, fn] of Object.entries(F)) table[k.toLowerCase()] = { name: k, fn };
  return table;
}

export class Api {
  constructor(app) {
    this.app = app;
    this.table = buildFunctions(app);
  }

  get functionNames() {
    return Object.values(this.table).map((x) => x.name).sort();
  }

  async call(name, params = {}) {
    const entry = this.table[String(name || '').toLowerCase()];
    if (!entry) return { ok: false, message: `Unknown function ${name}` };
    try {
      const r = await entry.fn(params || {});
      if (r === false) return { ok: false, message: `${entry.name} could not be performed` };
      this.app.mixer.emit('api', { name: entry.name, params });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  // "Cut", "Fade Input=2&Duration=500", "Function=Fade&Input=2"
  async callString(str) {
    const s = String(str || '').trim();
    if (!s) return { ok: false, message: 'Empty' };
    if (/^Function=/i.test(s)) {
      const q = new URLSearchParams(s);
      const params = Object.fromEntries(q);
      const fn = params.Function || params.function;
      delete params.Function;
      delete params.function;
      return this.call(fn, params);
    }
    const [fn, ...rest] = s.split(/\s+/);
    return this.call(fn, Object.fromEntries(new URLSearchParams(rest.join(' '))));
  }

  // ------------------------------------------------------------ state dumps
  stateJson() {
    const m = this.app.mixer;
    const o = this.app.outputs;
    const now = performance.now();
    return {
      app: 'Unique AV IMix',
      version: '1.0.0',
      format: { width: m.settings.width, height: m.settings.height, fps: m.settings.fps },
      program: m.inputNumber(m.getInput(m.programId)) || 0,
      preview: m.inputNumber(m.getInput(m.previewId)) || 0,
      inTransition: !!m.trans,
      tbar: m.tbar.value,
      fadeToBlack: m.ftb.on,
      tally: m.tally(),
      inputs: m.inputs.map((i, idx) => ({
        number: idx + 1,
        key: i.id,
        type: i.type,
        title: i.title,
        state: i.state,
        position: Math.round(i.position),
        duration: Math.round(i.duration),
        loop: !!i.settings.loop,
        muted: i.settings.audio.muted,
        volume: Math.round(i.settings.audio.volume),
        afv: i.settings.audio.afv,
        hasAudio: i.hasAudio,
        hasVideo: i.hasVideo,
        onAir: m.isOnAir(i),
        fields: i.fields || undefined,
        error: i.error || undefined,
      })),
      overlays: m.overlays.map((ov, n) => ({ number: n + 1, input: ov.inputId ? m.inputNumber(m.getInput(ov.inputId)) : 0, active: ov.state !== 'off', effect: ov.effect })),
      transitions: m.transitionSlots.map((t, n) => ({ number: n + 1, effect: t.type, duration: t.duration })),
      master: { volume: m.audio.buses.M.volume, muted: m.audio.buses.M.muted },
      recording: o.status().recording,
      streaming: o.status().streaming,
      external: o.status().external,
      replay: { recording: m.replay.recording, playing: m.replay.playing, events: m.replay.events.length },
      transitionProgress: m.trans ? m.transProgress(now) : 0,
    };
  }

  stateXml() {
    const s = this.stateJson();
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tf = (b) => (b ? 'True' : 'False');
    const typeMap = { camera: 'Capture', audio: 'AudioDevice', screen: 'Capture', video: 'Video', list: 'VideoList', image: 'Image', audiofile: 'AudioFile', title: 'GT', colour: 'Colour', browser: 'Browser', url: 'Stream', replay: 'Replay' };
    const inputs = s.inputs.map((i) => {
      const fields = i.fields ? Object.entries(i.fields).map(([k, v], n) => `<text index="${n}" name="${esc(k)}">${esc(v)}</text>`).join('') : '';
      return `<input key="${esc(i.key)}" number="${i.number}" type="${typeMap[i.type] || i.type}" title="${esc(i.title)}" shortTitle="${esc(i.title)}" state="${i.state}" position="${i.position}" duration="${i.duration}" loop="${tf(i.loop)}"${i.hasAudio ? ` muted="${tf(i.muted)}" volume="${i.volume}" balance="0" solo="False" audiobusses="M"` : ''}>${esc(i.title)}${fields}</input>`;
    }).join('');
    const overlays = s.overlays.map((o) => `<overlay number="${o.number}">${o.active && o.input ? o.input : ''}</overlay>`).join('');
    const transitions = s.transitions.map((t) => `<transition number="${t.number}" effect="${esc(t.effect.replace(/\s+/g, ''))}" duration="${t.duration}"/>`).join('');
    return `<vmix><version>1.0.0</version><edition>Unique AV IMix</edition><inputs>${inputs}</inputs><overlays>${overlays}</overlays>`
      + `<preview>${s.preview}</preview><active>${s.program}</active><fadeToBlack>${tf(s.fadeToBlack)}</fadeToBlack>`
      + `<transitions>${transitions}</transitions><recording>${tf(s.recording)}</recording><external>${tf(s.external)}</external>`
      + `<streaming>${tf(s.streaming)}</streaming><playList>False</playList><multiCorder>False</multiCorder><fullscreen>False</fullscreen>`
      + `<audio><master volume="${s.master.volume}" muted="${tf(s.master.muted)}" headphonesVolume="100"/></audio></vmix>`;
  }
}

export { faderToGain };
