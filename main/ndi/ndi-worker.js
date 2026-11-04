// One worker thread per NDI receiver / sender (and short-lived finders), so
// the blocking NDI calls never stall Electron's main thread.
const { parentPort, workerData } = require('worker_threads');
const ndi = require('./ndi-lib');

const { role, libPath } = workerData;
if (!ndi.load(libPath)) {
  parentPort.postMessage({ type: 'fatal', message: ndi.status(libPath).error });
  process.exit(0);
}

if (role === 'find') {
  try {
    parentPort.postMessage({ type: 'sources', sources: ndi.findSources(workerData.timeoutMs || 1500, workerData.extraIps || '') });
  } catch (e) {
    parentPort.postMessage({ type: 'fatal', message: e.message });
  }
  process.exit(0);
}

if (role === 'recv') {
  let recv;
  try {
    recv = new ndi.Receiver(workerData);
  } catch (e) {
    parentPort.postMessage({ type: 'fatal', message: e.message });
    process.exit(0);
  }
  let running = true;
  let inflight = 0; // video frames the main thread hasn't forwarded yet
  let lastVideo = 0;
  parentPort.on('message', (m) => {
    if (m.cmd === 'ack') inflight = Math.max(0, inflight - 1);
    else if (m.cmd === 'tally') recv.setTally(m.program, m.preview);
    else if (m.cmd === 'stop') running = false;
  });
  const loop = () => {
    if (!running) {
      recv.destroy();
      process.exit(0);
    }
    let f;
    try {
      f = recv.capture(30);
    } catch (e) {
      parentPort.postMessage({ type: 'error', message: e.message });
      f = { type: 'none' };
    }
    if (f.type === 'video') {
      lastVideo = Date.now();
      if (inflight < 2) {
        inflight++;
        parentPort.postMessage(f, [f.data]);
      }
    } else if (f.type === 'audio') {
      parentPort.postMessage(f, [f.data]);
    } else if (f.type === 'none' && lastVideo && Date.now() - lastVideo > 2000) {
      parentPort.postMessage({ type: 'nosignal' });
      lastVideo = 0;
    }
    setImmediate(loop);
  };
  parentPort.postMessage({ type: 'ready' });
  loop();
}

if (role === 'send') {
  let sender;
  try {
    sender = new ndi.Sender(workerData);
  } catch (e) {
    parentPort.postMessage({ type: 'fatal', message: e.message });
    process.exit(0);
  }
  parentPort.on('message', (m) => {
    try {
      if (m.cmd === 'video') sender.sendVideo(m);
      else if (m.cmd === 'audio') sender.sendAudio(m);
      else if (m.cmd === 'stop') {
        sender.destroy();
        process.exit(0);
      }
    } catch (e) {
      parentPort.postMessage({ type: 'error', message: e.message });
    }
  });
  setInterval(() => {
    try {
      parentPort.postMessage({ type: 'status', connections: sender.connections(), tally: sender.tally() });
    } catch {
      /* ignore */
    }
  }, 1000);
  parentPort.postMessage({ type: 'ready' });
}
