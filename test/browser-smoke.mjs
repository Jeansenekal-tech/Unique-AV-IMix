// End-to-end smoke test of the mixer UI in Chromium (fake camera/mic).
// Usage: node test/browser-smoke.mjs   (needs playwright + ffmpeg for fixtures)
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'output');
const fixtures = path.join(out, 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });
if (!fs.existsSync(path.join(fixtures, 'clip.webm'))) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libopus', '-shortest', path.join(fixtures, 'clip.webm')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00b140:s=640x360,drawbox=x=220:y=100:w=200:h=160:color=red:t=fill', '-frames:v', '1', path.join(fixtures, 'green.png')]);
}

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

const server = await serve(0, fixtures);
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await playwright.chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(url);
await page.waitForFunction(() => window.imixApp && window.imixApp.ready, null, { timeout: 20000 });
check(true, 'app boots');
// SwiftShader (software GPU in CI) is slow at 1080p; a real Mac GPU is not.
await page.evaluate(() => imixApp.mixer.setFormat(640, 360, 30));

const s0 = await page.evaluate(() => ({ n: imixApp.mixer.inputs.length, pg: imixApp.mixer.inputNumber(imixApp.mixer.getInput(imixApp.mixer.programId)) }));
check(s0.n === 4, `starter project has 4 inputs (got ${s0.n})`);
check(s0.pg === 2, `program is input 2 (got ${s0.pg})`);

