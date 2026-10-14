// Unique AV Recorder – renderer. Opens the chosen video and audio devices,
// shows a preview and level meters, and records with MediaRecorder. Chunks go
// to the main process, which writes them to disk and converts with FFmpeg.
/* global recorder */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    preview: $('preview'), noVideo: $('noVideo'), videoInfo: $('videoInfo'),
    recBadge: $('recBadge'), recBadgeTime: $('recBadgeTime'),
    meterL: $('meterL'), meterR: $('meterR'), peakL: $('peakL'), peakR: $('peakR'),
    recordBtn: $('recordBtn'), recordLabel: $('recordLabel'),
    time: $('time'), size: $('size'), free: $('free'), status: $('status'),
    videoDevice: $('videoDevice'), resolution: $('resolution'), fps: $('fps'),
    audioDevice: $('audioDevice'), gain: $('gain'), gainOut: $('gainOut'), monitor: $('monitor'),
    volume: $('volume'), volumeOut: $('volumeOut'), mute: $('mute'),
    format: $('format'), bitrate: $('bitrate'), bitrateField: $('bitrateField'),
    name: $('name'), folder: $('folder'), chooseFolder: $('chooseFolder'), openFolder: $('openFolder'),
    recent: $('recent'),
  };
  const LOCKED = ['videoDevice', 'resolution', 'fps', 'audioDevice', 'format', 'bitrate', 'name', 'chooseFolder'];

  let settings = {};
  let formats = {};
  let videoStream = null;
  let audioStream = null;
  let rec = null; // { mr, startedAt, queue, timer, codec, failed }
  let stopping = false;

  // Audio graph: device → input gain (trim) → volume/mute → { meters,
  // record destination, monitor }. Meters show exactly what is recorded.
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const gainNode = ctx.createGain();
  const volumeNode = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
  const recordDest = ctx.createMediaStreamDestination();
  const monitorGain = ctx.createGain();
  recordDest.channelCount = 2;
  gainNode.channelCount = 2;
  gainNode.channelCountMode = 'explicit'; // mono devices are up-mixed to both channels
  analysers.forEach((a, i) => { a.fftSize = 2048; splitter.connect(a, i); });
  gainNode.connect(volumeNode);
  volumeNode.connect(splitter);
  volumeNode.connect(recordDest);
  volumeNode.connect(monitorGain);
  monitorGain.connect(ctx.destination);
  monitorGain.gain.value = 0;
  let audioSource = null;

  function setStatus(msg, kind = '') {
    el.status.textContent = msg;
    el.status.className = `status ${kind}`;
  }

  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  };
  const fmtBytes = (b) => {
    if (b == null) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i >= 3 ? 2 : (i ? 1 : 0))} ${u[i]}`;
  };

  // ------------------------------------------------------------ devices
  function fillSelect(select, devices, noneLabel, keep) {
    select.innerHTML = '';
    const none = new Option(noneLabel, '');
    select.add(none);
    devices.forEach((d, i) => select.add(new Option(d.label || `Device ${i + 1}`, d.deviceId)));
    if (keep != null && [...select.options].some((o) => o.value === keep)) select.value = keep;
  }

  async function refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const video = devices.filter((d) => d.kind === 'videoinput');
    const audio = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const vKeep = el.videoDevice.options.length ? el.videoDevice.value : (settings.videoDevice ?? video[0]?.deviceId ?? '');
    const aKeep = el.audioDevice.options.length ? el.audioDevice.value : (settings.audioDevice ?? '');
    fillSelect(el.videoDevice, video, 'None (audio only)', vKeep);
    fillSelect(el.audioDevice, audio, 'None (no audio)', aKeep);
    el.videoDevice.dataset.groups = JSON.stringify(Object.fromEntries(video.map((d) => [d.deviceId, d.groupId])));
    el.audioDevice.dataset.groups = JSON.stringify(Object.fromEntries(audio.map((d) => [d.deviceId, d.groupId])));
    return { video, audio };
  }

  // A capture card usually exposes its embedded audio as a separate audio
  // device in the same group. Pick it when the user hasn't chosen one.
  function matchingAudioFor(videoId) {
    const vg = JSON.parse(el.videoDevice.dataset.groups || '{}')[videoId];
    if (!vg) return null;
    const ag = JSON.parse(el.audioDevice.dataset.groups || '{}');
    return Object.keys(ag).find((id) => ag[id] === vg) || null;
  }

  async function openVideo() {
    if (videoStream) videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
    el.preview.srcObject = null;
    el.videoInfo.textContent = '';
    const id = el.videoDevice.value;
    el.noVideo.hidden = !!id;
    if (!id) return;
    const v = { deviceId: { exact: id } };
    if (el.resolution.value) {
      const [w, h] = el.resolution.value.split('x').map(Number);
      v.width = { ideal: w };
      v.height = { ideal: h };
    }
    if (el.fps.value) v.frameRate = { ideal: Number(el.fps.value) };
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    } catch (e) {
      el.noVideo.hidden = false;
      el.noVideo.textContent = 'Could not open the video device';
      setStatus(`Video device error: ${e.message || e.name}. Close other apps that use it and try again.`, 'error');
      return;
    }
    el.preview.srcObject = videoStream;
    const track = videoStream.getVideoTracks()[0];
    const s = track.getSettings();
    el.videoInfo.textContent = `${s.width} × ${s.height}${s.frameRate ? ` @ ${Math.round(s.frameRate * 100) / 100} fps` : ''}`;
    track.addEventListener('ended', () => setStatus('The video device was disconnected.', 'error'));
  }

  async function openAudio() {
    if (audioSource) audioSource.disconnect();
    audioSource = null;
    if (audioStream) audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
    const id = el.audioDevice.value;
    if (!id) return;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: id },
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
          // Record the signal as it comes in – no "call" processing.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (e) {
      setStatus(`Audio device error: ${e.message || e.name}`, 'error');
      return;
    }
    audioSource = ctx.createMediaStreamSource(audioStream);
    audioSource.connect(gainNode);
    if (ctx.state !== 'running') ctx.resume();
    audioStream.getAudioTracks()[0].addEventListener('ended', () => setStatus('The audio device was disconnected.', 'error'));
  }

  // ------------------------------------------------------------ meters
  const peaks = [{ v: 0, t: 0 }, { v: 0, t: 0 }];
  const buf = new Float32Array(2048);
  const toPct = (lin) => {
    if (lin <= 0) return 0;
    const db = 20 * Math.log10(lin);
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  };
  function drawMeters() {
    const now = performance.now();
    analysers.forEach((a, i) => {
      let peak = 0;
      if (audioSource) {
        a.getFloatTimeDomainData(buf);
        for (let j = 0; j < buf.length; j++) peak = Math.max(peak, Math.abs(buf[j]));
      }
      const pct = toPct(peak);
      const p = peaks[i];
      if (pct >= p.v || now - p.t > 1500) { p.v = pct; p.t = now; }
      (i ? el.meterR : el.meterL).style.width = `${100 - pct}%`;
      const peakEl = i ? el.peakR : el.peakL;
      peakEl.style.left = `calc(${p.v}% - 2px)`;
      peakEl.style.opacity = p.v > 0 ? 1 : 0;
      peakEl.style.background = p.v >= 95 ? 'var(--rec)' : '#fff';
    });
    requestAnimationFrame(drawMeters);
  }

  // ------------------------------------------------------------ formats
  function fillFormats() {
    const audioOnly = !el.videoDevice.value;
    const keep = audioOnly ? settings.audioFormat : settings.videoFormat;
    el.format.innerHTML = '';
    Object.entries(formats)
      .filter(([, f]) => f.audioOnly === audioOnly)
      .forEach(([key, f]) => el.format.add(new Option(f.label, key)));
    if (keep && [...el.format.options].some((o) => o.value === keep)) el.format.value = keep;
    el.bitrateField.hidden = audioOnly;
  }

  function pickMime(withVideo) {
    const list = withVideo
      ? [
        ['video/x-matroska;codecs=avc1,opus', 'h264'],
        ['video/webm;codecs=h264,opus', 'h264'],
        ['video/webm;codecs=vp9,opus', 'vp9'],
        ['video/webm;codecs=vp8,opus', 'vp8'],
        ['video/webm', ''],
      ]
      : [['audio/webm;codecs=opus', ''], ['audio/webm', '']];
    return list.find(([m]) => MediaRecorder.isTypeSupported(m)) || ['', ''];
  }

  // ------------------------------------------------------------ recording
  function lock(on) {
    LOCKED.forEach((k) => { el[k].disabled = on; });
    el.recordBtn.classList.toggle('on', on);
    el.recordLabel.textContent = on ? 'Stop' : 'Record';
    el.recBadge.hidden = !on;
  }

  async function updateFree() {
    el.free.textContent = fmtBytes(await recorder.diskFree(el.folder.value));
  }

  async function start() {
    const hasVideo = !!videoStream;
    const hasAudio = !!audioStream;
    if (!hasVideo && !hasAudio) {
      setStatus('Choose a video device, an audio device, or both.', 'error');
      return;
    }
    if (ctx.state !== 'running') await ctx.resume();
    const tracks = [];
    if (hasVideo) tracks.push(videoStream.getVideoTracks()[0]);
    if (hasAudio) tracks.push(recordDest.stream.getAudioTracks()[0]);
    const [mimeType, codec] = pickMime(hasVideo);
    let mr;
    try {
      mr = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: Number(el.bitrate.value) * 1e6,
        audioBitsPerSecond: 256000,
      });
    } catch (e) {
      setStatus(`Could not start the recorder: ${e.message}`, 'error');
      return;
    }
    let paths;
    try {
      paths = await recorder.start({ folder: el.folder.value, format: el.format.value, codec, name: el.name.value });
    } catch (e) {
      setStatus(`Could not create the file: ${e.message}`, 'error');
      return;
    }
    rec = { mr, startedAt: performance.now(), queue: Promise.resolve(), codec, failed: false };
    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const r = rec;
      r.queue = r.queue.then(async () => {
        const res = await recorder.chunk(await e.data.arrayBuffer());
        if (res.bytes != null) el.size.textContent = fmtBytes(res.bytes);
        if (!res.ok && !r.failed) {
          r.failed = true;
          setStatus(`Write error: ${res.error || 'unknown'} – stopping.`, 'error');
          stop();
        }
      });
    };
    mr.onerror = (e) => {
      setStatus(`Recorder error: ${e.error?.message || 'unknown'}`, 'error');
      stop();
    };
    mr.start(1000);
    lock(true);
    el.size.textContent = '0 B';
    rec.timer = setInterval(() => {
      const t = fmtTime(performance.now() - rec.startedAt);
      el.time.textContent = t;
      el.recBadgeTime.textContent = t;
    }, 250);
    rec.freeTimer = setInterval(updateFree, 10000);
    setStatus(`Recording to ${paths.output}`);
  }

  async function stop() {
    if (!rec || stopping) return;
    stopping = true;
    const r = rec;
    el.recordBtn.disabled = true;
    clearInterval(r.timer);
    clearInterval(r.freeTimer);
    if (r.mr.state !== 'inactive') {
      await new Promise((resolve) => {
        r.mr.addEventListener('stop', resolve, { once: true });
        r.mr.stop();
      });
    }
    await r.queue; // all chunks are on disk
    setStatus('Finishing the file…');
    const res = await recorder.stop();
    rec = null;
    stopping = false;
    lock(false);
    el.recordBtn.disabled = false;
    addRecent(res, fmtTime(performance.now() - r.startedAt));
    if (res.ok) setStatus(`Saved ${res.file}`, 'ok');
    else setStatus(`${res.reason || 'Conversion failed.'}${res.file ? ` Raw recording kept: ${res.file}` : ''}`, 'error');
    updateFree();
  }

  function addRecent(res, duration) {
    if (!res.file) return;
    el.recent.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    if (!res.ok) li.className = 'failed';
    const a = document.createElement('a');
    a.textContent = res.file.split(/[\\/]/).pop();
    a.title = 'Show in folder';
    a.addEventListener('click', () => recorder.showFile(res.file));
    const small = document.createElement('small');
    small.textContent = res.ok ? duration : `${duration} – not converted`;
    li.append(a, small);
    el.recent.prepend(li);
  }

  // ------------------------------------------------------------ wiring
  function save(patch) {
    Object.assign(settings, patch);
    recorder.setSettings(patch);
  }

  async function init() {
    settings = await recorder.getSettings();
    formats = settings.formats;
    el.folder.value = settings.folder;
    if (settings.resolution != null) el.resolution.value = settings.resolution;
    else el.resolution.value = '1920x1080';
    if (settings.fps != null) el.fps.value = settings.fps;
    if (settings.bitrate) el.bitrate.value = settings.bitrate;
    if (settings.name) el.name.value = settings.name;
    if (settings.gain != null) el.gain.value = settings.gain;
    if (settings.volume != null) el.volume.value = settings.volume;
    setMute(!!settings.mute);
    applyLevels();
    if (!settings.ffmpeg) setStatus('FFmpeg was not found: recordings are saved but not converted.', 'error');

    // Device labels are only available once access has been granted.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch { /* no devices yet */ }
    }
    const { video, audio } = await refreshDevices();
    if (settings.audioDevice == null && el.videoDevice.value) {
      const match = matchingAudioFor(el.videoDevice.value);
      if (match) el.audioDevice.value = match;
    }
    if (!video.length && !audio.length) setStatus('No capture devices found. Connect a capture card or USB audio device.', 'error');
    fillFormats();
    await Promise.all([openVideo(), openAudio()]);
    updateFree();
    requestAnimationFrame(drawMeters);
  }

  el.videoDevice.addEventListener('change', async () => {
    save({ videoDevice: el.videoDevice.value });
    if (settings.audioDevice == null) {
      const match = matchingAudioFor(el.videoDevice.value);
      if (match) {
        el.audioDevice.value = match;
        openAudio();
      }
    }
    fillFormats();
    await openVideo();
  });
  el.resolution.addEventListener('change', () => { save({ resolution: el.resolution.value }); openVideo(); });
  el.fps.addEventListener('change', () => { save({ fps: el.fps.value }); openVideo(); });
  el.audioDevice.addEventListener('change', () => { save({ audioDevice: el.audioDevice.value }); openAudio(); });
  // ------------------------------------------------------------ levels
  const VOLUME_OFF = -60; // bottom of the fader = silence
  const dbText = (db) => (db <= VOLUME_OFF ? '-∞ dB' : `${db > 0 ? '+' : ''}${db} dB`);
  function setGain(node, db) {
    // Short ramp so moving a slider doesn't click in the recording.
    node.gain.setTargetAtTime(db <= VOLUME_OFF ? 0 : 10 ** (db / 20), ctx.currentTime, 0.015);
  }
  function applyLevels() {
    const gain = Number(el.gain.value);
    const vol = Number(el.volume.value);
    setGain(gainNode, gain);
    setGain(volumeNode, el.mute.getAttribute('aria-pressed') === 'true' ? VOLUME_OFF : vol);
    el.gainOut.textContent = dbText(gain);
    el.volumeOut.textContent = dbText(vol);
  }
  function setMute(on) {
    el.mute.setAttribute('aria-pressed', String(on));
    el.mute.textContent = on ? 'Muted' : 'Mute';
  }
  el.gain.addEventListener('input', applyLevels);
  el.volume.addEventListener('input', applyLevels);
  el.gain.addEventListener('change', () => save({ gain: Number(el.gain.value) }));
  el.volume.addEventListener('change', () => save({ volume: Number(el.volume.value) }));
  el.gain.addEventListener('dblclick', () => { el.gain.value = 0; applyLevels(); save({ gain: 0 }); });
  el.volume.addEventListener('dblclick', () => { el.volume.value = 0; applyLevels(); save({ volume: 0 }); });
  el.mute.addEventListener('click', (e) => {
    e.preventDefault(); // the button sits inside a <label>
    setMute(el.mute.getAttribute('aria-pressed') !== 'true');
    applyLevels();
    save({ mute: el.mute.getAttribute('aria-pressed') === 'true' });
  });
  el.monitor.addEventListener('change', () => {
    monitorGain.gain.value = el.monitor.checked ? 1 : 0;
    if (ctx.state !== 'running') ctx.resume();
  });
  el.format.addEventListener('change', () => save(el.videoDevice.value ? { videoFormat: el.format.value } : { audioFormat: el.format.value }));
  el.bitrate.addEventListener('change', () => save({ bitrate: el.bitrate.value }));
  el.name.addEventListener('change', () => save({ name: el.name.value }));
  el.chooseFolder.addEventListener('click', async () => {
    const f = await recorder.chooseFolder();
    if (f) { el.folder.value = f; settings.folder = f; updateFree(); }
  });
  el.openFolder.addEventListener('click', () => recorder.openFolder(el.folder.value));
  el.recordBtn.addEventListener('click', () => (rec ? stop() : start()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F9') { e.preventDefault(); if (!el.recordBtn.disabled) el.recordBtn.click(); }
  });
  navigator.mediaDevices.addEventListener('devicechange', () => { if (!rec) refreshDevices(); });

  // Exposed for the automated smoke test.
  window.__uar = {
    start, stop, isRecording: () => !!rec,
    levels: () => ({ gain: gainNode.gain.value, volume: volumeNode.gain.value }),
  };

  init().catch((e) => setStatus(`Startup error: ${e.message}`, 'error'));
})();
