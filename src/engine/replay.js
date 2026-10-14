// Instant replay: a rolling buffer of frames from the program output (or any
// input), with slow-motion playback, mark in/out events and an input that
// shows the replay picture.

export class Replay {
  constructor(mixer) {
    this.mixer = mixer;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.setQuality(960, 540);
    this.frames = [];
    this.events = [];
    this.seconds = 20;
    this.fps = 30;
    this.source = 'program';
    this.recording = false;
    this.playing = false;
    this.speed = 0.5;
    this.lastSeconds = 8;
    this.version = 0;
    this.lastCapture = 0;
    this.markInAt = null;
    this.pending = 0;
  }

  setQuality(w, h) {
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);
  }

  start() {
    this.recording = true;
    this.mixer.emit('replay');
  }

  stop() {
    this.recording = false;
    this.mixer.emit('replay');
  }

  clear() {
    for (const f of this.frames) if (!f.keep) f.bmp.close();
    this.frames = [];
  }

  sourceElement() {
    if (this.source === 'program') return this.mixer.compositor?.canvas;
    const inp = this.mixer.getInput(this.source);
    const src = inp && inp.videoSource();
    return src && src.kind === 'element' ? src.el : null;
  }

  capture(now) {
    if (!this.recording) return;
    if (now - this.lastCapture < 1000 / this.fps - 2) return;
    if (this.pending > 3) return; // GPU busy, drop a frame
    this.lastCapture = now;
    const el = this.sourceElement();
    if (!el) return;
    this.pending++;
    createImageBitmap(el, { resizeWidth: this.w, resizeHeight: this.h, resizeQuality: 'low' })
      .then((bmp) => {
        this.frames.push({ bmp, t: now, keep: 0 });
        const cutoff = now - this.seconds * 1000;
        while (this.frames.length && this.frames[0].t < cutoff) {
          const f = this.frames.shift();
          if (!f.keep) f.bmp.close();
        }
      })
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
  }

  get bufferedSeconds() {
    if (this.frames.length < 2) return 0;
    return (this.frames[this.frames.length - 1].t - this.frames[0].t) / 1000;
  }

  // ---------------------------------------------------------------- events
  markIn() {
    this.markInAt = performance.now();
    this.mixer.emit('replay');
  }

  markOut(name) {
    const end = performance.now();
    const start = this.markInAt ?? end - this.lastSeconds * 1000;
    const frames = this.frames.filter((f) => f.t >= start && f.t <= end);
    if (!frames.length) return null;
    frames.forEach((f) => f.keep++);
    const ev = { id: Date.now(), name: name || `Event ${this.events.length + 1}`, frames, duration: (end - start) / 1000 };
    this.events.push(ev);
    this.markInAt = null;
    this.mixer.emit('replay');
    return ev;
  }

  deleteEvent(id) {
    const i = this.events.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [ev] = this.events.splice(i, 1);
    this.release(ev.frames);
    this.mixer.emit('replay');
  }

  release(frames) {
    const live = new Set(this.frames);
    for (const f of frames) {
      f.keep--;
      if (!f.keep && !live.has(f)) f.bmp.close();
    }
  }

  // -------------------------------------------------------------- playback
  playFrames(frames) {
    if (!frames.length) return;
    // hold the clip's frames so the rolling buffer can't free them mid-play
    frames.forEach((f) => f.keep++);
    if (this.clip) this.release(this.clip);
    this.clip = frames;
    this.clipStart = frames[0].t;
    this.clipEnd = frames[frames.length - 1].t;
    this.pos = 0;
    this.lastTick = performance.now();
    this.playing = true;
    this.mixer.emit('replay');
  }

  playLast(seconds = this.lastSeconds) {
    const end = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    this.playFrames(this.frames.filter((f) => f.t >= end - seconds * 1000));
  }

  playEvent(id) {
    const ev = this.events.find((e) => e.id === id) || this.events[this.events.length - 1];
    if (ev) this.playFrames(ev.frames);
  }

  pause() {
    this.playing = false;
    this.mixer.emit('replay');
  }

  resume() {
    if (this.clip) {
      this.lastTick = performance.now();
      this.playing = true;
      this.mixer.emit('replay');
    }
  }

  tick(now) {
    if (!this.playing || !this.clip) return;
    const dt = now - this.lastTick;
    this.lastTick = now;
    this.pos += dt * this.speed;
    const t = this.clipStart + this.pos;
    if (t >= this.clipEnd) {
      this.playing = false;
      this.mixer.emit('replay');
    }
    // binary search for the frame at time t
    const c = this.clip;
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const f = c[lo];
    if (f && f !== this.shown) {
      try {
        this.ctx.drawImage(f.bmp, 0, 0, this.w, this.h);
      } catch {
        /* closed */
      }
      this.shown = f;
      this.version++;
    }
  }
}
