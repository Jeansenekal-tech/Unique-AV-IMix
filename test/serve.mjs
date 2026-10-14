// Minimal static server for running the UI in a plain browser (tests / dev).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webm': 'video/webm', '.mp4': 'video/mp4' };

export function serve(port = 0, extraRoot) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.normalize(path.join(root, u === '/' ? 'index.html' : u));
      if (extraRoot && u.startsWith('/fixtures/')) file = path.join(extraRoot, u.slice('/fixtures/'.length));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await serve(Number(process.argv[2]) || 8090);
  console.log(`Unique AV Streaming GuRu UI at http://127.0.0.1:${s.address().port}/`);
}
