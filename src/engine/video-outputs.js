// Unlimited video/audio outputs.
//
// Each output = a SOURCE and a TARGET:
//   source: program | clean (no overlays) | preview | multiview | input:<id>
//   target: display (full screen on any screen – HDMI/DisplayPort/USB-C/
//           Thunderbolt, AirPlay, and capture/playout cards that appear as a
//           display), window, decklink (Blackmagic via FFmpeg),
//           stream (SRT / RTMP / UDP via FFmpeg), audio (a bus to any audio
//           device – interfaces, HDMI/SDI embedders, AirPlay speakers)
// Display/window outputs can also carry a bus to a chosen audio device.
import { newId } from './inputs.js';

const imix = () => window.imix;

export const OUTPUT_TARGETS = [
  ['display', 'Display (full screen)'],
  ['window', 'Window'],
  ['decklink', 'Blackmagic DeckLink / UltraStudio (FFmpeg)'],
  ['stream', 'Network stream – SRT / RTMP / UDP (FFmpeg)'],
  ['audio', 'Audio device only'],
];

export function defaultOutput(n) {
  return {
    id: newId(),
    name: `Output ${n}`,
    source: 'program',
    target: 'display',
    displayId: '',
    device: '',
    url: '',
    bitrate: 8000,
    audioBus: '',
    audioDevice: '',
    autoStart: false,
  };
}

export class VideoOutputs {
  constructor(app) {
    this.app = app;
    this.runtime = new Map(); // id → { win, stream, rec, audioEl, extraKey, timer }
    if (imix()?.onOutputEvent) {
      imix().onOutputEvent((ev) => {
        const o = this.find(ev.id);
        if (ev.type === 'log') app.outputs.addLog(`${o?.name || 'Output'}: ${ev.message}`);
        if (ev.type === 'error') app.mixer.emit('toast', `${o?.name || 'Output'}: ${ev.message}`);
        if (ev.type === 'stopped' && this.runtime.has(ev.id)) {
          app.outputs.addLog(`${o?.name || 'Output'}: FFmpeg exited (${ev.code})`);
          this.close(ev.id);
        }
      });
    }
  }

  get mixer() {
    return this.app.mixer;
  }

  get list() {
    if (!this.mixer.videoOutputs) this.mixer.videoOutputs = [defaultOutput(1)];
    return this.mixer.videoOutputs;
  }

  find(id) {
    return this.list.find((o) => o.id === id || o.name === id) || this.list[Number(id) - 1];
  }

  isOpen(id) {
    return this.runtime.has(this.find(id)?.id);
  }

  add(patch = {}) {
    const o = { ...defaultOutput(this.list.length + 1), ...patch };
    this.list.push(o);
    this.changed();
    return o;
  }

  remove(id) {
    const o = this.find(id);
    if (!o) return;
    this.close(o.id);
    this.mixer.videoOutputs = this.list.filter((x) => x !== o);
    this.changed();
  }

  changed() {
    this.mixer.emit('outputs');
    this.mixer.emit('project-changed');
  }

  // ------------------------------------------------------------ sources
  sourceVideoTrack(o, rt) {
    const comp = this.mixer.compositor;
    const fps = this.mixer.settings.fps;
    if (o.source === 'program') return this.app.outputs.canvasStream.getVideoTracks()[0];
    const key = o.source;
    rt.extraKey = key;
    if (key.startsWith('input:')) this.mixer.extraRenders.add(key.slice(6));
    const canvas = comp.acquireExtra(key);
    rt.extraCanvas = canvas;
    return canvas.captureStream(fps).getVideoTracks()[0];
  }

  releaseSource(rt) {
    if (!rt.extraKey) return;
    this.mixer.compositor.releaseExtra(rt.extraKey);
    if (rt.extraKey.startsWith('input:')) {
      const id = rt.extraKey.slice(6);
      const stillUsed = [...this.runtime.values()].some((r) => r !== rt && r.extraKey === rt.extraKey);
      if (!stillUsed) this.mixer.extraRenders.delete(id);
    }
  }

  async attachAudio(el, o) {
    if (!o.audioBus) return;
    el.srcObject = this.mixer.audio.stream(o.audioBus);
    if (o.audioDevice && el.setSinkId) {
      try {
        await el.setSinkId(o.audioDevice);
      } catch (e) {
        this.mixer.emit('toast', `${o.name}: audio device unavailable (${e.message})`);
      }
    }
    el.play().catch(() => {});
  }

