// Dev bridge: Node implementation of CONTRACT.md for browser development.
// Filesystem + /vault assets + state + SSE events + fs watcher + Claude Code child processes.
// Only used by `vite` in dev; the shipped app talks to the .NET host instead (src/bridge/webview.js).
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

  // ---------------------------------------------------------------- claude code
  const sessions = new Map(); // id -> { proc, cwd, killed }
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

  const claudeStart = async ({ cwd, permissionMode = 'default', resume, model } = {}) => {
    const info = await claudeInfo();
    if (!info.path) throw new Error('claude CLI not found (looked on PATH and in ~/.local/bin; set OS_CLAUDE to override)');
    const dir = resolveCwd(cwd);
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', permissionMode];
    if (resume) args.push('--resume', String(resume));
    if (model) args.push('--model', String(model));

    console.log('[bridge] claude ' + args.join(' ') + '  (cwd ' + dir + ')');

    const proc = spawn(info.path, args, {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const id = randomUUID();
    const sess = { proc, cwd: dir, killed: false };
    sessions.set(id, sess);

    const send = (event) => emit('claude', { id, event });
    const lineReader = (stream, onLine) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.trim()) onLine(line);
        }
      });
      stream.on('end', () => { const t = buf.trim(); buf = ''; if (t) onLine(t); });
    };

    lineReader(proc.stdout, (line) => {
      let obj = null;
      try { obj = JSON.parse(line); } catch { obj = null; }
      if (obj && typeof obj === 'object') send(obj);
      else send({ type: 'stderr', text: line });
    });
    lineReader(proc.stderr, (line) => send({ type: 'stderr', text: line }));

    proc.stdin.on('error', (e) => { if (e.code !== 'EPIPE') send({ type: 'stderr', text: 'stdin: ' + e.message }); });
    proc.on('error', (e) => { send({ type: 'stderr', text: 'spawn: ' + e.message }); });
    proc.on('close', (code, signal) => {
      sessions.delete(id);
      send({ type: 'exit', code: code === null ? (signal ? -1 : 0) : code });
    });
    return { id };
  };

  const writeLine = (id, obj) => {
    const s = sessions.get(id);
    if (!s) throw new Error('no such claude session: ' + id);
    if (!s.proc.stdin.writable) throw new Error('claude session stdin closed: ' + id);
    s.proc.stdin.write(JSON.stringify(obj) + '\n');
  };

  const claudeStop = async (id) => {
    const s = sessions.get(id);
    if (!s) return;
    s.killed = true;
    const pid = s.proc.pid;
    if (IS_WIN && pid) {
      await new Promise((resolve) => {
        execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
      });
    }
    try { s.proc.kill('SIGKILL'); } catch { }
  };

  // Claude Code keeps one .jsonl per session under
  // %USERPROFILE%/.claude/projects/<cwd with every non-alphanumeric character replaced by '-'>/.
  const transcriptPath = (sessionId) => {
    const id = String(sessionId || '');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad session id');
    const encoded = root.replace(/[^A-Za-z0-9]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', encoded, id + '.jsonl');
  };

  /** The `user` and `assistant` lines of a session transcript, in file order. Missing file -> []. */
  const claudeTranscript = async (sessionId) => {
    let raw;
    try { raw = await fs.readFile(transcriptPath(sessionId), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && (obj.type === 'user' || obj.type === 'assistant')) out.push(obj);
    }
    return out;
  };

  const killAll = () => {
    for (const [, s] of sessions) {
      const pid = s.proc.pid;
      try {
        if (IS_WIN && pid) spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
        else s.proc.kill('SIGKILL');
      } catch { }
    }
    sessions.clear();
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
    claudeStart: async (opts) => claudeStart(opts || {}),
    claudeSend: async (id, text) => { writeLine(id, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text ?? '') }] } }); },
    claudeInterrupt: async (id) => { writeLine(id, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }); },
    claudeStop,
    claudeTranscript,

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
