// A plain static server for the built Ose Web (`dist-web/`), for tests/e2e/web.spec.js: what any
// static host does, and nothing more. No bridge, no rewriting: every URL is a file, or 404.
//
//   node tests/e2e/web-serve.mjs [dir] [port]     serves `dir` (default dist-web) by hand

import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * Serve `dir` on 127.0.0.1:`port` (0 picks one). Resolves `{ url, close, requests }`, where
 * `requests` counts what reached the server (the offline scenario reads it).
 * @param {string} dir @param {number} [port]
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: string[] }>}
 */
export function serveStatic(dir, port = 0) {
  const root = path.resolve(dir);
  /** @type {string[]} */
  const requests = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0] || '/');
    requests.push(url);
    let file = path.join(root, url.endsWith('/') ? `${url}index.html` : url);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
      statSync(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = addr && typeof addr === 'object' ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        requests,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = process.argv[2] || path.join(here, '..', '..', 'dist-web');
  const s = await serveStatic(dir, Number(process.argv[3] || 5176));
  console.log(`Ose Web from ${dir} on ${s.url}`);
}
