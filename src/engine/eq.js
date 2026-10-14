// 6-band parametric equaliser used on every input channel and every bus:
//   HPF (low cut) · low shelf · 3 × bell · high shelf
// Disabled bands become flat peaking filters (unity gain, no phase change).

export const EQ_BAND_TYPES = ['highpass', 'lowshelf', 'peaking', 'highshelf', 'lowpass', 'notch'];

export function defaultEq() {
  return {
    on: false,
    bands: [
      { type: 'highpass', freq: 80, gain: 0, q: 0.707, on: false },
      { type: 'lowshelf', freq: 120, gain: 0, q: 0.7, on: true },
      { type: 'peaking', freq: 400, gain: 0, q: 1.0, on: true },
      { type: 'peaking', freq: 1500, gain: 0, q: 1.0, on: true },
      { type: 'peaking', freq: 4500, gain: 0, q: 1.0, on: true },
      { type: 'highshelf', freq: 10000, gain: 0, q: 0.7, on: true },
    ],
  };
}

// Accept older saved projects ({ on, low, mid, high }) and partial data.
export function normalizeEq(eq) {
  const d = defaultEq();
  if (!eq || typeof eq !== 'object') return d;
  if (Array.isArray(eq.bands) && eq.bands.length) {
    // Keep the same object (the EQ window edits it live); just fill gaps.
    eq.on = !!eq.on;
    d.bands.forEach((b, i) => {
      eq.bands[i] = { ...b, ...(eq.bands[i] || {}) };
    });
    eq.bands.length = d.bands.length;
    return eq;
  }
  d.on = !!eq.on;
  if (eq.low) d.bands[1].gain = eq.low;
  if (eq.mid) d.bands[3].gain = eq.mid;
  if (eq.high) d.bands[5].gain = eq.high;
  return d;
}

export const EQ_PRESETS = {
  Flat: () => defaultEq().bands,
  'Voice / Presenter': () => bands([
    ['highpass', 90, 0, 0.707, true], ['lowshelf', 180, -2, 0.7, true], ['peaking', 350, -2.5, 1.2, true],
    ['peaking', 3000, 3, 0.9, true], ['peaking', 6500, -1.5, 2.5, true], ['highshelf', 11000, 2, 0.7, true],
  ]),
  'Podcast / Broadcast': () => bands([
    ['highpass', 80, 0, 0.707, true], ['lowshelf', 120, 2, 0.7, true], ['peaking', 300, -3, 1.0, true],
    ['peaking', 2500, 2.5, 1.0, true], ['peaking', 7000, -2, 3.0, true], ['highshelf', 12000, 1.5, 0.7, true],
  ]),
  'Music Bed (under voice)': () => bands([
    ['highpass', 40, 0, 0.707, true], ['lowshelf', 100, 0, 0.7, true], ['peaking', 500, 0, 1.0, true],
    ['peaking', 2500, -5, 0.8, true], ['peaking', 5000, -2, 1.0, true], ['highshelf', 12000, 0, 0.7, true],
  ]),
  'Low Cut (rumble)': () => bands([
    ['highpass', 120, 0, 0.707, true], ['lowshelf', 120, 0, 0.7, true], ['peaking', 400, 0, 1.0, true],
    ['peaking', 1500, 0, 1.0, true], ['peaking', 4500, 0, 1.0, true], ['highshelf', 10000, 0, 0.7, true],
  ]),
  'Bass Boost': () => bands([
    ['highpass', 30, 0, 0.707, false], ['lowshelf', 100, 5, 0.7, true], ['peaking', 250, 1, 1.0, true],
    ['peaking', 1500, 0, 1.0, true], ['peaking', 4500, 0, 1.0, true], ['highshelf', 10000, 0, 0.7, true],
  ]),
  'Telephone': () => bands([
    ['highpass', 400, 0, 0.9, true], ['lowshelf', 120, 0, 0.7, false], ['peaking', 1000, 4, 1.2, true],
    ['peaking', 1500, 0, 1.0, false], ['peaking', 4500, 0, 1.0, false], ['lowpass', 3400, 0, 0.9, true],
  ]),
};

function bands(list) {
  return list.map(([type, freq, gain, q, on]) => ({ type, freq, gain, q, on }));
}

export class Equalizer {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.filters = defaultEq().bands.map(() => ctx.createBiquadFilter());
    let node = this.input;
    for (const f of this.filters) {
      f.type = 'peaking';
      f.gain.value = 0;
      node.connect(f);
      node = f;
    }
    this.output = node;
  }

  apply(eq) {
    const t = this.ctx.currentTime;
    eq.bands.forEach((b, i) => {
      const f = this.filters[i];
      if (!f) return;
      const active = eq.on && b.on;
      const type = active ? b.type : 'peaking';
      if (f.type !== type) f.type = type;
      f.frequency.setTargetAtTime(Math.max(10, Math.min(22000, b.freq)), t, 0.01);
      f.Q.setTargetAtTime(Math.max(0.1, Math.min(18, b.q)), t, 0.01);
      f.gain.setTargetAtTime(active ? Math.max(-24, Math.min(24, b.gain)) : 0, t, 0.01);
    });
  }

  // Combined magnitude response (dB) at the given frequencies.
  response(freqs) {
    const f32 = Float32Array.from(freqs);
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    const total = new Float32Array(freqs.length).fill(0);
    for (const f of this.filters) {
      f.getFrequencyResponse(f32, mag, phase);
      for (let i = 0; i < freqs.length; i++) total[i] += 20 * Math.log10(Math.max(mag[i], 1e-6));
    }
    return total;
  }
}