  // --------------------------------------------------------- open / close
  async open(id) {
    const o = this.find(id);
    if (!o) throw new Error(`No output ${id}`);
    if (this.runtime.has(o.id)) return true;
    const rt = {};
    this.runtime.set(o.id, rt);
    try {
      if (o.target === 'audio') {
        if (!o.audioBus) throw new Error('Choose an audio bus for this output');
        rt.audioEl = new Audio();
        await this.attachAudio(rt.audioEl, o);
      } else if (o.target === 'display' || o.target === 'window') {
        await this.openWindow(o, rt);
      } else if (o.target === 'decklink' || o.target === 'stream') {
        await this.openEncoder(o, rt);
      }
    } catch (e) {
      this.close(o.id);
      throw e;
    }
    this.mixer.emit('outputs');
    return true;
  }

  async openWindow(o, rt) {
    if (imix()?.setOutputTarget) {
      await imix().setOutputTarget({ displayId: o.target === 'display' ? (o.displayId || null) : null, fullscreen: o.target === 'display', title: o.name });
    }
    const multiview = o.source === 'multiview';
    const w = window.open(multiview ? 'multiview.html' : 'output.html', `imix-out-${o.id}`, 'width=960,height=540');
    if (!w) throw new Error('Could not open the output window');
    rt.win = w;
    if (multiview) {
      w.imixMixer = this.mixer;
      w.addEventListener('load', () => { w.imixMixer = this.mixer; });
    } else {
      const track = this.sourceVideoTrack(o, rt);
      const attach = () => {
        const v = w.document.getElementById('out');
        if (!v || v.srcObject) return;
        v.srcObject = new MediaStream([track]);
        v.play().catch(() => {});
        if (o.audioBus) {
          const a = w.document.createElement('audio');
          w.document.body.append(a);
          this.attachAudio(a, o);
        }
      };
      w.addEventListener('load', attach);
      setTimeout(attach, 600);
    }
    rt.timer = setInterval(() => {
      if (w.closed) this.close(o.id);
    }, 1000);
  }

  async openEncoder(o, rt) {
    if (!imix()?.outputStart) throw new Error('Device outputs need the desktop app (FFmpeg)');
    if (o.source === 'multiview') throw new Error('Multiview can only go to a display or window');
    const s = this.mixer.settings;
    const tracks = [this.sourceVideoTrack(o, rt)];
    const audio = this.mixer.audio.stream(o.audioBus || 'M').getAudioTracks()[0];
    if (audio) tracks.push(audio);
    const r = await imix().outputStart(o.id, {
      kind: o.target === 'decklink' ? 'decklink' : 'url',
      device: o.device,
      url: o.url,
      width: s.width,
      height: s.height,
      fps: s.fps,
      videoBitrate: o.bitrate || 8000,
      audioBitrate: 192,
      encoder: s.encoder,
    });
    if (!r || r.ok === false) throw new Error(r?.message || 'Could not start FFmpeg');
    const mime = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: Math.max(12000, (o.bitrate || 8000) * 2) * 1000 });
    let queue = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      queue = queue.then(() => e.data.arrayBuffer()).then((buf) => imix().outputChunk(o.id, buf));
    };
    rec.start(o.target === 'decklink' ? 40 : 100);
    rt.rec = rec;
    this.app.outputs.addLog(`${o.name}: started (${o.target === 'decklink' ? `DeckLink ${o.device}` : o.url})`);
  }

  close(id) {
    const o = this.find(id);
    const key = o ? o.id : id;
    const rt = this.runtime.get(key);
    if (!rt) return;
    this.runtime.delete(key);
    clearInterval(rt.timer);
    if (rt.win && !rt.win.closed) rt.win.close();
    if (rt.audioEl) {
      rt.audioEl.pause();
      rt.audioEl.srcObject = null;
    }
    if (rt.rec) {
      try {
        rt.rec.stop();
      } catch {
        /* ignore */
      }
      imix()?.outputStop(key);
    }
    this.releaseSource(rt);
    this.mixer.emit('outputs');
  }

  toggle(id) {
    return this.isOpen(id) ? this.close(id) : this.open(id);
  }

  closeAll() {
    for (const id of [...this.runtime.keys()]) this.close(id);
  }

  async openAutoStart() {
    for (const o of this.list) {
      if (o.autoStart) await this.open(o.id).catch((e) => this.mixer.emit('toast', `${o.name}: ${e.message}`));
    }
  }

  setSource(id, source) {
    const o = this.find(id);
    if (!o) throw new Error(`No output ${id}`);
    o.source = source;
    if (this.isOpen(o.id)) {
      this.close(o.id);
      return this.open(o.id);
    }
    this.changed();
    return true;
  }
}
