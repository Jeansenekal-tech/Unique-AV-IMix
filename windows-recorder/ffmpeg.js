// FFmpeg helpers: locating the binary and turning the raw MediaRecorder
// capture (Matroska/WebM, no index) into a finished, seekable file.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findFfmpeg() {
  const list = [];
  try {
    // eslint-disable-next-line global-require
    const p = require('ffmpeg-static');
    if (p) list.push(p.replace('app.asar', 'app.asar.unpacked'));
  } catch {
    /* optional dependency */
  }
  for (const p of list) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']).toString().trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {
    /* not on PATH */
  }
  return null;
}

// Output formats offered in the UI. `audioOnly` formats are used when no
// video device is selected.
const FORMATS = {
  mp4: { ext: 'mp4', muxer: 'mp4', label: 'MP4 (H.264 + AAC)', audioOnly: false },
  mkv: { ext: 'mkv', muxer: 'matroska', label: 'MKV (original streams, fastest)', audioOnly: false },
  m4a: { ext: 'm4a', muxer: 'ipod', label: 'M4A (AAC)', audioOnly: true },
  wav: { ext: 'wav', muxer: 'wav', label: 'WAV (PCM 24-bit)', audioOnly: true },
};

// Build the FFmpeg arguments that convert the raw capture into `format`.
// `videoCodec` is what MediaRecorder produced ('h264', 'vp9', 'vp8' or '').
function buildConvertArgs(input, output, format, videoCodec) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
  switch (format) {
    case 'mp4':
      if (videoCodec === 'h264') args.push('-c:v', 'copy');
      else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
      args.push('-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart');
      break;
    case 'mkv':
      args.push('-c', 'copy');
      break;
    case 'm4a':
      args.push('-vn', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart');
      break;
    case 'wav':
      args.push('-vn', '-c:a', 'pcm_s24le');
      break;
    default:
      throw new Error(`Unknown format ${format}`);
  }
  // Name the muxer explicitly: the output may be a temp file with no extension.
  args.push('-f', FORMATS[format].muxer, output);
  return args;
}

// Convert `input` to `output`. Resolves { ok, file, reason }. On success the
// raw input is deleted; on failure it is kept so nothing is lost.
function convert(input, output, format, videoCodec) {
  return new Promise((resolve) => {
    const bin = findFfmpeg();
    if (!bin) return resolve({ ok: false, file: input, reason: 'FFmpeg not found – the raw recording was kept.' });
    const tmp = path.join(path.dirname(output), `.${path.basename(output)}.part`);
    const args = buildConvertArgs(input, tmp, format, videoCodec);
    let stderr = '';
    const proc = spawn(bin, args, { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => resolve({ ok: false, file: input, reason: e.message }));
    proc.on('exit', (code) => {
      if (code === 0) {
        try {
          fs.renameSync(tmp, output);
          fs.unlinkSync(input);
          return resolve({ ok: true, file: output });
        } catch (e) {
          return resolve({ ok: false, file: input, reason: e.message });
        }
      }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      resolve({ ok: false, file: input, reason: `FFmpeg exited ${code}: ${stderr.trim().split('\n').pop() || ''}` });
    });
  });
}

module.exports = { findFfmpeg, FORMATS, buildConvertArgs, convert };
