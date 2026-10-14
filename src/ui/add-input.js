// "Add Input" dialogs for every input type, plus file drag & drop.
import { h, modal, toast } from './dom.js';
import { INPUT_TYPES } from '../engine/inputs.js';
import { TITLE_TEMPLATES, renderTitle, DEFAULT_TITLE_STYLE } from '../engine/titles.js';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|mpg|mpeg|ts)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|flac|ogg|opus|aiff?)$/i;

export function fileSource(file) {
  const path = window.imix?.pathForFile?.(file) || '';
  return path ? { path, name: file.name } : { url: URL.createObjectURL(file), name: file.name };
}

export function classify(file) {
  const n = file.name || '';
  if (file.type?.startsWith('image/') || IMAGE_EXT.test(n)) return 'image';
  if (file.type?.startsWith('audio/') || AUDIO_EXT.test(n)) return 'audiofile';
  if (file.type?.startsWith('video/') || VIDEO_EXT.test(n)) return 'video';
  return null;
}

export async function addFiles(app, files) {
  let added = 0;
  for (const file of files) {
    if (/\.imix$/i.test(file.name)) {
      app.project.openFile(file);
      return;
    }
    const type = classify(file);
    if (!type) {
      toast(`Unsupported file: ${file.name}`, 'error');
      continue;
    }
    await app.mixer.addInput({ type, ...fileSource(file) });
    added++;
  }
  if (added) toast(`Added ${added} input${added > 1 ? 's' : ''}`);
}

function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, multiple });
    inp.addEventListener('change', () => resolve([...inp.files]));
    inp.click();
  });
}

