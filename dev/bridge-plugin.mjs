// Dev bridge: Node implementation of CONTRACT.md for browser development.
// Filesystem + /vault assets + state + SSE events + fs watcher + pseudo-terminals.
// Only used by `vite` in dev; the shipped app talks to the Tauri host instead (src/bridge/tauri.js).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

  // ---------------------------------------------------------------- claude cli
  let infoCache = null;

  const which = (bin) => {
    const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
    const dirs = [
      ...(process.env.OS_CLAUDE ? [path.dirname(process.env.OS_CLAUDE)] : []),
      path.join(os.homedir(), '.local', 'bin'),
      ...String(process.env.PATH || '').split(path.delimiter),
    ];
    for (const d of dirs) {
      if (!d) continue;
      for (const ext of exts) {
        const f = path.join(d, bin + ext);
        try { if (fss.statSync(f).isFile()) return f; } catch { }
      }
    }
    return null;
  };

  const claudeInfo = async () => {
    if (infoCache) return infoCache;
    const bin = (process.env.OS_CLAUDE && fss.existsSync(process.env.OS_CLAUDE) ? process.env.OS_CLAUDE : null) || which('claude');
    if (!bin) return (infoCache = { path: null });
    const version = await new Promise((resolve) => {
      execFile(bin, ['--version'], { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout).trim().match(/\d+\.\d+\.\d+[^\s]*/);
        resolve(m ? m[0] : String(stdout).trim().split(/\r?\n/)[0] || null);
      });
    });
    if (!version) return (infoCache = { path: null });
    return (infoCache = { path: bin, version });
  };

  const resolveCwd = (c) => {
    if (!c) return root;
    const full = path.isAbsolute(String(c)) ? path.resolve(String(c)) : abs(c);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('cwd outside root: ' + c);
    return full;
  };

  // ---------------------------------------------------------------- pseudo-terminals
  // node-pty is an optional dependency (it is prebuilt, but a machine can still fail to
  // install it); when it is missing every pty command says so instead of crashing the server.
  const ptys = new Map(); // id -> { proc }
  let nodePty; // undefined = not tried yet, null = unavailable
  const PTY_UNAVAILABLE = 'pty unavailable in the dev bridge';

  const loadPty = async () => {
    if (nodePty !== undefined) return nodePty;
    try {
      nodePty = (await import('@homebridge/node-pty-prebuilt-multiarch')).default ?? null;
    } catch (e) {
      console.warn('[bridge] node-pty unavailable: ' + (e && e.message ? e.message : e));
      nodePty = null;
    }
    if (!nodePty) throw new Error(PTY_UNAVAILABLE);
    return nodePty;
  };

  const ptyStart = async ({ cwd, cols, rows, cmd, args, env } = {}) => {
    const pty = await loadPty();
    let file = String(cmd || '').trim();
    let claudeEnv = {};
    const inherited = { ...process.env };
    if (!file) {
      const info = await claudeInfo();
      if (!info.path) throw new Error('claude CLI not found');
      file = info.path;
      // same rule as the host: sessions live in <vault>/.claude/projects/vault on every machine
      claudeEnv = { CLAUDE_CONFIG_DIR: path.join(root, '.claude'), CLAUDE_CODE_PROJECT_DIR_NAME: 'vault' };
      // a fresh top-level session: no inherited CLAUDE* variables from whatever runs this server
      for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith('CLAUDE')) inherited[k] = undefined;
    }
    const dir = resolveCwd(cwd);
    const id = randomUUID();
    const proc = pty.spawn(file, Array.isArray(args) ? args.map(String) : [], {
      name: 'xterm-256color',
      cols: Math.max(1, Number(cols) || 80),
      rows: Math.max(1, Number(rows) || 24),
      cwd: dir,
      useConpty: true,
      env: {
        ...inherited,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
        ...claudeEnv,
        ...(env && typeof env === 'object' ? env : {}),
      },
    });
    console.log('[bridge] pty ' + id + ': ' + file + ' ' + (args || []).join(' ') + '  (cwd ' + dir + ')');
    ptys.set(id, { proc });

    // node-pty hands us a string it decoded itself; the contract carries raw bytes as base64,
    // so it is re-encoded here. The host emits the true bytes; both decode the same on the web
    // side because the terminal writes UTF-8 either way.
    proc.onData((data) => emit('pty', { id, data: Buffer.from(data, 'utf8').toString('base64') }));
    proc.onExit(({ exitCode, signal }) => {
      ptys.delete(id);
      emit('pty', { id, exit: exitCode === undefined || exitCode === null ? (signal ? -1 : 0) : exitCode });
    });
    return { id };
  };

  const usePty = (id) => {
    if (nodePty === null) throw new Error(PTY_UNAVAILABLE);
    const s = ptys.get(id);
    if (!s) throw new Error('no pty ' + id);
    return s;
  };

  // Killing a pty that has already exited is not an error; killing one when node-pty never
  // loaded is, so the view says the same thing for every pty command.
  const ptyKill = async (id) => {
    if (nodePty === null) throw new Error(PTY_UNAVAILABLE);
    const s = ptys.get(id);
    if (!s) return;
    ptys.delete(id);
    try { s.proc.kill(); } catch { }
  };

  const killAll = () => {
    for (const [, s] of ptys) { try { s.proc.kill(); } catch { } }
    ptys.clear();
  };

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
  const cmds = {
    rootInfo: async () => ({ root, name: path.basename(root) }),
    tree: async () => { const t = await tree(root); t.name = path.basename(root); t.path = ''; return t; },
    list: async (p) => listDir(abs(p)),
    stat: async (p) => { try { const st = await fs.stat(abs(p)); return { exists: true, kind: st.isDirectory() ? 'dir' : 'file', mtime: st.mtimeMs, size: st.size }; } catch { return { exists: false }; } },
    exists: async (p) => fss.existsSync(abs(p)),
    readText: async (p) => fs.readFile(abs(p), 'utf8'),
    writeText: async (p, text) => { const f = abs(p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, text, 'utf8'); },
    appendText: async (p, text) => { const f = abs(p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.appendFile(f, text, 'utf8'); },
    writeBinary: async (p, b64) => { const f = abs(p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, Buffer.from(b64, 'base64')); },
    mkdir: async (p) => fs.mkdir(abs(p), { recursive: true }),
    rename: async (a, b) => { await fs.mkdir(path.dirname(abs(b)), { recursive: true }); await fs.rename(abs(a), abs(b)); },
    trash: async (p) => { const t = path.join(root, '.trash'); await fs.mkdir(t, { recursive: true }); await fs.rename(abs(p), path.join(t, Date.now() + '-' + path.basename(p))); },
    search: async (q, opts) => search(q, opts),

    claudeInfo,
    log: async (text) => { console.log('[selftest]', String(text)); },
    platform: async () => ({ os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', version: 'dev', exe: process.execPath, root }),
    ptyStart: async (opts) => ptyStart(opts || {}),
    ptyWrite: async (id, data) => { usePty(id).proc.write(String(data ?? '')); },
    ptyResize: async (id, cols, rows) => { usePty(id).proc.resize(Math.max(1, Number(cols) || 80), Math.max(1, Number(rows) || 24)); },
    ptyKill,

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
      const shutdown = () => { stopWatch(); killAll(); for (const c of clients) { clearInterval(c.ping); try { c.res.end(); } catch { } } clients.clear(); };
      server.httpServer?.on('close', shutdown);
      process.once('exit', shutdown);
      process.once('SIGINT', () => { shutdown(); process.exit(0); });

      server.middlewares.use(async (req, res, next) => {
        const url = decodeURIComponent(req.url.split('?')[0]);

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
