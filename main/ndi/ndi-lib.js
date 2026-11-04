// NDI® bindings via koffi (FFI – no native compile step). Loads the NDI
// runtime library (libndi) that ships with the NDI SDK / NDI Tools, or a copy
// bundled with the app. NDI® is a registered trademark of Vizrt NDI AB.
// https://ndi.video
const fs = require('fs');
const path = require('path');
const os = require('os');

let koffi;
try {
  // eslint-disable-next-line global-require
  koffi = require('koffi');
} catch {
  koffi = null;
}

const fourcc = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const FOURCC = { BGRA: fourcc('BGRA'), BGRX: fourcc('BGRX'), RGBA: fourcc('RGBA'), RGBX: fourcc('RGBX'), UYVY: fourcc('UYVY') };
const FRAME = { none: 0, video: 1, audio: 2, metadata: 3, error: 4, status_change: 100, source_change: 101 };
const BANDWIDTH = { lowest: 0, highest: 100, audio_only: 10 };
const COLOR = { BGRX_BGRA: 0, RGBX_RGBA: 2 };

function candidatePaths(custom) {
  const list = [];
  if (custom) list.push(custom);
  const plat = process.platform;
  const libName = plat === 'darwin' ? 'libndi.dylib' : plat === 'win32' ? 'Processing.NDI.Lib.x64.dll' : 'libndi.so';
  for (const v of ['NDI_RUNTIME_DIR_V6', 'NDI_RUNTIME_DIR_V5']) {
    if (process.env[v]) list.push(path.join(process.env[v], libName));
  }
  // bundled with the packaged app (Contents/Resources/ndi/)
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'ndi', libName));
  list.push(path.join(__dirname, '..', '..', 'vendor', 'ndi', libName));
  if (plat === 'darwin') {
    list.push(
      '/Library/NDI SDK for Apple/lib/macOS/libndi.dylib',
      '/Library/NDI SDK for Apple/lib/macOS/libndi_advanced.dylib',
      '/usr/local/lib/libndi.dylib',
      '/opt/homebrew/lib/libndi.dylib',
      '/Library/Frameworks/NDI.framework/NDI',
    );
    // NDI Tools apps carry their own copy of the runtime
    try {
      for (const app of fs.readdirSync('/Applications')) {
        if (!/^NDI/i.test(app) || !app.endsWith('.app')) continue;
        for (const sub of ['Contents/Frameworks', 'Contents/MacOS', 'Contents/Resources']) {
          const dir = path.join('/Applications', app, sub);
          try {
            for (const f of fs.readdirSync(dir)) if (/^libndi.*\.dylib$/.test(f)) list.push(path.join(dir, f));
          } catch {
            /* no such folder */
          }
        }
      }
    } catch {
      /* ignore */
    }
  } else if (plat === 'linux') {
    for (const d of ['/usr/lib', '/usr/local/lib', '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu']) {
      list.push(path.join(d, 'libndi.so.6'), path.join(d, 'libndi.so.5'), path.join(d, 'libndi.so'));
    }
  } else if (plat === 'win32') {
    list.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NDI', 'NDI 6 Runtime', 'v6', libName));
  }
  return [...new Set(list)];
}

let lib = null;
let loadError = null;
let loadedPath = null;

function load(customPath) {
  if (lib) return lib;
  if (!koffi) {
    loadError = 'koffi (FFI) is not installed';
    return null;
  }
  const tried = [];
  for (const p of candidatePaths(customPath)) {
    if (!fs.existsSync(p)) continue;
    try {
      const L = koffi.load(p);
      lib = bind(L);
      if (!lib.NDIlib_initialize()) {
        lib = null;
        loadError = 'NDI could not start (this CPU or OS is not supported by the NDI runtime)';
        return null;
      }
      loadedPath = p;
      loadError = null;
      return lib;
    } catch (e) {
      tried.push(`${p}: ${e.message}`);
    }
  }
  loadError = tried.length ? `Could not load NDI runtime – ${tried.join('; ')}` : 'NDI runtime not found. Install the free NDI SDK for Apple or NDI Tools from ndi.video.';
  return null;
}

