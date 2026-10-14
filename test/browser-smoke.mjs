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
check(fps > 2, `render loop running (${fps.toFixed(1)} fps)`);

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
// Six aux buses + parametric EQ
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  const busStrips = document.querySelectorAll('.strip.master').length;
  await imixApp.api.call('AudioBus', { Input: 5, Value: 'F' });
  await new Promise((res) => setTimeout(res, 400));
  const lv = m.audio.meters();
  return { buses: Object.keys(m.audio.buses).join(''), busStrips, busF: Math.max(...lv['bus:F']), routed: m.getInput(5).settings.audio.buses.F };
});
check(r.buses === 'MABCDEF' && r.busStrips === 7, `Master + buses A–F (${r.buses}, ${r.busStrips} bus strips)`);
check(r.routed && r.busF > 0.01, `input routed to Bus F carries audio (${r.busF.toFixed(3)})`);
r = await page.evaluate(async () => {
  const { EQ_PRESETS } = await import('./engine/eq.js');
  const m = imixApp.mixer;
  const inp = m.getInput(5);
  const eq = inp.settings.audio.eq;
  eq.bands = EQ_PRESETS.Telephone();
  eq.on = true;
  m.inputChanged(inp);
  await new Promise((res) => setTimeout(res, 300));
  const node = m.audio.channels.get(inp.id).eqNode;
  const [lo, mid, hi] = node.response([100, 1000, 10000]);
  eq.on = false;
  m.inputChanged(inp);
  await new Promise((res) => setTimeout(res, 300));
  const [flat] = node.response([100]);
  return { lo, mid, hi, flat };
});
check(r.lo < -15 && r.hi < -15 && r.mid > 2, `EQ shapes the signal (100 Hz ${r.lo.toFixed(1)} dB, 1 kHz ${r.mid.toFixed(1)} dB, 10 kHz ${r.hi.toFixed(1)} dB)`);
check(Math.abs(r.flat) < 0.1, `EQ bypass is flat (${r.flat.toFixed(2)} dB)`);
await page.evaluate(() => [...document.querySelectorAll('.strip .btn.eq')].pop().click());
r = await page.evaluate(() => ({ panel: !!document.querySelector('.panel .eq-panel canvas'), rows: document.querySelectorAll('.panel .eq-row').length, title: document.querySelector('.panel .modal-head span')?.textContent }));
check(r.panel && r.rows === 6, `EQ window opens with 6 bands (${r.title})`);
await page.evaluate(() => document.querySelector('.panel .x-btn').click());
r = await page.evaluate(async () => {
  const { normalizeEq } = await import('./engine/eq.js');
  const old = normalizeEq({ on: true, low: 4, mid: -2, high: 3 });
  const m = imixApp.mixer;
  m.audio.buses.C.eq.on = true;
  m.audio.buses.C.eq.bands[2].gain = 5;
  const proj = JSON.parse(JSON.stringify(m.toProject()));
  return { old: [old.on, old.bands[1].gain, old.bands[3].gain, old.bands[5].gain], saved: proj.audioBuses.C.eq.bands[2].gain };
});
check(r.old.join() === 'true,4,-2,3', `old 3-band EQ settings migrate (${r.old})`);
check(r.saved === 5, 'bus EQ saved in the project');

r = await page.evaluate(async () => {
  // the 4 s clip may have finished during the audio checks – restart it first
  const v = imixApp.mixer.getInput(5);
  v.restart();
  v.play();
  await new Promise((res) => setTimeout(res, 300));
  await imixApp.api.call('Cut', { Input: 1 });
  await new Promise((res) => setTimeout(res, 300));
  return v.state;
});
check(r === 'Paused', `auto-pause off air (${r})`);

// Slow motion (per-input playback speed)
r = await page.evaluate(async () => {
  const v = imixApp.mixer.getInput(5);
  await imixApp.api.call('SetRate', { Input: 5, Value: 0.25 });
  const a = v.el.playbackRate;
  await imixApp.api.call('SlowMotion', { Input: 5 }); // toggle back to 1×
  const b = v.el.playbackRate;
  await imixApp.api.call('SlowMotion', { Input: 5 }); // slow-mo speed (0.5×)
  const c = v.el.playbackRate;
  await imixApp.api.call('SlowMotionOff', { Input: 5 });
  const bad = await imixApp.api.call('SetRate', { Input: 1, Value: 0.5 });
  return { a, b, c, d: v.el.playbackRate, bad: bad.ok };
});
check(r.a === 0.25 && r.b === 1 && r.c === 0.5 && r.d === 1, `slow motion speeds (${r.a}× → ${r.b}× → ${r.c}× → ${r.d}×)`);
check(r.bad === false, 'speed rejected for non-media inputs');

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

// Custom output format (any size, fractional frame rate)
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  m.setFormat(1000, 562, 29.97);
  await new Promise((res) => setTimeout(res, 600));
  const c = document.getElementById('programCanvas');
  const out = { w: c.width, h: c.height, fps: m.settings.fps, label: document.getElementById('formatLabel').textContent, rendering: m.stats.fps > 0 };
  m.setFormat(640, 360, 30);
  return out;
});
check(r.w === 1000 && r.h === 562 && r.fps === 29.97 && /1000×562 29\.97p/.test(r.label), `custom format 1000×562 @ 29.97 (${r.label})`);

// Unlimited outputs: several outputs with different sources at once
r = await page.evaluate(async () => {
  const m = imixApp.mixer;
  const vo = imixApp.videoOutputs;
  m.cut(1);
  m.overlay(0, 3, 'in'); // lower third over program
  await new Promise((res) => setTimeout(res, 700));
  const outs = [
    vo.add({ source: 'program', target: 'window' }),
    vo.add({ source: 'clean', target: 'window' }),
    vo.add({ source: `input:${m.getInput(2).id}`, target: 'window' }),
    vo.add({ source: 'preview', target: 'window' }),
  ];
  for (const o of outs) await vo.open(o.id);
  await new Promise((res) => setTimeout(res, 1200));
  const sample = (canvas, x, y) => {
    const t = document.createElement('canvas');
    t.width = 64; t.height = 36;
    t.getContext('2d').drawImage(canvas, 0, 0, 64, 36);
    return [...t.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];
  };
  const clean = m.compositor.extras.get('clean').canvas;
  const prog = document.getElementById('programCanvas');
  // lower third bar sits bottom-left (≈ x 10–30 %, y 85 %)
  const progPx = sample(prog, 10, 28); // red name bar of the lower third
  const cleanPx = sample(clean, 10, 28);
  const windows = outs.map((o) => { const rt = vo.runtime.get(o.id); const v = rt?.win?.document.getElementById('out'); return !!(v && v.srcObject && v.srcObject.getVideoTracks().length); });
  const extras = [...m.compositor.extras.keys()].sort().join(',');
  for (const o of outs) vo.remove(o.id);
  m.overlay(0, null, 'off');
  return { windows, extras, progPx, cleanPx, left: m.compositor.extras.size, open: vo.runtime.size };
});
check(r.windows.every(Boolean) && r.windows.length === 4, `4 outputs open at once, each receiving video (${r.windows})`);
check(/clean/.test(r.extras) && /preview/.test(r.extras) && /input:/.test(r.extras), `separate feeds rendered (${r.extras})`);
check(JSON.stringify(r.progPx) !== JSON.stringify(r.cleanPx), `clean feed has no overlay (program ${r.progPx} vs clean ${r.cleanPx})`);
check(r.left === 0 && r.open === 0, 'feeds released when outputs close');

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