async function listDevices(kind) {
  try {
    // labels need a permission grant first
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === kind && d.label)) {
      const s = await navigator.mediaDevices.getUserMedia(kind === 'videoinput' ? { video: true } : { audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    return devices.filter((d) => d.kind === kind);
  } catch (e) {
    toast(`Cannot list devices: ${e.message}`, 'error');
    return [];
  }
}

export function showAddInput(app, type) {
  if (type) return addOfType(app, type);
  const body = h('div', { class: 'type-grid' }, Object.entries(INPUT_TYPES).map(([t, def]) => h('div', {
    class: 'type-card',
    onclick: () => {
      m.close();
      addOfType(app, t);
    },
  }, h('span', { class: 'ic' }, def.icon), def.label)));
  const m = modal({ title: 'Add Input', body, width: 620 });
  return null;
}

async function addOfType(app, type) {
  const mixer = app.mixer;
  switch (type) {
    case 'video':
    case 'image':
    case 'audiofile': {
      const accept = type === 'video' ? 'video/*,.mov,.mkv' : type === 'image' ? 'image/*' : 'audio/*';
      const files = await pickFiles(accept);
      for (const f of files) await mixer.addInput({ type, ...fileSource(f) });
      return;
    }
    case 'list':
      return listDialog(app);
    case 'camera':
      return cameraDialog(app);
    case 'audio':
      return audioDialog(app);
    case 'screen':
      return screenDialog(app);
    case 'title':
      return titleDialog(app);
    case 'colour':
      return colourDialog(app);
    case 'browser':
      return browserDialog(app);
    case 'url':
      return urlDialog(app);
    case 'replay':
      await mixer.addInput({ type: 'replay' });
      toast('Instant Replay input added – replay buffer is recording');
      return;
    default:
  }
}

async function cameraDialog(app) {
  const [videos, audios] = await Promise.all([listDevices('videoinput'), listDevices('audioinput')]);
  if (!videos.length) return toast('No cameras or capture devices found', 'error');
  const dev = h('select', null, videos.map((d) => h('option', { value: d.deviceId }, d.label || 'Camera')));
  const res = h('select', null, [['3840x2160', '4K UHD'], ['1920x1080', '1080p'], ['1280x720', '720p'], ['640x480', '480p']]
    .map(([v, l]) => h('option', { value: v, selected: v === '1920x1080' }, `${l} (${v})`)));
  const fps = h('select', null, [60, 50, 30, 25, 24].map((f) => h('option', { value: f, selected: f === 30 }, `${f} fps`)));
  const aud = h('select', null, h('option', { value: '' }, 'None (video only)'), audios.map((d) => h('option', { value: d.deviceId }, d.label || 'Microphone')));
  const body = h('div', { class: 'form' },
    h('label', null, 'Device'), dev,
    h('label', null, 'Resolution'), res,
    h('label', null, 'Frame rate'), fps,
    h('label', null, 'Embedded audio'), aud,
    h('div', { class: 'full help' }, 'USB/HDMI capture cards, webcams, iPhone Continuity Camera and virtual cameras appear here.'));
  modal({
    title: 'Add Camera / Capture Device',
    body,
    width: 520,
    buttons: [{ label: 'Cancel' }, {
      label: 'Add',
      primary: true,
      onClick: async () => {
        const [w, hh] = res.value.split('x').map(Number);
        const v = videos.find((d) => d.deviceId === dev.value);
        const a = audios.find((d) => d.deviceId === aud.value);
        const input = await app.mixer.addInput({
          type: 'camera', deviceId: dev.value, deviceLabel: v?.label, width: w, height: hh, fps: Number(fps.value),
          audioDeviceId: aud.value, audioDeviceLabel: a?.label,
        });
        if (input.error) toast(input.error, 'error');
      },
    }],
  });
}

async function audioDialog(app) {
  const audios = await listDevices('audioinput');
  if (!audios.length) return toast('No audio inputs found', 'error');
  const dev = h('select', null, audios.map((d) => h('option', { value: d.deviceId }, d.label || 'Microphone')));
  const ch = h('select', null, h('option', { value: 'stereo' }, 'Stereo'), h('option', { value: 'left' }, 'Left channel (mono)'), h('option', { value: 'right' }, 'Right channel (mono)'));
  modal({
    title: 'Add Audio Input',
    body: h('div', { class: 'form' }, h('label', null, 'Device'), dev, h('label', null, 'Channels'), ch),
    width: 480,
    buttons: [{ label: 'Cancel' }, {
      label: 'Add',
      primary: true,
      onClick: async () => {
        const d = audios.find((x) => x.deviceId === dev.value);
        const input = await app.mixer.addInput({ type: 'audio', deviceId: dev.value, deviceLabel: d?.label, channels: ch.value });
        if (input.error) toast(input.error, 'error');
      },
    }],
  });
}

async function screenDialog(app) {
  if (!window.imix?.screenSources) {
    const input = await app.mixer.addInput({ type: 'screen' });
    if (input.error) toast(input.error, 'error');
    return;
  }
  const status = await window.imix.mediaAccess('screen');
  let sources = [];
  try {
    sources = await window.imix.screenSources();
  } catch (e) {
    toast(`Screen capture unavailable: ${e.message}`, 'error');
  }
  if (!sources.length) {
    return toast(status === 'denied' ? 'Allow Screen Recording for Unique AV IMix in System Settings → Privacy & Security.' : 'No screens found', 'error');
  }
  let selected = sources[0];
  const cards = sources.map((s) => h('div', {
    class: `source-card ${s === selected ? 'selected' : ''}`,
    onclick: (e) => {
      selected = s;
      grid.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
      e.currentTarget.classList.add('selected');
    },
  }, h('img', { src: s.thumbnail }), s.name));
  const grid = h('div', { class: 'source-grid' }, cards);
  modal({
    title: 'Add Screen / Window Capture',
    body: grid,
    width: 720,
    buttons: [{ label: 'Cancel' }, {
      label: 'Add',
      primary: true,
      onClick: async () => {
        const input = await app.mixer.addInput({ type: 'screen', sourceId: selected.id, sourceName: selected.name });
        if (input.error) toast(input.error, 'error');
      },
    }],
  });
}

async function listDialog(app) {
  const files = await pickFiles('video/*,audio/*,image/*,.mov,.mkv');
  if (!files.length) return;
  const items = files.map((f) => {
    const s = fileSource(f);
    return { name: f.name, path: s.path, url: s.url };
  });
  await app.mixer.addInput({ type: 'list', items });
}

function titleDialog(app) {
  const names = Object.keys(TITLE_TEMPLATES);
  const canvas = h('canvas', { width: 480, height: 270, style: { width: '100%', background: '#333 repeating-conic-gradient(#3a3a3a 0 25%, #2c2c2c 0 50%) 50% / 20px 20px', borderRadius: '6px' } });
  const sel = h('select', null, names.map((n) => h('option', { value: n }, n)));
  const draw = () => {
    const tpl = TITLE_TEMPLATES[sel.value];
    const fields = Object.fromEntries(tpl.fields);
    renderTitle(canvas.getContext('2d'), 480, 270, sel.value, fields, DEFAULT_TITLE_STYLE, { a: 1, now: performance.now(), state: {} });
  };
  sel.addEventListener('change', draw);
  setTimeout(draw);
  modal({
    title: 'Add Title / Graphics',
    body: h('div', { class: 'form' }, h('label', null, 'Template'), sel, h('div', { class: 'full' }, canvas),
      h('div', { class: 'full help' }, 'Edit text, colours and fonts in the input settings (⚙) after adding. Titles are transparent – use them as overlays.')),
    width: 560,
    buttons: [{ label: 'Cancel' }, {
      label: 'Add',
      primary: true,
      onClick: () => app.mixer.addInput({ type: 'title', template: sel.value }, { select: false }),
    }],
  });
}

function colourDialog(app) {
  const c = h('input', { type: 'color', value: '#1d3557' });
  const presets = ['#000000', '#ffffff', '#00b140', '#0047bb', '#1d3557', '#e63946', '#f1c40f', '#7c5cff'];
  const sw = h('div', { class: 'row' }, presets.map((p) => h('button', { class: 'btn small', style: { background: p, width: '28px', height: '24px' }, onclick: () => { c.value = p; } })));
  modal({
    title: 'Add Colour',
    body: h('div', { class: 'form' }, h('label', null, 'Colour'), c, h('label', null, 'Presets'), sw),
    width: 440,
    buttons: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => app.mixer.addInput({ type: 'colour', color: c.value }) }],
  });
}

