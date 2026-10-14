// FFmpeg integration: locating the binary, live streaming (RTMP/RTMPS/SRT/file
// via the tee muxer) and post-record remuxing.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let customPath = '';

function setCustomPath(p) {
  customPath = p || '';
}

function candidatePaths() {
  const list = [];
  if (customPath) list.push(customPath);
  try {
    // eslint-disable-next-line global-require
    let p = require('ffmpeg-static');
    if (p) list.push(p.replace('app.asar', 'app.asar.unpacked'));
  } catch {
    /* optional dependency */
  }
  list.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  return list;
}

function findFfmpeg() {
  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']).toString().trim();
    if (out) return out.split('\n')[0];
  } catch {
    /* not on PATH */
  }
  return null;
}

function ffmpegInfo() {
  const bin = findFfmpeg();
  if (!bin) return { found: false };
  let version = '';
  let encoders = '';
  try {
    version = execFileSync(bin, ['-hide_banner', '-version']).toString().split('\n')[0];
    encoders = execFileSync(bin, ['-hide_banner', '-encoders']).toString();
  } catch {
    /* ignore */
  }
  return {
    found: true,
    path: bin,
    version,
    videotoolbox: encoders.includes('h264_videotoolbox'),
    libx264: encoders.includes('libx264'),
  };
}

function muxerFor(url) {
  if (/^rtmps?:\/\//i.test(url)) return 'flv';
  if (/^srt:\/\//i.test(url)) return 'mpegts';
  if (/^udp:\/\//i.test(url)) return 'mpegts';
  if (/\.flv$/i.test(url)) return 'flv';
  if (/\.ts$/i.test(url)) return 'mpegts';
  if (/\.mkv$/i.test(url)) return 'matroska';
  return 'flv';
}

function escapeTee(s) {
  // The tee muxer treats | [ ] as separators; escape them in URLs.
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function buildStreamArgs(opts) {
  const fps = opts.fps || 30;
  const vb = opts.videoBitrate || 6000;
  const ab = opts.audioBitrate || 160;
  const info = ffmpegInfo();
  let encoder = opts.encoder || 'auto';
  if (encoder === 'auto') encoder = info.videotoolbox ? 'h264_videotoolbox' : 'libx264';
  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-fflags', '+genpts', '-i', 'pipe:0'];
  args.push('-map', '0:v:0', '-map', '0:a:0?');
  if (encoder === 'h264_videotoolbox') {
    args.push('-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high');
  } else {
    args.push('-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high');
  }
  args.push(
    '-b:v', `${vb}k`, '-maxrate', `${vb}k`, '-bufsize', `${vb * 2}k`,
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2), '-keyint_min', String(fps * 2),
    '-c:a', 'aac', '-b:a', `${ab}k`, '-ar', '48000', '-ac', '2'
  );
  const dests = opts.destinations.filter((d) => d && d.url);
  const targets = dests.map((d) => {
    let url = d.url.trim();
    if (d.key) url = url.replace(/\/+$/, '') + '/' + d.key.trim();
    return { url, muxer: muxerFor(url) };
  });
  if (targets.length === 1) {
    args.push('-f', targets[0].muxer, targets[0].url);
  } else {
    args.push('-flags', '+global_header', '-f', 'tee',
      targets.map((t) => `[f=${t.muxer}:onfail=ignore]${escapeTee(t.url)}`).join('|'));
  }
  return { args, encoder };
}

class Streamer {
  constructor(onEvent) {
    this.proc = null;
    this.onEvent = onEvent;
  }

  start(opts) {
    if (this.proc) this.stop();
    const bin = findFfmpeg();
    if (!bin) throw new Error('FFmpeg not found. Install it (brew install ffmpeg) or set its path in Settings.');
    if (!opts.destinations || !opts.destinations.some((d) => d && d.url)) throw new Error('No stream destinations enabled.');
    const { args, encoder } = buildStreamArgs(opts);
    this.onEvent({ type: 'log', message: `ffmpeg ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ').replace(/(rtmps?:\/\/[^/]+\/[^/]+\/)[^\s|"]+/g, '$1••••')}` });
    const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.startedAt = Date.now();
    this.encoder = encoder;
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      const m = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?bitrate=\s*([\d.]+\w*bits\/s|N\/A).*?speed=\s*([\d.]+x|N\/A)/.exec(text);
      if (m) {
        this.onEvent({ type: 'stats', frame: +m[1], fps: +m[2], bitrate: m[3], speed: m[4] });
      } else if (text.trim()) {
        this.onEvent({ type: 'log', message: text.trim() });
      }
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.onEvent({ type: 'stopped', code });
    });
    proc.on('error', (err) => {
      this.onEvent({ type: 'error', message: err.message });
    });
    return { ok: true, encoder };
  }

  write(chunk) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(Buffer.from(chunk));
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, 3000);
  }
}

// Remux a finished MediaRecorder file so it has a proper index/duration
// (MediaRecorder writes fragmented / unseekable files). Best effort.
function remux(file, targetExt) {
  return new Promise((resolve) => {
    const bin = findFfmpeg();
    if (!bin) return resolve({ ok: false, file, reason: 'ffmpeg not found' });
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const out = path.join(dir, `${base}.${targetExt}`);
    const tmp = path.join(dir, `.${base}.remux.${targetExt}`);
    const fromWebm = /\.webm$/i.test(file);
    const toMp4 = targetExt === 'mp4' || targetExt === 'mov';
    // Opus isn't playable in QuickTime, so WebM → MP4 re-encodes audio to AAC.
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-c:v', 'copy'];
    args.push(...(fromWebm && toMp4 ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'copy']));
    if (toMp4) args.push('-movflags', '+faststart');
    args.push(tmp);
    const proc = spawn(bin, args, { stdio: 'ignore' });
    proc.on('error', () => resolve({ ok: false, file }));
    proc.on('exit', (code) => {
      if (code === 0) {
        try {
          if (out !== file) fs.unlinkSync(file);
          fs.renameSync(tmp, out);
          return resolve({ ok: true, file: out });
        } catch (e) {
          return resolve({ ok: false, file, reason: e.message });
        }
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      resolve({ ok: false, file, reason: `ffmpeg exited ${code}` });
    });
  });
}

module.exports = { findFfmpeg, ffmpegInfo, setCustomPath, Streamer, remux, buildStreamArgs, muxerFor };
