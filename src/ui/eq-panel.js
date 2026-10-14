// Parametric EQ window: draggable response curve + per-band controls.
//   drag a handle → frequency / gain     scroll on a handle → Q (width)
//   double-click a handle → reset that band's gain
import { h, panel } from './dom.js';
import { EQ_PRESETS, EQ_BAND_TYPES, defaultEq } from '../engine/eq.js';
import { busLabel } from '../engine/audio.js';

const W = 640;
const H = 240;
const F_MIN = 20;
const F_MAX = 20000;
const DB = 18;
const COLORS = ['#9aa3b2', '#3e8ef7', '#30a46c', '#f5a524', '#d6409f', '#7c5cff'];
const TYPE_LABEL = { highpass: 'Low cut', lowshelf: 'Low shelf', peaking: 'Bell', highshelf: 'High shelf', lowpass: 'High cut', notch: 'Notch' };

const xOf = (f) => (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * W;
const fOf = (x) => F_MIN * Math.pow(F_MAX / F_MIN, Math.max(0, Math.min(W, x)) / W);
const yOf = (db) => H / 2 - (db / DB) * (H / 2 - 12);
const dbOf = (y) => ((H / 2 - y) / (H / 2 - 12)) * DB;
const fmtF = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);
const hasGain = (t) => t === 'peaking' || t === 'lowshelf' || t === 'highshelf';

