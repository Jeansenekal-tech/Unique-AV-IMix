// Audio mixer built on Web Audio.
//
//  source → delay → trim → gate → EQ (6-band) → compressor → pan → fader → onAir(AFV/mute)
//         → meter
//         → sends → Master / Bus A–F
//  Bus    → EQ → fader → mute → meter → [record/stream destination] (+ monitor)
import { Equalizer, normalizeEq } from './eq.js';

export const AUX_BUSES = ['A', 'B', 'C', 'D', 'E', 'F'];
export const BUSES = ['M', ...AUX_BUSES];
export const busLabel = (b) => (b === 'M' ? 'Master' : `Bus ${b}`);

export function faderToGain(v) {
  // 0..100 fader, cubic taper: 100 = unity (0 dB), 70 ≈ -9 dB, 50 ≈ -18 dB
  const x = Math.max(0, Math.min(100, v)) / 100;
  return x * x * x;
}

export function gainToDb(g) {
  return g <= 0.00001 ? -Infinity : 20 * Math.log10(g);
}

class Meter {
  constructor(ctx, node) {
    this.split = ctx.createChannelSplitter(2);
    node.connect(this.split);
    this.l = ctx.createAnalyser();
    this.r = ctx.createAnalyser();
    this.l.fftSize = 512;
    this.r.fftSize = 512;
    this.split.connect(this.l, 0);
    this.split.connect(this.r, 1);
    this.buf = new Float32Array(512);
    this.peakHold = [0, 0];
  }

  read() {
    const peak = (a) => {
      a.getFloatTimeDomainData(this.buf);
      let m = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const v = Math.abs(this.buf[i]);
        if (v > m) m = v;
      }
      return m;
    };
    return [peak(this.l), peak(this.r)];
  }
}

class Bus {
  constructor(engine, name) {
    const { ctx } = engine;
    this.name = name;
    this.input = ctx.createGain();
    this.eqNode = new Equalizer(ctx);
    this.eq = normalizeEq(null);
    this.fader = ctx.createGain();
    this.mute = ctx.createGain();
    this.input.connect(this.eqNode.input);
    this.eqNode.output.connect(this.fader).connect(this.mute);
    this.meter = new Meter(ctx, this.mute);
    this.dest = ctx.createMediaStreamDestination();
    this.mute.connect(this.dest);
    this.volume = 100;
    this.muted = false;
  }

  set(volume, muted) {
    this.volume = volume ?? this.volume;
    this.muted = muted ?? this.muted;
    const t = this.fader.context.currentTime;
    this.fader.gain.setTargetAtTime(faderToGain(this.volume), t, 0.02);
    this.mute.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.01);
  }

  applyEq() {
    this.eqNode.apply(this.eq);
  }

  serialize() {
    return { volume: this.volume, muted: this.muted, eq: this.eq };
  }

  restore(data) {
    if (!data) return;
    this.eq = normalizeEq(data.eq);
    this.applyEq();
    this.set(data.volume ?? 100, !!data.muted);
  }
}

class Channel {
  constructor(engine, input) {
    const { ctx } = engine;
    this.engine = engine;
    this.input = input;
    this.delay = ctx.createDelay(2);
    this.trim = ctx.createGain();
    this.gate = ctx.createGain();
    this.gateAnalyser = ctx.createAnalyser();
    this.gateAnalyser.fftSize = 256;
    this.gateBuf = new Float32Array(256);
    this.eqNode = new Equalizer(ctx);
    this.comp = ctx.createDynamicsCompressor();
    this.compBypass = ctx.createGain();
    this.compIn = ctx.createGain();
    this.compOut = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.fader = ctx.createGain();
    this.onAir = ctx.createGain();
    this.sends = {};

    this.delay.connect(this.trim).connect(this.gate);
    this.trim.connect(this.gateAnalyser);
    this.gate.connect(this.eqNode.input);
    this.eqNode.output.connect(this.compIn);
    this.compIn.connect(this.comp).connect(this.compOut);
    this.compIn.connect(this.compBypass).connect(this.compOut);
    this.compOut.connect(this.pan).connect(this.fader).connect(this.onAir);
    this.meter = new Meter(ctx, this.onAir);
    for (const b of BUSES) {
      const g = ctx.createGain();
      g.gain.value = 0;
      this.onAir.connect(g);
      g.connect(engine.buses[b].input);
      this.sends[b] = g;
    }
    this.source = null;
    this.sourceKey = null;
    this.audible = false;
    this.apply();
  }

  connectSource() {
    const { ctx } = this.engine;
    const inp = this.input;
    let key = null;
    let node = null;
    try {
      if (inp.audioElement) {
        key = inp.audioElement;
        if (key !== this.sourceKey) {
          if (!key._imixSource) key._imixSource = ctx.createMediaElementSource(key);
          node = key._imixSource;
        }
      } else if (inp.audioStream) {
        key = inp.stream;
        if (key !== this.sourceKey) node = ctx.createMediaStreamSource(inp.audioStream);
      }
    } catch (e) {
      console.warn('audio source', e);
      return;
    }
    if (node) {
      if (this.source) this.source.disconnect();
      // mono sources (e.g. a single mic channel) are split to both sides
      if (inp.channels === 'left' || inp.channels === 'right') {
        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        node.connect(split);
        const ch = inp.channels === 'left' ? 0 : 1;
        split.connect(merge, ch, 0);
        split.connect(merge, ch, 1);
        merge.connect(this.delay);
        this.source = merge;
      } else {
        node.connect(this.delay);
        this.source = node;
      }
      this.sourceKey = key;
    }
  }

