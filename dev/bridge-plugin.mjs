// Dev bridge: the Node implementation of what the Tauri host answers, for browser development.
// Filesystem + /vault assets + state + SSE events + fs watcher.
// Only used by `vite` in dev; the shipped app talks to the Tauri host instead (src/kernel/bridge/tauri.js).
//
// The files, the save path, versions, drafts and the log are ./files.mjs, the Node twin of the
// host's vault.rs, files.rs, versions.rs and drafts.rs: same commands, same answers, same
// `[code] message` errors, same hash. A command this bridge does not implement fails with
// `[unknown_command] <cmd>`, exactly as the host does; only the names a past version retired
// still answer null. Drafts and the log live in `work/dev-appdata` (gitignored), the dev
// server's stand-in for the app's per-machine folder; `OSE_DEV_APPDATA` names another.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { vaultRoot, rootSource, repoRoot } from './root.mjs';
import { createFiles, errorText, hash, writeAtomic } from './files.mjs';

export { createFiles, hash, writeAtomic };

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
  const dataDir = path.resolve(process.env.OSE_DEV_APPDATA || path.join(repoRoot, 'work', 'dev-appdata'));
  // The dev bridge serves one vault for its whole life, so its epoch never moves.
  const EPOCH = 1;
  const store = createFiles({ root, dataDir, epoch: EPOCH, log: (line) => console.log('[app]', line) });
  const { abs } = store;
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
  // Set when a watcher failed; the next one to start says `rescan` (docs/HOST.md "Events").
  let missed = false;
  const pending = new Map(); // relPath -> { renamed:boolean }
  // Paths we have seen existing, with their file id (`ino`): a rename keeps the id, which is how
  // a delete and a create in one batch are known to be one file moving (watcher.rs pairs the
  // two ends of a rename the same way, from the system's own rename notice).
  const known = new Map();   // relPath -> ino
  // Seeded once, in the background, so a file that was there before the first event can still
  // be recognised when it is renamed.
  const seed = async (dir, depth) => {
    if (depth > 24) return;
    let ents = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hiddenSegment(e.name)) continue;
      const full = path.join(dir, e.name);
      const p = rel(full);
      if (!known.has(p)) { try { known.set(p, (await fs.stat(full)).ino); } catch { /* gone */ } }
      if (e.isDirectory()) await seed(full, depth + 1);
    }
  };

  /**
   * One batch of changes, as the host reports them (docs/HOST.md "Events"). A delete and a
   * create in the same batch are a rename when the created path has the file id the deleted
   * one had, or, when the deleted path's id was never seen, the same name in another folder.
   * A rename moves the history and re-keys the drafts, as watcher.rs `follow_rename` does, and
   * is reported as `{path: from, kind: 'rename', to}`.
   */
  const flush = async () => {
    watchTimer = null;
    const batch = [...pending.entries()];
    pending.clear();
    const changes = [];
    const gone = new Map(); // relPath -> the ino it had, or undefined
    for (const [p, info] of batch) {
      let st = null;
      try { st = await fs.stat(path.join(root, p)); } catch { st = null; }
      let kind;
      if (!st) { kind = 'delete'; gone.set(p, known.get(p)); known.delete(p); }
      else if (!known.has(p) && (info.renamed || Date.now() - st.birthtimeMs < 3000)) { kind = 'create'; known.set(p, st.ino); }
      else { kind = 'modify'; known.set(p, st.ino); }
      changes.push({ path: p, kind, ino: st ? st.ino : undefined });
    }
    const taken = new Set();
    const pairs = new Map(); // the delete -> the create it is the other end of
    for (const c of changes) {
      if (c.kind !== 'delete') continue;
      const was = gone.get(c.path);
      const base = path.posix.basename(c.path);
      const to = changes.find((d) => d.kind === 'create' && !taken.has(d)
        && (was !== undefined ? d.ino === was : path.posix.basename(d.path) === base));
      if (to) { taken.add(to); pairs.set(c, to); }
    }
    const out = [];
    for (const c of changes) {
      if (taken.has(c)) continue;
      const to = pairs.get(c);
      if (!to) { out.push({ path: c.path, kind: c.kind }); continue; }
      // A folder that moved takes what was known under it along.
      for (const [k, v] of [...known]) {
        if (k.startsWith(c.path + '/')) { known.delete(k); known.set(to.path + k.slice(c.path.length), v); }
      }
      try { await store.moveHistory(c.path, to.path); } catch (e) { console.warn(`[bridge] history: ${c.path} -> ${to.path}: ${e.message}`); }
      try { await store.rekeyDrafts(c.path, to.path); } catch (e) { console.warn(`[bridge] drafts: ${c.path} -> ${to.path}: ${e.message}`); }
      out.push({ path: c.path, kind: 'rename', to: to.path });
    }
    if (out.length) emit('fs', { changes: out });
  };

  function startWatch() {
    clearTimeout(restartTimer); restartTimer = null;
    if (!known.size) seed(root, 0).catch(() => { });
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
        missed = true;
        if (!restartTimer) restartTimer = setTimeout(startWatch, 1000);
      });
      if (missed) { missed = false; emit('fs', { changes: [], rescan: true }); }
    } catch (e) {
      console.warn('[bridge] watch failed:', e.message);
      watcher = null;
      missed = true;
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
  // A command this bridge does not implement: named once in the log, `[unknown_command]` to the
  // caller. The names a past version retired answer null, as the host's `gone()` does.
  const unknown = new Set();
  const retired = (cmd) => ['riceInfo', 'riceReady', 'riceFailed'].includes(cmd) || cmd.startsWith('update');
  const cmds = {
    rootInfo: async () => (noVault ? { root: null, name: null, epoch: EPOCH } : { root, name: path.basename(root), epoch: EPOCH }),
    vaultInfo: async () => (noVault
      ? { root: null, name: null, remembered: false, source: null, epoch: EPOCH }
      : { root, name: path.basename(root), remembered: false, source: 'dev', epoch: EPOCH }),
    // `{adopt:false}` only chooses (docs/HOST.md "pickVault"); there is one root here either way.
    pickVault: async (opts) => (opts && opts.adopt === false
      ? { root, name: path.basename(root) }
      : { root, name: path.basename(root), epoch: EPOCH }),
    // Recent vaults are the host's business (src-tauri/src/vaults.rs): the dev bridge has one
    // configured root and no per-user config folder, so the list is the vault it is serving.
    recentVaults: async () => (noVault ? [] : [{ path: root, name: path.basename(root), exists: true, current: true }]),
    openVault: async () => ({ root, name: path.basename(root), epoch: EPOCH }),
    forgetVault: async () => null,
    tree: async () => { const t = await tree(root); t.name = path.basename(root); t.path = ''; return t; },
    list: async (p) => listDir(abs(p)),
    stat: async (p) => { try { const st = await fs.stat(abs(p)); return { exists: true, kind: st.isDirectory() ? 'dir' : 'file', mtime: st.mtimeMs, size: st.size }; } catch { return { exists: false }; } },
    exists: async (p) => fss.existsSync(abs(p)),
    // Every file command, the save path, drafts, versions and the log (./files.mjs).
    ...store.files,
    search: async (q, opts) => search(q, opts),

    run: async (id, cmd, args, opts) => run(id, cmd, args, opts),
    runKill: async (id) => runKill(id),

    platform: async () => ({ os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', version: 'dev', build: null, exe: process.execPath, exeDir: path.dirname(process.execPath), root: noVault ? null : root, logPath: store.logPath }),

    getState: async () => { try { return JSON.parse(await fs.readFile(statePath(), 'utf8')); } catch { return {}; } },
    // `setState(state, {epoch})`: a write sent late from a page of a vault that was left is
    // refused (`[stale_vault]`); a lost vault folder is not recreated for it (`[no_vault]`); a
    // refused rename gives up after a moment and leaves nothing behind (state.rs).
    setState: async (o, opts) => {
      store.checkEpoch(opts);
      store.requireVault();
      await fs.mkdir(path.dirname(statePath()), { recursive: true });
      await writeAtomic(statePath(), JSON.stringify(o ?? {}, null, 2), { budget: 100, aside: 'discard' });
      return null;
    },
    openExternal, reveal, openPath,

    // Paper. Both are WebView2's own (src-tauri/src/print.rs) and a Node host has neither: no
    // save dialog, no print engine, no window of its own. `{ browser: true }` is deliberately
    // not `null`, because `null` means "this host has no such command" and would make the page
    // say printing needs the app. `browser` means "you are in a browser, do it from the page
    // side": `Print` falls back to `window.print()`, which here is a real Chromium dialog that
    // returns, and `Export to PDF` says it is host-only, because a page cannot write a file
    // where the user chose.
    printToPdf: async () => ({ browser: true }),
    showPrintUI: async () => ({ browser: true }),

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
            if (!unknown.has(cmd)) { unknown.add(cmd); console.log(`[bridge] no such command: ${cmd}`); }
            if (retired(cmd)) { res.end(JSON.stringify({ ok: true, result: null })); return; }
            res.end(JSON.stringify({ ok: false, error: `[unknown_command] ${cmd}` }));
            return;
          }
          const result = await cmds[cmd](...args);
          res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
        } catch (e) {
          // `[code] message`, as the host words it (docs/HOST.md "Errors"); the kernel splits it.
          const error = errorText(e);
          console.warn(`[bridge] ${cmd} failed: ${error}`);
          res.end(JSON.stringify({ ok: false, error }));
        }
      });
    },
  };
}
