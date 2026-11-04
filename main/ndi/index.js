// NDI® manager for the main process: availability, source discovery, and the
// worker threads behind every NDI input (receiver) and NDI output (sender).
const { Worker } = require('worker_threads');
const path = require('path');
const ndi = require('./ndi-lib');

// worker_threads can't run scripts from inside app.asar
const WORKER = path.join(__dirname, 'ndi-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

class NdiManager {
  constructor(send) {
    this.send = send; // (channel, data) → mixer window
    this.customPath = '';
    this.receivers = new Map();
    this.senders = new Map();
  }

  setLibPath(p) {
    this.customPath = p || '';
    return this.status();
  }

  status() {
    return ndi.status(this.customPath);
  }

  libPath() {
    const st = this.status();
    if (!st.available) throw new Error(st.error);
    return st.path;
  }

  spawn(role, data) {
    return new Worker(WORKER, { workerData: { role, libPath: this.libPath(), ...data } });
  }

  find(timeoutMs = 1500, extraIps = '') {
    return new Promise((resolve, reject) => {
      let w;
      try {
        w = this.spawn('find', { timeoutMs, extraIps });
      } catch (e) {
        reject(e);
        return;
      }
      w.once('message', (m) => (m.type === 'sources' ? resolve(m.sources) : reject(new Error(m.message))));
      w.once('error', reject);
    });
  }

  // ---------------------------------------------------------- receivers
  openReceiver(id, opts) {
    this.closeReceiver(id);
    const w = this.spawn('recv', { source: opts.source, url: opts.url || '', bandwidth: opts.bandwidth || 'highest', name: opts.recvName || 'Unique AV Streaming GuRu' });
    const r = { w, audio: opts.audio !== false };
    this.receivers.set(id, r);
    w.on('message', (m) => {
      if (m.type === 'video') {
        this.send('ndi-frame', { id, width: m.width, height: m.height, opaque: m.opaque, fps: m.fps, data: new Uint8Array(m.data) });
        w.postMessage({ cmd: 'ack' });
      } else if (m.type === 'audio') {
        if (r.audio) this.send('ndi-audio', { id, sampleRate: m.sampleRate, channels: m.channels, samples: m.samples, data: new Float32Array(m.data) });
      } else {
        this.send('ndi-event', { id, ...m });
      }
    });
    w.on('error', (e) => this.send('ndi-event', { id, type: 'fatal', message: e.message }));
    w.on('exit', () => {
      if (this.receivers.get(id) === r) this.receivers.delete(id);
    });
    return { ok: true };
  }

  setReceiverAudio(id, on) {
    const r = this.receivers.get(id);
    if (r) r.audio = on;
  }

  tally(id, program, preview) {
    this.receivers.get(id)?.w.postMessage({ cmd: 'tally', program, preview });
  }

  closeReceiver(id) {
    const r = this.receivers.get(id);
    if (!r) return;
    this.receivers.delete(id);
    r.w.postMessage({ cmd: 'stop' });
    setTimeout(() => r.w.terminate(), 1000);
  }

  // ------------------------------------------------------------ senders
  openSender(id, { name, groups }) {
    this.closeSender(id);
    const w = this.spawn('send', { name, groups: groups || '' });
    this.senders.set(id, w);
    w.on('message', (m) => this.send('ndi-event', { id, sender: true, ...m }));
    w.on('error', (e) => this.send('ndi-event', { id, sender: true, type: 'fatal', message: e.message }));
    w.on('exit', () => {
      if (this.senders.get(id) === w) this.senders.delete(id);
    });
    return { ok: true };
  }

  senderVideo(id, frame) {
    const w = this.senders.get(id);
    if (!w) return;
    const buf = toArrayBuffer(frame.data);
    w.postMessage({ cmd: 'video', width: frame.width, height: frame.height, fps: frame.fps, format: frame.format || 'RGBA', data: buf }, [buf]);
  }

  senderAudio(id, frame) {
    const w = this.senders.get(id);
    if (!w) return;
    const buf = toArrayBuffer(frame.data);
    w.postMessage({ cmd: 'audio', sampleRate: frame.sampleRate, channels: frame.channels, samples: frame.samples, data: buf }, [buf]);
  }

  closeSender(id) {
    const w = this.senders.get(id);
    if (!w) return;
    this.senders.delete(id);
    w.postMessage({ cmd: 'stop' });
    setTimeout(() => w.terminate(), 1000);
  }

  closeAll() {
    for (const id of [...this.receivers.keys()]) this.closeReceiver(id);
    for (const id of [...this.senders.keys()]) this.closeSender(id);
  }
}

function toArrayBuffer(d) {
  if (d instanceof ArrayBuffer) return d;
  const u = d instanceof Uint8Array ? d : new Uint8Array(d.buffer || d);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

module.exports = { NdiManager };
