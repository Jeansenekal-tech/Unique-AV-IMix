// Outputs window: any number of video/audio outputs, each with its own
// source, destination (display, window, DeckLink, network, audio device)
// and audio bus/device.
import { h, panel, toast } from './dom.js';
import { OUTPUT_TARGETS } from '../engine/video-outputs.js';
import { BUSES, busLabel } from '../engine/audio.js';

export async function openOutputsPanel(app) {
  const { mixer } = app;
  const vo = app.videoOutputs;
  const body = h('div', { class: 'outputs-panel' });
  const p = panel('outputs', { title: '🖥 Outputs', body, width: 760, onClose: () => off() });
  if (!p) return;

  let displays = [];
  let audioDevices = [];
  let decklink = { supported: false, devices: [] };
  try {
    displays = window.imix?.displays ? await window.imix.displays() : [];
  } catch {
    /* ignore */
  }
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (!devs.some((d) => d.kind === 'audiooutput' && d.label)) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      s?.getTracks().forEach((t) => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    }
    audioDevices = devs.filter((d) => d.kind === 'audiooutput');
  } catch {
    /* ignore */
  }
  try {
    decklink = window.imix?.outputDevices ? await window.imix.outputDevices() : decklink;
  } catch {
    /* ignore */
  }

  const sel = (options, value, onChange, attrs = {}) => h('select', { ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, l)));

  function sourceOptions() {
    return [
      ['program', 'Program (output)'],
      ['clean', 'Clean feed (program without overlays)'],
      ['preview', 'Preview'],
      ['multiview', 'Multiview'],
      ...mixer.inputs.filter((i) => i.hasVideo).map((i) => [`input:${i.id}`, `Input ${mixer.inputNumber(i)} – ${i.title}`]),
    ];
  }

  function card(o) {
    const open = vo.isOpen(o.id);
    const save = () => vo.changed();
    const restartIfOpen = async () => {
      save();
      if (vo.isOpen(o.id)) {
        vo.close(o.id);
        await vo.open(o.id).catch((e) => toast(e.message, 'error'));
      }
      draw();
    };
    const targetFields = [];
    if (o.target === 'display') {
      targetFields.push(h('label', null, 'Screen'), sel([['', 'Automatic (first external)'], ...displays.map((d) => [d.id, `${d.label} – ${d.width}×${d.height}${d.primary ? ' (main)' : ''}`])], o.displayId, (v) => { o.displayId = v; restartIfOpen(); }));
    }
    if (o.target === 'decklink') {
      if (decklink.supported) {
        targetFields.push(h('label', null, 'Device'), sel([['', 'Choose…'], ...decklink.devices.map((d) => [d, d])], o.device, (v) => { o.device = v; restartIfOpen(); }));
      } else {
        targetFields.push(h('div', { class: 'full help warn-box' },
          'DeckLink/UltraStudio output needs Blackmagic Desktop Video installed and an FFmpeg built with DeckLink support (the bundled FFmpeg cannot include it for licensing reasons). Set its path in Settings → Streaming → FFmpeg path, then reopen this window. The output format follows the mixer format (Settings → General) and must be a mode the card supports, e.g. 1080p25 / 1080p29.97 / 1080p50.'));
      }
    }
    if (o.target === 'stream') {
      targetFields.push(
        h('label', null, 'URL'), h('input', { type: 'text', value: o.url, placeholder: 'srt://host:9000?mode=caller · rtmp://server/app/key · udp://239.0.0.1:5000', onchange: (e) => { o.url = e.target.value.trim(); restartIfOpen(); } }),
        h('label', null, 'Bitrate (kbps)'), h('input', { type: 'number', min: 500, max: 100000, value: o.bitrate, onchange: (e) => { o.bitrate = Number(e.target.value) || 8000; save(); } }),
      );
    }
    const audioBus = sel([['', o.target === 'audio' ? 'Choose a bus…' : 'No audio'], ...BUSES.map((b) => [b, busLabel(b)])], o.audioBus, (v) => { o.audioBus = v; restartIfOpen(); });
    const audioDev = sel([['', 'System default output'], ...audioDevices.filter((d) => d.deviceId !== 'default').map((d) => [d.deviceId, d.label || 'Audio device'])], o.audioDevice, (v) => { o.audioDevice = v; restartIfOpen(); });
    const showAudioDevice = o.target === 'display' || o.target === 'window' || o.target === 'audio';
    return h('div', { class: `output-card ${open ? 'live' : ''}` },
      h('div', { class: 'output-head' },
        h('span', { class: 'live-dot' }),
        h('input', { type: 'text', class: 'output-name', value: o.name, onchange: (e) => { o.name = e.target.value; save(); } }),
        h('label', { class: 'help' }, h('input', { type: 'checkbox', checked: o.autoStart, onchange: (e) => { o.autoStart = e.target.checked; save(); } }), ' start with project'),
        h('button', {
          class: `btn small ${open ? 'danger' : 'primary'}`,
          onclick: async () => {
            try {
              await vo.toggle(o.id);
            } catch (e) {
              toast(`${o.name}: ${e.message}`, 'error', 7000);
            }
            draw();
          },
        }, open ? 'Stop' : 'Start'),
        h('button', { class: 'x-btn', title: 'Remove output', onclick: () => { vo.remove(o.id); draw(); } }, '×')),
      h('div', { class: 'form' },
        o.target === 'audio' ? null : h('label', null, 'Source'),
        o.target === 'audio' ? null : sel(sourceOptions(), o.source, (v) => { o.source = v; restartIfOpen(); }),
        h('label', null, 'Destination'), sel(OUTPUT_TARGETS, o.target, (v) => { o.target = v; restartIfOpen(); }),
        ...targetFields,
        h('label', null, o.target === 'decklink' || o.target === 'stream' ? 'Audio (embedded)' : 'Audio bus'), audioBus,
        showAudioDevice && o.audioBus ? h('label', null, 'Audio device') : null,
        showAudioDevice && o.audioBus ? audioDev : null));
  }

  function draw() {
    body.replaceChildren(
      h('p', { class: 'help' }, `Add as many outputs as you need – each can show a different source on its own screen, window, Blackmagic card, network stream or audio device. ${displays.length} display${displays.length === 1 ? '' : 's'} connected${decklink.supported ? `, ${decklink.devices.length} DeckLink device(s)` : ''}, ${audioDevices.length} audio output device(s).`),
      ...vo.list.map(card),
      h('div', { class: 'row', style: { display: 'flex', gap: '8px', marginTop: '10px' } },
        h('button', { class: 'btn small primary', onclick: () => { vo.add(); draw(); } }, '＋ Add output'),
        h('button', { class: 'btn small', onclick: () => { vo.add({ name: `Audio ${vo.list.length + 1}`, target: 'audio', audioBus: 'A' }); draw(); } }, '＋ Add audio output'),
        h('button', { class: 'btn small', onclick: () => { vo.closeAll(); draw(); } }, 'Stop all')),
      h('p', { class: 'help' }, 'Screens include HDMI, DisplayPort, USB-C/Thunderbolt adapters, AirPlay displays, and playout or capture devices that macOS shows as a display. Audio devices include interfaces (Focusrite, RME, MOTU…), HDMI/SDI audio and AirPlay speakers.'));
  }
  draw();
  let last = '';
  const off = mixer.on('outputs', () => {
    if (!document.body.contains(body) || body.contains(document.activeElement)) return;
    const sig = JSON.stringify([vo.list, [...vo.runtime.keys()]]);
    if (sig !== last) {
      last = sig;
      draw();
    }
  });
}