function bind(L) {
  const k = koffi;
  const Source = k.struct('NDIlib_source_t', { p_ndi_name: 'const char *', p_url_address: 'const char *' });
  const FindCreate = k.struct('NDIlib_find_create_t', { show_local_sources: 'bool', p_groups: 'const char *', p_extra_ips: 'const char *' });
  const RecvCreate = k.struct('NDIlib_recv_create_v3_t', {
    source_to_connect_to: Source, color_format: 'int', bandwidth: 'int', allow_video_fields: 'bool', p_ndi_recv_name: 'const char *',
  });
  const Video = k.struct('NDIlib_video_frame_v2_t', {
    xres: 'int', yres: 'int', FourCC: 'uint32_t', frame_rate_N: 'int', frame_rate_D: 'int', picture_aspect_ratio: 'float',
    frame_format_type: 'int', timecode: 'int64_t', p_data: 'void *', line_stride_in_bytes: 'int', p_metadata: 'const char *', timestamp: 'int64_t',
  });
  const Audio = k.struct('NDIlib_audio_frame_v2_t', {
    sample_rate: 'int', no_channels: 'int', no_samples: 'int', timecode: 'int64_t', p_data: 'void *',
    channel_stride_in_bytes: 'int', p_metadata: 'const char *', timestamp: 'int64_t',
  });
  const Meta = k.struct('NDIlib_metadata_frame_t', { length: 'int', timecode: 'int64_t', p_data: 'void *' });
  const SendCreate = k.struct('NDIlib_send_create_t', { p_ndi_name: 'const char *', p_groups: 'const char *', clock_video: 'bool', clock_audio: 'bool' });
  const Tally = k.struct('NDIlib_tally_t', { on_program: 'bool', on_preview: 'bool' });
  const Handle = k.pointer('NDI_HANDLE', k.opaque());

  const f = {
    types: { Source, FindCreate, RecvCreate, Video, Audio, Meta, SendCreate, Tally },
    NDIlib_initialize: L.func('bool NDIlib_initialize()'),
    NDIlib_destroy: L.func('void NDIlib_destroy()'),
    NDIlib_version: L.func('const char *NDIlib_version()'),
    NDIlib_find_create_v2: L.func('NDIlib_find_create_v2', Handle, [k.pointer(FindCreate)]),
    NDIlib_find_destroy: L.func('NDIlib_find_destroy', 'void', [Handle]),
    NDIlib_find_wait_for_sources: L.func('NDIlib_find_wait_for_sources', 'bool', [Handle, 'uint32_t']),
    NDIlib_find_get_current_sources: L.func('NDIlib_find_get_current_sources', 'void *', [Handle, k.out(k.pointer('uint32_t'))]),
    NDIlib_recv_create_v3: L.func('NDIlib_recv_create_v3', Handle, [k.pointer(RecvCreate)]),
    NDIlib_recv_destroy: L.func('NDIlib_recv_destroy', 'void', [Handle]),
    NDIlib_recv_capture_v2: L.func('NDIlib_recv_capture_v2', 'int', [Handle, k.out(k.pointer(Video)), k.out(k.pointer(Audio)), k.out(k.pointer(Meta)), 'uint32_t']),
    NDIlib_recv_free_video_v2: L.func('NDIlib_recv_free_video_v2', 'void', [Handle, k.pointer(Video)]),
    NDIlib_recv_free_audio_v2: L.func('NDIlib_recv_free_audio_v2', 'void', [Handle, k.pointer(Audio)]),
    NDIlib_recv_free_metadata: L.func('NDIlib_recv_free_metadata', 'void', [Handle, k.pointer(Meta)]),
    NDIlib_recv_set_tally: L.func('NDIlib_recv_set_tally', 'bool', [Handle, k.pointer(Tally)]),
    NDIlib_recv_get_no_connections: L.func('NDIlib_recv_get_no_connections', 'int', [Handle]),
    NDIlib_send_create: L.func('NDIlib_send_create', Handle, [k.pointer(SendCreate)]),
    NDIlib_send_destroy: L.func('NDIlib_send_destroy', 'void', [Handle]),
    NDIlib_send_send_video_v2: L.func('NDIlib_send_send_video_v2', 'void', [Handle, k.pointer(Video)]),
    NDIlib_send_send_audio_v2: L.func('NDIlib_send_send_audio_v2', 'void', [Handle, k.pointer(Audio)]),
    NDIlib_send_get_no_connections: L.func('NDIlib_send_get_no_connections', 'int', [Handle, 'uint32_t']),
    NDIlib_send_get_tally: L.func('NDIlib_send_get_tally', 'bool', [Handle, k.out(k.pointer(Tally)), 'uint32_t']),
  };
  return f;
}

