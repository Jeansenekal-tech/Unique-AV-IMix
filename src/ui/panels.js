// Floating tool panels: Instant Replay, Scripts, Shortcuts & MIDI, Log, Help.
import { h, panel, modal, toast } from './dom.js';
import { describeTrigger, DEFAULT_SHORTCUTS, EXAMPLE_SCRIPT } from '../engine/automation.js';

export function openReplay(app) {
  const { mixer } = app;
  const r = mixer.replay;
  const body = h('div');
  const p = panel('replay', { title: '⏪ Instant Replay', body, width: 460, x: window.innerWidth - 500, y: 80, onClose: () => off() });
  if (!p) return;
  const draw = () => {
    const srcSel = h('select', {
      onchange: (e) => {
        r.source = e.target.value;
        r.clear();
      },
    }, h('option', { value: 'program' }, 'Output (program)'), mixer.inputs.filter((i) => i.hasVideo && i.type !== 'replay').map((i) => h('option', { value: i.id, selected: r.source === i.id }, `${mixer.inputNumber(i)}. ${i.title}`)));
    srcSel.value = r.source;
    const speed = h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: r.speed, oninput: (e) => { r.speed = Number(e.target.value); spv.textContent = `${r.speed.toFixed(2)}x`; } });
    const spv = h('span', { class: 'val' }, `${r.speed.toFixed(2)}x`);
    const last = h('input', { type: 'number', min: 1, max: 60, value: r.lastSeconds, style: { width: '60px' }, oninput: (e) => { r.lastSeconds = Number(e.target.value) || 5; } });
    const hasInput = mixer.inputs.some((i) => i.type === 'replay');
    body.replaceChildren(
      h('div', { class: 'form' },
        h('label', null, 'Record'), h('div', { class: 'row' },
          h('button', { class: `btn small ${r.recording ? 'active out' : ''}`, onclick: () => (r.recording ? r.stop() : r.start()) }, r.recording ? '● Recording' : 'Start buffer'),
          h('span', { class: 'help', id: 'replayBuf' }, '')),
        h('label', null, 'Source'), srcSel,
        h('label', null, 'Speed'), h('div', { class: 'row' }, speed, spv,
          ...[0.25, 0.5, 1].map((v) => h('button', { class: 'btn small', onclick: () => { r.speed = v; speed.value = v; spv.textContent = `${v.toFixed(2)}x`; } }, `${v}x`))),
        h('label', null, 'Play last'), h('div', { class: 'row' }, last, h('span', { class: 'help' }, 'seconds'),
          h('button', { class: 'btn small primary', onclick: () => r.playLast(r.lastSeconds) }, '▶ Play last')),
        h('label', null, 'Transport'), h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => r.resume() }, '▶'),
          h('button', { class: 'btn small', onclick: () => r.pause() }, '❚❚'),
          h('button', { class: 'btn small', onclick: () => r.markIn() }, r.markInAt ? 'Mark In ●' : 'Mark In'),
          h('button', { class: 'btn small', onclick: () => r.markOut() }, 'Mark Out')),
        h('label', null, 'Output'), h('div', { class: 'row' },
          hasInput
            ? h('button', { class: 'btn small', onclick: () => { const i = mixer.inputs.find((x) => x.type === 'replay'); mixer.transition(mixer.quickPlay.type, mixer.quickPlay.duration, i.id); } }, 'Take replay to Output')
            : h('button', { class: 'btn small', onclick: async () => { await mixer.addInput({ type: 'replay' }, { select: false }); draw(); } }, 'Add Replay input'),
          h('button', { class: 'btn small', onclick: () => mixer.transition(mixer.quickPlay.type, mixer.quickPlay.duration, mixer.trans ? undefined : mixer.previewId) }, 'Back to Preview')),
      ),
      h('h4', { style: { margin: '14px 0 6px', color: 'var(--text3)', fontSize: '11px' } }, 'EVENTS'),
      r.events.length
        ? h('table', { class: 'list' }, r.events.map((ev) => h('tr', null,
          h('td', null, ev.name), h('td', null, `${ev.duration.toFixed(1)}s`),
          h('td', null, h('button', { class: 'btn small', onclick: () => r.playEvent(ev.id) }, '▶'), h('button', { class: 'btn small', onclick: () => r.deleteEvent(ev.id) }, '✕')))))
        : h('p', { class: 'help' }, 'Mark In / Mark Out to save highlights as events.'),
    );
  };
  draw();
  const offEv = mixer.on('replay', draw);
  const timer = setInterval(() => {
    const el = body.querySelector('#replayBuf');
    if (el) el.textContent = `${r.bufferedSeconds.toFixed(1)}s / ${r.seconds}s buffered${r.playing ? ` – playing ${r.speed}x` : ''}`;
  }, 250);
  function off() {
    offEv();
    clearInterval(timer);
  }
}

