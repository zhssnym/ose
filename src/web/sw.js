// The service worker of Ose Web (docs/WEB.md "The service worker and the `vault/` origin").
//
// Two jobs:
// 1. Offline. The build (vite.web.config.js) writes the list of every file it made into
//    MANIFEST below, with its build stamp; install caches them all under `ose-web-<build>`, and
//    every request for the app is answered from that cache: after the first visit nothing is
//    fetched. A new build is a new cache; the old one is deleted on activate. In dev (`npm run
//    dev:web`) MANIFEST stays null and the app is left to the network.
// 2. The `vault/` origin. `vault/<vaultId>/<path>` answers a vault file and
//    `vault/~abs/<outsideId>/<name>` a file opened from outside, from the handle kept in
//    IndexedDB (`getFile()`), a Range answered with 206 as protocol.rs does, the type from
//    protocol.rs's table. When the worker cannot read the handle (the permission belongs to the
//    page), it asks the page that made the request over a MessageChannel.
//
// A module worker (registered with `type: 'module'`) with no import: the build copies it as it
// is, with MANIFEST filled in, and the tests import its pure parts. It opens the same database `ose-web` as src/web/idb.js, with the same stores should it be first.

/* @ose-manifest */ const MANIFEST = null;

/** @type {any} */
const sw = globalThis;
const BUILD = MANIFEST ? String(/** @type {any} */ (MANIFEST).build) : 'dev';
const CACHE = `ose-web-${BUILD}`;
const FILES = MANIFEST ? /** @type {string[]} */ (/** @type {any} */ (MANIFEST).files) : [];
const STORES = ['vaults', 'outside', 'drafts', 'local', 'log', 'meta'];
const ASK_WAIT = 5000;

/** protocol.rs `mime_of`. @param {string} ext */
function mimeOf(ext) {
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8';
    case 'js': case 'mjs': return 'text/javascript; charset=utf-8';
    case 'css': return 'text/css; charset=utf-8';
    case 'json': case 'map': return 'application/json; charset=utf-8';
    case 'jsonl': return 'application/x-ndjson; charset=utf-8';
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'ico': return 'image/x-icon';
    case 'bmp': return 'image/bmp';
    case 'pdf': return 'application/pdf';
    case 'wasm': return 'application/wasm';
    case 'woff2': return 'font/woff2';
    case 'woff': return 'font/woff';
    case 'ttf': return 'font/ttf';
    case 'otf': return 'font/otf';
    case 'mp4': case 'm4v': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mov': return 'video/quicktime';
    case 'ogg': case 'ogv': return 'video/ogg';
    case 'mp3': return 'audio/mpeg';
    case 'm4a': return 'audio/mp4';
    case 'wav': return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'opus': case 'oga': return 'audio/ogg';
    case 'txt': case 'md': return 'text/plain; charset=utf-8';
    case 'webmanifest': return 'application/manifest+json';
    default: return 'application/octet-stream';
  }
}

/** @param {string} name */
const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

// ---------------------------------------------------------------- IndexedDB, read only

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ose-web', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        if (s === 'log') db.createObjectStore(s, { autoIncrement: true });
        else db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {string} store @param {string} key @returns {Promise<any>} */
