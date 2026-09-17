// Dev bridge: the Node implementation of what the Tauri host answers, for browser development.
// Filesystem + /vault assets + state + SSE events + fs watcher.
// Only used by `vite` in dev; the shipped app talks to the Tauri host instead (src/bridge/tauri.js).
//
// A command this bridge does not implement answers null and is named once in the log, exactly
// as the host does: the two sides are changed by different hands and neither may break the
// other.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { vaultRoot, rootSource } from './root.mjs';

const HIDE = new Set(['.git', '.obsidian', '.claude', '.vscode', '.trash', 'node_modules', 'App', '.tmp.driveupload', '.makemd', '.space',
  // The executable itself, and the bundle on macOS (vault.rs). Both names: the app is `ose`
  // from 0.4.0 on and a copy already on disk keeps the name it has.
  'ose.exe', 'ose.pdb', 'Ose.app',
  'os.exe', 'os.pdb', 'os.app']);
// The types `/vault/...` answers with. It follows the host's table (src-tauri/src/protocol.rs
// `mime_of`) for everything the shell can put on a page, because a PDF page and an image page
// are drawn by the web view itself from this type and nothing else: a `.bmp` served as
// octet-stream is a broken picture in the browser dev and a good one in the host, which is the
// worst kind of difference between the two.
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
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
  // The vault search, the same semantics as the host (src-tauri/src/vault.rs `search`): terms
  // ANDed within a file, `path:` and `file:` filters, quoted phrases, names matched, the text
  // extensions read, a `col` on every line hit, a cap that counts files, and one generation
  // counter per caller channel so a newer query abandons the walk the older one started.
  const SEARCH_EXTS = new Set(['md', 'txt', 'csv', 'jsonl', 'py', 'log', 'tex', 'json', 'yaml', 'toml']);
  const LINES_PER_FILE = 20;
  const searchGen = new Map();

  /** `a "b c" path:x file:y` -> { terms, paths, files }, everything lowercased. */
  const parseQuery = (q) => {
    const out = { terms: [], paths: [], files: [] };
    const s = String(q || '');
    let i = 0;
    while (i < s.length) {
      if (/\s/.test(s[i])) { i++; continue; }
      let kind = 0;
      for (const [word, k] of [['path:', 1], ['file:', 2]]) {
        if (s.slice(i, i + word.length).toLowerCase() === word) { kind = k; i += word.length; break; }
      }
      let word = '';
      if (s[i] === '"') {
        i++;
        while (i < s.length && s[i] !== '"') word += s[i++];
        i++;
      } else {
        while (i < s.length && !/\s/.test(s[i])) word += s[i++];
      }
      word = word.trim().toLowerCase();
      if (!word) continue;
      if (kind === 1) out.paths.push(word.replace(/\\/g, '/'));
      else if (kind === 2) out.files.push(word);
      else out.terms.push(word);
    }
    return out;
  };

  const searchAllowed = (q, rel, name) => {
    const r = rel.toLowerCase();
    return (!q.paths.length || q.paths.some((p) => r.startsWith(p.replace(/\/+$/, ''))))
      && (!q.files.length || q.files.some((f) => name.includes(f)));
  };

  const search = async (q, { limit = 100, chan = null } = {}) => {
    const query = parseQuery(q);
    if (!query.terms.length && !query.paths.length && !query.files.length) {
      return { hits: [], files: 0, total: 0, capped: false, stale: false };
    }
    let gen = 0;
    if (chan) { gen = (searchGen.get(chan) || 0) + 1; searchGen.set(chan, gen); }
    const current = () => !chan || searchGen.get(chan) === gen;

    const found = [];
    let stale = false;
    const walk = async (full) => {
      if (!current()) { stale = true; return; }
      for (const c of await listDir(full)) {
        if (!current()) { stale = true; return; }
        const name = c.name.toLowerCase();
        const ok = searchAllowed(query, c.path, name);
        const nameHit = !!query.terms.length && query.terms.every((t) => name.includes(t));
        if (c.kind === 'dir') {
          if (ok && nameHit) found.push({ path: c.path, kind: 'dir', nameHit: true, total: 0, lines: [] });
          await walk(path.join(full, c.name));
          continue;
        }
        if (!ok) continue;
        if (!SEARCH_EXTS.has(c.ext)) {
          if (nameHit) found.push({ path: c.path, kind: 'file', nameHit: true, total: 0, lines: [] });
          continue;
        }
        let text;
        try { text = await fs.readFile(path.join(full, c.name), 'utf8'); } catch { continue; }
        const lower = text.toLowerCase();
        const relLower = c.path.toLowerCase();
        // A term found in the path counts, so `philosophy kant` finds a page about Kant that
        // sits in a philosophy folder without repeating the word.
        if (!query.terms.every((t) => lower.includes(t) || relLower.includes(t))) {
          if (nameHit) found.push({ path: c.path, kind: 'file', nameHit: true, total: 0, lines: [] });
          continue;
        }
        const lines = [];
        let total = 0;
        text.split(/\r?\n/).forEach((line, i) => {
          const low = line.toLowerCase();
          let at = -1;
          for (const t of query.terms) { const k = low.indexOf(t); if (k >= 0 && (at < 0 || k < at)) at = k; }
          if (at < 0) return;
          total++;
          if (lines.length >= LINES_PER_FILE) return;
          const before = low.slice(0, at);
          const lead = (/^\s*/.exec(before) || [''])[0].length;
          lines.push({ path: c.path, line: i + 1, col: before.length - lead + 1, text: line.trim().slice(0, 240), kind: 'file' });
        });
        if (lines.length || nameHit) found.push({ path: c.path, kind: 'file', nameHit, total, lines });
      }
    };
    await walk(root);

    found.sort((a, b) => (b.nameHit - a.nameHit) || (b.total - a.total) || a.path.localeCompare(b.path, 'fr', { numeric: true }));
    const total = found.length;
    const cap = limit === 0 ? Infinity : limit;
    const capped = total > cap;
    const kept = capped ? found.slice(0, cap) : found;
    const hits = [];
    for (const f of kept) {
      if (f.nameHit) hits.push({ path: f.path, line: 0, col: 0, text: f.path, kind: f.kind });
      hits.push(...f.lines);
    }
    return { hits, files: kept.length, total, capped, stale };
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

  // `openPath` (N10, N24): a vault file in the platform's default application. The argument is
  // vault-relative and goes through `abs`, so it can never leave the root, and the file has to
  // exist — the host refuses the same way, and neither ever sees a scheme.
  // Executables and scripts are revealed, never run: a link in a page must not start a program.
  const EXECUTABLE = new Set(['exe', 'bat', 'cmd', 'com', 'msi', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr',
    'pif', 'reg', 'lnk', 'url', 'sh', 'command', 'app', 'jar', 'py', 'pyw', 'rb', 'pl']);
  const openPath = async (p) => {
    const full = abs(p);
    if (!fss.existsSync(full)) throw new Error('nothing to open: ' + p);
    if (EXECUTABLE.has(path.extname(full).slice(1).toLowerCase())) return reveal(p);
    if (IS_WIN) {
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${full}"`], { windowsHide: true, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [full], { detached: true, stdio: 'ignore' }).unref();
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

  // ---------------------------------------------------------------- versions (batch 12, P5)
  // The same rules as the host (src-tauri/src/versions.rs): `.ose/versions/<rel>/<id>.md`, the
  // page's own name used as a folder, ids in UTC so they sort, one version per file per five
  // minutes unless forced, 20 per file, 50 MB per vault, every write atomic (temp then rename).
  const V_ROOT = '.ose/versions';
  const V_INTERVAL = 5 * 60 * 1000;
  const V_PER_FILE = 20;
  const V_TOTAL = 50 * 1024 * 1024;
  const vId = (ms) => {
    const d = new Date(ms), p2 = (n) => String(n).padStart(2, '0');
    return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  };
  const vOk = (id) => /^[0-9-]{1,40}$/.test(String(id ?? ''));
  // `abs` only promises the vault; `.ose/versions/../pages` is inside it and outside the
  // history, so containment in the history is checked here as well.
  const vDir = (p) => {
    const rel = String(p ?? '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
    if (!rel) throw new Error('a version needs a file');
    const base = abs(V_ROOT), full = abs(V_ROOT + '/' + rel);
    if (full === base || !full.startsWith(base + path.sep)) throw new Error('path escapes the version history: ' + p);
    return full;
  };
  const vList = async (p) => {
    const dir = vDir(p);
    let names = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.md') || !vOk(n.slice(0, -3))) continue;
      try { const st = await fs.stat(path.join(dir, n)); if (st.isFile()) out.push({ id: n.slice(0, -3), at: st.mtimeMs, bytes: st.size }); } catch { }
    }
    out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return out;
  };
  // Temp-plus-rename, the way the host writes every file (vault.rs `write_atomic`, S25): the
  // new bytes are on disk before the name changes, so an interrupted write cannot leave half a
  // file where a whole one was. The counter beside the pid is what keeps two writes inside one
  // process from choosing the same temp name. Every write in this bridge goes through here —
  // the dev bridge is where every agent tests, so it must not be the softer of the two (QA
  // severity 4, "Dev bridge writes are not atomic").
  let tmpN = 0;
  const atomicWrite = async (full, data, enc) => {
    await fs.mkdir(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.${tmpN++}.tmp`);
    await fs.writeFile(tmp, data, enc);
    await fs.rename(tmp, full);
  };
  const vWrite = (full, text) => atomicWrite(full, text, 'utf8');
  const vPruneFile = async (p) => {
    const dir = vDir(p);
    for (const e of (await vList(p)).slice(V_PER_FILE)) { try { await fs.unlink(path.join(dir, e.id + '.md')); } catch { } }
  };
  const vPruneVault = async () => {
    const all = [];
    const walk = async (dir, depth) => {
      if (depth > 32) return;
      let ents;
      try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!e.name.endsWith('.md') || !vOk(e.name.slice(0, -3))) continue;
        try { const st = await fs.stat(full); all.push({ dir, full, id: e.name.slice(0, -3), bytes: st.size }); } catch { }
      }
    };
    await walk(abs(V_ROOT), 0);
    let total = all.reduce((n, e) => n + e.bytes, 0);
    if (total <= V_TOTAL) return;
    all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const left = new Map();
    for (const e of all) left.set(e.dir, (left.get(e.dir) || 0) + 1);
    for (const e of all) {
      if (total <= V_TOTAL) break;
      if ((left.get(e.dir) || 1) <= 1) continue;            // never the last version of a file
      try { await fs.unlink(e.full); left.set(e.dir, left.get(e.dir) - 1); total -= e.bytes; } catch { }
    }
  };

  // ---------------------------------------------------------------- run
  // The same shapes as the host (src-tauri/src/run.rs): no shell, the UTF-8 floor, lines
  // streamed as the `run` event, `{done:true, code, timedOut}` at the end, and every child
  // killed when this server stops. There is no allow list and no refusal: a plugin is the
  // vault owner's own code and may run any program (docs/PLUGINS.md).
  const RUN_UTF8 = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  const RUN_DEFAULT_TIMEOUT = 60000;
  const running = new Map(); // id -> { child, timedOut }

  const runKill = async (id) => {
    const entry = running.get(id);
    if (!entry) return false;
    try { entry.child.kill(); } catch { }
    return true;
  };

  const killAllRuns = () => { for (const id of [...running.keys()]) runKill(id); };

  const run = async (id, program, args = [], opts = {}) => {
    id = String(id ?? '');
    if (!id.trim()) throw new Error('run needs an id');
    if (running.has(id)) throw new Error('run id in use: ' + id);
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error('run: args must be a list of strings');

    // A program name goes to PATH; anything with a separator is a file inside the vault.
    let exe = String(program ?? '').trim();
    if (!exe) throw new Error('run needs a program');
    if (/[\\/]/.test(exe)) {
      exe = abs(exe);
      if (!fss.existsSync(exe)) throw new Error('no such program in the vault: ' + program);
    } else if (exe.includes(':')) {
      throw new Error('not a program name: ' + program);
    }

    const cwd = opts.cwd ? abs(opts.cwd) : root;
    if (!fss.existsSync(cwd)) throw new Error('no such folder: ' + opts.cwd);
    const env = { ...process.env, ...RUN_UTF8 };
    for (const [k, v] of Object.entries(opts.env || {})) {
      if (v === null) delete env[k]; else env[k] = String(v);
    }

    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, timedOut: false };
    running.set(id, entry);

    const timeoutMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : RUN_DEFAULT_TIMEOUT;
    const timer = setTimeout(() => { entry.timedOut = true; try { child.kill(); } catch { } }, timeoutMs);

    // One event per line, no trailing newline, the last partial line included.
    const lines = (stream, name) => {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        rest += chunk;
        const parts = rest.split(/\r?\n/);
        rest = parts.pop();
        for (const line of parts) emit('run', { id, stream: name, line });
      });
      stream.on('end', () => { if (rest) emit('run', { id, stream: name, line: rest }); rest = ''; });
    };
    lines(child.stdout, 'stdout');
    lines(child.stderr, 'stderr');

    child.stdin.end(typeof opts.input === 'string' ? opts.input : '');
    child.on('error', (e) => {
      clearTimeout(timer);
      running.delete(id);
      emit('run', { id, stream: 'stderr', line: String(e.message || e) });
      emit('run', { id, done: true, code: null, timedOut: entry.timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(id);
      emit('run', { id, done: true, code: entry.timedOut ? null : code, timedOut: entry.timedOut });
    });
    return { id, pid: child.pid };
  };

  // ---------------------------------------------------------------- commands
  const statePath = () => path.join(root, '.ose', 'state.json'); // same file the Tauri host uses
  // The dev bridge always has a root (dev/root.mjs). `?novault=1` on the page makes rootInfo
  // and vaultInfo answer as the host does before a vault is chosen, so the choose-vault surface
  // can be seen in a browser; pickVault then "chooses" the configured root without a dialog and
  // the page reloads without the flag. The flag arrives as a query on the bridge call (http.js).
  let noVault = false;
  // A command this bridge does not implement: named once in the log, null to the caller.
  const unknown = new Set();
  const cmds = {
    rootInfo: async () => (noVault ? { root: null, name: null } : { root, name: path.basename(root) }),
    vaultInfo: async () => (noVault
      ? { root: null, name: null, remembered: false, source: null }
      : { root, name: path.basename(root), remembered: false, source: 'dev' }),
    pickVault: async () => ({ root, name: path.basename(root) }),
    // Recent vaults are the host's business (src-tauri/src/vaults.rs): the dev bridge has one
    // configured root and no per-user config folder, so the list is the vault it is serving.
    recentVaults: async () => (noVault ? [] : [{ path: root, name: path.basename(root), exists: true, current: true }]),
    openVault: async () => ({ root, name: path.basename(root) }),
    forgetVault: async () => null,
    tree: async () => { const t = await tree(root); t.name = path.basename(root); t.path = ''; return t; },
    list: async (p) => listDir(abs(p)),
    stat: async (p) => { try { const st = await fs.stat(abs(p)); return { exists: true, kind: st.isDirectory() ? 'dir' : 'file', mtime: st.mtimeMs, size: st.size }; } catch { return { exists: false }; } },
    exists: async (p) => fss.existsSync(abs(p)),
    readText: async (p) => fs.readFile(abs(p), 'utf8'),
    writeText: async (p, text) => { await atomicWrite(abs(p), text, 'utf8'); },
    appendText: async (p, text) => { const f = abs(p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.appendFile(f, text, 'utf8'); },
    writeBinary: async (p, b64) => { await atomicWrite(abs(p), Buffer.from(b64, 'base64'), null); },
    // `ose.files.readBinary`: the bytes as base64, the counterpart of writeBinary, the same
    // path rules as readText (vault.rs `read_binary`).
    readBinary: async (p) => (await fs.readFile(abs(p))).toString('base64'),
    mkdir: async (p) => fs.mkdir(abs(p), { recursive: true }),
    // Never overwrites, like the host (vault.rs `rename`): a rename onto an existing page would
    // silently swallow it, and the UI relies on the refusal to report the collision (batch 9, B8).
    // `Notes.md` -> `notes.md` is a real rename, not a collision (N17): on Windows and on a
    // default macOS volume `existsSync` says the target is there because it *is* the source.
    // It goes through a temporary name, exactly as the host does (vault.rs `rename`).
    rename: async (a, b) => {
      const src = abs(a), dst = abs(b);
      if (!fss.existsSync(src)) throw new Error('nothing to rename: ' + a);
      if (src === dst) return;
      if (src !== dst && src.toLowerCase() === dst.toLowerCase()) {
        const via = path.join(path.dirname(dst), `.${path.basename(dst)}.${process.pid}.case`);
        await fs.rename(src, via);
        await fs.rename(via, dst);
        return;
      }
      if (fss.existsSync(dst)) throw new Error('already exists: ' + b);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
    },
    // `mode` is 'system' or 'vault' (settings, S37). Node has no recycle bin, so the dev
    // bridge always does what 'vault' means and never deletes anything outright.
    trash: async (p, opts) => {
      const t = path.join(root, '.trash');
      await fs.mkdir(t, { recursive: true });
      await fs.rename(abs(p), path.join(t, Date.now() + '-' + path.basename(p)));
      if (opts && opts.mode && opts.mode !== 'vault') console.log('[bridge] trash: no recycle bin in the dev bridge, used .trash');
    },
    search: async (q, opts) => search(q, opts),

    versionKeep: async (p, text, force = false) => {
      if (!text) return { kept: false, id: null };
      const dir = vDir(p);
      const list = await vList(p);
      const newest = list[0];
      if (newest) {
        try { if (await fs.readFile(path.join(dir, newest.id + '.md'), 'utf8') === text) return { kept: false, id: null }; } catch { }
        if (!force && Date.now() - newest.at < V_INTERVAL) return { kept: false, id: null };
      }
      let ms = Date.now(), id = vId(ms);
      while (list.some((e) => e.id === id)) { ms += 1000; id = vId(ms); }
      await vWrite(path.join(dir, id + '.md'), text);
      await vPruneFile(p);
      await vPruneVault();
      return { kept: true, id };
    },
    versionList: async (p) => vList(p),
    versionRead: async (p, id) => {
      if (!vOk(id)) throw new Error('not a version id: ' + id);
      return fs.readFile(path.join(vDir(p), id + '.md'), 'utf8');
    },
    // Only "there is no file" means there is nothing to keep (F3, versions.rs `restore`): a
    // file that cannot be read holds text no version has, so the restore fails and writes
    // nothing rather than putting the old version over content it never saw.
    versionRestore: async (p, id) => {
      const text = await cmds.versionRead(p, id);
      let current = '';
      try { current = await fs.readFile(abs(p), 'utf8'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const kept = (!current || current === text) ? { kept: false, id: null } : await cmds.versionKeep(p, current, true);
      await vWrite(abs(p), text);
      return kept;
    },

    run: async (id, cmd, args, opts) => run(id, cmd, args, opts),
    runKill: async (id) => runKill(id),

    log: async (text) => { console.log('[app]', String(text)); },
    platform: async () => ({ os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', version: 'dev', build: null, exe: process.execPath, exeDir: path.dirname(process.execPath), root: noVault ? null : root }),

    getState: async () => { try { return JSON.parse(await fs.readFile(statePath(), 'utf8')); } catch { return {}; } },
    setState: async (o) => { await fs.mkdir(path.dirname(statePath()), { recursive: true }); await fs.writeFile(statePath(), JSON.stringify(o ?? {}, null, 2), 'utf8'); },
    openExternal, reveal, openPath,

    winMinimize: async () => { }, winMaximize: async () => { }, winClose: async () => { }, winIsMaximized: async () => false,
    winStartDrag: async () => { }, winStartResize: async () => { }, winSetTheme: async () => { },
    winSetTitle: async () => { },
    quit: async () => { },
  };

  return {
    name: 'os-dev-bridge',
    configureServer(server) {
      startWatch();
      const shutdown = () => { stopWatch(); killAllRuns(); for (const c of clients) { clearInterval(c.ping); try { c.res.end(); } catch { } } clients.clear(); };
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
          if (!Object.prototype.hasOwnProperty.call(cmds, cmd)) {
            if (!unknown.has(cmd)) { unknown.add(cmd); console.log(`[bridge] no such command: ${cmd} (answering null)`); }
            res.end(JSON.stringify({ ok: true, result: null }));
            return;
          }
          const result = await cmds[cmd](...args);
          res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: `${cmd}: ${e && e.message ? e.message : String(e)}` }));
        }
      });
    },
  };
}