export function openScripts(app) {
  const { mixer } = app;
  const body = h('div');
  const log = h('div', { class: 'log', style: { height: '120px' } });
  const p = panel('scripts', { title: 'Scripts', body, width: 640, onClose: () => offs.forEach((f) => f()) });
  if (!p) return;
  let current = mixer.scripts[0] || null;
  const editor = h('textarea', { rows: 14, style: { width: '100%' }, spellcheck: 'false' });
  editor.addEventListener('input', () => {
    if (current) current.code = editor.value;
  });
  const draw = () => {
    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '170px' } },
      mixer.scripts.map((s) => h('div', {
        class: 'btn small',
        style: { textAlign: 'left', borderColor: s === current ? 'var(--accent)' : '' },
        onclick: () => { current = s; draw(); },
      }, `${app.scripts.running.has(s.name) ? '▶ ' : ''}${s.name}`)),
      h('button', {
        class: 'btn small',
        onclick: () => {
          const s = { name: `Script ${mixer.scripts.length + 1}`, code: EXAMPLE_SCRIPT };
          mixer.scripts.push(s);
          current = s;
          draw();
        },
      }, '＋ New script'));
    editor.value = current ? current.code : '';
    editor.disabled = !current;
    const nameIn = h('input', { type: 'text', value: current?.name || '', disabled: !current, oninput: (e) => { if (current) current.name = e.target.value; } });
    body.replaceChildren(
      h('div', { style: { display: 'flex', gap: '10px' } }, list, h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { class: 'row', style: { display: 'flex', gap: '6px' } }, nameIn,
          h('button', { class: 'btn small primary', disabled: !current, onclick: () => current && app.scripts.start(current.name) }, '▶ Run'),
          h('button', { class: 'btn small', disabled: !current, onclick: () => current && app.scripts.stop(current.name) }, '■ Stop'),
          h('button', { class: 'btn small danger', disabled: !current, onclick: () => { app.scripts.stop(current.name); mixer.scripts.splice(mixer.scripts.indexOf(current), 1); current = mixer.scripts[0] || null; draw(); } }, 'Delete')),
        editor)),
      h('div', { class: 'help', style: { margin: '8px 0 4px' } }, 'Run from the API or shortcuts with ScriptStart Value=<name>.'),
      log);
  };
  draw();
  const offs = [
    mixer.on('scripts', draw),
    mixer.on('scriptlog', (msg) => {
      log.textContent += `${msg}\n`;
      log.scrollTop = log.scrollHeight;
    }),
  ];
}

