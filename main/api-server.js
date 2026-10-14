// Remote control APIs, modelled on the conventions popular switchers use so
// existing control surfaces (e.g. Bitfocus Companion, Stream Deck plugins)
// can be pointed at Unique AV Streaming GuRu:
//   HTTP  :8088  GET /api?Function=Cut&Input=2   GET /api (XML state)
//   TCP   :8099  FUNCTION Cut Input=2 | XML | TALLY | SUBSCRIBE TALLY|ACTS | PING
// plus a touch-friendly web controller at http://<host>:8088/
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { mimeFor } = require('./protocol');

const WEB_ROOT = path.join(__dirname, '..', 'src', 'web');

class ApiServer {
  constructor(bridge, log) {
    this.bridge = bridge; // { call(fn, params), xml(), json(), snapshot() }
    this.log = log || (() => {});
    this.http = null;
    this.tcp = null;
    this.tcpClients = new Set();
    this.config = { enabled: true, httpPort: 8088, tcpPort: 8099, lan: false, password: '' };
    this.lastTally = '';
    this.acts = {}; // activator name (e.g. "Input 3") -> value string
  }

  async apply(config) {
    const next = { ...this.config, ...config };
    const changed = JSON.stringify(next) !== JSON.stringify(this.config) || !this.http;
    this.config = next;
    if (!changed) return this.status();
    await this.stop();
    if (!next.enabled) return this.status();
    const host = next.lan ? '0.0.0.0' : '127.0.0.1';
    this.error = null;
    await new Promise((resolve) => {
      this.http = http.createServer((req, res) => this.handleHttp(req, res));
      this.http.on('error', (e) => {
        this.error = `HTTP: ${e.message}`;
        this.log(this.error);
        resolve();
      });
      this.http.listen(next.httpPort, host, resolve);
    });
    await new Promise((resolve) => {
      this.tcp = net.createServer((sock) => this.handleTcp(sock));
      this.tcp.on('error', (e) => {
        this.error = `TCP: ${e.message}`;
        this.log(this.error);
        resolve();
      });
      this.tcp.listen(next.tcpPort, host, resolve);
    });
    return this.status();
  }

  status() {
    return { ...this.config, password: this.config.password ? '••••' : '', running: !!this.http && !this.error, error: this.error || null };
  }

  async stop() {
    for (const c of this.tcpClients) c.destroy();
    this.tcpClients.clear();
    await Promise.all([
      new Promise((r) => (this.http ? this.http.close(() => r()) : r())),
      new Promise((r) => (this.tcp ? this.tcp.close(() => r()) : r())),
    ]);
    if (this.http) this.http.closeAllConnections?.();
    this.http = null;
    this.tcp = null;
  }

  authorized(req) {
    if (!this.config.password) return true;
    const h = req.headers.authorization || '';
    const m = /^Basic (.+)$/.exec(h);
    if (!m) return false;
    const [, pass] = Buffer.from(m[1], 'base64').toString().split(':');
    return pass === this.config.password;
  }

