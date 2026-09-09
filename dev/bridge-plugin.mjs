// Dev bridge: Node implementation of CONTRACT.md for browser development.
// Filesystem + /vault assets + state + SSE events + fs watcher.
// Only used by `vite` in dev; the shipped app talks to the Tauri host instead (src/bridge/tauri.js).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { vaultRoot, rootSource } from './root.mjs';

const HIDE = new Set(['.git', '.obsidian', '.claude', '.vscode', '.trash', 'node_modules', 'App', '.tmp.driveupload', '.makemd', '.space', 'os.exe', 'os.pdb']);
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const IS_WIN = process.platform === 'win32';

// A path segment is hidden when it is in HIDE or is a dotfile. Used by the tree and the watcher.
const hiddenSegment = (s) => !s || HIDE.has(s) || s.startsWith('.');
const hiddenPath = (relPath) => relPath.split(/[\\/]+/).some(hiddenSegment);

export function bridgePlugin() {
  // OSE_ROOT / OS_ROOT env, else ose.config.json at the repo root, else the parent folder.
  const root = vaultRoot();
  console.log(`[bridge] vault root: ${root} (from ${rootSource()})`);
  const abs = (p) => {
    const full = path.resolve(root, String(p ?? '').replace(/^\/+/, ''));
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path outside root: ' + p);
    return full;
  };
  const rel = (full) => path.relative(root, full).split(path.sep).join('/');
  const node = async (full, st) => {
    st = st || await fs.stat(full);
    const name = path.basename(full);
    return { name, path: rel(full), kind: st.isDirectory() ? 'dir' : 'file', ext: st.isDirectory() ? '' : path.extname(name).slice(1).toLowerCase(), mtime: st.mtimeMs, size: st.size };
  };
  const listDir = async (full) => {
    const ents = await fs.readdir(full, { withFileTypes: true });
    const out = [];
    for (const e of ents) {
      if (hiddenSegment(e.name)) continue;
      try { out.push(await node(path.join(full, e.name))); } catch { }
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'fr', { numeric: true }) : a.kind === 'dir' ? -1 : 1));
    return out;
  };
  const tree = async (full) => {
    const n = await node(full);
    if (n.kind === 'dir') n.children = await Promise.all((await listDir(full)).map(c => c.kind === 'dir' ? tree(path.join(full, c.name)) : c));
    return n;
  };
  const search = async (q, { limit = 200 } = {}) => {
    const out = [], needle = String(q || '').toLowerCase();
    const walk = async (full) => {
      for (const c of await listDir(full)) {
        if (out.length >= limit) return;
        if (c.kind === 'dir') await walk(path.join(full, c.name));
        else if (c.ext === 'md') {
          let lines;
          try { lines = (await fs.readFile(path.join(full, c.name), 'utf8')).split(/\r?\n/); } catch { continue; }
          lines.forEach((t, i) => { if (out.length < limit && t.toLowerCase().includes(needle)) out.push({ path: c.path, line: i + 1, text: t.trim().slice(0, 240) }); });
        }
      }
    };
    if (needle) await walk(root);
    return out;
  };

  // ---------------------------------------------------------------- events (SSE)
  const clients = new Set(); // { res, ping }
  const emit = (event, data) => {
    if (!clients.size) return;
    const frame = 'data: ' + JSON.stringify({ event, data }) + '\n\n';
    for (const c of clients) { try { c.res.write(frame); } catch { } }
  };

  function openStream(req, res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    try { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true); } catch { }
    // retry hint for EventSource's own reconnect, then an immediate hello so onopen fires fast
    res.write('retry: 1000\n\n');
    res.write('data: ' + JSON.stringify({ event: 'bridge', data: { connected: true, pid: process.pid } }) + '\n\n');
    const client = { res, ping: setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { } }, 20000) };
    clients.add(client);
    const done = () => { clearInterval(client.ping); clients.delete(client); try { res.end(); } catch { } };
    req.on('close', done); req.on('error', done); res.on('error', done);
  }

  // ---------------------------------------------------------------- fs watcher
  let watcher = null, watchTimer = null, restartTimer = null;
  const pending = new Map(); // relPath -> { renamed:boolean }
  const known = new Set();   // paths we have already reported as existing

  const flush = async () => {
    watchTimer = null;
    const batch = [...pending.entries()];
    pending.clear();
    const changes = [];
    for (const [p, info] of batch) {
      let st = null;
      try { st = await fs.stat(path.join(root, p)); } catch { st = null; }
      let kind;
      if (!st) { kind = 'delete'; known.delete(p); }
      else if (!known.has(p) && (info.renamed || Date.now() - st.birthtimeMs < 3000)) { kind = 'create'; known.add(p); }
      else { kind = 'modify'; known.add(p); }
      changes.push({ path: p, kind });
    }
    if (changes.length) emit('fs', { changes });
  };

  function startWatch() {
    clearTimeout(restartTimer); restartTimer = null;
    try {
      watcher = fss.watch(root, { recursive: true, persistent: true }, (type, filename) => {
        if (!filename) return;
        const relPath = String(filename).split(path.sep).join('/');
        if (hiddenPath(relPath)) return;
        const prev = pending.get(relPath) || { renamed: false };
        if (type === 'rename') prev.renamed = true;
        pending.set(relPath, prev);
        if (!watchTimer) watchTimer = setTimeout(() => { flush().catch(() => { }); }, 150);
      });
      watcher.on('error', (e) => {
        console.warn('[bridge] watcher error:', e.message);
        try { watcher.close(); } catch { }
        watcher = null;
        if (!restartTimer) restartTimer = setTimeout(startWatch, 1000);
      });
    } catch (e) {
      console.warn('[bridge] watch failed:', e.message);
      watcher = null;
      if (!restartTimer) restartTimer = setTimeout(startWatch, 2000);
    }
  }

  function stopWatch() {
    clearTimeout(watchTimer); watchTimer = null;
    clearTimeout(restartTimer); restartTimer = null;
    try { watcher?.close(); } catch { }
    watcher = null;
  }

  // ---------------------------------------------------------------- shell out
  const openExternal = async (url) => {
    let u;
    try { u = new URL(String(url)); } catch { throw new Error('not a url: ' + url); }
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error('refused protocol: ' + u.protocol);
    const safe = u.href.replace(/"/g, '%22');
    if (IS_WIN) {
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${safe}"`], { windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [safe], { detached: true, stdio: 'ignore' }).unref();
    }
  };

  const reveal = async (p) => {
    const full = abs(p);
    const exists = fss.existsSync(full);
    if (IS_WIN) {
      const target = exists ? full : path.dirname(full);
      const arg = exists ? `/select,"${target}"` : `"${target}"`;
      spawn('explorer.exe', [arg], { windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [exists ? path.dirname(full) : full], { detached: true, stdio: 'ignore' }).unref();
    }
  };

  // ---------------------------------------------------------------- commands
  const statePath = () => path.join(root, '.ose', 'state.json'); // same file the Tauri host uses
  // The dev bridge always has a root (dev/root.mjs). `?novault=1` on the page makes rootInfo
  // and vaultInfo answer as the host does before a vault is chosen, so the choose-vault surface
  // can be seen in a browser; pickVault then "chooses" the configured root without a dialog and
  // the page reloads without the flag. The flag arrives as a query on the bridge call (http.js).
  let noVault = false;
  const cmds = {
    rootInfo: async () => (noVault ? { root: null, name: null } : { root, name: path.basename(root) }),
    vaultInfo: async () => (noVault
      ? { root: null, name: null, remembered: false, source: null }
      : { root, name: path.basename(root), remembered: false, source: 'dev' }),
    pickVault: async () => ({ root, name: path.basename(root) }),
    forgetVault: async () => null,
    tree: async () => { const t = await tree(root); t.name = path.basename(root); t.path = ''; return t; },
    list: async (p) => listDir(abs(p)),
    stat: async (p) => { try { const st = await fs.stat(abs(p)); return { exists: true, kind: st.isDirectory() ? 'dir' : 'file', mtime: st.mtimeMs, size: st.size }; } catch { return { exists: false }; } },
    exists: async (p) => fss.existsSync(abs(p)),
    readText: async (p) => fs.readFile(abs(p), 'utf8'),
    writeText: async (p, text) => { const f = abs(p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, text, 'utf8'); },
    appendText: async (p, text) => { const f = abs(p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.appendFile(f, text, 'utf8'); },
    writeBinary: async (p, b64) => { const f = abs(p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, Buffer.from(b64, 'base64')); },
    mkdir: async (p) => fs.mkdir(abs(p), { recursive: true }),
    // Never overwrites, like the host (vault.rs `rename`): a rename onto an existing page would
    // silently swallow it, and the UI relies on the refusal to report the collision (batch 9, B8).
    rename: async (a, b) => {
      const src = abs(a), dst = abs(b);
      if (!fss.existsSync(src)) throw new Error('nothing to rename: ' + a);
      if (src !== dst && fss.existsSync(dst)) throw new Error('already exists: ' + b);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
    },
    trash: async (p) => { const t = path.join(root, '.trash'); await fs.mkdir(t, { recursive: true }); await fs.rename(abs(p), path.join(t, Date.now() + '-' + path.basename(p))); },
    search: async (q, opts) => search(q, opts),

    log: async (text) => { console.log('[selftest]', String(text)); },
    platform: async () => ({ os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', version: 'dev', exe: process.execPath, exeDir: path.dirname(process.execPath), root: noVault ? null : root }),

    getState: async () => { try { return JSON.parse(await fs.readFile(statePath(), 'utf8')); } catch { return {}; } },
    setState: async (o) => { await fs.mkdir(path.dirname(statePath()), { recursive: true }); await fs.writeFile(statePath(), JSON.stringify(o ?? {}, null, 2), 'utf8'); },
    openExternal, reveal,

    winMinimize: async () => { }, winMaximize: async () => { }, winClose: async () => { }, winIsMaximized: async () => false,
    winStartDrag: async () => { }, winStartResize: async () => { }, winSetTheme: async () => { },
  };

  return {
    name: 'os-dev-bridge',
    configureServer(server) {
      startWatch();
      const shutdown = () => { stopWatch(); for (const c of clients) { clearInterval(c.ping); try { c.res.end(); } catch { } } clients.clear(); };
      server.httpServer?.on('close', shutdown);
      process.once('exit', shutdown);
      process.once('SIGINT', () => { shutdown(); process.exit(0); });

      server.middlewares.use(async (req, res, next) => {
        const [rawPath, rawQuery = ''] = req.url.split('?');
        const url = decodeURIComponent(rawPath);

        if (url === '/__bridge/events') { openStream(req, res); return; }

        if (url.startsWith('/vault/')) {
          try {
            const f = abs(url.slice(7));
            const st = await fs.stat(f);
            if (!st.isFile()) throw new Error('not a file');
            res.setHeader('Content-Type', mime[path.extname(f).toLowerCase()] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            fss.createReadStream(f).pipe(res);
          } catch { res.statusCode = 404; res.end('not found'); }
          return;
        }

        if (!url.startsWith('/__bridge/')) return next();
        const cmd = url.slice(10);
        noVault = /(^|&)novault=1(&|$)/.test(rawQuery);
        let body = '';
        for await (const chunk of req) body += chunk;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const { args = [] } = body ? JSON.parse(body) : {};
          if (!Object.prototype.hasOwnProperty.call(cmds, cmd)) throw new Error('unknown command ' + cmd);
          const result = await cmds[cmd](...args);
          res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: `${cmd}: ${e && e.message ? e.message : String(e)}` }));
        }
      });
    },
  };
}
