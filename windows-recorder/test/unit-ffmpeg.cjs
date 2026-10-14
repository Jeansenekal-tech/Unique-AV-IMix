// Unit + integration tests for the FFmpeg conversion step.
// Generates small Matroska/WebM files like MediaRecorder's and converts them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('../ffmpeg');

const args = (f, c) => ffmpeg.buildConvertArgs('in.mkv', 'out', f, c);
assert.deepStrictEqual(args('mp4', 'h264').slice(6, 8), ['-c:v', 'copy'], 'H.264 is copied into MP4');
assert.ok(args('mp4', 'vp9').includes('libx264'), 'VP9 is re-encoded for MP4');
assert.ok(args('mkv', 'vp9').join(' ').includes('-c copy'), 'MKV copies streams');
assert.ok(args('wav', '').includes('pcm_s24le'));
assert.deepStrictEqual(args('m4a', '').slice(-3), ['-f', 'ipod', 'out']);
assert.throws(() => args('avi', ''));

const bin = ffmpeg.findFfmpeg();
assert.ok(bin, 'ffmpeg found');
const probe = (file) => execFileSync(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const info = (file) => {
  try { return probe(file); } catch (e) { return e.stderr.toString(); }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uar-'));
  const make = (name, extra) => {
    const f = path.join(dir, name);
    execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi',
      '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '2', ...extra, f]);
    return f;
  };
  const cases = [
    ['vp8.mkv', ['-c:v', 'libvpx', '-c:a', 'libopus'], 'mp4', 'vp8', /Video: h264.*\n.*Audio: aac/s],
    ['h264.mkv', ['-c:v', 'libx264', '-c:a', 'libopus'], 'mp4', 'h264', /Video: h264.*\n.*Audio: aac/s],
    ['copy.mkv', ['-c:v', 'libvpx', '-c:a', 'libopus'], 'mkv', 'vp8', /Video: vp8.*\n.*Audio: opus/s],
    ['audio.webm', ['-vn', '-c:a', 'libopus'], 'wav', '', /Audio: pcm_s24le/],
    ['audio2.webm', ['-vn', '-c:a', 'libopus'], 'm4a', '', /Audio: aac/],
  ];
  for (const [name, extra, fmt, codec, re] of cases) {
    const raw = make(name, extra);
    const out = path.join(dir, `${name}.${ffmpeg.FORMATS[fmt].ext}`);
    const r = await ffmpeg.convert(raw, out, fmt, codec);
    assert.ok(r.ok, `${name} → ${fmt}: ${r.reason}`);
    assert.ok(!fs.existsSync(raw), 'raw file removed after success');
    assert.match(info(out), re, `${name} → ${fmt} streams`);
    assert.match(info(out), /Duration: 00:00:0[12]/, 'has a duration');
    console.log(`ok  ${name} → ${path.basename(out)}`);
  }
  // A broken input keeps the raw file.
  const bad = path.join(dir, 'bad.mkv');
  fs.writeFileSync(bad, 'not a video');
  const r = await ffmpeg.convert(bad, path.join(dir, 'bad.mp4'), 'mp4', 'h264');
  assert.ok(!r.ok && fs.existsSync(bad) && r.file === bad, 'raw kept on failure');
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.part')), 'no temp files left');
  console.log('ok  failed conversion keeps raw file');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('All ffmpeg tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