// target: { title, eq (live object), apply(), node (Equalizer) }
export function openEq(app, target, id) {
  const { eq } = target;
  const canvas = h('canvas', { width: W * 2, height: H * 2, style: { width: `${W}px`, height: `${H}px`, background: '#0b0c0f', borderRadius: '6px', cursor: 'crosshair', display: 'block' } });
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const freqs = Array.from({ length: 256 }, (_, i) => F_MIN * Math.pow(F_MAX / F_MIN, i / 255));

  const onBtn = h('button', { class: `btn small toggle ${eq.on ? 'active' : ''}`, onclick: () => { eq.on = !eq.on; onBtn.classList.toggle('active', eq.on); changed(); } }, 'EQ ON');
  const preset = h('select', {
    onchange: (e) => {
      if (!EQ_PRESETS[e.target.value]) return;
      eq.bands = EQ_PRESETS[e.target.value]();
      eq.on = true;
      onBtn.classList.add('active');
      e.target.value = '';
      buildRows();
      changed();
    },
  }, h('option', { value: '' }, 'Presets…'), Object.keys(EQ_PRESETS).map((k) => h('option', { value: k }, k)));
  const reset = h('button', { class: 'btn small', onclick: () => { eq.bands = defaultEq().bands; buildRows(); changed(); } }, 'Reset');
  const rows = h('div', { class: 'eq-rows' });
  const body = h('div', { class: 'eq-panel' },
    h('div', { class: 'row', style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, onBtn, preset, reset,
      h('span', { class: 'help', style: { marginLeft: 'auto' } }, 'Drag points · scroll = width (Q) · double-click = 0 dB')),
    canvas, rows);

  const p = panel(`eq:${id}`, { title: `EQ – ${target.title}`, body, width: W + 34, onClose: () => cancelAnimationFrame(raf) });
  if (!p) return;

  function changed() {
    target.apply();
    syncRows();
  }

  // ---------------------------------------------------------- band rows
  let rowEls = [];
  function buildRows() {
    rowEls = eq.bands.map((b, i) => {
      const on = h('input', { type: 'checkbox', checked: b.on, onchange: (e) => { b.on = e.target.checked; changed(); } });
      const type = h('select', { onchange: (e) => { b.type = e.target.value; changed(); } }, EQ_BAND_TYPES.map((t) => h('option', { value: t, selected: t === b.type }, TYPE_LABEL[t])));
      const freq = h('input', { type: 'number', min: 20, max: 20000, step: 1, value: Math.round(b.freq), onchange: (e) => { b.freq = Number(e.target.value) || b.freq; changed(); } });
      const gain = h('input', { type: 'number', min: -24, max: 24, step: 0.5, value: b.gain, onchange: (e) => { b.gain = Number(e.target.value) || 0; changed(); } });
      const q = h('input', { type: 'number', min: 0.1, max: 18, step: 0.1, value: b.q, onchange: (e) => { b.q = Number(e.target.value) || b.q; changed(); } });
      const row = h('div', { class: 'eq-row' },
        h('span', { class: 'eq-dot', style: { background: COLORS[i] } }, i + 1), on, type,
        h('label', null, 'Hz ', freq), h('label', null, 'dB ', gain), h('label', null, 'Q ', q));
      return { row, on, type, freq, gain, q };
    });
    rows.replaceChildren(...rowEls.map((r) => r.row));
    syncRows();
  }

  function syncRows() {
    eq.bands.forEach((b, i) => {
      const r = rowEls[i];
      if (!r) return;
      if (document.activeElement !== r.freq) r.freq.value = Math.round(b.freq);
      if (document.activeElement !== r.gain) r.gain.value = Math.round(b.gain * 10) / 10;
      if (document.activeElement !== r.q) r.q.value = Math.round(b.q * 100) / 100;
      r.gain.disabled = !hasGain(b.type);
      r.type.value = b.type;
      r.on.checked = b.on;
      r.row.style.opacity = b.on && eq.on ? 1 : 0.5;
    });
  }

  // ------------------------------------------------------------ drawing
  function handlePos(b) {
    return { x: xOf(b.freq), y: yOf(hasGain(b.type) ? b.gain : 0) };
  }

  let raf = 0;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px Menlo, monospace';
    ctx.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(xOf(f), 0);
      ctx.lineTo(xOf(f), H);
      ctx.stroke();
      ctx.fillStyle = '#6b7484';
      ctx.fillText(fmtF(f), xOf(f) + 3, H - 4);
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(0, yOf(db));
      ctx.lineTo(W, yOf(db));
      ctx.stroke();
      ctx.fillStyle = '#6b7484';
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 4, yOf(db) - 3);
    }
    const resp = target.node.response(freqs);
    ctx.beginPath();
    freqs.forEach((f, i) => {
      const y = yOf(Math.max(-DB - 6, Math.min(DB + 6, resp[i])));
      if (i === 0) ctx.moveTo(xOf(f), y);
      else ctx.lineTo(xOf(f), y);
    });
    ctx.strokeStyle = eq.on ? '#9d86ff' : '#4a4f5a';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.lineTo(W, yOf(0));
    ctx.lineTo(0, yOf(0));
    ctx.closePath();
    ctx.fillStyle = eq.on ? 'rgba(124,92,255,0.15)' : 'rgba(255,255,255,0.03)';
    ctx.fill();
    eq.bands.forEach((b, i) => {
      const { x, y } = handlePos(b);
      ctx.beginPath();
      ctx.arc(x, y, i === dragging ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = b.on && eq.on ? COLORS[i] : '#3a3f4b';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px -apple-system, Helvetica';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x, y + 3);
      ctx.textAlign = 'left';
    });
    raf = requestAnimationFrame(draw);
  }

  // ---------------------------------------------------------- interaction
  let dragging = -1;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const hit = (pt) => {
    let best = -1;
    let bestD = 14;
    eq.bands.forEach((b, i) => {
      const hp = handlePos(b);
      const d = Math.hypot(hp.x - pt.x, hp.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  canvas.addEventListener('mousedown', (e) => {
    dragging = hit(local(e));
    if (dragging >= 0) {
      const b = eq.bands[dragging];
      if (!eq.on) {
        eq.on = true;
        onBtn.classList.add('active');
      }
      b.on = true;
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging < 0 || !document.body.contains(canvas)) return;
    const pt = local(e);
    const b = eq.bands[dragging];
    b.freq = Math.round(fOf(pt.x));
    if (hasGain(b.type)) b.gain = Math.round(Math.max(-DB, Math.min(DB, dbOf(pt.y))) * 2) / 2;
    changed();
  });
  window.addEventListener('mouseup', () => {
    dragging = -1;
  });
  canvas.addEventListener('wheel', (e) => {
    const i = hit(local(e));
    if (i < 0) return;
    e.preventDefault();
    const b = eq.bands[i];
    b.q = Math.max(0.1, Math.min(18, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    changed();
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    const i = hit(local(e));
    if (i < 0) return;
    eq.bands[i].gain = 0;
    changed();
  });

  buildRows();
  draw();
}

export function openInputEq(app, input) {
  const ch = app.mixer.audio.channels.get(input.id);
  if (!ch) return;
  openEq(app, {
    title: `${app.mixer.inputNumber(input)}. ${input.title}`,
    eq: input.settings.audio.eq,
    node: ch.eqNode,
    apply: () => app.mixer.inputChanged(input),
  }, input.id);
}

export function openBusEq(app, bus) {
  const b = app.mixer.audio.buses[bus];
  openEq(app, {
    title: busLabel(bus),
    eq: b.eq,
    node: b.eqNode,
    apply: () => {
      b.applyEq();
      app.mixer.emit('project-changed');
    },
  }, `bus:${bus}`);
}
