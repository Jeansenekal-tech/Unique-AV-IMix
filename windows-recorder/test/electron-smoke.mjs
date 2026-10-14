// End-to-end test: boots the recorder with Chromium's fake camera and
// microphone, records a few seconds and checks the finished MP4.
// On Linux run under a display: xvfb-run -a node test/electron-smoke.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
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
const out = path.join(here, 'output');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

const app = await playwright._electron.launch({
  executablePath: require(path.join(root, 'node_modules', 'electron')),
  args: [root, `--user-data-dir=${path.join(out, 'profile')}`, '--no-sandbox'],
  env: { ...process.env, UAR_FAKE_MEDIA: '1', UAR_OUTPUT_DIR: path.join(out, 'recordings') },
});
const page = await app.firstWindow();
page.on('console', (m) => console.log(`[renderer] ${m.text()}`));
page.on('pageerror', (e) => { console.log(`[pageerror] ${e.message}`); failures++; });

await page.waitForFunction(() => document.getElementById('videoInfo').textContent.includes('×'), null, { timeout: 15000 });
check(true, `preview opened: ${await page.textContent('#videoInfo')}`);
const opts = await page.$$eval('#audioDevice option', (o) => o.map((x) => x.value));
check(opts.length > 1, `audio devices listed (${opts.length - 1})`);
if (!(await page.inputValue('#audioDevice'))) {
  await page.selectOption('#audioDevice', opts[1]);
}
check((await page.inputValue('#format')) === 'mp4', 'MP4 is the default video format');

// Input gain / volume / mute
const setRange = (sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }, v);
await setRange('#gain', 6);
await setRange('#volume', -6);
await page.waitForTimeout(300);
let lv = await page.evaluate(() => window.__uar.levels());
check(Math.abs(lv.gain - 1.995) < 0.02 && Math.abs(lv.volume - 0.501) < 0.01, `gain +6 dB / volume -6 dB applied (${lv.gain.toFixed(3)}, ${lv.volume.toFixed(3)})`);
check((await page.textContent('#gainOut')) === '+6 dB' && (await page.textContent('#volumeOut')) === '-6 dB', 'level readouts');
await page.click('#mute');
await page.waitForTimeout(300);
lv = await page.evaluate(() => window.__uar.levels());
check(lv.volume < 0.001 && (await page.getAttribute('#mute', 'aria-pressed')) === 'true', 'mute silences the recording');
await page.click('#mute');
await page.dblclick('#gain');
await page.dblclick('#volume');
await page.waitForTimeout(300);
lv = await page.evaluate(() => window.__uar.levels());
check(Math.abs(lv.gain - 1) < 0.01 && Math.abs(lv.volume - 1) < 0.01, 'double-click resets to 0 dB, unmuted');

await page.click('#recordBtn');
await page.waitForTimeout(4000);
check(await page.evaluate(() => window.__uar.isRecording()), 'recording in progress');
check(!(await page.isHidden('#recBadge')), 'REC badge shown');
check(await page.isDisabled('#videoDevice'), 'device selection locked while recording');
await page.keyboard.press('F9');
await page.waitForFunction(() => /Saved|error|kept/i.test(document.getElementById('status').textContent), null, { timeout: 30000 });
const status = await page.textContent('#status');
check(status.startsWith('Saved'), `status: ${status}`);
await page.screenshot({ path: path.join(out, 'screenshot.png') });

const recDir = path.join(out, 'recordings');
const files = fs.readdirSync(recDir);
const mp4 = files.find((f) => f.endsWith('.mp4'));
check(!!mp4 && files.length === 1, `one finished file, no raw left (${files.join(', ')})`);
if (mp4) {
  const ff = require('ffmpeg-static');
  let info = '';
  try { execFileSync(ff, ['-hide_banner', '-i', path.join(recDir, mp4)], { stdio: 'pipe' }); } catch (e) { info = e.stderr.toString(); }
  check(/Video: h264/.test(info), 'video is H.264');
  check(/Audio: aac/.test(info), 'audio is AAC');
  const m = info.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const secs = m ? Number(m[3]) + Number(m[2]) * 60 : 0;
  check(secs >= 3 && secs <= 6, `duration ${secs}s`);
}

// Audio only → WAV
await page.selectOption('#videoDevice', '');
await page.selectOption('#format', 'wav');
await page.click('#recordBtn');
await page.waitForTimeout(2000);
await page.click('#recordBtn');
await page.waitForFunction(() => /\.wav/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
check(fs.readdirSync(recDir).some((f) => f.endsWith('.wav')), 'audio-only WAV recorded');

await app.close();
console.log(failures ? `${failures} check(s) failed` : 'All recorder smoke checks passed');
process.exit(failures ? 1 : 0);
