// Electron end-to-end test: boots the real app, drives the HTTP + TCP API,
// records to disk, streams through FFmpeg (to a local file) and loads a
// web-browser input. Run under a display (xvfb-run on Linux CI).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
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

// Local update server announcing a newer version
const updateServer = http.createServer((req, res) => {
  if (req.url.startsWith('/updates/update-mac.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ version: '99.0.0', notes: 'Test release', files: [{ name: 'Unique-AV-Streaming-GuRu-99.0.0-x64.zip', arch: 'x64', size: 10, sha512: 'x' }, { name: 'Unique-AV-Streaming-GuRu-99.0.0-arm64.zip', arch: 'arm64', size: 10, sha512: 'x' }] }));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => updateServer.listen(0, '127.0.0.1', r));

const app = await playwright._electron.launch({
  executablePath: require(path.join(root, 'node_modules', 'electron')),
  args: ['--no-sandbox', `--user-data-dir=${userData}`, root],
  cwd: root,
  env: { ...process.env, IMIX_FAKE_MEDIA: '1', UASG_UPDATE_URL: `http://127.0.0.1:${updateServer.address().port}/updates` },
  timeout: 60000,
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => window.imixApp && window.imixApp.ready, null, { timeout: 30000 });
check(true, 'Electron app boots');

// Keep the software-GPU (CI) load low; real Macs run 1080p60.
await page.evaluate(() => { imixApp.mixer.settings.thumbFps = 2; imixApp.mixer.setFormat(320, 180, 15); });
check((await page.title()) === 'Unique AV Streaming GuRu', `window title is the new name (${await page.title()})`);
const upd = await page.evaluate(() => window.imix.updateCheck());
check(upd.status === 'available' && upd.latest === '99.0.0', `auto-update finds newer release (${upd.status} ${upd.latest || upd.error || ''})`);
await page.waitForTimeout(500);
const pill = await page.evaluate(() => document.getElementById('updatePill').textContent);
check(/99\.0\.0/.test(pill), `update shown in top bar (“${pill}”)`);

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
    sock.write('PING\r\nSUBSCRIBE ACTS\r\nSUBSCRIBE TALLY\r\nFUNCTION PreviewInput Input=2\r\nFUNCTION Cut\r\nTALLY\r\nXML\r\n');
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
check(tcp.startsWith('VERSION OK'), 'TCP greeting (VERSION OK)');
check(tcp.includes('PING OK PONG'), 'TCP PING');
check(tcp.includes('SUBSCRIBE OK ACTS') && /ACTS OK Input 2 1/.test(tcp), 'TCP SUBSCRIBE ACTS pushes activator changes');
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

// ---------------------------------------------------- control-surface API
res = await fetch(`${base}/api/?Function=Play&Input=0`);
check(res.ok, 'HTTP /api/ with Input=0 (preview input)');
const xml2 = await (await fetch(`${base}/api`)).text();
check(/<master [^>]*meterF1="/.test(xml2) && /<busA /.test(xml2), 'XML has audio meters and buses');

// ------------------------------------------------------ CPU / GPU monitor
const sys = await page.evaluate(async () => {
  for (let i = 0; i < 30 && !imixApp.system; i++) await new Promise((r) => setTimeout(r, 200));
  return { stats: imixApp.system, cpu: document.querySelector('#statCpu .v').textContent, gpu: document.querySelector('#statGpu .v').textContent, ram: document.querySelector('#statMem .v').textContent };
});
check(sys.stats && Number.isFinite(sys.stats.cpu) && Number.isFinite(sys.stats.appCpu) && sys.stats.memoryMB > 0, `system monitor reports CPU/RAM (${JSON.stringify(sys.stats)})`);
check(/%$/.test(sys.cpu) && sys.gpu && sys.ram, `status bar shows CPU ${sys.cpu} · GPU ${sys.gpu} · RAM ${sys.ram}`);

// ------------------------------------- Unique AV Countdown (integrated)
const cd = await page.evaluate(async () => {
  await imixApp.api.call('CountdownReset');
  const r1 = await imixApp.api.call('CountdownStart');
  await new Promise((r) => setTimeout(r, 1500));
  const snap = await window.imix.countdownSnapshot();
  const inp = await imixApp.mixer.addInput({ type: 'countdown' }, { select: false });
  await new Promise((r) => setTimeout(r, 3000));
  await imixApp.api.call('CountdownMessage', { Value: 'Wrap up' });
  await imixApp.api.call('CountdownAdd', { Value: 60 });
  await new Promise((r) => setTimeout(r, 400));
  const snap2 = await window.imix.countdownSnapshot();
  return {
    ok: r1.ok, running: snap.running, time: snap.time, title: snap.title, err: inp.error || null,
    frame: inp.frame ? [inp.frame.width, inp.frame.height] : null, msg: snap2.messageVisible ? snap2.message : '',
    pill: document.getElementById('cdPill').textContent, inState: !!imixApp.api.stateJson().countdown,
  };
});
check(cd.ok && cd.running, `countdown starts from the mixer API (${cd.time} · ${cd.title})`);
check(cd.frame && cd.frame[0] > 0 && !cd.err, `Countdown input renders the presenter timer (${JSON.stringify(cd.frame)} ${cd.err || ''})`);
check(cd.msg === 'Wrap up', 'CountdownMessage shows a presenter message');
check(/⏱/.test(cd.pill) && cd.inState, `countdown status in top bar (“${cd.pill}”) and API state`);
let cdState = null;
for (let i = 0; i < 20 && !cdState; i++) {
  try {
    cdState = await (await fetch('http://127.0.0.1:8080/api/state')).json();
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
check(cdState && cdState.running && Array.isArray(cdState.segments), `countdown phone remote on :8080 (${cdState?.time} running=${cdState?.running})`);
await new Promise((resolve) => {
  const sock = dgram.createSocket('udp4');
  const pad = (b) => Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
  sock.send(pad(Buffer.from('/timer/pause')), 8000, '127.0.0.1', () => { sock.close(); resolve(); });
});
await new Promise((r) => setTimeout(r, 500));
const afterOsc = await page.evaluate(() => window.imix.countdownSnapshot());
check(afterOsc.running === false && /OSC/.test(afterOsc.lastRemoteEvent), `countdown OSC on UDP 8000 (${afterOsc.lastRemoteEvent})`);
const operatorPage = app.windows().find((w) => w.url().startsWith('app://ui/operator.html'));
const segs = operatorPage ? await operatorPage.evaluate(() => document.querySelectorAll('#segList li').length) : 0;
check(operatorPage && segs > 0, `countdown operator window loaded (${segs} rundown segments)`);

// ------------------------------------------- device / network outputs
const devices = await page.evaluate(() => window.imix.outputDevices());
check(devices && typeof devices.supported === 'boolean', `DeckLink detection (${devices.supported ? devices.devices.join(', ') || 'supported, no cards' : 'not in this FFmpeg build'})`);
const devOut = path.join(out, 'output-feed.flv');
await page.evaluate(async (file) => {
  const vo = imixApp.videoOutputs;
  const o = vo.add({ name: 'Network test', source: 'clean', target: 'stream', url: file, bitrate: 1500 });
  await vo.open(o.id);
  await new Promise((r) => setTimeout(r, 4000));
  vo.remove(o.id);
  await new Promise((r) => setTimeout(r, 2500));
}, devOut);
if (fs.existsSync(devOut)) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'compact=p=0', devOut]).toString();
  check(/codec_name=h264/.test(probe), `clean feed → FFmpeg network output (${probe.trim().replace(/\n/g, ' | ')})`);
} else check(false, 'network output file written');

// --------------------------------------------------------------- ffmpeg info
const ff = await page.evaluate(() => window.imix.ffmpegInfo());
check(ff.found, `FFmpeg detected (${ff.path})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
await page.screenshot({ path: path.join(out, 'electron.png') });
await app.close();
updateServer.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
