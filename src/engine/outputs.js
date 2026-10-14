// Recording, streaming, external output, multiview output and snapshots.
const imix = () => window.imix;

function pad(n) {
  return String(n).padStart(2, '0');
}

export function expandPattern(pattern) {
  const d = new Date();
  return (pattern || 'Unique AV Streaming GuRu {date} {time}')
    .replace('{date}', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace('{time}', `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`)
    .replace(/[\\/:*?"<>|]/g, '-');
}

export function pickMime(kind) {
  const prefs = kind === 'stream'
    ? ['video/webm;codecs=h264,opus', 'video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : kind === 'webm'
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d0028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return prefs.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

export class Outputs {
  constructor(mixer, canvas) {
    this.mixer = mixer;
    this.canvas = canvas;
    this.recording = null;
    this.streaming = null;
    this.streamStats = null;
    this.log = [];
    this.externalWin = null;
    this.multiviewWin = null;
    this.makeVideoTrack();
    if (imix()?.onStreamEvent) {
      imix().onStreamEvent((ev) => this.onStreamEvent(ev));
    }
  }

  makeVideoTrack() {
    if (this.canvasStream) this.canvasStream.getTracks().forEach((t) => t.stop());
    this.canvasStream = this.canvas.captureStream(this.mixer.settings.fps);
  }

  onFormatChanged() {
    const wasRec = !!this.recording;
    this.makeVideoTrack();
    if (this.externalWin && !this.externalWin.closed) this.attachExternal();
    if (wasRec) this.mixer.emit('toast', 'Format changed – restart recording/streaming to apply.');
  }

  programStream(bus = 'M') {
    const tracks = [...this.canvasStream.getVideoTracks()];
    const audio = this.mixer.audio.stream(bus).getAudioTracks();
    if (audio.length) tracks.push(audio[0]);
    return new MediaStream(tracks);
  }

  addLog(msg) {
    this.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (this.log.length > 200) this.log.shift();
    this.mixer.emit('outputlog');
  }

  status() {
    return {
      recording: !!this.recording,
      recordStarted: this.recording?.started || 0,
      recordFile: this.recording?.file || '',
      streaming: !!this.streaming,
      streamStarted: this.streaming?.started || 0,
      streamStats: this.streamStats,
      external: !!(this.externalWin && !this.externalWin.closed),
      multiview: !!(this.multiviewWin && !this.multiviewWin.closed),
    };
  }

  notify() {
    imix()?.setStatus({ recording: !!this.recording, streaming: !!this.streaming });
    this.mixer.emit('outputs');
  }

  // ------------------------------------------------------------- recording
  async startRecording() {
    if (this.recording) return true;
    const s = this.mixer.settings;
    const mime = pickMime(s.recordFormat === 'webm' ? 'webm' : 'mp4');
    if (!mime) throw new Error('No supported recording format');
    const ext = mime.startsWith('video/mp4') ? 'mp4' : mime.includes('matroska') ? 'mkv' : 'webm';
    // MP4 requested but only WebM/H.264 is available: FFmpeg converts it to MP4
    // when recording stops (video copied losslessly, audio → AAC).
    const convertTo = s.recordFormat !== 'webm' && ext === 'webm' && mime.includes('h264') ? 'mp4' : null;
    const rec = new MediaRecorder(this.programStream(s.recordBus), {
      mimeType: mime,
      videoBitsPerSecond: s.recordBitrate * 1000,
      audioBitsPerSecond: 256000,
    });
    const filename = `${expandPattern(s.filenamePattern)}.${ext}`;
    const state = { rec, mime, ext, convertTo, started: Date.now(), chunks: [], file: filename, id: null, queue: Promise.resolve() };
    if (imix()?.recordStart) {
      const r = await imix().recordStart({ dir: s.recordDir, filename });
      state.id = r.id;
      state.file = r.file;
    }
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      if (state.id) {
        state.queue = state.queue.then(() => e.data.arrayBuffer()).then((buf) => imix().recordChunk(state.id, buf));
      } else state.chunks.push(e.data);
    };
    rec.onerror = (e) => this.addLog(`Recording error: ${e.error?.message || e}`);
    rec.start(1000);
    this.recording = state;
    this.addLog(`Recording started: ${state.file} (${mime})`);
    this.notify();
    return true;
  }

  async stopRecording() {
    const state = this.recording;
    if (!state) return true;
    this.recording = null;
    this.notify();
    await new Promise((resolve) => {
      state.rec.onstop = resolve;
      state.rec.stop();
    });
    await state.queue;
    if (state.id) {
      const file = await imix().recordStop(state.id, { remux: state.convertTo || this.mixer.settings.remux });
      this.lastRecording = file;
      this.addLog(`Recording saved: ${file}`);
      this.mixer.emit('toast', `Recording saved: ${file}`);
    } else {
      const blob = new Blob(state.chunks, { type: state.mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      this.lastRecording = state.file;
      this.addLog(`Recording downloaded: ${state.file}`);
    }
    this.mixer.emit('outputs');
    return true;
  }

  toggleRecording() {
    return this.recording ? this.stopRecording() : this.startRecording();
  }

  // ------------------------------------------------------------- streaming
  async startStreaming(destIndex) {
    if (this.streaming) return true;
    if (!imix()?.streamStart) throw new Error('Streaming requires the desktop app (FFmpeg).');
    const s = this.mixer.settings;
    let dests = this.mixer.streamDestinations.filter((d) => d.enabled && d.url);
    if (destIndex != null && destIndex !== '') {
      const d = this.mixer.streamDestinations[Number(destIndex)];
      dests = d && d.url ? [d] : [];
    }
    if (!dests.length) throw new Error('No stream destination configured. Open Settings → Streaming.');
    const mime = pickMime('stream');
    if (!mime) throw new Error('No streamable encoder available');
    const r = await imix().streamStart({
      destinations: dests.map(({ url, key }) => ({ url, key })),
      videoBitrate: s.streamBitrate,
      audioBitrate: s.audioBitrate,
      fps: s.fps,
      encoder: s.encoder,
    });
    if (!r || r.ok === false) throw new Error(r?.message || 'Could not start FFmpeg');
    // Intermediate stream to FFmpeg is high quality; FFmpeg does the final encode.
    const rec = new MediaRecorder(this.programStream(s.streamBus), {
      mimeType: mime,
      videoBitsPerSecond: Math.max(s.streamBitrate * 2, 8000) * 1000,
      audioBitsPerSecond: 192000,
    });
    const state = { rec, started: Date.now(), dests: dests.map((d) => d.name), queue: Promise.resolve() };
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      state.queue = state.queue.then(() => e.data.arrayBuffer()).then((buf) => imix().streamChunk(buf));
    };
    rec.start(100);
    this.streaming = state;
    this.streamStats = null;
    this.addLog(`Streaming started to ${state.dests.join(', ')} (encoder: ${r.encoder})`);
    this.notify();
    return true;
  }

  async stopStreaming() {
    const state = this.streaming;
    if (!state) return true;
    this.streaming = null;
    try {
      state.rec.stop();
    } catch {
      /* ignore */
    }
    await state.queue;
    await imix()?.streamStop();
    this.addLog('Streaming stopped');
    this.notify();
    return true;
  }

  toggleStreaming(i) {
    return this.streaming ? this.stopStreaming() : this.startStreaming(i);
  }

  onStreamEvent(ev) {
    if (ev.type === 'stats') {
      this.streamStats = ev;
      this.mixer.emit('outputs');
    } else if (ev.type === 'log') {
      this.addLog(ev.message);
    } else if (ev.type === 'error') {
      this.addLog(`Stream error: ${ev.message}`);
      this.mixer.emit('toast', `Stream error: ${ev.message}`);
    } else if (ev.type === 'stopped') {
      if (this.streaming) {
        this.addLog(`FFmpeg exited (code ${ev.code}) – stream stopped`);
        this.mixer.emit('toast', 'Stream stopped unexpectedly – see Output log');
        try {
          this.streaming.rec.stop();
        } catch {
          /* ignore */
        }
        this.streaming = null;
        this.notify();
      }
    }
  }

  // ------------------------------------------------------- external output
  async openExternal(displayId) {
    if (imix()?.setOutputTarget) await imix().setOutputTarget({ displayId, fullscreen: true });
    if (this.externalWin && !this.externalWin.closed) this.externalWin.close();
    const w = window.open('output.html', 'imix-output', 'width=960,height=540');
    if (!w) throw new Error('Could not open output window');
    this.externalWin = w;
    const attach = () => this.attachExternal();
    w.addEventListener('load', attach);
    setTimeout(attach, 500);
    const timer = setInterval(() => {
      if (w.closed) {
        clearInterval(timer);
        this.mixer.emit('outputs');
      }
    }, 1000);
    this.mixer.emit('outputs');
    return true;
  }

  attachExternal() {
    const w = this.externalWin;
    if (!w || w.closed) return;
    const v = w.document.getElementById('out');
    if (!v) return;
    v.srcObject = new MediaStream(this.canvasStream.getVideoTracks());
    v.play().catch(() => {});
  }

  closeExternal() {
    if (this.externalWin && !this.externalWin.closed) this.externalWin.close();
    this.externalWin = null;
    this.mixer.emit('outputs');
  }

  async openMultiview(displayId) {
    if (imix()?.setOutputTarget) await imix().setOutputTarget({ displayId, fullscreen: true });
    if (this.multiviewWin && !this.multiviewWin.closed) this.multiviewWin.close();
    const w = window.open('multiview.html', 'imix-multiview', 'width=1280,height=720');
    if (!w) throw new Error('Could not open multiview window');
    w.imixMixer = this.mixer;
    w.addEventListener('load', () => {
      w.imixMixer = this.mixer;
    });
    this.multiviewWin = w;
    this.mixer.emit('outputs');
    return true;
  }

  // -------------------------------------------------------------- snapshot
  snapshotDataUrl(input, type = 'image/png', quality = 0.92) {
    if (input) {
      const c = input.thumbCtx?.canvas;
      return c ? c.toDataURL(type, quality) : null;
    }
    return this.canvas.toDataURL(type, quality);
  }

  async snapshot() {
    const dataUrl = this.snapshotDataUrl(null);
    const name = `${expandPattern('Snapshot {date} {time}')}.png`;
    if (imix()?.writeBinary) {
      const info = await imix().info();
      const dir = this.mixer.settings.recordDir || info.moviesDir;
      const bin = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
      const file = await imix().writeBinary(`${dir}/${name}`, bin);
      this.mixer.emit('toast', `Snapshot saved: ${file}`);
      return file;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = name;
    a.click();
    return name;
  }
}