  apply() {
    const a = this.input.settings.audio;
    const t = this.engine.ctx.currentTime;
    this.delay.delayTime.setTargetAtTime(Math.min(2, Math.max(0, a.delay / 1000)), t, 0.01);
    this.trim.gain.setTargetAtTime(Math.pow(10, (a.gain || 0) / 20), t, 0.01);
    if (!Array.isArray(a.eq?.bands)) a.eq = normalizeEq(a.eq);
    this.eqNode.apply(a.eq);
    this.comp.threshold.value = a.comp.threshold;
    this.comp.ratio.value = a.comp.ratio;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.15;
    this.compBypass.gain.value = a.comp.on ? 0 : 1;
    this.comp.connect(this.compOut);
    if (!a.comp.on) {
      try {
        this.comp.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, a.balance)), t, 0.01);
    this.fader.gain.setTargetAtTime(faderToGain(a.volume), t, 0.02);
    for (const b of BUSES) this.sends[b].gain.setTargetAtTime(a.buses?.[b] ? 1 : 0, t, 0.01);
  }

  setAudible(on) {
    if (on === this.audible) return;
    this.audible = on;
    this.onAir.gain.setTargetAtTime(on ? 1 : 0, this.engine.ctx.currentTime, 0.03);
  }

  updateGate() {
    const g = this.input.settings.audio.gate;
    if (!g.on) {
      if (this.gate.gain.value !== 1) this.gate.gain.value = 1;
      return;
    }
    // envelope follower on the (pre-gate) channel signal
    this.gateAnalyser.getFloatTimeDomainData(this.gateBuf);
    let rms = 0;
    for (let i = 0; i < this.gateBuf.length; i++) rms += this.gateBuf[i] * this.gateBuf[i];
    rms = Math.sqrt(rms / this.gateBuf.length);
    const open = gainToDb(rms) > g.threshold;
    this.gate.gain.setTargetAtTime(open ? 1 : 0, this.engine.ctx.currentTime, open ? 0.005 : 0.08);
  }

  dispose() {
    try {
      this.source?.disconnect();
      this.onAir.disconnect();
      for (const s of Object.values(this.sends)) s.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive', sampleRate: 48000 });
    this.buses = {};
    for (const b of BUSES) this.buses[b] = new Bus(this, b);
    this.monitor = this.ctx.createGain();
    this.monitorBus = 'M';
    this.buses.M.mute.connect(this.monitor);
    this.monitor.connect(this.ctx.destination);
    this.monitorOn = true;
    this.channels = new Map();
    this.solo = null;
    // keep the graph alive even with no sources
    const silent = this.ctx.createConstantSource();
    silent.offset.value = 0;
    silent.connect(this.buses.M.input);
    silent.start();
  }

  resume() {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  setMonitor(on, bus = this.monitorBus) {
    this.monitorOn = on;
    if (!this.buses[bus]) bus = 'M';
    if (bus !== this.monitorBus) {
      try {
        this.buses[this.monitorBus].mute.disconnect(this.monitor);
      } catch {
        /* ignore */
      }
      this.buses[bus].mute.connect(this.monitor);
      this.monitorBus = bus;
    }
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  setSolo(inputId) {
    this.solo = this.solo === inputId ? null : inputId;
  }

  addInput(input) {
    if (!input.hasAudio) return null;
    let ch = this.channels.get(input.id);
    if (!ch) {
      ch = new Channel(this, input);
      this.channels.set(input.id, ch);
    }
    ch.connectSource();
    return ch;
  }

  removeInput(id) {
    const ch = this.channels.get(id);
    if (ch) ch.dispose();
    this.channels.delete(id);
  }

  apply(input) {
    const ch = this.channels.get(input.id);
    if (ch) ch.apply();
  }

  // Called every frame by the mixer with an "is on air" predicate.
  update(isOnAir) {
    for (const ch of this.channels.values()) {
      const a = ch.input.settings.audio;
      if (!ch.source) ch.connectSource();
      let audible = !a.muted && (!a.afv || isOnAir(ch.input));
      if (this.solo) audible = audible && ch.input.id === this.solo;
      ch.setAudible(audible);
      ch.updateGate();
    }
  }

  stream(bus = 'M') {
    return (this.buses[bus] || this.buses.M).dest.stream;
  }

  serializeBuses() {
    return Object.fromEntries(BUSES.map((b) => [b, this.buses[b].serialize()]));
  }

  restoreBuses(data) {
    for (const b of BUSES) this.buses[b].restore(data?.[b]);
  }

  meters() {
    const out = {};
    for (const [id, ch] of this.channels) out[id] = ch.meter.read();
    for (const b of BUSES) out[`bus:${b}`] = this.buses[b].meter.read();
    return out;
  }
}
