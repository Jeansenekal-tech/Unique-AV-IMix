// Input tiles (multiview grid) with tally, overlay buttons and quick actions.
import { h, $, contextMenu, fmtShort, toast, promptText } from './dom.js';
import { INPUT_TYPES } from '../engine/inputs.js';
import { addFiles, showAddInput } from './add-input.js';
import { openInputSettings } from './input-settings.js';

const PLAYABLE = ['video', 'list', 'audiofile', 'replay'];

export function initInputs(app) {
  const { mixer } = app;
  const grid = $('#inputGrid');
  const tiles = new Map();

  const sizeSlider = $('#tileSize');
  const savedSize = localStorage.getItem('imix.tileSize');
  if (savedSize) sizeSlider.value = savedSize;
  const applySize = () => {
    grid.style.setProperty('--tile', `${sizeSlider.value}px`);
    localStorage.setItem('imix.tileSize', sizeSlider.value);
  };
  sizeSlider.addEventListener('input', applySize);
  applySize();

  function makeTile(input) {
    const thumb = h('canvas', { width: 320, height: 180 });
    input.thumbCtx = thumb.getContext('2d');
    const body = h('div', { class: 'tile-body' }, thumb);
    if (!input.hasVideo) body.append(h('div', { class: 'audio-only' }, INPUT_TYPES[input.type]?.icon || '🔊'));
    const badge = h('div', { class: 'tile-badge hidden' });
    const prog = h('div', { class: 'tile-progress hidden' }, h('div'));
    const err = h('div', { class: 'tile-err hidden' });
    body.append(badge, prog, err);

    const num = h('span', { class: 'tile-num' });
    const title = h('span', { class: 'tile-title' });
    const head = h('div', { class: 'tile-head' }, num, title, h('span', { class: 'tile-type' }, INPUT_TYPES[input.type]?.icon || ''));

    const fb = (label, titleText, fn, cls = '') => h('button', {
      class: `btn ${cls}`,
      title: titleText,
      onclick: (e) => {
        e.stopPropagation();
        fn(e);
      },
    }, label);
    const ovBtns = [1, 2, 3, 4].map((n) => fb(String(n), `Overlay ${n}`, () => mixer.overlay(n - 1, input.id, 'toggle'), 'ov-btn'));
    const loopBtn = PLAYABLE.includes(input.type) && input.type !== 'replay' ? fb('⟳', 'Loop', () => input.setLoop?.(!input.settings.loop), 'toggle') : null;
    const muteBtn = input.hasAudio ? fb('🔊', 'Audio on/off', () => app.api.call('Audio', { Input: input.id }), 'mute') : null;
    const foot = h('div', { class: 'tile-foot' },
      fb('Cut', 'Cut directly to program', () => mixer.cut(input.id)),
      fb('QP', 'Quick Play (transition directly to program)', () => mixer.transition(mixer.quickPlay.type, mixer.quickPlay.duration, input.id)),
      PLAYABLE.includes(input.type) ? fb('⏯', 'Play / Pause', () => app.api.call('PlayPause', { Input: input.id })) : null,
      loopBtn, ...ovBtns, muteBtn,
      fb('⚙', 'Input settings', () => openInputSettings(app, input)));

    const el = h('div', { class: 'tile', draggable: 'true', 'data-id': input.id }, head, body, foot);
    el.addEventListener('click', () => mixer.setPreview(input.id));
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tile-foot')) return;
      openInputSettings(app, input);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Preview', action: () => mixer.setPreview(input.id) },
        { label: 'Cut to Output', action: () => mixer.cut(input.id) },
        { label: 'Quick Play', action: () => mixer.transition(mixer.quickPlay.type, mixer.quickPlay.duration, input.id) },
        '-',
        ...[1, 2, 3, 4].map((n) => ({ label: `Overlay ${n}`, action: () => mixer.overlay(n - 1, input.id, 'toggle') })),
        '-',
        { label: 'Settings…', action: () => openInputSettings(app, input) },
        { label: 'Rename…', action: () => rename(input) },
        { label: 'Duplicate', action: () => mixer.duplicateInput(input.id) },
        ...(input.type === 'browser' ? [{ label: 'Reload page', action: () => input.reload() }] : []),
        { label: 'Snapshot input', action: () => snapshotInput(input) },
        '-',
        { label: 'Remove', action: () => mixer.removeInput(input.id) },
      ]);
    });
    // drag to reorder
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/imix-input', input.id);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/imix-input')) return;
      e.preventDefault();
      el.classList.add('drop-before');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
    el.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('text/imix-input');
      el.classList.remove('drop-before');
      if (!id || id === input.id) return;
      e.preventDefault();
      e.stopPropagation();
      mixer.moveInput(id, mixer.inputs.indexOf(input));
    });

    return { el, num, title, badge, prog, err, ovBtns, loopBtn, muteBtn };
  }

  async function rename(input) {
    const name = await promptText('Input name', input.title);
    if (name) {
      input.title = name;
      mixer.emit('inputs');
    }
  }

  function snapshotInput(input) {
    const url = app.outputs.snapshotDataUrl(input);
    if (!url) return toast('Nothing to snapshot', 'error');
    const a = h('a', { href: url, download: `${input.title}.png` });
    a.click();
  }

  function render() {
    const ids = new Set(mixer.inputs.map((i) => i.id));
    for (const [id, t] of tiles) {
      if (!ids.has(id)) {
        t.el.remove();
        tiles.delete(id);
      }
    }
    grid.replaceChildren();
    if (!mixer.inputs.length) {
      grid.append(h('div', { class: 'empty-hint' }, 'No inputs yet. Click “＋ Add Input” or drop video, image and audio files here.'));
    }
    for (const input of mixer.inputs) {
      let t = tiles.get(input.id);
      if (!t) {
        t = makeTile(input);
        tiles.set(input.id, t);
      }
      grid.append(t.el);
    }
    updateAll();
  }

  function update(input) {
    const t = tiles.get(input.id);
    if (!t) return;
    const n = mixer.inputNumber(input);
    t.num.textContent = n;
    t.title.textContent = input.title;
    t.el.title = `${n}. ${input.title}`;
    const onAir = mixer.isOnAir(input) || mixer.programId === input.id;
    t.el.classList.toggle('program', onAir);
    t.el.classList.toggle('preview', !onAir && mixer.previewId === input.id);
    mixer.overlays.forEach((ov, i) => {
      const on = ov.inputId === input.id && ov.state !== 'off';
      t.ovBtns[i].classList.toggle(`on${i + 1}`, on);
    });
    if (t.loopBtn) t.loopBtn.classList.toggle('active', !!input.settings.loop);
    if (t.muteBtn) {
      t.muteBtn.classList.toggle('active', input.settings.audio.muted);
      t.muteBtn.textContent = input.settings.audio.muted ? '🔇' : '🔊';
    }
    t.err.classList.toggle('hidden', !input.error);
    t.err.textContent = input.error || '';
  }

  function updateAll() {
    for (const input of mixer.inputs) update(input);
  }

  function updateBadges() {
    for (const input of mixer.inputs) {
      const t = tiles.get(input.id);
      if (!t) continue;
      if (PLAYABLE.includes(input.type) && input.duration) {
        t.badge.classList.remove('hidden');
        const rem = input.duration - input.position;
        t.badge.textContent = `${input.state === 'Running' ? '▶' : '❚❚'} -${fmtShort(rem)}`;
        t.prog.classList.remove('hidden');
        t.prog.firstChild.style.width = `${(input.position / input.duration) * 100}%`;
      } else if (input.type === 'list') {
        t.badge.classList.remove('hidden');
        t.badge.textContent = `${input.index + 1}/${input.items.length}`;
      } else if (input.type === 'replay') {
        t.badge.classList.remove('hidden');
        t.badge.textContent = `${mixer.replay.recording ? '● ' : ''}${mixer.replay.bufferedSeconds.toFixed(0)}s${mixer.replay.playing ? ` ▶ ${mixer.replay.speed}x` : ''}`;
      } else {
        t.badge.classList.add('hidden');
      }
    }
  }

  mixer.on('inputs', render);
  mixer.on('state', updateAll);
  mixer.on('onair', updateAll);
  mixer.on('input', update);
  setInterval(updateBadges, 250);

  // drag & drop media files
  const pane = $('#inputsPane');
  const hint = $('#dropHint');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  pane.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    hint.classList.remove('hidden');
  });
  pane.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.classList.add('hidden');
  });
  pane.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  pane.addEventListener('drop', (e) => {
    depth = 0;
    hint.classList.add('hidden');
    if (!hasFiles(e)) return;
    e.preventDefault();
    addFiles(app, [...e.dataTransfer.files]);
  });
  // prevent the window from navigating to dropped files elsewhere
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('#addInputBtn').addEventListener('click', () => showAddInput(app));
  render();
}