function browserDialog(app) {
  if (!window.imix?.browserOpen) return toast('Web browser inputs require the desktop app', 'error');
  const url = h('input', { type: 'url', value: 'https://', style: { width: '100%' } });
  const size = h('select', null, ['1920x1080', '1280x720', '1080x1920', '800x600'].map((s) => h('option', { value: s, selected: s === '1280x720' }, s)));
  const fps = h('input', { type: 'number', value: 25, min: 1, max: 60 });
  const css = h('textarea', { rows: 3, placeholder: 'body { background: transparent !important; }' });
  modal({
    title: 'Add Web Browser',
    body: h('div', { class: 'form' }, h('label', null, 'URL'), url, h('label', null, 'Size'), size, h('label', null, 'Frame rate'), fps,
      h('label', null, 'Custom CSS'), css, h('div', { class: 'full help' }, 'Pages with a transparent background can be used as overlays (e.g. HTML graphics, chat widgets).')),
    width: 560,
    buttons: [{ label: 'Cancel' }, {
      label: 'Add',
      primary: true,
      onClick: () => {
        const [w, hh] = size.value.split('x').map(Number);
        return app.mixer.addInput({ type: 'browser', url: url.value, width: w, height: hh, fps: Number(fps.value), css: css.value });
      },
    }],
  });
}

function urlDialog(app) {
  const url = h('input', { type: 'url', value: 'https://', style: { width: '100%' } });
  modal({
    title: 'Add Stream URL',
    body: h('div', { class: 'form' }, h('label', null, 'Media URL'), url,
      h('div', { class: 'full help' }, 'Direct MP4/WebM/HLS-in-MP4 media URLs. The server must allow cross-origin access (CORS) for the picture to be mixed.')),
    width: 560,
    buttons: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => app.mixer.addInput({ type: 'url', url: url.value }) }],
  });
}
