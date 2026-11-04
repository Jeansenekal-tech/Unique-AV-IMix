// Audio worklets for NDI®:
//   imix-ndi-player – plays received NDI audio (interleaved stereo) into the mixer
//   imix-ndi-tap    – captures a bus as planar Float32 blocks for NDI output
const WORKLET = `
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 2;            // 2 s ring buffer (stereo frames)
    this.buf = new Float32Array(this.size * 2);
    this.w = 0; this.r = 0; this.count = 0;
    this.port.onmessage = (e) => this.push(e.data.samples, e.data.rate);
  }
  push(data, rate) {
    // simple linear resample when the source rate differs from the context
    const step = rate && rate !== sampleRate ? rate / sampleRate : 1;
    const frames = Math.floor(data.length / 2 / step);
    for (let i = 0; i < frames; i++) {
      const pos = i * step, j = Math.floor(pos), f = pos - j;
      const j2 = Math.min(j + 1, data.length / 2 - 1);
      this.buf[this.w * 2] = data[j * 2] * (1 - f) + data[j2 * 2] * f;
      this.buf[this.w * 2 + 1] = data[j * 2 + 1] * (1 - f) + data[j2 * 2 + 1] * f;
      this.w = (this.w + 1) % this.size;
      if (this.count < this.size) this.count++; else this.r = (this.r + 1) % this.size;
    }
    // keep latency low: never more than ~150 ms queued
    const max = Math.floor(sampleRate * 0.15);
    while (this.count > max) { this.r = (this.r + 1) % this.size; this.count--; }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      if (this.count > 0) {
        L[i] = this.buf[this.r * 2]; R[i] = this.buf[this.r * 2 + 1];
        this.r = (this.r + 1) % this.size; this.count--;
      } else { L[i] = 0; R[i] = 0; }
    }
    return true;
  }
}
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = 1024;
    this.L = new Float32Array(this.block); this.R = new Float32Array(this.block); this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const l = inp[0], r = inp[1] || inp[0];
    for (let i = 0; i < l.length; i++) {
      this.L[this.n] = l[i]; this.R[this.n] = r[i]; this.n++;
      if (this.n === this.block) {
        const planar = new Float32Array(this.block * 2);
        planar.set(this.L, 0); planar.set(this.R, this.block);
        this.port.postMessage({ data: planar, samples: this.block, rate: sampleRate }, [planar.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('imix-ndi-player', Player);
registerProcessor('imix-ndi-tap', Tap);
`;

const loaded = new WeakMap();

export function ensureNdiWorklet(ctx) {
  if (!loaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    loaded.set(ctx, ctx.audioWorklet.addModule(url));
  }
  return loaded.get(ctx);
}
