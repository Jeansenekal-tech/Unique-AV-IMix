// Per-input settings: general, position/crop, colour correction, keying,
// multi-layer (PiP), audio processing, and title / list / browser editors.
import { h, modal, tabs, slider, hexToRgb01, rgb01ToHex, toast } from './dom.js';
import { TITLE_TEMPLATES } from '../engine/titles.js';
import { fileSource } from './add-input.js';
import { BUSES, busLabel } from '../engine/audio.js';
import { openInputEq } from './eq-panel.js';

export function openInputSettings(app, input) {
  const { mixer } = app;
  const st = input.settings;
  const changed = () => mixer.inputChanged(input);

  const general = () => {
    const name = h('input', { type: 'text', value: input.title, oninput: (e) => { input.title = e.target.value; mixer.emit('inputs'); } });
    const rows = [h('label', null, 'Name'), name];
    if (['video', 'list', 'audiofile'].includes(input.type)) {
      rows.push(
        h('label', null, 'Loop'), check(st.loop, (v) => (input.setLoop ? input.setLoop(v) : (st.loop = v))),
        h('label', null, 'Auto Play'), check(st.autoPlay, (v) => { st.autoPlay = v; }),
        h('label', null, 'Auto Pause'), check(st.autoPause, (v) => { st.autoPause = v; }),
        h('label', null, 'Auto Restart'), check(st.autoRestart, (v) => { st.autoRestart = v; }),
        h('div', { class: 'full help' }, 'Auto Play starts the input when it goes to Output or an overlay; Auto Pause pauses it when it leaves.'),
        h('h4', null, 'Speed / slow motion'),
        ...slider('Playback speed', st.rate || 1, { min: 0.1, max: 2, step: 0.05, fmt: (v) => `${Number(v).toFixed(2)}×`, onInput: (v) => input.setRate(v) }),
        ...slider('Slow-mo button speed', st.slowMoRate || 0.5, { min: 0.1, max: 0.9, step: 0.05, fmt: (v) => `${Number(v).toFixed(2)}×`, onInput: (v) => { st.slowMoRate = v; } }),
        h('label', null, 'Keep audio pitch'), check(st.preservePitch !== false, (v) => { st.preservePitch = v; input.applyRate(); }),
        h('div', { class: 'full help' }, 'For live cameras use Instant Replay (⏪) – it records the source and plays it back in slow motion.'),
      );
    }
    if (input.type === 'video' || input.type === 'audiofile') {
      rows.push(h('label', null, 'Source'), h('span', { class: 'code' }, input.path || input.url));
    }
    if (input.type === 'colour') {
      rows.push(h('label', null, 'Colour'), h('input', { type: 'color', value: input.color, oninput: (e) => input.setColor(e.target.value) }));
    }
    if (input.type === 'browser') {
      const url = h('input', { type: 'url', value: input.url, style: { width: '100%' } });
      rows.push(h('label', null, 'URL'), h('div', { class: 'row' }, url,
        h('button', { class: 'btn small', onclick: () => input.navigate(url.value) }, 'Go'),
        h('button', { class: 'btn small', onclick: () => input.reload() }, 'Reload')));
    }
    if (input.type === 'camera') {
      rows.push(h('label', null, 'Device'), h('span', null, input.deviceLabel || input.deviceId || 'Default'));
    }
    if (input.type === 'replay') {
      rows.push(h('div', { class: 'full help' }, 'Control playback from the Replay panel (⏪ Replay in the bottom bar).'));
    }
    if (input.hasVideo) {
      rows.push(h('label', null, 'Fit'), select(['fit', 'fill', 'stretch'], st.fit, (v) => { st.fit = v; changed(); }, { fit: 'Fit (letterbox)', fill: 'Fill (crop)', stretch: 'Stretch' }));
      rows.push(...slider('Opacity', st.opacity, { onInput: (v) => { st.opacity = v; changed(); } }));
    }
    return h('div', { class: 'form' }, rows);
  };

  const position = () => h('div', { class: 'form' },
    h('h4', null, 'Position & zoom'),
    ...slider('Zoom', st.zoom, { min: 0, max: 4, step: 0.01, onInput: (v) => { st.zoom = v; changed(); } }),
    ...slider('Pan X', st.panX, { min: -2, max: 2, step: 0.01, onInput: (v) => { st.panX = v; changed(); } }),
    ...slider('Pan Y', st.panY, { min: -2, max: 2, step: 0.01, onInput: (v) => { st.panY = v; changed(); } }),
    h('h4', null, 'Crop'),
    ...slider('Left', st.crop.l, { max: 0.5, step: 0.005, onInput: (v) => { st.crop.l = v; changed(); } }),
    ...slider('Right', st.crop.r, { max: 0.5, step: 0.005, onInput: (v) => { st.crop.r = v; changed(); } }),
    ...slider('Top', st.crop.t, { max: 0.5, step: 0.005, onInput: (v) => { st.crop.t = v; changed(); } }),
    ...slider('Bottom', st.crop.b, { max: 0.5, step: 0.005, onInput: (v) => { st.crop.b = v; changed(); } }),
    h('h4', null, 'Presets'),
    h('div', { class: 'full row' },
      ...[
        ['Full', { zoom: 1, panX: 0, panY: 0 }],
        ['PiP top-right', { zoom: 0.33, panX: 0.6, panY: 0.6 }],
        ['PiP top-left', { zoom: 0.33, panX: -0.6, panY: 0.6 }],
        ['PiP bottom-right', { zoom: 0.33, panX: 0.6, panY: -0.6 }],
        ['PiP bottom-left', { zoom: 0.33, panX: -0.6, panY: -0.6 }],
        ['Left half', { zoom: 0.5, panX: -0.5, panY: 0 }],
        ['Right half', { zoom: 0.5, panX: 0.5, panY: 0 }],
      ].map(([label, p]) => h('button', { class: 'btn small', onclick: () => { Object.assign(st, p); changed(); reopen(2); } }, label))),
  );

  const colour = () => h('div', { class: 'form' },
    ...slider('Brightness', st.color.brightness, { min: -1, max: 1, onInput: (v) => { st.color.brightness = v; changed(); } }),
    ...slider('Contrast', st.color.contrast, { min: 0, max: 2, onInput: (v) => { st.color.contrast = v; changed(); } }),
    ...slider('Saturation', st.color.saturation, { min: 0, max: 2, onInput: (v) => { st.color.saturation = v; changed(); } }),
    ...slider('Hue', st.color.hue, { min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°`, onInput: (v) => { st.color.hue = v; changed(); } }),
    ...slider('Gamma', st.color.gamma, { min: 0.2, max: 3, onInput: (v) => { st.color.gamma = v; changed(); } }),
    h('div', { class: 'full' }, h('button', { class: 'btn small', onclick: () => { Object.assign(st.color, { brightness: 0, contrast: 1, saturation: 1, hue: 0, gamma: 1 }); changed(); reopen(3); } }, 'Reset')),
  );

  const key = () => {
    const k = st.key;
    const colourPick = h('input', { type: 'color', value: rgb01ToHex(k.color), oninput: (e) => { k.color = hexToRgb01(e.target.value); changed(); } });
    const picker = h('canvas', { width: 320, height: 180, style: { width: '320px', cursor: 'crosshair', borderRadius: '4px', background: '#000' } });
    const src = input.videoSource();
    if (src && src.el) {
      try {
        picker.getContext('2d').drawImage(src.el, 0, 0, 320, 180);
      } catch {
        /* ignore */
      }
    }
    picker.addEventListener('click', (e) => {
      const r = picker.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 320;
      const y = ((e.clientY - r.top) / r.height) * 180;
      const d = picker.getContext('2d').getImageData(x, y, 1, 1).data;
      k.color = [d[0] / 255, d[1] / 255, d[2] / 255];
      colourPick.value = rgb01ToHex(k.color);
      if (k.mode === 'none') k.mode = 'chroma';
      changed();
      reopen(4);
    });
    return h('div', { class: 'form' },
      h('label', null, 'Key mode'), select(['none', 'chroma', 'luma'], k.mode, (v) => { k.mode = v; changed(); }, { none: 'Off', chroma: 'Chroma key (green / blue screen)', luma: 'Luma key' }),
      h('label', null, 'Key colour'), h('div', { class: 'row' }, colourPick,
        h('button', { class: 'btn small', onclick: () => { k.color = [0, 0.69, 0.25]; k.mode = 'chroma'; changed(); reopen(4); } }, 'Green'),
        h('button', { class: 'btn small', onclick: () => { k.color = [0, 0.28, 0.73]; k.mode = 'chroma'; changed(); reopen(4); } }, 'Blue')),
      h('label', null, 'Pick from image'), picker,
      ...slider('Similarity', k.similarity, { min: 0, max: 1, step: 0.005, onInput: (v) => { k.similarity = v; changed(); } }),
      ...slider('Smoothness', k.smoothness, { min: 0, max: 0.5, step: 0.005, onInput: (v) => { k.smoothness = v; changed(); } }),
      ...slider('Spill reduction', k.spill, { min: 0, max: 0.5, step: 0.005, onInput: (v) => { k.spill = v; changed(); } }),
      h('h4', null, 'Luma key'),
      ...slider('Low', k.lumaLow, { onInput: (v) => { k.lumaLow = v; changed(); } }),
      ...slider('High', k.lumaHigh, { onInput: (v) => { k.lumaHigh = v; changed(); } }),
    );
  };

  const layers = () => {
    const opts = mixer.inputs.filter((i) => i !== input && i.hasVideo);
    const rows = st.layers.map((l, idx) => {
      const sel = h('select', {
        onchange: (e) => {
          l.inputId = e.target.value || null;
          l.enabled = !!l.inputId;
          changed();
        },
      }, h('option', { value: '' }, '— none —'), opts.map((o) => h('option', { value: o.id, selected: o.id === l.inputId }, `${mixer.inputNumber(o)}. ${o.title}`)));
      const num = (keyName) => h('input', {
        type: 'number', step: 0.01, min: -1, max: 2, value: l[keyName], title: keyName,
        oninput: (e) => { l[keyName] = Number(e.target.value); changed(); },
      });
      return h('div', { class: 'layer-row' },
        h('input', { type: 'checkbox', checked: l.enabled, onchange: (e) => { l.enabled = e.target.checked; changed(); } }),
        sel, num('x'), num('y'), num('w'), num('h'),
        h('input', { type: 'number', min: 0, max: 40, value: l.border, title: 'Border px', oninput: (e) => { l.border = Number(e.target.value); changed(); } }),
        idx === 0 ? null : null);
    });
    return h('div', null,
      h('p', { class: 'help' }, 'Layers composite other inputs on top of this one (picture-in-picture, split screens, virtual sets). X/Y/W/H are fractions of the frame (0–1). Border in pixels.'),
      h('div', { class: 'layer-row', style: { color: 'var(--text3)', fontSize: '11px' } }, h('span', null, 'On'), h('span', null, 'Input'), h('span', null, 'X'), h('span', null, 'Y'), h('span', null, 'W'), h('span', null, 'H'), h('span', null, 'Border')),
      rows,
      h('div', { class: 'row', style: { marginTop: '10px', gap: '6px', display: 'flex', flexWrap: 'wrap' } },
        h('button', { class: 'btn small', onclick: () => preset('pip') }, 'Preset: PiP'),
        h('button', { class: 'btn small', onclick: () => preset('side') }, 'Preset: Side by side'),
        h('button', { class: 'btn small', onclick: () => preset('quad') }, 'Preset: Quad'),
        h('button', { class: 'btn small', onclick: () => preset('three') }, 'Preset: 3-up')));
  };

  function preset(kind) {
    const L = st.layers;
    const setL = (i, x, y, w, hh) => Object.assign(L[i], { x, y, w, h: hh });
    if (kind === 'pip') setL(0, 0.64, 0.06, 0.32, 0.32);
    if (kind === 'side') {
      setL(0, 0.02, 0.25, 0.47, 0.47);
      setL(1, 0.51, 0.25, 0.47, 0.47);
    }
    if (kind === 'quad') {
      setL(0, 0, 0, 0.5, 0.5);
      setL(1, 0.5, 0, 0.5, 0.5);
      setL(2, 0, 0.5, 0.5, 0.5);
      setL(3, 0.5, 0.5, 0.5, 0.5);
    }
    if (kind === 'three') {
      setL(0, 0.01, 0.3, 0.32, 0.32);
      setL(1, 0.34, 0.3, 0.32, 0.32);
      setL(2, 0.67, 0.3, 0.32, 0.32);
    }
    changed();
    reopen(tabIndex('Layers'));
  }

  const audio = () => {
    const a = st.audio;
    return h('div', { class: 'form' },
      ...slider('Volume', a.volume, { min: 0, max: 100, step: 1, fmt: (v) => `${Math.round(v)}`, onInput: (v) => { a.volume = v; changed(); } }),
      ...slider('Gain (trim)', a.gain, { min: -24, max: 24, step: 0.5, fmt: (v) => `${v} dB`, onInput: (v) => { a.gain = v; changed(); } }),
      ...slider('Balance', a.balance, { min: -1, max: 1, step: 0.01, onInput: (v) => { a.balance = v; changed(); } }),
      ...slider('Delay (sync)', a.delay, { min: 0, max: 1000, step: 1, fmt: (v) => `${v} ms`, onInput: (v) => { a.delay = v; changed(); } }),
      h('label', null, 'Muted'), check(a.muted, (v) => { a.muted = v; changed(); }),
      h('label', null, 'Audio follows video'), check(a.afv, (v) => { a.afv = v; changed(); }),
      h('label', null, 'Output buses'), h('div', { class: 'row', style: { flexWrap: 'wrap' } }, BUSES.map((b) => h('label', null, check(a.buses[b], (v) => { a.buses[b] = v; changed(); }), ` ${busLabel(b)}`))),
      h('h4', null, 'Equaliser'),
      h('label', null, '6-band EQ'), h('div', { class: 'row' }, check(a.eq.on, (v) => { a.eq.on = v; changed(); }),
        h('button', { class: 'btn small', onclick: () => openInputEq(app, input) }, 'Open EQ…')),
      h('h4', null, 'Dynamics'),
      h('label', null, 'Compressor'), check(a.comp.on, (v) => { a.comp.on = v; changed(); }),
      ...slider('Threshold', a.comp.threshold, { min: -60, max: 0, step: 1, fmt: (v) => `${v} dB`, onInput: (v) => { a.comp.threshold = v; changed(); } }),
      ...slider('Ratio', a.comp.ratio, { min: 1, max: 20, step: 0.5, fmt: (v) => `${v}:1`, onInput: (v) => { a.comp.ratio = v; changed(); } }),
      h('label', null, 'Noise gate'), check(a.gate.on, (v) => { a.gate.on = v; changed(); }),
      ...slider('Gate threshold', a.gate.threshold, { min: -90, max: 0, step: 1, fmt: (v) => `${v} dB`, onInput: (v) => { a.gate.threshold = v; changed(); } }),
    );
  };

  const title = () => {
    const tplSel = select(Object.keys(TITLE_TEMPLATES), input.template, (v) => { input.setTemplate(v); reopen(1); });
    const fields = Object.entries(input.fields).map(([k, v]) => [
      h('label', null, k),
      k === 'Text' && input.template === 'Plain Text'
        ? h('textarea', { rows: 3, value: v, oninput: (e) => input.setText(k, e.target.value) })
        : h('input', { type: 'text', value: v, oninput: (e) => input.setText(k, e.target.value) }),
    ]);
    const s = input.style;
    const fonts = ['Helvetica Neue', 'Arial', 'Avenir Next', 'Futura', 'Gill Sans', 'Georgia', 'Impact', 'Menlo', 'SF Pro Display', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
    const countdown = input.template === 'Countdown' ? [
      h('label', null, 'Countdown'), h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => input.countdown('start') }, 'Start'),
        h('button', { class: 'btn small', onclick: () => input.countdown('pause') }, 'Pause'),
        h('button', { class: 'btn small', onclick: () => input.countdown('stop') }, 'Reset')),
    ] : [];
    return h('div', { class: 'form' },
      h('label', null, 'Template'), tplSel,
      h('h4', null, 'Text'),
      ...fields.flat(),
      ...countdown,
      h('h4', null, 'Style'),
      h('label', null, 'Font'), select(fonts, s.font, (v) => input.setStyle({ font: v })),
      h('label', null, 'Accent colour'), h('input', { type: 'color', value: s.accent, oninput: (e) => input.setStyle({ accent: e.target.value }) }),
      h('label', null, 'Background colour'), h('input', { type: 'color', value: s.primary, oninput: (e) => input.setStyle({ primary: e.target.value }) }),
      h('label', null, 'Text colour'), h('input', { type: 'color', value: s.text, oninput: (e) => input.setStyle({ text: e.target.value }) }),
      ...slider('Background opacity', s.bgOpacity, { onInput: (v) => input.setStyle({ bgOpacity: v }) }),
      h('label', null, 'Alignment'), select(['left', 'center', 'right'], s.align, (v) => input.setStyle({ align: v })),
      h('label', null, 'Animate in'), check(s.animate, (v) => input.setStyle({ animate: v })),
      ...(input.template === 'Ticker' ? slider('Ticker speed', s.speed, { min: 20, max: 600, step: 10, fmt: (v) => `${v}px/s`, onInput: (v) => input.setStyle({ speed: v }) }) : []),
      h('div', { class: 'full help' }, 'API: SetText Input=… SelectedName=<field> Value=…'),
    );
  };

  const list = () => {
    const body = h('tbody');
    const draw = () => {
      body.replaceChildren(...input.items.map((it, i) => h('tr', { style: { background: i === input.index ? 'rgba(124,92,255,.2)' : '' } },
        h('td', null, i + 1),
        h('td', null, it.name || it.path),
        h('td', null,
          h('button', { class: 'btn small', onclick: () => { input.load(i, true); draw(); } }, '▶'),
          h('button', { class: 'btn small', onclick: () => { if (i > 0) { [input.items[i - 1], input.items[i]] = [input.items[i], input.items[i - 1]]; draw(); } } }, '↑'),
          h('button', { class: 'btn small', onclick: () => { input.removeItem(i); draw(); } }, '✕')))));
    };
    draw();
    const add = h('button', {
      class: 'btn small',
      onclick: () => {
        const inp = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*' });
        inp.onchange = () => {
          input.addItems([...inp.files].map((f) => ({ name: f.name, ...fileSource(f) })));
          draw();
        };
        inp.click();
      },
    }, '＋ Add files');
    return h('div', null,
      h('div', { class: 'row', style: { display: 'flex', gap: '8px', marginBottom: '8px' } }, add,
        h('label', null, check(input.settings.loop, (v) => input.setLoop(v)), ' Loop list'),
        h('label', null, check(input.shuffle, (v) => { input.shuffle = v; }), ' Shuffle')),
      h('table', { class: 'list' }, h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'File'), h('th', null, ''))), body));
  };

  const defs = [{ label: 'General', render: general }];
  if (input.type === 'title') defs.push({ label: 'Title', render: title });
  if (input.type === 'list') defs.push({ label: 'Playlist', render: list });
  if (input.hasVideo) {
    defs.push({ label: 'Position', render: position });
    defs.push({ label: 'Colour', render: colour });
    defs.push({ label: 'Key', render: key });
    defs.push({ label: 'Layers', render: layers });
  }
  if (input.hasAudio) defs.push({ label: 'Audio', render: audio });

  function tabIndex(label) {
    return Math.max(0, defs.findIndex((d) => d.label === label));
  }

  let m = null;
  function reopen(i) {
    // map legacy fixed indices to labels
    const map = { 1: 'Title', 2: 'Position', 3: 'Colour', 4: 'Key' };
    const idx = typeof i === 'number' && map[i] && defs.some((d) => d.label === map[i]) ? tabIndex(map[i]) : i;
    m?.close();
    m = show(idx);
  }

  function show(initial = 0) {
    return modal({
      title: `${mixer.inputNumber(input)}. ${input.title} – Settings`,
      body: tabs(defs, initial),
      width: 640,
      buttons: [
        { label: 'Remove input', danger: true, onClick: () => mixer.removeInput(input.id) },
        { label: 'Done', primary: true },
      ],
    });
  }
  if (!mixer.getInput(input.id)) return toast('Input no longer exists', 'error');
  m = show(0);
}

function check(value, onChange) {
  return h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) });
}

function select(values, current, onChange, labels = {}) {
  return h('select', { onchange: (e) => onChange(e.target.value) }, values.map((v) => h('option', { value: v, selected: v === current }, labels[v] || v)));
}
