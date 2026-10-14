// Transition panel, T-bar, monitor transports, audio mixer and overlay status.
import { h, $, fmtShort } from './dom.js';
import { TRANSITIONS, OVERLAY_EFFECTS } from '../engine/transitions.js';
import { gainToDb, faderToGain } from '../engine/audio.js';

export function initTransitions(app) {
  const { mixer } = app;
  const root = $('#transitions');
  const slotEls = [];

  const cut = h('button', { class: 'btn big cut', title: 'Cut (Enter)', onclick: () => mixer.cut() }, 'CUT');
  const qpSel = h('select', { title: 'Quick Play effect', onchange: (e) => { mixer.quickPlay.type = e.target.value; } },
    TRANSITIONS.filter((t) => t.id !== 'stinger').map((t) => h('option', { value: t.name }, t.name)));

  const slots = h('div', { class: 'tr-buttons' });
  mixer.transitionSlots.forEach((slot, i) => {
    const btn = h('button', { class: 'btn', title: i === 0 ? 'Space' : ['', 'Q', 'W', 'E'][i], onclick: () => mixer.transitionSlot(i) }, slot.type);
    const sel = h('select', {
      onchange: (e) => {
        mixer.transitionSlots[i].type = e.target.value;
        btn.textContent = e.target.value;
      },
    }, TRANSITIONS.map((t) => h('option', { value: t.name, selected: t.name === slot.type }, t.name)));
    const dur = h('input', {
      type: 'number', min: 0, max: 10000, step: 100, value: slot.duration, title: 'Duration (ms)',
      oninput: (e) => { mixer.transitionSlots[i].duration = Number(e.target.value) || 0; },
    });
    slotEls.push({ btn, sel, dur });
    slots.append(h('div', { class: 'tr-slot' }, btn, h('div', { class: 'tr-cfg' }, sel, dur)));
  });

  const tbar = h('input', { type: 'range', id: 'tbar', min: 0, max: 1000, value: 0, oninput: (e) => mixer.setTbar(e.target.value / 1000) });
  const ftb = h('button', { class: 'btn ftb', title: 'Fade to black (B)', onclick: () => mixer.toggleFtb() }, 'FTB');
  const st1 = h('button', { class: 'btn small', title: 'Stinger 1 (configure in Settings → Stingers)', onclick: () => mixer.transition('Stinger 1') }, 'Stinger 1');
  const st2 = h('button', { class: 'btn small', title: 'Stinger 2', onclick: () => mixer.transition('Stinger 2') }, 'Stinger 2');

  root.append(
    cut,
    h('div', { class: 'tr-main' }, slots, h('div', { class: 'tbar-wrap' }, h('label', null, 'T-BAR'), tbar)),
    h('div', { class: 'tr-row' }, st1, st2),
    h('div', { class: 'tr-row' }, h('span', { class: 'help', style: { alignSelf: 'center' } }, 'Quick Play'), qpSel),
    ftb,
  );

  const refresh = () => {
    mixer.transitionSlots.forEach((slot, i) => {
      const e = slotEls[i];
      e.btn.textContent = slot.type;
      e.sel.value = slot.type;
      if (document.activeElement !== e.dur) e.dur.value = slot.duration;
    });
    qpSel.value = mixer.quickPlay.type;
    ftb.classList.toggle('active', mixer.ftb.on);
  };
  mixer.on('transitions', refresh);
  mixer.on('project', refresh);
  mixer.on('state', () => {
    ftb.classList.toggle('active', mixer.ftb.on);
    const active = !!mixer.trans;
    cut.classList.toggle('transitioning', active && false);
    slotEls.forEach((e) => e.btn.classList.toggle('transitioning', active && !mixer.trans?.manual && mixer.trans?.def?.name === e.btn.textContent));
  });
  mixer.on('tbar', () => {
    if (document.activeElement !== tbar) tbar.value = Math.round(mixer.tbar.value * 1000);
  });
  mixer.on('frame', () => {
    if (mixer.trans && !mixer.trans.manual && document.activeElement !== tbar) {
      const p = mixer.transProgress(performance.now());
      const v = mixer.tbar.base === 1 ? 1 - p : p;
      tbar.value = Math.round(v * 1000);
    }
  });
  tbar.addEventListener('change', () => tbar.blur());
  refresh();
}

