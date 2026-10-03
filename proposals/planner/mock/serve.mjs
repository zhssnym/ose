// A static server for the mock: the repository as it is, on http://127.0.0.1:5199, so the page
// can be looked at beside a running `npm run dev` without touching it. No dependency.
//
//   node proposals/planner/mock/serve.mjs      then open /proposals/planner/mock/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env.PORT) || 5199;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // the root is the app's own page, which needs its host: go to the mock instead
    if (path === '/') { res.writeHead(302, { location: '/proposals/planner/mock/' }).end(); return; }
    let file = normalize(join(root, path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) && file !== root) { res.writeHead(403).end(); return; }
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`mock: http://127.0.0.1:${port}/proposals/planner/mock/`));
