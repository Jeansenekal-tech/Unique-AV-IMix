// Electron end-to-end test: boots the real app, drives the HTTP + TCP API,
// records to disk, streams through FFmpeg (to a local file) and loads a
// web-browser input. Run under a display (xvfb-run on Linux CI).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(here, 'output', 'electron');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const userData = path.join(out, 'profile');

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

const app = await playwright._electron.launch({
  executablePath: require(path.join(root, 'node_modules', 'electron')),
  args: ['--no-sandbox', `--user-data-dir=${userData}`, root],
  cwd: root,
  env: { ...process.env, IMIX_FAKE_MEDIA: '1' },
  timeout: 60000,
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => window.imixApp && window.imixApp.ready, null, { timeout: 30000 });
check(true, 'Electron app boots');
// Keep the software-GPU (CI) load low; real Macs run 1080p60.
await page.evaluate(() => { imixApp.mixer.settings.thumbFps = 2; imixApp.mixer.setFormat(320, 180, 15); });

// ---------------------------------------------------------------- HTTP API
const base = 'http://127.0.0.1:8088';
let ok = false;
for (let i = 0; i < 20 && !ok; i++) {
  try {
    ok = (await fetch(`${base}/api/state.json`)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
check(ok, 'HTTP API listening on :8088');
let res = await fetch(`${base}/api?Function=PreviewInput&Input=1`);
check(res.ok && (await res.text()).includes('successfully'), 'HTTP PreviewInput');
res = await fetch(`${base}/api?Function=Cut`);
check(res.ok, 'HTTP Cut');
const xml = await (await fetch(`${base}/api`)).text();
check(/<active>1<\/active>/.test(xml) && /<inputs>/.test(xml), 'HTTP XML state reflects cut');
res = await fetch(`${base}/api?Function=Nope`);
check(res.status === 500, 'unknown function → 500');
const snap = await fetch(`${base}/api/snapshot.jpg`);
check(snap.ok && (await snap.arrayBuffer()).byteLength > 1000, 'snapshot.jpg');
const web = await (await fetch(`${base}/`)).text();
check(web.includes('Unique AV'), 'web controller served');

// ----------------------------------------------------------------- TCP API
const tcp = await new Promise((resolve, reject) => {
  const sock = net.connect(8099, '127.0.0.1');
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
  });
  sock.on('connect', () => {
    sock.write('SUBSCRIBE TALLY\r\nFUNCTION PreviewInput Input=2\r\nTALLY\r\nXML\r\n');
    const start = Date.now();
    const wait = setInterval(() => {
      if (/<\/vmix>/.test(buf) || Date.now() - start > 15000) {
        clearInterval(wait);
        sock.end();
        resolve(buf);
      }
    }, 100);
  });
  sock.on('error', reject);
});
check(tcp.includes('SUBSCRIBE OK TALLY'), 'TCP SUBSCRIBE TALLY');
check(tcp.includes('FUNCTION OK Completed'), 'TCP FUNCTION');
check(/TALLY OK [012]+/.test(tcp), 'TCP TALLY');
check(/XML \d+\r\n<vmix>/.test(tcp), 'TCP XML');

// --------------------------------------------------------------- recording
await page.evaluate((dir) => {
  imixApp.mixer.settings.recordDir = dir;
}, out);
const recFile = await page.evaluate(async () => {
  await imixApp.outputs.startRecording();
  await new Promise((r) => setTimeout(r, 3000));
  await imixApp.outputs.stopRecording();
  return imixApp.outputs.lastRecording;
});
check(recFile && fs.existsSync(recFile), `recording written (${recFile})`);
if (recFile && fs.existsSync(recFile)) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'compact=p=0', recFile]).toString();
  check(/codec_type=video/.test(probe) && /codec_type=audio/.test(probe), `recording has video + audio (${probe.trim().replace(/\n/g, ' | ')})`);
}

// --------------------------------------------------------------- streaming
const streamOut = path.join(out, 'stream.flv');
await page.evaluate((file) => {
  imixApp.mixer.streamDestinations = [{ name: 'Local', url: file, key: '', enabled: true }];
  imixApp.mixer.settings.encoder = 'libx264';
  imixApp.mixer.settings.streamBitrate = 1500;
}, streamOut);
const streamErr = await page.evaluate(async () => {
  try {
    await imixApp.outputs.startStreaming();
    await new Promise((r) => setTimeout(r, 4000));
    await imixApp.outputs.stopStreaming();
    await new Promise((r) => setTimeout(r, 1500));
    return null;
  } catch (e) {
    return e.message;
  }
});
check(!streamErr, `streaming start/stop (${streamErr || 'ok'})`);
const log = await page.evaluate(() => imixApp.outputs.log.join('\n'));
if (fs.existsSync(streamOut)) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'compact=p=0', streamOut]).toString();
  check(/codec_name=h264/.test(probe) && /codec_name=aac/.test(probe), `FFmpeg stream output is H.264 + AAC (${probe.trim().replace(/\n/g, ' | ')})`);
} else {
  check(false, `stream output file exists\n${log}`);
}

// ------------------------------------------------------------ browser input
const browserFrames = await page.evaluate(async () => {
  const inp = await imixApp.mixer.addInput({ type: 'browser', url: 'data:text/html,<body style="background:%23ff0000"><h1>IMix</h1></body>', width: 320, height: 180, fps: 10 }, { select: false });
  await new Promise((r) => setTimeout(r, 2500));
  const f = inp.frame;
  return f ? { w: f.width, h: f.height, px: [f.data[0], f.data[1], f.data[2]] } : null;
});
check(browserFrames && browserFrames.w > 0, `browser input receives frames (${JSON.stringify(browserFrames)})`);

// ---------------------------------------------------------- external output
const ext = await page.evaluate(async () => {
  await imixApp.outputs.openExternal(null);
  await new Promise((r) => setTimeout(r, 2500));
  const w = imixApp.outputs.externalWin;
  const v = w && !w.closed && w.document.getElementById('out');
  const ok = !!(v && v.srcObject && v.srcObject.getVideoTracks().length);
  imixApp.outputs.closeExternal();
  return ok;
});
check(ext, 'external output window receives the program stream');

// --------------------------------------------------------------- ffmpeg info
const ff = await page.evaluate(() => window.imix.ffmpegInfo());
check(ff.found, `FFmpeg detected (${ff.path})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
await page.screenshot({ path: path.join(out, 'electron.png') });
await app.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