await page.waitForTimeout(800);
const px = async () => page.evaluate(() => {
  const c = document.getElementById('programCanvas');
  const t = document.createElement('canvas');
  t.width = 64; t.height = 36;
  const x = t.getContext('2d');
  x.drawImage(c, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  const mid = x.getImageData(32, 18, 1, 1).data;
  return { avg: sum / (d.length / 4) / 3, mid: [mid[0], mid[1], mid[2]] };
});
const p1 = await px();
check(p1.avg > 10, `program output renders (avg luma ${p1.avg.toFixed(1)})`);
await page.waitForTimeout(1500);
const fps = await page.evaluate(() => imixApp.mixer.stats.fps);
check(fps > 10, `render loop running (${fps.toFixed(1)} fps)`);

// API: transition
let r = await page.evaluate(() => imixApp.api.call('Fade', { Input: 1, Duration: 300 }));
check(r.ok, 'API Fade Input=1');
await page.waitForTimeout(600);
r = await page.evaluate(() => imixApp.mixer.inputNumber(imixApp.mixer.getInput(imixApp.mixer.programId)));
check(r === 1, `after fade program is 1 (got ${r})`);
const midColour = (await px()).mid;
check(Math.abs(midColour[0] - 0x14) < 12 && Math.abs(midColour[2] - 0x3d) < 12, `program shows colour input (${midColour})`);

// T-bar
await page.evaluate(() => imixApp.mixer.setPreview(2));
await page.evaluate(() => imixApp.mixer.setTbar(0.5));
r = await page.evaluate(() => !!imixApp.mixer.trans && imixApp.mixer.trans.manual);
check(r, 'T-bar starts manual transition');
await page.evaluate(() => imixApp.mixer.setTbar(1));
r = await page.evaluate(() => ({ t: !!imixApp.mixer.trans, pg: imixApp.mixer.inputNumber(imixApp.mixer.getInput(imixApp.mixer.programId)) }));
check(!r.t && r.pg === 2, 'T-bar completes transition');

// Each transition type renders without GL errors
r = await page.evaluate(async () => {
  const { TRANSITIONS } = await import('./engine/transitions.js');
  const m = imixApp.mixer;
  const bad = [];
  for (const t of TRANSITIONS) {
    if (t.id === -1 || t.id === 'stinger') continue;
    m.trans = { def: t, from: m.programId, to: m.previewId, start: performance.now() - 250, duration: 500, manual: false };
    m.compositor.frame(performance.now(), {});
    const err = m.compositor.gl.getError();
    if (err) bad.push(`${t.name}:${err}`);
  }
  m.trans = null;
  return bad;
});
check(r.length === 0, `all transition shaders render (${r.join(',') || 'ok'})`);

// Overlay
r = await page.evaluate(() => imixApp.api.call('OverlayInput1In', { Input: 3 }));
check(r.ok, 'OverlayInput1In');
await page.waitForTimeout(700);
r = await page.evaluate(() => imixApp.mixer.overlays[0].state);
check(r === 'on', `overlay 1 is on (${r})`);
r = await page.evaluate(() => imixApp.api.stateXml());
check(r.includes('<overlay number="1">3</overlay>'), 'XML reports overlay');
await page.evaluate(() => imixApp.api.call('OverlayInput1Out'));
await page.waitForTimeout(700);
r = await page.evaluate(() => imixApp.mixer.overlays[0].state);
check(r === 'off', `overlay 1 off (${r})`);

// Title text via API
r = await page.evaluate(() => imixApp.api.call('SetText', { Input: 3, SelectedName: 'Name', Value: 'Test Person' }));
check(r.ok, 'SetText');
r = await page.evaluate(() => imixApp.mixer.getInput(3).fields.Name);
check(r === 'Test Person', 'title field updated');

// Video file input with audio
r = await page.evaluate(async () => {
  const inp = await imixApp.mixer.addInput({ type: 'video', url: '/fixtures/clip.webm', name: 'clip.webm' });
  await new Promise((res) => setTimeout(res, 1500));
  return { ready: !!inp.videoSource(), dur: inp.duration, hasAudio: imixApp.mixer.audio.channels.has(inp.id) };
});
check(r.ready && r.dur > 3000, `video input loads (duration ${r.dur})`);
check(r.hasAudio, 'video input has an audio channel');
r = await page.evaluate(async () => {
  await imixApp.api.call('CutDirect', { Input: 5 });
  await new Promise((res) => setTimeout(res, 800));
  const v = imixApp.mixer.getInput(5);
  return { state: v.state, pos: v.position };
});
check(r.state === 'Running' && r.pos > 100, `auto-play on cut (${r.state} ${r.pos.toFixed(0)}ms)`);
r = await page.evaluate(async () => {
  await new Promise((res) => setTimeout(res, 400));
  const lv = imixApp.mixer.audio.meters();
  return Math.max(...lv['bus:M']);
});
check(r > 0.01, `master meter shows audio (${r.toFixed(3)})`);
r = await page.evaluate(async () => {
  await imixApp.api.call('Cut', { Input: 1 });
  await new Promise((res) => setTimeout(res, 300));
  return imixApp.mixer.getInput(5).state;
});
check(r === 'Paused', `auto-pause off air (${r})`);

// Camera (fake device)
r = await page.evaluate(async () => {
  const inp = await imixApp.mixer.addInput({ type: 'camera', width: 640, height: 480 });
  await new Promise((res) => setTimeout(res, 1200));
  return { err: inp.error, src: !!inp.videoSource() };
});
check(!r.err && r.src, `camera input works (${r.err || 'ok'})`);

// Image + chroma key: keyed green should become transparent
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  const inp = await m.addInput({ type: 'image', url: '/fixtures/green.png', name: 'green.png' }, { select: false });
  await new Promise((res) => setTimeout(res, 500));
  inp.settings.key.mode = 'chroma';
  inp.settings.key.color = [0, 0xb1 / 255, 0x40 / 255];
  m.overlay(1, inp.id, 'in');
  m.cut(1);
  await new Promise((res) => setTimeout(res, 900));
  const c = document.getElementById('programCanvas');
  const t = document.createElement('canvas');
  t.width = 64; t.height = 36;
  const x = t.getContext('2d');
  x.drawImage(c, 0, 0, 64, 36);
  const edge = x.getImageData(4, 18, 1, 1).data; // was green → now shows the colour input below
  const centre = x.getImageData(32, 18, 1, 1).data; // red box stays
  m.overlay(1, null, 'off');
  return { edge: [...edge.slice(0, 3)], centre: [...centre.slice(0, 3)] };
});
check(r.edge[1] < 100 && r.centre[0] > 180, `chroma key removes green (edge ${r.edge}, centre ${r.centre})`);