  async handleHttp(req, res) {
    try {
      if (!this.authorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Unique AV Streaming GuRu"' });
        return res.end('Authentication required');
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (p === '/api') {
        const params = {};
        for (const [k, v] of url.searchParams) params[k] = v;
        const fn = params.Function || params.function;
        if (fn) {
          delete params.Function;
          delete params.function;
          const r = await this.bridge.call(fn, params);
          res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
          return res.end(r.ok ? 'Function completed successfully.' : `Error: ${r.message}`);
        }
        const xml = await this.bridge.xml();
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', ...cors });
        return res.end(xml);
      }
      if (p === '/api/state.json') {
        const json = await this.bridge.json();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
        return res.end(JSON.stringify(json));
      }
      if (p === '/api/snapshot.jpg') {
        const input = url.searchParams.get('Input') || '';
        const dataUrl = await this.bridge.snapshot(input);
        if (!dataUrl) {
          res.writeHead(404);
          return res.end();
        }
        const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', ...cors });
        return res.end(buf);
      }
      // Static web controller
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
      const file = path.normalize(path.join(WEB_ROOT, rel));
      if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': mimeFor(file) });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${e.message}`);
    }
  }

  handleTcp(sock) {
    this.tcpClients.add(sock);
    sock.setEncoding('utf8');
    sock.tally = false;
    sock.acts = false;
    sock.write('VERSION OK 1.0.0\r\n');
    let buf = '';
    let authed = !this.config.password;
    sock.on('data', async (data) => {
      buf += data;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const [cmdRaw, ...rest] = line.split(' ');
        const cmd = cmdRaw.toUpperCase();
        if (!authed) {
          if (cmd === 'AUTH' && rest.join(' ') === this.config.password) {
            authed = true;
            sock.write('AUTH OK\r\n');
          } else sock.write(`${cmd} ER Authentication required (AUTH <password>)\r\n`);
          continue;
        }
        try {
          if (cmd === 'FUNCTION') {
            const fn = rest[0];
            const params = {};
            if (rest.length > 1) {
              for (const [k, v] of new URLSearchParams(rest.slice(1).join(' '))) params[k] = v;
            }
            const r = await this.bridge.call(fn, params);
            sock.write(r.ok ? 'FUNCTION OK Completed\r\n' : `FUNCTION ER ${r.message}\r\n`);
          } else if (cmd === 'XML') {
            const xml = await this.bridge.xml();
            sock.write(`XML ${Buffer.byteLength(xml)}\r\n${xml}`);
          } else if (cmd === 'TALLY') {
            const json = await this.bridge.json();
            sock.write(`TALLY OK ${json.tally}\r\n`);
          } else if (cmd === 'SUBSCRIBE') {
            const what = (rest[0] || '').toUpperCase();
            if (what === 'TALLY') {
              sock.tally = true;
              sock.write('SUBSCRIBE OK TALLY\r\n');
              if (this.lastTally) sock.write(`TALLY OK ${this.lastTally}\r\n`);
            } else if (what === 'ACTS') {
              sock.acts = true;
              sock.write('SUBSCRIBE OK ACTS\r\n');
              const lines = Object.entries(this.acts).filter(([, v]) => v !== '0').map(([k, v]) => `ACTS OK ${k} ${v}\r\n`);
              if (lines.length) sock.write(lines.join(''));
            } else sock.write(`SUBSCRIBE ER Unsupported\r\n`);
          } else if (cmd === 'UNSUBSCRIBE') {
            const what = (rest[0] || 'TALLY').toUpperCase();
            if (what === 'ACTS') sock.acts = false;
            else sock.tally = false;
            sock.write(`UNSUBSCRIBE OK ${what}\r\n`);
          } else if (cmd === 'ACTS') {
            // Query one activator: "ACTS Input 3" or "ACTS MasterVolume"
            const name = rest.join(' ');
            const key = Object.keys(this.acts).find((k) => k.toLowerCase() === name.toLowerCase());
            if (key) sock.write(`ACTS OK ${key} ${this.acts[key]}\r\n`);
            else if (rest[0]) sock.write(`ACTS OK ${name} 0\r\n`);
            else sock.write('ACTS ER Activator name required\r\n');
          } else if (cmd === 'PING') {
            sock.write('PING OK PONG\r\n');
          } else if (cmd === 'VERSION') {
            sock.write('VERSION OK 1.0.0\r\n');
          } else if (cmd === 'QUIT') {
            sock.write('QUIT OK Bye\r\n');
            sock.end();
          } else {
            sock.write(`${cmd} ER Unknown command\r\n`);
          }
        } catch (e) {
          sock.write(`${cmd} ER ${e.message}\r\n`);
        }
      }
    });
    sock.on('close', () => this.tcpClients.delete(sock));
    sock.on('error', () => this.tcpClients.delete(sock));
  }

  // Activators: real-time state changes pushed to "SUBSCRIBE ACTS" clients,
  // e.g. "ACTS OK Input 3 1", "ACTS OK InputVolume 2 0.8", "ACTS OK Recording 1".
  pushActs(next) {
    const lines = [];
    for (const [k, v] of Object.entries(next)) {
      if (this.acts[k] !== v) lines.push(`ACTS OK ${k} ${v}\r\n`);
    }
    for (const k of Object.keys(this.acts)) {
      if (!(k in next) && this.acts[k] !== '0') lines.push(`ACTS OK ${k} 0\r\n`);
    }
    this.acts = next;
    if (!lines.length) return;
    const msg = lines.join('');
    for (const s of this.tcpClients) if (s.acts) s.write(msg);
  }

  pushTally(tally) {
    if (tally === this.lastTally) return;
    this.lastTally = tally;
    for (const s of this.tcpClients) if (s.tally) s.write(`TALLY OK ${tally}\r\n`);
  }
}

module.exports = { ApiServer };