export function openShortcuts(app) {
  const { mixer } = app;
  const body = h('div');
  const p = panel('shortcuts', { title: 'Shortcuts & MIDI', body, width: 700, onClose: () => app.shortcuts.cancelLearn() });
  if (!p) return;
  app.shortcuts.enableMidi();
  const fnList = h('datalist', { id: 'fnList' }, app.api.functionNames.map((n) => h('option', { value: n })));
  const draw = () => {
    const rows = mixer.shortcuts.map((s, i) => {
      const learnBtn = h('button', {
        class: 'btn small',
        onclick: () => {
          learnBtn.textContent = 'Press key / MIDI…';
          app.shortcuts.learn((t) => {
            s.trigger = t;
            draw();
          });
        },
      }, describeTrigger(s.trigger) || 'Learn');
      return h('tr', null,
        h('td', null, learnBtn),
        h('td', null, h('input', { type: 'text', list: 'fnList', value: s.fn, oninput: (e) => { s.fn = e.target.value; } })),
        h('td', null, h('input', { type: 'text', value: s.params || '', placeholder: 'Input=1&Duration=500', style: { width: '100%' }, oninput: (e) => { s.params = e.target.value; } })),
        h('td', null, h('button', { class: 'btn small', onclick: () => app.api.callString(`${s.fn} ${s.params || ''}`) }, 'Test'),
          h('button', { class: 'btn small', onclick: () => { mixer.shortcuts.splice(i, 1); draw(); } }, '✕')));
    });
    const midi = app.shortcuts.midiInputs.length ? `MIDI devices: ${app.shortcuts.midiInputs.map((x) => x.name).join(', ')}` : 'No MIDI devices detected.';
    body.replaceChildren(fnList,
      h('div', { style: { maxHeight: '50vh', overflow: 'auto' } }, h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Trigger'), h('th', null, 'Function'), h('th', null, 'Parameters'), h('th', null, ''))),
        h('tbody', null, rows))),
      h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px' } },
        h('button', { class: 'btn small', onclick: () => { mixer.shortcuts.push({ trigger: null, fn: 'Cut', params: '' }); draw(); } }, '＋ Add'),
        h('button', { class: 'btn small', onclick: () => { mixer.shortcuts = structuredClone(DEFAULT_SHORTCUTS); draw(); } }, 'Reset to defaults')),
      h('p', { class: 'help' }, `${midi} For MIDI faders use parameters like “Input=2&Value={value100}” with SetVolume, or “Value={value}” with SetFader.`));
  };
  draw();
}

export function openLog(app) {
  const body = h('div', { class: 'log' });
  const p = panel('log', { title: 'Output Log', body, width: 640, onClose: () => off() });
  if (!p) return;
  const draw = () => {
    body.textContent = app.outputs.log.join('\n') || 'No messages yet.';
    body.scrollTop = body.scrollHeight;
  };
  draw();
  const off = app.mixer.on('outputlog', draw);
}

export function openHelp() {
  const rows = [
    ['Space', 'Transition 1'], ['Enter', 'Cut'], ['Q / W / E', 'Transitions 2–4'], ['1–9', 'Select input for Preview'],
    ['⇧ 1–9', 'Cut input directly to Output'], ['F1–F4', 'Toggle overlay 1–4 with the Preview input'], ['B', 'Fade to black'],
    ['⌘R', 'Start/stop recording'], ['⇧⌘R', 'Start/stop streaming'], ['⌘S / ⌘O', 'Save / open project'], ['⇧⌘P', 'Snapshot'],
    ['Click tile', 'Preview'], ['Double-click tile', 'Input settings'], ['Right-click tile', 'More actions'], ['Drag tile', 'Reorder inputs'],
  ];
  modal({
    title: 'Keyboard Shortcuts',
    body: h('table', { class: 'list' }, rows.map(([k, v]) => h('tr', null, h('td', null, h('span', { class: 'code' }, k)), h('td', null, v)))),
    width: 520,
    buttons: [{ label: 'Close', primary: true }],
  });
}

export function openApiHelp(app) {
  const names = app.api.functionNames;
  modal({
    title: 'API Reference',
    body: h('div', null,
      h('p', null, 'HTTP: ', h('span', { class: 'code' }, 'GET http://127.0.0.1:8088/api?Function=Fade&Input=2&Duration=1000')),
      h('p', null, 'State (XML): ', h('span', { class: 'code' }, 'GET /api'), '  •  JSON: ', h('span', { class: 'code' }, 'GET /api/state.json'), '  •  Snapshot: ', h('span', { class: 'code' }, 'GET /api/snapshot.jpg')),
      h('p', null, 'TCP (port 8099): ', h('span', { class: 'code' }, 'FUNCTION Cut Input=3'), ' ', h('span', { class: 'code' }, 'XML'), ' ', h('span', { class: 'code' }, 'TALLY'), ' ', h('span', { class: 'code' }, 'SUBSCRIBE TALLY')),
      h('p', { class: 'help' }, 'Input can be the input number, its title, or its key. Values starting with + or - are relative for SetVolume / SetZoom / SetPanX / SetPanY.'),
      h('div', { class: 'log', style: { height: '300px' } }, names.join('\n'))),
    width: 640,
    buttons: [{ label: 'Close', primary: true }],
  });
}

export { toast };
