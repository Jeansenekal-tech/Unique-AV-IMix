// Custom "imix://" scheme.
//   imix://app/<path>     -> files from ./src (the UI)
//   imix://media/<path>   -> any local media file (URL-encoded absolute path)
// Serving media from the same origin as the UI keeps WebGL textures untainted,
// and the manual Range support lets <video> seek inside large files.
const { protocol } = require('electron');
const fs = require('fs');
const path = require('path');

const SCHEME = 'imix';
const SRC_ROOT = path.join(__dirname, '..', 'src');
// Unique AV Countdown's pages keep their original app://ui/… addresses.
const COUNTDOWN_UI = path.join(__dirname, '..', 'countdown', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function fileResponse(file, request) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = {
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) {
      // suffix range: last N bytes
      start = Math.max(0, stat.size - parseInt(m[2], 10));
      end = stat.size - 1;
    }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(nodeStreamToWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
  }
  headers['Content-Length'] = String(stat.size);
  return new Response(nodeStreamToWeb(fs.createReadStream(file)), { status: 200, headers });
}

function nodeStreamToWeb(stream) {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

function handleProtocol() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host === 'app') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(SRC_ROOT, rel));
      if (!file.startsWith(SRC_ROOT)) return new Response('Forbidden', { status: 403 });
      return fileResponse(file, request);
    }
    if (url.host === 'media') {
      const file = decodeURIComponent(url.pathname.slice(1));
      return fileResponse(path.resolve(file), request);
    }
    return new Response('Not found', { status: 404 });
  });
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'operator.html';
    const file = path.normalize(path.join(COUNTDOWN_UI, rel));
    if (!file.startsWith(COUNTDOWN_UI)) return new Response('Forbidden', { status: 403 });
    return fileResponse(file, request);
  });
}

module.exports = { SCHEME, SRC_ROOT, registerSchemePrivileges, handleProtocol, mimeFor };
