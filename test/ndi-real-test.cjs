// Real NDI® loopback test: sender → discovery → receiver, using the actual
// NDI runtime (run on macOS CI after downloading the NDI SDK).
//   node test/ndi-real-test.cjs /path/to/libndi.dylib
const ndi = require('../main/ndi/ndi-lib');

const lib = process.argv[2];
let failures = 0;
const check = (c, m) => { console.log(`${c ? '✔' : '✖'} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const st = ndi.status(lib);
  check(st.available, `NDI runtime loads (${st.version || st.error})`);
  if (!st.available) process.exit(1);

  const W = 1280, H = 720;
  const sender = new ndi.Sender({ name: `GuRu CI ${process.pid}` });
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set([200, 40, 10, 255], i * 4); // RGBA
  const tone = new Float32Array(1600 * 2);
  for (let i = 0; i < 1600; i++) { const v = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 48000); tone[i] = v; tone[1600 + i] = v; }
  let sending = true;
  (async () => {
    while (sending) {
      sender.sendVideo({ width: W, height: H, data: px.buffer, fps: 29.97 });
      sender.sendAudio({ sampleRate: 48000, channels: 2, samples: 1600, data: tone.buffer });
      await sleep(33);
    }
  })();

  let source = null;
  for (let i = 0; i < 20 && !source; i++) {
    source = ndi.findSources(1000).find((s) => s.name.includes(`GuRu CI ${process.pid}`));
  }
  check(!!source, `sender discovered (${source ? source.name : 'not found'})`);
  if (!source) process.exit(1);

  const recv = new ndi.Receiver({ source: source.name, url: source.url });
  let video = null;
  let audio = null;
  const end = Date.now() + 10000;
  while (Date.now() < end && (!video || !audio)) {
    const f = recv.capture(100);
    if (f.type === 'video' && !video) video = f;
    if (f.type === 'audio' && !audio) audio = f;
    await sleep(1);
  }
  check(video && video.width === W && video.height === H, `video received ${video ? `${video.width}×${video.height} @ ${video.fps.toFixed(3)}` : 'none'}`);
  if (video) {
    const p = new Uint8Array(video.data, (W * (H / 2) + W / 2) * 4, 4); // centre pixel, BGRA
    check(Math.abs(p[2] - 200) < 8 && Math.abs(p[1] - 40) < 8 && Math.abs(p[0] - 10) < 8, `colour survives the round trip (BGRA ${[...p]})`);
    check(Math.abs(video.fps - 29.97) < 0.01, 'frame rate 30000/1001');
  }
  check(audio && audio.sampleRate === 48000 && audio.samples > 0, `audio received ${audio ? `${audio.samples} samples @ ${audio.sampleRate}` : 'none'}`);
  if (audio) {
    const a = new Float32Array(audio.data);
    check(Math.max(...a.map(Math.abs)) > 0.3, 'audio level matches the 440 Hz tone');
  }
  recv.setTally(true, false);
  let tally = null;
  for (let i = 0; i < 30 && !(tally && tally.program); i++) { await sleep(100); tally = sender.tally(); }
  check(tally && tally.program, `tally reaches the sender (${JSON.stringify(tally)})`);
  check(sender.connections() >= 1, `sender sees ${sender.connections()} connection(s)`);

  sending = false;
  await sleep(100);
  recv.destroy();
  sender.destroy();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