function status(customPath) {
  const l = load(customPath);
  return l
    ? { available: true, version: String(l.NDIlib_version() || ''), path: loadedPath }
    : { available: false, error: loadError, searched: candidatePaths(customPath).filter((p) => !p.includes('/Applications/')) };
}

// ------------------------------------------------------------------ finder
function findSources(timeoutMs = 1500, extraIps = '') {
  const l = load();
  if (!l) throw new Error(loadError);
  const finder = l.NDIlib_find_create_v2({ show_local_sources: true, p_groups: null, p_extra_ips: extraIps || null });
  if (!finder) throw new Error('Could not create NDI finder');
  try {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) l.NDIlib_find_wait_for_sources(finder, Math.max(1, Math.min(250, end - Date.now())));
    const count = [0];
    const ptr = l.NDIlib_find_get_current_sources(finder, count);
    const n = count[0] || 0;
    if (!ptr || !n) return [];
    const arr = koffi.decode(ptr, koffi.array(l.types.Source, n));
    return arr.map((s) => ({ name: s.p_ndi_name, url: s.p_url_address || '' }));
  } finally {
    l.NDIlib_find_destroy(finder);
  }
}

// ---------------------------------------------------------------- receiver
class Receiver {
  constructor({ source, url = '', bandwidth = 'highest', name = 'Unique AV Streaming GuRu' }) {
    const l = load();
    if (!l) throw new Error(loadError);
    this.l = l;
    this.handle = l.NDIlib_recv_create_v3({
      source_to_connect_to: { p_ndi_name: source, p_url_address: url || null },
      color_format: COLOR.BGRX_BGRA,
      bandwidth: BANDWIDTH[bandwidth] ?? BANDWIDTH.highest,
      allow_video_fields: false,
      p_ndi_recv_name: name,
    });
    if (!this.handle) throw new Error(`Could not connect to NDI source “${source}”`);
  }

