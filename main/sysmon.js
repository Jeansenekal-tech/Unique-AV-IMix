// CPU / GPU / memory monitor for the status bar.
//  - CPU: whole-system usage (from os.cpus() deltas) and this app's own usage
//    (all Electron processes, normalised to the machine's core count).
//  - GPU: on macOS, IOAccelerator "Device Utilization %" via `ioreg` (no admin
//    rights needed; works on Apple Silicon, Intel and AMD GPUs). On other
//    platforms, nvidia-smi when available.
const { app } = require('electron');
const { execFile } = require('child_process');
const os = require('os');

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Parse `ioreg -c IOAccelerator` output (one entry per GPU).
function parseIoreg(out) {
  if (!out) return null;
  const util = [...out.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  const names = [...out.matchAll(/"model"\s*=\s*<?"([^"]+)"/g)].map((m) => m[1]);
  const mem = [...out.matchAll(/"In use system memory"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  if (!util.length) return null;
  return { percent: Math.max(...util), name: names[0] || 'GPU', memoryMB: mem.length ? Math.round(Math.max(...mem) / 1048576) : null };
}

async function readGpu() {
  if (process.platform === 'darwin') {
    return parseIoreg(await run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']));
  }
  const out = await run('nvidia-smi', ['--query-gpu=utilization.gpu,name,memory.used', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const [percent, name, memMB] = out.split('\n')[0].split(',').map((s) => s.trim());
  return Number.isFinite(Number(percent)) ? { percent: Number(percent), name, memoryMB: Number(memMB) || null } : null;
}

class SystemMonitor {
  constructor(send) {
    this.send = send;
    this.timer = null;
    this.prev = cpuTimes();
    this.gpuAvailable = true;
    this.latest = null;
  }

  async sample() {
    const now = cpuTimes();
    const dTotal = now.total - this.prev.total;
    const dIdle = now.idle - this.prev.idle;
    this.prev = now;
    const cores = os.cpus().length || 1;
    const system = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;

    let appCpu = 0;
    let appMemKB = 0;
    let gpuProcCpu = 0;
    for (const m of app.getAppMetrics()) {
      appCpu += m.cpu.percentCPUUsage || 0;
      appMemKB += m.memory?.workingSetSize || 0;
      if (m.type === 'GPU') gpuProcCpu = m.cpu.percentCPUUsage || 0;
    }

    let gpu = null;
    if (this.gpuAvailable) {
      gpu = await readGpu();
      if (!gpu && !this.gpuTried) this.gpuAvailable = false; // stop polling if unsupported
      this.gpuTried = true;
    }

    this.latest = {
      cpu: Math.round(system),
      appCpu: Math.round(Math.min(100, appCpu / cores)),
      cores,
      memoryMB: Math.round(appMemKB / 1024),
      totalMemoryMB: Math.round(os.totalmem() / 1048576),
      gpu: gpu ? Math.round(gpu.percent) : null,
      gpuName: gpu?.name || null,
      gpuMemoryMB: gpu?.memoryMB ?? null,
      gpuProcessCpu: Math.round(gpuProcCpu),
    };
    this.send(this.latest);
    return this.latest;
  }

  start(intervalMs = 1500) {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample().catch(() => {}), intervalMs);
    this.sample().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { SystemMonitor, readGpu, parseIoreg };