async function dbGet(store, key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

// ---------------------------------------------------------------- the vault origin

/**
 * `vault/<vaultId>/<path>` or `vault/~abs/<id>/<name>`, relative to the scope, as
 * `{ outside, vault, id, name, path, segs }`, or null when it is not a well-formed one. A `..`,
 * `.ose` or `.git` segment is never served.
 * @param {string} rel the part after `vault/`
 */
export function parseVaultPath(rel) {
  let segs;
  try { segs = rel.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (segs.length < 2) return null;
  if (segs.some((s) => s === '..' || s === '.' || s.includes('/') || s.includes('\\'))) return null;
  if (segs[0] === '~abs') {
    if (segs.length !== 3 || !/^[0-9a-f]{16}$/.test(segs[1] || '')) return null;
    return { outside: true, vault: '', id: segs[1] || '', name: segs[2] || '', path: '', segs: [] };
  }
  const vault = segs[0] || '';
  if (!/^[0-9a-f]{16}$/.test(vault)) return null;
  const inner = segs.slice(1);
  if (inner.some((s) => ['.ose', '.git'].includes(s.toLowerCase()) || s.endsWith('.crswap'))) return null;
  return { outside: false, vault, id: '', name: inner[inner.length - 1] || '', path: inner.join('/'), segs: inner };
}

/**
 * The file, read by the worker itself; null when it may not (permission) or it is not there.
 * @param {NonNullable<ReturnType<typeof parseVaultPath>>} t
 * @returns {Promise<File | null>}
 */
async function readHere(t) {
  if (t.outside) {
    const rec = await dbGet('outside', t.id);
    if (!rec || !rec.handle || rec.name !== t.name) return null;
    if (typeof rec.handle.queryPermission === 'function' && (await rec.handle.queryPermission({ mode: 'read' })) !== 'granted') return null;
    return rec.handle.getFile();
  }
  const rec = await dbGet('vaults', t.vault);
  if (!rec || !rec.handle) return null;
  /** @type {any} */
  let dir = rec.handle;
  if (typeof dir.queryPermission === 'function' && (await dir.queryPermission({ mode: 'read' })) !== 'granted') return null;
  for (const s of t.segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
  const fh = await dir.getFileHandle(t.segs[t.segs.length - 1]);
  return fh.getFile();
}

/**
 * Ask the page that made the request for the file (it holds the permission).
 * @param {string} clientId @param {NonNullable<ReturnType<typeof parseVaultPath>>} t
 * @returns {Promise<{ file: File | null, status: number }>}
 */
async function askClient(clientId, t) {
  const client = clientId ? await sw.clients.get(clientId) : null;
  if (!client) return { file: null, status: 404 };
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ file: null, status: 504 }), ASK_WAIT);
    ch.port1.onmessage = (ev) => {
      clearTimeout(timer);
      const d = ev.data || {};
      resolve(d.ok && d.file ? { file: d.file, status: 200 } : { file: null, status: Number(d.status) || 404 });
    };
    client.postMessage({ type: 'ose-vault-read', outside: t.outside, vault: t.vault, id: t.id, name: t.name, path: t.path }, [ch.port2]);
  });
}

/**
 * The response for a file: the whole of it, or the range asked for (206), or 416.
 * @param {Blob} file @param {string} name @param {string | null} range
 */
export function fileResponse(file, name, range) {
  const size = file.size;
  const headers = { 'Content-Type': mimeOf(extOf(name)), 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m) return new Response(file, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  let start;
  let end;
  if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else {
    start = Number(m[1] || 0);
    end = m[2] === '' || m[2] === undefined ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}

/** @param {any} event @param {string} rel */
async function vaultResponse(event, rel) {
  const t = parseVaultPath(rel);
  if (!t) return new Response('not found', { status: 404 });
  let file = null;
  try { file = await readHere(t); } catch { file = null; }
  if (!file) {
    const asked = await askClient(event.clientId || event.resultingClientId || '', t);
    if (!asked.file) return new Response('not found', { status: asked.status });
    file = asked.file;
  }
  return fileResponse(file, t.name, event.request.headers.get('range'));
}

// ---------------------------------------------------------------- the lifecycle

if (typeof sw.addEventListener === 'function' && typeof sw.registration !== 'undefined') {
  sw.addEventListener('install', (/** @type {any} */ event) => {
    event.waitUntil((async () => {
      if (FILES.length) {
        const cache = await caches.open(CACHE);
        await cache.addAll(FILES.map((f) => new URL(f, sw.registration.scope).href));
      }
      await sw.skipWaiting();
    })());
  });

  sw.addEventListener('activate', (/** @type {any} */ event) => {
    event.waitUntil((async () => {
      for (const k of await caches.keys()) if (k.startsWith('ose-web-') && k !== CACHE) await caches.delete(k);
      await sw.clients.claim();
    })());
  });

  sw.addEventListener('fetch', (/** @type {any} */ event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    const scope = new URL(sw.registration.scope);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    const rel = url.pathname.slice(scope.pathname.length);
    if (rel.startsWith('vault/')) { event.respondWith(vaultResponse(event, rel.slice('vault/'.length))); return; }
    if (!MANIFEST) return;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // A navigation to the app's folder (with `?vault=`) is the page itself.
      if (req.mode === 'navigate') {
        const page = await cache.match(new URL('index.html', scope).href);
        if (page) return page;
      }
      return fetch(req);
    })());
  });
}