// -------------------------------------------------------- monitor transports
export function initMonitors(app) {
  const { mixer } = app;
  const pvName = $('#pvName');
  const pgName = $('#pgName');

  function transport(el, getInput) {
    const play = h('button', { class: 'btn small', onclick: () => { const i = getInput(); if (i) app.api.call('PlayPause', { Input: i.id }); } }, '⏯');
    const restart = h('button', { class: 'btn small', onclick: () => getInput()?.restart() }, '⏮');
    const seek = h('input', {
      type: 'range', class: 'seek', min: 0, max: 1000, value: 0,
      oninput: (e) => { const i = getInput(); if (i && i.duration) i.seek((e.target.value / 1000) * i.duration); },
    });
    const next = h('button', { class: 'btn small', title: 'Next item', onclick: () => getInput()?.next?.() }, '⏭');
    const time = h('span', { class: 'time' });
    const info = h('span', { class: 'help' });
    el.append(restart, play, next, seek, time, info);
    return () => {
      const i = getInput();
      const playable = i && ['video', 'list', 'audiofile', 'url'].includes(i.type);
      [play, restart, seek].forEach((x) => { x.style.visibility = playable ? 'visible' : 'hidden'; });
      next.style.display = i && i.type === 'list' ? '' : 'none';
      if (playable) {
        if (document.activeElement !== seek) seek.value = i.duration ? (i.position / i.duration) * 1000 : 0;
        time.textContent = `${fmtShort(i.position)} / ${fmtShort(i.duration)}`;
        play.textContent = i.state === 'Running' ? '⏸' : '▶';
        info.textContent = '';
      } else {
        time.textContent = '';
        info.textContent = i ? describe(i) : '';
      }
    };
  }

  function describe(i) {
    if (i.type === 'camera' || i.type === 'screen') {
      const v = i.el;
      return v && v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '';
    }
    if (i.type === 'title') return `Template: ${i.template}`;
    if (i.type === 'replay') return `Replay ${app.mixer.replay.playing ? `▶ ${app.mixer.replay.speed}x` : 'paused'}`;
    return '';
  }

  const upPv = transport($('#pvTransport'), () => mixer.getInput(mixer.previewId));
  const upPg = transport($('#pgTransport'), () => mixer.getInput(mixer.programId));
  const names = () => {
    const pv = mixer.getInput(mixer.previewId);
    const pg = mixer.getInput(mixer.programId);
    pvName.textContent = pv ? `${mixer.inputNumber(pv)}. ${pv.title}` : '—';
    const ovs = mixer.overlays.map((o, n) => (o.state !== 'off' && mixer.getInput(o.inputId) ? `OV${n + 1}: ${mixer.getInput(o.inputId).title}` : null)).filter(Boolean);
    pgName.textContent = (pg ? `${mixer.inputNumber(pg)}. ${pg.title}` : '—') + (ovs.length ? `  +  ${ovs.join(', ')}` : '');
  };
  mixer.on('state', names);
  mixer.on('inputs', names);
  setInterval(() => {
    upPv();
    upPg();
  }, 200);
  names();
}

// ------------------------------------------------------------- overlay status
export function initOverlayStatus(app) {
  const { mixer } = app;
  const root = $('#overlayStatus');
  const btns = mixer.overlays.map((ov, i) => {
    const b = h('button', { class: 'btn ov-btn ov-status', title: `Overlay ${i + 1} – click: toggle with preview input, right-click: effect`, onclick: () => app.api.call(`PreviewOverlayInput${i + 1}`, {}) }, `OV${i + 1}`);
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sel = h('select', {
        onchange: (ev) => { ov.effect = ev.target.value; mixer.emit('state'); menu.remove(); },
      }, OVERLAY_EFFECTS.map((x) => h('option', { value: x, selected: x === ov.effect }, x)));
      const dur = h('input', { type: 'number', value: ov.duration, step: 100, min: 0, style: { width: '70px' }, oninput: (ev) => { ov.duration = Number(ev.target.value) || 0; } });
      const menu = h('div', { class: 'menu', style: { left: `${e.clientX}px`, top: `${e.clientY - 90}px`, padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('b', null, `Overlay ${i + 1}`), sel, h('label', { class: 'help' }, 'Duration ms ', dur),
        h('button', { class: 'btn small', onclick: () => { mixer.overlay(i, null, 'off'); menu.remove(); } }, 'Clear'),
        h('button', { class: 'btn small', onclick: () => menu.remove() }, 'Close'));
      document.body.append(menu);
    });
    root.append(b);
    return b;
  });
  const update = () => btns.forEach((b, i) => {
    const ov = mixer.overlays[i];
    b.classList.toggle(`on${i + 1}`, ov.state !== 'off' && !!ov.inputId);
    const inp = mixer.getInput(ov.inputId);
    b.title = `Overlay ${i + 1}${inp ? ` (${inp.title})` : ''} – ${ov.effect} ${ov.duration}ms. Click: toggle with preview input. Right-click: options`;
  });
  mixer.on('state', update);
  update();
}