  // Returns { type:'video', width, height, fourcc, fps, data(ArrayBuffer tightly packed BGRA) }
  //       | { type:'audio', sampleRate, channels, samples, data(Float32 interleaved ArrayBuffer) }
  //       | { type:'none' } | { type:'status' } | { type:'error' }
  capture(timeoutMs = 50) {
    const l = this.l;
    const v = {};
    const a = {};
    const m = {};
    const t = l.NDIlib_recv_capture_v2(this.handle, v, a, m, timeoutMs);
    if (t === FRAME.video) {
      try {
        const w = v.xres;
        const h = v.yres;
        const stride = v.line_stride_in_bytes || w * 4;
        // copy (Electron's V8 memory cage forbids ArrayBuffers over external memory)
        const src = koffi.decode(v.p_data, koffi.array('uint8_t', stride * h));
        let out;
        if (stride === w * 4) out = src.buffer.byteLength === src.byteLength ? src.buffer : src.slice().buffer;
        else {
          const packed = new Uint8Array(w * h * 4);
          for (let y = 0; y < h; y++) packed.set(src.subarray(y * stride, y * stride + w * 4), y * w * 4);
          out = packed.buffer;
        }
        return { type: 'video', width: w, height: h, fourcc: v.FourCC, opaque: v.FourCC === FOURCC.BGRX, fps: v.frame_rate_D ? v.frame_rate_N / v.frame_rate_D : 0, data: out };
      } finally {
        l.NDIlib_recv_free_video_v2(this.handle, v);
      }
    }
    if (t === FRAME.audio) {
      try {
        const ch = a.no_channels;
        const n = a.no_samples;
        const strideF = (a.channel_stride_in_bytes || n * 4) / 4;
        const src = koffi.decode(a.p_data, koffi.array('float', strideF * ch));
        const outCh = Math.min(2, ch);
        const inter = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          const L = src[i];
          const R = outCh > 1 ? src[strideF + i] : L;
          inter[i * 2] = L;
          inter[i * 2 + 1] = R;
        }
        return { type: 'audio', sampleRate: a.sample_rate, channels: 2, samples: n, data: inter.buffer };
      } finally {
        l.NDIlib_recv_free_audio_v2(this.handle, a);
      }
    }
    if (t === FRAME.metadata) l.NDIlib_recv_free_metadata(this.handle, m);
    if (t === FRAME.error) return { type: 'error' };
    if (t === FRAME.status_change || t === FRAME.source_change) return { type: 'status' };
    return { type: 'none' };
  }

  setTally(onProgram, onPreview) {
    this.l.NDIlib_recv_set_tally(this.handle, { on_program: !!onProgram, on_preview: !!onPreview });
  }

  connections() {
    return this.l.NDIlib_recv_get_no_connections(this.handle);
  }

  destroy() {
    if (this.handle) this.l.NDIlib_recv_destroy(this.handle);
    this.handle = null;
  }
}

// ------------------------------------------------------------------ sender
function fpsFraction(fps) {
  const f = Number(fps) || 30;
  for (const [n, d] of [[24000, 1001], [30000, 1001], [60000, 1001], [120000, 1001]]) if (Math.abs(f - n / d) < 0.01) return [n, d];
  return [Math.round(f * 1000), 1000];
}

class Sender {
  constructor({ name, groups = '' }) {
    const l = load();
    if (!l) throw new Error(loadError);
    this.l = l;
    this.handle = l.NDIlib_send_create({ p_ndi_name: name, p_groups: groups || null, clock_video: false, clock_audio: false });
    if (!this.handle) throw new Error(`Could not create NDI output “${name}” (is the name already in use?)`);
  }

  // data: ArrayBuffer of RGBA (or BGRA) pixels, tightly packed
  sendVideo({ width, height, data, fps = 30, format = 'RGBA' }) {
    const [N, D] = fpsFraction(fps);
    const buf = Buffer.from(data);
    this.l.NDIlib_send_send_video_v2(this.handle, {
      xres: width, yres: height, FourCC: FOURCC[format] || FOURCC.RGBA, frame_rate_N: N, frame_rate_D: D,
      picture_aspect_ratio: width / height, frame_format_type: 1, timecode: 0x7fffffffffffffffn,
      p_data: buf, line_stride_in_bytes: width * 4, p_metadata: null, timestamp: 0n,
    });
  }

  // data: Float32 PLANAR (all of channel 0, then channel 1 …)
  sendAudio({ sampleRate = 48000, channels = 2, samples, data }) {
    const buf = Buffer.from(data);
    this.l.NDIlib_send_send_audio_v2(this.handle, {
      sample_rate: sampleRate, no_channels: channels, no_samples: samples, timecode: 0x7fffffffffffffffn,
      p_data: buf, channel_stride_in_bytes: samples * 4, p_metadata: null, timestamp: 0n,
    });
  }

  connections() {
    return this.l.NDIlib_send_get_no_connections(this.handle, 0);
  }

  tally() {
    const t = {};
    this.l.NDIlib_send_get_tally(this.handle, t, 0);
    return { program: !!t.on_program, preview: !!t.on_preview };
  }

  destroy() {
    if (this.handle) this.l.NDIlib_send_destroy(this.handle);
    this.handle = null;
  }
}

module.exports = { load, status, findSources, Receiver, Sender, FOURCC, candidatePaths, fpsFraction, hostName: os.hostname };
