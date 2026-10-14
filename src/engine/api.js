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

    // ------------------------------------------- control-surface extras
    AutoPlayOn: (p) => setFlag(p, 'autoPlay', true),
    AutoPlayOff: (p) => setFlag(p, 'autoPlay', false),
    AutoPauseOn: (p) => setFlag(p, 'autoPause', true),
    AutoPauseOff: (p) => setFlag(p, 'autoPause', false),
    AutoRestartOn: (p) => setFlag(p, 'autoRestart', true),
    AutoRestartOff: (p) => setFlag(p, 'autoRestart', false),
    SoloOn: (p) => { const i = needInput(m, p); if (m.audio.solo !== i.id) m.audio.setSolo(i.id); },
    SoloOff: (p) => { const i = needInput(m, p); if (m.audio.solo === i.id) m.audio.setSolo(i.id); },
    BusXAudioOn: (p) => m.audio.buses[busKey(p.Value)]?.set(undefined, false),
    BusXAudioOff: (p) => m.audio.buses[busKey(p.Value)]?.set(undefined, true),
    BusXSolo: (p) => m.audio.setMonitor(true, m.audio.monitorBus === busKey(p.Value) ? 'M' : busKey(p.Value)),
    BusXSoloOn: (p) => m.audio.setMonitor(true, busKey(p.Value)),
    BusXSoloOff: () => m.audio.setMonitor(m.audio.monitorOn, 'M'),
    SetHeadphonesVolume: (p) => m.audio.monitor.gain.setTargetAtTime(faderToGain(num(p.Value, 100)), m.audio.ctx.currentTime, 0.02),
    SetCropX1: (p) => setCrop(p, 'l', (v) => v),
    SetCropX2: (p) => setCrop(p, 'r', (v) => 1 - v),
    SetCropY1: (p) => setCrop(p, 't', (v) => v),
    SetCropY2: (p) => setCrop(p, 'b', (v) => 1 - v),
    ColourCorrectionReset: (p) => {
      const i = needInput(m, p);
      Object.assign(i.settings.color, { brightness: 0, contrast: 1, saturation: 1, hue: 0, gamma: 1 });
      m.inputChanged(i);
    },
    SetColor: (p) => needInput(m, p).setColor?.(p.Value),
    SnapshotInput: async (p) => {
      const url = o().snapshotDataUrl(needInput(m, p));
      if (!url) throw new Error('Nothing to snapshot');
      if (!window.imix?.writeBinary) return;
      const info = await window.imix.info();
      const bin = Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));
      await window.imix.writeBinary(`${m.settings.recordDir || info.moviesDir}/${needInput(m, p).title} ${Date.now()}.png`, bin);
    },
    SuspendCountdown: (p) => needInput(m, p).countdown?.('pause'),
    ChangeCountdown: (p) => needInput(m, p).countdown?.('set', p.Value),
    SetTickerSpeed: (p) => needInput(m, p).setStyle?.({ speed: num(p.Value, 160) }),
    StreamingSetURL: (p) => setDest(p, 'url'),
    StreamingSetKey: (p) => setDest(p, 'key'),
    Fullscreen: () => (o().status().external ? o().closeExternal() : o().openExternal(null)),
    FullscreenOn: () => o().openExternal(null),
    FullscreenOff: () => o().closeExternal(),
    ReplayMarkInLive: () => m.replay.markIn(),
    ReplayLive: () => m.replay.pause(),
    NextPlayListEntry: (p) => (optInput(m, p) || m.getInput(m.previewId))?.next?.(),
    PreviousPlayListEntry: (p) => (optInput(m, p) || m.getInput(m.previewId))?.previous?.(),

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

  function setFlag(p, key, v) {
    const i = needInput(m, p);
    i.settings[key] = v;
    m.inputChanged(i);
  }

  function setCrop(p, edge, map) {
    const i = needInput(m, p);
    i.settings.crop[edge] = Math.max(0, Math.min(1, map(num(p.Value))));
    m.inputChanged(i);
  }

  function setDest(p, field) {
    const d = m.streamDestinations[num(p.StreamingChannel ?? p.Channel, 0)] || m.streamDestinations[0];
    d[field] = String(p.Value ?? '');
    m.emit('project-changed');
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
      app: 'Unique AV Streaming GuRu',
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
      system: { ...(this.app.system || {}), fps: Math.round(m.stats.fps * 10) / 10, frameMs: Math.round(m.stats.frameMs * 10) / 10 },
    };
  }

  // XML state in the layout switcher control surfaces (e.g. Bitfocus
  // Companion's vMix module, Stream Deck plugins) parse.
  stateXml() {
    const m = this.app.mixer;
    const s = this.stateJson();
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tf = (b) => (b ? 'True' : 'False');
    const num = (v, d = 3) => Number(v || 0).toFixed(d);
    const meters = m.audio.meters();
    const typeMap = { camera: 'Capture', audio: 'AudioDevice', screen: 'Capture', video: 'Video', list: 'VideoList', image: 'Image', audiofile: 'AudioFile', title: 'GT', colour: 'Colour', browser: 'Browser', url: 'Stream', replay: 'Replay' };
    const inputs = m.inputs.map((inp, idx) => {
      const a = inp.settings.audio;
      const st = inp.settings;
      const attrs = [
        `key="${esc(inp.id)}"`, `number="${idx + 1}"`, `type="${typeMap[inp.type] || inp.type}"`, `title="${esc(inp.title)}"`, `shortTitle="${esc(inp.title)}"`,
        `state="${inp.state}"`, `position="${Math.round(inp.position)}"`, `duration="${Math.round(inp.duration)}"`, `loop="${tf(st.loop)}"`,
      ];
      if (inp.type === 'list') attrs.push(`selectedIndex="${(inp.index || 0) + 1}"`);
      if (inp.hasAudio) {
        const lv = meters[inp.id] || [0, 0];
        const buses = ['M', 'A', 'B'].filter((b) => a.buses[b]).join(',');
        attrs.push(`muted="${tf(a.muted)}"`, `volume="${num(a.volume, 2)}"`, `balance="${num(a.balance, 2)}"`, `solo="${tf(m.audio.solo === inp.id)}"`,
          `audiobusses="${buses}"`, `meterF1="${num(lv[0], 5)}"`, `meterF2="${num(lv[1], 5)}"`, `gainDb="${num(a.gain, 1)}"`);
      }
      const layers = st.layers.map((l, n) => (l.enabled && l.inputId && m.getInput(l.inputId)
        ? `<overlay index="${n}" key="${esc(l.inputId)}"><position panX="${num(l.x * 2 + l.w - 1)}" panY="${num(1 - l.y * 2 - l.h)}" zoomX="${num(l.w)}" zoomY="${num(l.h)}"/></overlay>`
        : '')).join('');
      const fields = inp.fields ? Object.entries(inp.fields).map(([k, v], n) => `<text index="${n}" name="${esc(k)}">${esc(v)}</text>`).join('') : '';
      const position = `<position panX="${num(st.panX)}" panY="${num(st.panY)}" zoomX="${num(st.zoom)}" zoomY="${num(st.zoom)}"/>`;
      return `<input ${attrs.join(' ')}>${esc(inp.title)}${layers}${fields}${position}</input>`;
    }).join('');
    const overlays = s.overlays.map((o) => `<overlay number="${o.number}">${o.active && o.input ? o.input : ''}</overlay>`).join('');
    const transitions = s.transitions.map((t) => `<transition number="${t.number}" effect="${esc(t.effect.replace(/\s+/g, ''))}" duration="${t.duration}"/>`).join('');
    const bus = (tag, b, extra = '') => {
      const lv = meters[`bus:${b}`] || [0, 0];
      const bb = m.audio.buses[b];
      return `<${tag} volume="${num(bb.volume, 2)}" muted="${tf(bb.muted)}" meterF1="${num(lv[0], 5)}" meterF2="${num(lv[1], 5)}"${extra}/>`;
    };
    const o = this.app.outputs.status();
    const recDuration = o.recording ? Math.floor((Date.now() - o.recordStarted) / 1000) : 0;
    return `<vmix><version>1.0.0</version><edition>Unique AV Streaming GuRu</edition><inputs>${inputs}</inputs><overlays>${overlays}</overlays>`
      + `<preview>${s.preview}</preview><active>${s.program}</active><fadeToBlack>${tf(s.fadeToBlack)}</fadeToBlack>`
      + `<transitions>${transitions}</transitions>`
      + (o.recording ? `<recording duration="${recDuration}">True</recording>` : '<recording>False</recording>')
      + `<external>${tf(s.external)}</external>`
      + `<streaming>${tf(s.streaming)}</streaming><playList>False</playList><multiCorder>False</multiCorder><fullscreen>False</fullscreen>`
      + `<audio>${bus('master', 'M', ` headphonesVolume="100"`)}${bus('busA', 'A', ' solo="False" sendToMaster="False"')}${bus('busB', 'B', ' solo="False" sendToMaster="False"')}</audio></vmix>`;
  }

  // Activator values for "SUBSCRIBE ACTS" (real-time feedback for control surfaces).
  acts() {
    const m = this.app.mixer;
    const o = this.app.outputs.status();
    const b = (v) => (v ? '1' : '0');
    const vol = (v) => (Math.round(v) / 100).toString();
    const out = {};
    m.inputs.forEach((inp, idx) => {
      const n = idx + 1;
      out[`Input ${n}`] = b(m.programId === inp.id);
      out[`InputPreview ${n}`] = b(m.previewId === inp.id);
      out[`InputPlaying ${n}`] = b(inp.state === 'Running');
      if (inp.hasAudio) {
        const a = inp.settings.audio;
        out[`InputVolume ${n}`] = vol(a.volume);
        out[`InputAudio ${n}`] = b(!a.muted);
        out[`InputAudioAuto ${n}`] = b(a.afv);
        out[`InputSolo ${n}`] = b(m.audio.solo === inp.id);
        out[`InputMasterAudio ${n}`] = b(a.buses.M);
        out[`InputBusAAudio ${n}`] = b(a.buses.A);
        out[`InputBusBAudio ${n}`] = b(a.buses.B);
      }
    });
    m.overlays.forEach((ov, i) => {
      const inp = ov.inputId && m.getInput(ov.inputId);
      if (inp) out[`Overlay${i + 1} ${m.inputNumber(inp)}`] = b(ov.state !== 'off');
    });
    out.MasterVolume = vol(m.audio.buses.M.volume);
    out.MasterAudio = b(!m.audio.buses.M.muted);
    out.BusAVolume = vol(m.audio.buses.A.volume);
    out.BusAAudio = b(!m.audio.buses.A.muted);
    out.BusBVolume = vol(m.audio.buses.B.volume);
    out.BusBAudio = b(!m.audio.buses.B.muted);
    out.FadeToBlack = b(m.ftb.on);
    out.Recording = b(o.recording);
    out.Streaming = b(o.streaming);
    out.External = b(o.external);
    out.ReplayRecording = b(m.replay.recording);
    out.ReplayPlaying = b(m.replay.playing);
    return out;
  }
}

export { faderToGain };