// ---------------------------------------------------------------- audio mixer
export function initAudioMixer(app) {
  const { mixer } = app;
  const root = $('#mixerStrips');
  const strips = new Map();

  function meterCanvas() {
    return h('canvas', { width: 14, height: 160 });
  }

  function makeStrip({ id, name, master, getVol, setVol, getMute, toggleMute, extra }) {
    const meter = meterCanvas();
    const fader = h('input', { type: 'range', min: 0, max: 100, step: 0.5, value: getVol(), oninput: (e) => setVol(Number(e.target.value)) });
    fader.addEventListener('dblclick', () => setVol(100));
    const db = h('div', { class: 'strip-db' });
    const mute = h('button', { class: 'btn mute', onclick: toggleMute }, 'M');
    const el = h('div', { class: `strip ${master ? 'master' : ''}` },
      h('div', { class: 'strip-name', title: name }, name),
      h('div', { class: 'strip-mid' }, meter, fader),
      db,
      h('div', { class: 'strip-btns' }, mute, ...(extra || [])));
    const s = { el, meter, fader, db, mute, getVol, getMute, peak: [0, 0], hold: [0, 0] };
    strips.set(id, s);
    return s;
  }

  function render() {
    root.replaceChildren();
    strips.clear();
    for (const input of mixer.inputs) {
      if (!input.hasAudio) continue;
      const a = input.settings.audio;
      const bus = (b) => h('button', { class: 'btn bus', title: `Route to ${b === 'M' ? 'Master' : `Bus ${b}`}`, 'data-bus': b, onclick: () => app.api.call('AudioBus', { Input: input.id, Value: b }) }, b);
      const afv = h('button', { class: 'btn afv', title: 'Audio follows video (on only when on air)', onclick: () => app.api.call('AudioAuto', { Input: input.id }) }, 'Auto');
      const solo = h('button', { class: 'btn solo', title: 'Solo (monitor only this input)', onclick: () => { mixer.audio.setSolo(input.id); refresh(); } }, 'S');
      const s = makeStrip({
        id: input.id,
        name: `${mixer.inputNumber(input)}. ${input.title}`,
        getVol: () => a.volume,
        setVol: (v) => app.api.call('SetVolume', { Input: input.id, Value: v }),
        getMute: () => a.muted,
        toggleMute: () => app.api.call('Audio', { Input: input.id }),
        extra: [solo, afv, bus('M'), bus('A'), bus('B')],
      });
      s.input = input;
      s.afv = afv;
      s.solo = solo;
      s.buses = s.el.querySelectorAll('.bus');
      root.append(s.el);
    }
    for (const [b, label] of [['A', 'Bus A'], ['B', 'Bus B'], ['M', 'MASTER']]) {
      const bus = mixer.audio.buses[b];
      const s = makeStrip({
        id: `bus:${b}`,
        name: label,
        master: true,
        getVol: () => bus.volume,
        setVol: (v) => { bus.set(v); refresh(); },
        getMute: () => bus.muted,
        toggleMute: () => { bus.set(undefined, !bus.muted); refresh(); },
      });
      root.append(s.el);
    }
    refresh();
  }

  function refresh() {
    for (const s of strips.values()) {
      if (document.activeElement !== s.fader) s.fader.value = s.getVol();
      s.mute.classList.toggle('active', !!s.getMute());
      const g = faderToGain(s.getVol());
      s.db.textContent = g <= 0 ? '-∞ dB' : `${gainToDb(g).toFixed(1)} dB`;
      if (s.input) {
        const a = s.input.settings.audio;
        s.afv.classList.toggle('active', a.afv);
        s.solo.classList.toggle('active', mixer.audio.solo === s.input.id);
        s.buses.forEach((b) => b.classList.toggle('active', !!a.buses[b.dataset.bus]));
        s.el.classList.toggle('onair', mixer.isOnAir(s.input) && !a.muted);
      }
    }
  }

  function drawMeters() {
    const levels = mixer.audio.meters();
    for (const [id, s] of strips) {
      const lv = levels[id];
      if (!lv) continue;
      const ctx = s.meter.getContext('2d');
      const W = s.meter.width;
      const H = s.meter.height;
      ctx.clearRect(0, 0, W, H);
      for (let ch = 0; ch < 2; ch++) {
        const db = gainToDb(lv[ch]);
        s.peak[ch] = Math.max(db, (s.peak[ch] ?? -60) - 1.2);
        if (db > s.hold[ch] || performance.now() - (s.holdAt?.[ch] || 0) > 1500) {
          s.hold[ch] = db;
          s.holdAt = s.holdAt || [0, 0];
          s.holdAt[ch] = performance.now();
        }
        const norm = (d) => Math.max(0, Math.min(1, (d + 60) / 60));
        const v = norm(s.peak[ch]);
        const x = ch * (W / 2);
        const w = W / 2 - 1;
        const grad = ctx.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, '#2fbf71');
        grad.addColorStop(0.7, '#2fbf71');
        grad.addColorStop(0.85, '#f5a524');
        grad.addColorStop(1, '#e5484d');
        ctx.fillStyle = grad;
        ctx.fillRect(x, H - v * H, w, v * H);
        ctx.fillStyle = '#fff';
        ctx.fillRect(x, H - norm(s.hold[ch]) * H, w, 2);
      }
    }
    requestAnimationFrame(drawMeters);
  }

  mixer.on('inputs', render);
  mixer.on('input', refresh);
  mixer.on('onair', refresh);
  mixer.on('api', refresh);
  render();
  requestAnimationFrame(drawMeters);

  const mon = $('#monitorBtn');
  const upMon = () => mon.classList.toggle('active', mixer.audio.monitorOn);
  mon.addEventListener('click', () => {
    mixer.audio.setMonitor(!mixer.audio.monitorOn);
    mixer.settings.monitor = mixer.audio.monitorOn;
    mixer.saveSettings();
    upMon();
  });
  upMon();
}
