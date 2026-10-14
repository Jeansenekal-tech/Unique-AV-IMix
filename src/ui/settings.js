// Settings dialog: format, recording, streaming, audio, replay, stingers, API.
import { h, modal, tabs, toast } from './dom.js';
import { pickMime } from '../engine/outputs.js';
import { fileSource } from './add-input.js';
import { BUSES, busLabel } from '../engine/audio.js';

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
    const PRESETS = [
      ['1280x720', 'HD 720p'], ['1920x1080', 'Full HD 1080p'], ['2560x1440', 'QHD 1440p'], ['3840x2160', '4K UHD'], ['4096x2160', 'DCI 4K'],
      ['1080x1920', 'Vertical 1080×1920 (Reels / Shorts / TikTok)'], ['720x1280', 'Vertical 720×1280'], ['1080x1080', 'Square 1080×1080'],
      ['1920x1200', 'WUXGA 1920×1200 (projectors)'], ['1280x800', 'WXGA 1280×800 (projectors)'], ['3840x1080', 'Ultra-wide 3840×1080 (LED wall)'],
      ['720x576', 'PAL SD'], ['720x480', 'NTSC SD'],
    ];
    const current = `${s.width}x${s.height}`;
    const isPreset = PRESETS.some(([v]) => v === current);
    const res = h('select', null, PRESETS.map(([v, l]) => h('option', { value: v, selected: v === current }, l)),
      h('option', { value: 'custom', selected: !isPreset }, 'Custom…'));
    const cw = h('input', { type: 'number', min: 64, max: 8192, step: 2, value: s.width, style: { width: '90px' } });
    const ch = h('input', { type: 'number', min: 64, max: 8192, step: 2, value: s.height, style: { width: '90px' } });
    const customRow = h('div', { class: 'row' }, cw, h('span', null, '×'), ch, h('span', { class: 'help' }, 'pixels (even numbers, 64–8192)'));
    const FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 72, 90, 100, 119.88, 120];
    const fps = h('select', null, FPS.map((f) => h('option', { value: f, selected: f === s.fps }, `${f} fps`)),
      h('option', { value: 'custom', selected: !FPS.includes(s.fps) }, 'Custom…'));
    const cf = h('input', { type: 'number', min: 1, max: 240, step: 0.001, value: s.fps, style: { width: '90px' } });
    const fpsRow = h('div', { class: 'row' }, cf, h('span', { class: 'help' }, 'frames per second (1–240)'));
    const sync = () => {
      customRow.style.display = res.value === 'custom' ? 'flex' : 'none';
      fpsRow.style.display = fps.value === 'custom' ? 'flex' : 'none';
      if (res.value !== 'custom') [cw.value, ch.value] = res.value.split('x');
      if (fps.value !== 'custom') cf.value = fps.value;
    };
    res.addEventListener('change', sync);
    fps.addEventListener('change', sync);
    setTimeout(sync);
    const thumbs = h('select', { onchange: (e) => { s.thumbFps = Number(e.target.value); save(); } },
      [5, 10, 15, 30].map((f) => h('option', { value: f, selected: f === s.thumbFps }, `${f} fps`)));
    return h('div', { class: 'form' },
      h('label', null, 'Output resolution'), res,
      h('label', null, ''), customRow,
      h('label', null, 'Frame rate'), fps,
      h('label', null, ''), fpsRow,
      h('label', null, ''), h('button', {
        class: 'btn small primary',
        onclick: () => {
          const even = (v) => Math.max(64, Math.min(8192, Math.round(Number(v) / 2) * 2 || 64));
          const w = even(cw.value);
          const hh = even(ch.value);
          const f = Math.max(1, Math.min(240, Number(cf.value) || 30));
          mixer.setFormat(w, hh, f);
          cw.value = w;
          ch.value = hh;
          toast(`Output format: ${w}×${hh} @ ${f} fps`);
        },
      }, 'Apply format'),
      h('label', null, 'Multiview refresh'), thumbs,
      h('label', null, 'Show overlays on Preview'), check(s.previewOverlays, (v) => { s.previewOverlays = v; save(); }),
      h('label', null, 'Restore last session on launch'), check(s.autoRestoreSession, (v) => { s.autoRestoreSession = v; save(); }),
      h('div', { class: 'full help' }, 'Any size works, including LED-wall and projector resolutions. Higher resolutions and frame rates need more GPU power – Apple Silicon handles 1080p60 comfortably; 4K60 needs an M-series Pro/Max or better. Streaming services expect standard sizes (e.g. 1920×1080).'));
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
    h('div', { class: 'full help' }, 'Choose the Mac’s output device (speakers, headphones, audio interface) in System Settings → Sound. Each input can be sent to Master and Buses A–F from its mixer strip. Use the buses for separate mixes, e.g. a clean feed for recording, a mix-minus for remote guests, or a stream mix without the presenter’s talkback.'));

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
      h('div', { class: 'full help' }, 'The API accepts the common switcher function names (Cut, Fade, PreviewInput, OverlayInput1In, SetText, StartRecording …) so control surfaces such as Bitfocus Companion / Stream Deck can drive Unique AV Streaming GuRu. Enable LAN access to use phones and tablets as remotes — set a password when you do.'));
  };

  const updates = () => {
    const u = s.updates;
    const statusEl = h('div', { class: 'full' });
    const btns = h('div', { class: 'row' });
    const apply = () => {
      save();
      window.imix?.updateConfigure(u);
    };
    const draw = (st) => {
      if (!st) return;
      const lines = {
        idle: 'Not checked yet.',
        checking: 'Checking for updates…',
        uptodate: `You’re up to date. Latest: ${st.latest || st.current}.`,
        available: `Version ${st.latest} is available${st.size ? ` (${(st.size / 1048576).toFixed(0)} MB)` : ''}.`,
        downloading: `Downloading ${st.latest}… ${Math.round((st.progress || 0) * 100)}%`,
        ready: `Version ${st.latest} is downloaded and ready to install.`,
        installing: 'Installing…',
        error: `Problem: ${st.error}`,
      };
      statusEl.replaceChildren(h('p', null, h('b', null, `Installed version ${st.current}. `), lines[st.status] || ''),
        st.notes && ['available', 'ready', 'downloading'].includes(st.status) ? h('div', { class: 'log', style: { height: '110px' } }, st.notes) : '',
        !st.supported ? h('p', { class: 'help' }, 'Automatic installation works in the installed Mac app (not in development mode).') : '');
      btns.replaceChildren(
        h('button', { class: 'btn small', onclick: () => window.imix.updateCheck() }, 'Check now'),
        st.status === 'available' ? h('button', { class: 'btn small primary', onclick: () => window.imix.updateDownload() }, st.supported ? 'Download update' : 'Open download page') : '',
        st.status === 'ready' ? h('button', { class: 'btn small primary', onclick: () => app.promptInstallUpdate?.() }, 'Restart & Update') : '');
    };
    if (!window.imix?.updateStatus) return h('p', { class: 'help' }, 'Updates are available in the desktop app.');
    window.imix.updateStatus().then(draw);
    const off = mixer.on('update', draw);
    setTimeout(() => {
      const obs = new MutationObserver(() => {
        if (!document.body.contains(statusEl)) {
          off();
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
    return h('div', { class: 'form' },
      statusEl, h('label', null, ''), btns,
      h('label', null, 'Check automatically'), check(u.auto, (v) => { u.auto = v; apply(); }),
      h('label', null, 'Download in background'), check(u.autoDownload, (v) => { u.autoDownload = v; apply(); }),
      h('label', null, 'Update URL'), h('input', { type: 'text', value: u.url, placeholder: 'default (GitHub Releases)', onchange: (e) => { u.url = e.target.value.trim(); apply(); } }),
      h('div', { class: 'full help' }, 'Updates download quietly and never interrupt a show: the app only restarts when you click “Restart & Update”, or installs when you next quit. The update URL is a folder containing update-mac.json (published by the release workflow).'));
  };

  const defs = [
    { id: 'general', label: 'General', render: general },
    { id: 'outputs', label: 'Recording', render: recording },
    { id: 'streaming', label: 'Streaming', render: streaming },
    { id: 'audio', label: 'Audio', render: audio },
    { id: 'replay', label: 'Replay', render: replay },
    { id: 'stingers', label: 'Stingers', render: stingers },
    { id: 'api', label: 'Web & API', render: api },
    { id: 'updates', label: 'Updates', render: updates },
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
  return sel(BUSES.map((b) => [b, busLabel(b)]), current, onChange);
}

function num(label, value, min, max, onChange) {
  return [h('label', null, label), h('input', { type: 'number', value, min, max, onchange: (e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min))) })];
}
