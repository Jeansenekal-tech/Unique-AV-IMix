// Settings dialog: format, recording, streaming, audio, replay, stingers, API.
import { h, modal, tabs, toast } from './dom.js';
import { pickMime } from '../engine/outputs.js';
import { fileSource } from './add-input.js';

const STREAM_PRESETS = {
  Custom: '',
  'YouTube Live': 'rtmp://a.rtmp.youtube.com/live2',
  Twitch: 'rtmp://live.twitch.tv/app',
  'Facebook Live': 'rtmps://live-api-s.facebook.com:443/rtmp',
  'Restream.io': 'rtmp://live.restream.io/live',
  'SRT (caller)': 'srt://host:port?mode=caller',
};

export function openSettings(app, initialTab) {
  const { mixer } = app;
  const s = mixer.settings;
  const save = () => mixer.saveSettings();
  const isApp = !!window.imix?.isElectron;

  const general = () => {
    const res = h('select', null, [
      ['1280x720', 'HD 720p'], ['1920x1080', 'Full HD 1080p'], ['2560x1440', 'QHD 1440p'], ['3840x2160', '4K UHD'],
      ['1080x1920', 'Vertical 1080×1920 (Reels/Shorts/TikTok)'], ['1080x1080', 'Square 1080×1080'], ['720x576', 'PAL SD'],
    ].map(([v, l]) => h('option', { value: v, selected: v === `${s.width}x${s.height}` }, l)));
    const fps = h('select', null, [24, 25, 30, 50, 60].map((f) => h('option', { value: f, selected: f === s.fps }, `${f} fps`)));
    const thumbs = h('select', { onchange: (e) => { s.thumbFps = Number(e.target.value); save(); } },
      [5, 10, 15, 30].map((f) => h('option', { value: f, selected: f === s.thumbFps }, `${f} fps`)));
    return h('div', { class: 'form' },
      h('label', null, 'Output resolution'), res,
      h('label', null, 'Frame rate'), fps,
      h('label', null, ''), h('button', {
        class: 'btn small',
        onclick: () => {
          const [w, hh] = res.value.split('x').map(Number);
          mixer.setFormat(w, hh, Number(fps.value));
          toast(`Output format: ${w}×${hh} @ ${fps.value} fps`);
        },
      }, 'Apply format'),
      h('label', null, 'Multiview refresh'), thumbs,
      h('label', null, 'Show overlays on Preview'), check(s.previewOverlays, (v) => { s.previewOverlays = v; save(); }),
      h('label', null, 'Restore last session on launch'), check(s.autoRestoreSession, (v) => { s.autoRestoreSession = v; save(); }),
      h('div', { class: 'full help' }, 'Higher resolutions and frame rates need more GPU power. Apple Silicon Macs handle 1080p60 comfortably.'));
  };

  const recording = () => {
    const dir = h('input', { type: 'text', value: s.recordDir, placeholder: `${app.info?.moviesDir || 'Downloads (browser)'}`, oninput: (e) => { s.recordDir = e.target.value; save(); }, style: { flex: 1 } });
    const choose = isApp ? h('button', {
      class: 'btn small',
      onclick: async () => {
        const [p] = await window.imix.openDialog({ properties: ['openDirectory', 'createDirectory'] });
        if (p) {
          dir.value = p;
          s.recordDir = p;
          save();
        }
      },
    }, 'Choose…') : null;
    const mp4 = pickMime('mp4');
    return h('div', { class: 'form' },
      h('label', null, 'Folder'), h('div', { class: 'row' }, dir, choose),
      h('label', null, 'File name'), h('input', { type: 'text', value: s.filenamePattern, oninput: (e) => { s.filenamePattern = e.target.value; save(); } }),
      h('label', null, 'Format'), sel([['mp4', `MP4 / H.264 + AAC${mp4.startsWith('video/mp4') ? '' : ' (unavailable – will use WebM)'}`], ['webm', 'WebM / VP9 + Opus']], s.recordFormat, (v) => { s.recordFormat = v; save(); }),
      ...num('Video bitrate (kbps)', s.recordBitrate, 1000, 100000, (v) => { s.recordBitrate = v; save(); }),
      h('label', null, 'Audio source'), busSel(s.recordBus, (v) => { s.recordBus = v; save(); }),
      h('label', null, 'Finalise with FFmpeg'), check(s.remux, (v) => { s.remux = v; save(); }),
      h('div', { class: 'full help' }, 'Finalising rewrites the file index after recording (fast, lossless) so it seeks properly in QuickTime / editors. Requires FFmpeg.'),
      h('div', { class: 'full help' }, '{date} and {time} in the file name are replaced automatically.'));
  };

  const streaming = () => {
    const dests = mixer.streamDestinations.map((d) => {
      const preset = h('select', {
        onchange: (e) => {
          if (STREAM_PRESETS[e.target.value]) {
            d.url = STREAM_PRESETS[e.target.value];
            url.value = d.url;
            if (d.name.startsWith('Destination')) {
              d.name = e.target.value;
              name.value = d.name;
            }
            persist();
          }
        },
      }, Object.keys(STREAM_PRESETS).map((k) => h('option', { value: k, selected: STREAM_PRESETS[k] && STREAM_PRESETS[k] === d.url }, k)));
      const name = h('input', { type: 'text', value: d.name, oninput: (e) => { d.name = e.target.value; persist(); } });
      const url = h('input', { type: 'text', value: d.url, placeholder: 'rtmp://server/app', style: { width: '100%' }, oninput: (e) => { d.url = e.target.value; persist(); } });
      const key = h('input', { type: 'password', value: d.key, placeholder: 'Stream key', oninput: (e) => { d.key = e.target.value; persist(); } });
      return h('div', { class: 'form', style: { marginBottom: '12px', padding: '10px', background: 'var(--bg3)', borderRadius: '6px' } },
        h('label', null, 'Enabled'), h('div', { class: 'row' }, check(d.enabled, (v) => { d.enabled = v; persist(); }), name),
        h('label', null, 'Service'), preset,
        h('label', null, 'URL'), url,
        h('label', null, 'Stream key'), key);
    });
    const ff = h('div', { class: 'help' }, 'Checking FFmpeg…');
    if (window.imix?.ffmpegInfo) {
      window.imix.ffmpegInfo().then((i) => {
        ff.textContent = i.found ? `FFmpeg: ${i.path} — ${i.version}${i.videotoolbox ? ' — Apple VideoToolbox hardware encoder available' : ''}` : 'FFmpeg not found. Install with “brew install ffmpeg” or set a path below.';
      });
    } else ff.textContent = 'Streaming is available in the desktop app.';
    return h('div', null,
      h('p', { class: 'help' }, 'Enabled destinations stream simultaneously. Supports RTMP, RTMPS and SRT.'),
      dests,
      h('div', { class: 'form' },
        ...num('Video bitrate (kbps)', s.streamBitrate, 500, 50000, (v) => { s.streamBitrate = v; save(); }),
        ...num('Audio bitrate (kbps)', s.audioBitrate, 64, 320, (v) => { s.audioBitrate = v; save(); }),
        h('label', null, 'Encoder'), sel([['auto', 'Automatic (hardware on Mac)'], ['h264_videotoolbox', 'Apple VideoToolbox (hardware)'], ['libx264', 'x264 (software)']], s.encoder, (v) => { s.encoder = v; save(); }),
        h('label', null, 'Audio source'), busSel(s.streamBus, (v) => { s.streamBus = v; save(); }),
        h('label', null, 'FFmpeg path'), h('input', {
          type: 'text', value: s.ffmpegPath, placeholder: 'auto-detect',
          onchange: async (e) => {
            s.ffmpegPath = e.target.value;
            save();
            await window.imix?.ffmpegSetPath(s.ffmpegPath);
          },
        }),
        h('div', { class: 'full' }, ff)));
    function persist() {
      mixer.emit('project-changed');
    }
  };

  const audio = () => h('div', { class: 'form' },
    h('label', null, 'Monitor (speakers)'), check(mixer.audio.monitorOn, (v) => { mixer.audio.setMonitor(v); s.monitor = v; save(); }),
    h('label', null, 'Monitor bus'), busSel(mixer.audio.monitorBus, (v) => { mixer.audio.setMonitor(mixer.audio.monitorOn, v); s.monitorBus = v; save(); }),
    h('div', { class: 'full help' }, 'Choose the Mac’s output device (speakers, headphones, audio interface) in System Settings → Sound. Per-input routing to Master / Bus A / Bus B is on each mixer strip.'));

  const replay = () => h('div', { class: 'form' },
    ...num('Buffer length (seconds)', s.replaySeconds, 5, 120, (v) => { s.replaySeconds = v; save(); mixer.applyReplaySettings(); }),
    h('label', null, 'Quality'), sel([['640x360', '360p (low memory)'], ['960x540', '540p'], ['1280x720', '720p'], ['1920x1080', '1080p (high memory)']], s.replayQuality, (v) => { s.replayQuality = v; save(); mixer.applyReplaySettings(); }),
    h('div', { class: 'full help' }, 'Memory use ≈ width × height × 4 × fps × seconds. 540p × 20 s @ 30 fps ≈ 1.2 GB.'));

  const stingers = () => h('div', null, mixer.stingers.map((st, i) => {
    const file = h('span', { class: 'code' }, st.path || st.url || 'none');
    return h('div', { class: 'form', style: { marginBottom: '14px' } },
      h('h4', null, `Stinger ${i + 1}`),
      h('label', null, 'Video'), h('div', { class: 'row' }, file, h('button', {
        class: 'btn small',
        onclick: () => {
          const inp = h('input', { type: 'file', accept: 'video/*' });
          inp.onchange = () => {
            const src = fileSource(inp.files[0]);
            mixer.setStinger(i, src);
            file.textContent = src.path || src.name;
          };
          inp.click();
        },
      }, 'Choose…')),
      ...num('Cut point (ms)', st.cutPoint, 0, 10000, (v) => mixer.setStinger(i, { cutPoint: v })));
  }), h('p', { class: 'help' }, 'Use a WebM (VP8/VP9) with an alpha channel for transparent stingers. The cut point is when the output switches underneath the stinger.'));

  const api = () => {
    const a = s.api;
    const urls = h('div', { class: 'full help' });
    const status = h('div', { class: 'full help' });
    const apply = async () => {
      save();
      if (!window.imix?.apiConfigure) return;
      const st = await window.imix.apiConfigure(a);
      status.textContent = st.running ? '✔ Running' : `✖ ${st.error || 'Stopped'}`;
      app.updateApiStatus?.(st);
      const hosts = a.lan ? await window.imix.netAddresses() : ['127.0.0.1'];
      urls.replaceChildren(...hosts.flatMap((host) => [
        h('div', null, 'Web controller: ', h('span', { class: 'code' }, `http://${host}:${a.httpPort}/`)),
        h('div', null, 'HTTP API: ', h('span', { class: 'code' }, `http://${host}:${a.httpPort}/api?Function=Cut`)),
        h('div', null, 'TCP API: ', h('span', { class: 'code' }, `${host}:${a.tcpPort}`)),
      ]));
    };
    setTimeout(apply);
    if (!window.imix?.apiConfigure) return h('p', { class: 'help' }, 'The web controller and HTTP/TCP API are available in the desktop app.');
    return h('div', { class: 'form' },
      h('label', null, 'Enabled'), check(a.enabled, (v) => { a.enabled = v; apply(); }),
      ...num('HTTP port', a.httpPort, 1024, 65535, (v) => { a.httpPort = v; apply(); }),
      ...num('TCP port', a.tcpPort, 1024, 65535, (v) => { a.tcpPort = v; apply(); }),
      h('label', null, 'Allow network (LAN) access'), check(a.lan, (v) => { a.lan = v; apply(); }),
      h('label', null, 'Password'), h('input', { type: 'password', value: a.password, placeholder: 'none', onchange: (e) => { a.password = e.target.value; apply(); } }),
      status, urls,
      h('div', { class: 'full help' }, 'The API accepts the common switcher function names (Cut, Fade, PreviewInput, OverlayInput1In, SetText, StartRecording …) so control surfaces such as Bitfocus Companion / Stream Deck can drive Unique AV IMix. Enable LAN access to use phones and tablets as remotes — set a password when you do.'));
  };

  const defs = [
    { id: 'general', label: 'General', render: general },
    { id: 'outputs', label: 'Recording', render: recording },
    { id: 'streaming', label: 'Streaming', render: streaming },
    { id: 'audio', label: 'Audio', render: audio },
    { id: 'replay', label: 'Replay', render: replay },
    { id: 'stingers', label: 'Stingers', render: stingers },
    { id: 'api', label: 'Web & API', render: api },
  ];
  const idx = Math.max(0, defs.findIndex((d) => d.id === initialTab));
  modal({ title: 'Settings', body: tabs(defs, idx), width: 720, buttons: [{ label: 'Done', primary: true }] });
}

function check(value, onChange) {
  return h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) });
}

function sel(options, current, onChange) {
  return h('select', { onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === current }, l)));
}

function busSel(current, onChange) {
  return sel([['M', 'Master'], ['A', 'Bus A'], ['B', 'Bus B']], current, onChange);
}

function num(label, value, min, max, onChange) {
  return [h('label', null, label), h('input', { type: 'number', value, min, max, onchange: (e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min))) })];
}