// Layers (PiP)
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  const host = m.getInput(1);
  await imixApp.api.call('SetLayer', { Input: 1, Layer: 1, Value: 5 });
  m.compositor.frame(performance.now(), {});
  const ok = host.hasLayers() && m.compositor.composed.has(host.id);
  await imixApp.api.call('LayerOff', { Input: 1, Value: 1 });
  return ok;
});
check(r, 'multi-layer input composes');

// FTB
await page.evaluate(() => imixApp.api.call('FadeToBlack'));
await page.waitForTimeout(1200);
r = (await px()).avg;
check(r < 2, `fade to black (avg ${r.toFixed(1)})`);
await page.evaluate(() => imixApp.api.call('FadeToBlack'));
await page.waitForTimeout(1200);

// Replay buffer
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  await m.addInput({ type: 'replay' }, { select: false });
  await new Promise((res) => setTimeout(res, 1500));
  m.replay.playLast(1);
  await new Promise((res) => setTimeout(res, 300));
  return { buffered: m.replay.bufferedSeconds, playing: m.replay.playing, frames: m.replay.frames.length };
});
check(r.buffered > 0.8 && r.playing, `instant replay buffers & plays (${r.buffered.toFixed(2)}s, ${r.frames} frames)`);

// Scripts
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  m.scripts.push({ name: 'test', code: "await API.Function('PreviewInput', { Input: 2 }); await sleep(50); await API.Function('Cut');" });
  imixApp.scripts.start('test');
  await new Promise((res) => setTimeout(res, 300));
  return m.inputNumber(m.getInput(m.programId));
});
check(r === 2, `script runs functions (program ${r})`);

// Keyboard shortcut: digit selects preview, Enter cuts
await page.mouse.click(5, 300);
await page.keyboard.press('Digit4');
r = await page.evaluate(() => imixApp.mixer.inputNumber(imixApp.mixer.getInput(imixApp.mixer.previewId)));
check(r === 4, `key 4 → preview input 4 (got ${r})`);

// Recording (browser → download)
const dl = page.waitForEvent('download', { timeout: 15000 });
r = await page.evaluate(async () => {
  try {
    await imixApp.outputs.startRecording();
    await new Promise((res) => setTimeout(res, 2500));
    await imixApp.outputs.stopRecording();
    return 'ok';
  } catch (e) {
    return e.message;
  }
});
check(r === 'ok', `recording start/stop (${r})`);
const download = await dl.catch(() => null);
if (download) {
  const file = path.join(out, download.suggestedFilename());
  await download.saveAs(file);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'csv=p=0', file]).toString().trim();
  check(/video/.test(probe) && /audio/.test(probe), `recorded file has video+audio (${probe.replace(/\n/g, ' | ')})`);
} else check(false, 'recording download');

// Project round trip
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  const proj = JSON.parse(JSON.stringify(m.toProject()));
  const n = proj.inputs.length;
  await m.loadProject(proj);
  return { before: n, after: m.inputs.length };
});
check(r.before === r.after && r.after > 4, `project save/load round trip (${r.before} → ${r.after})`);

// UI: open settings & input settings dialogs
await page.click('#bbSettings');
await page.waitForSelector('.modal');
await page.keyboard.press('Escape');
await page.dblclick('.tile[data-id] .tile-body');
await page.waitForSelector('.modal .tabs');
const tabsCount = await page.$$eval('.modal .tab', (t) => t.length);
check(tabsCount >= 2, `input settings dialog opens (${tabsCount} tabs)`);
await page.keyboard.press('Escape');

await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'screenshot.png') });

const realErrors = errors.filter((e) => !/favicon|404|Failed to load resource/.test(e));
check(realErrors.length === 0, `no page errors${realErrors.length ? `:\n  ${realErrors.join('\n  ')}` : ''}`);

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
