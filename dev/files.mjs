// The dev bridge's filesystem: the Node twin of the host's vault.rs, files.rs, versions.rs and
// drafts.rs (docs/HOST.md). Same commands, same answers, same `[code] message` errors, same hash,
// same file names under `.ose/history` and the same draft keys, so a page behaves in the browser
// exactly as it does in the app. The vite plugin (./bridge-plugin.mjs) serves these over HTTP;
// tests call them directly on a temp folder:
//
//   import { createFiles, hash } from './dev/files.mjs';
//   const f = createFiles({ root, dataDir });
//   await f.saveFile('a.md', 'text', { expectedHash: null });
//
// Every write goes through `writeAtomic`: a temp file beside the target, synced, renamed over
// it with no delete first, the rename retried while Windows says the file is busy, and the new
// bytes never thrown away (C3).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const FOLDS_CASE = IS_WIN || process.platform === 'darwin';

// ---------------------------------------------------------------- errors

/** An Error whose message is `[code] message`, the one shape every command fails with. */
export function coded(code, message) {
  const e = new Error(`[${code}] ${message}`);
  e.code = code;
  return e;
}

/** A Node error on the vault path `rel`, with the code a page can act on. */
const ioError = (rel, e) => coded(e && e.code === 'ENOENT' ? 'not_found' : 'io', `${rel}: ${(e && e.message) || e}`);

/** Anything thrown, as the `[code] message` string the bridge answers. */
export function errorText(e) {
  const msg = (e && e.message) || String(e);
  return /^\s*\[[a-z_]+\]/.test(msg) ? msg : `[io] ${msg}`;
}

// ---------------------------------------------------------------- the hash

/**
 * FNV-1a, 64 bits, over the raw bytes, as 16 lowercase hex digits (docs/HOST.md "Hash"):
 * `""` -> `cbf29ce484222325`, `"a"` -> `af63dc4c8601ec8c`. Two 32-bit halves, because a
 * BigInt per byte is slow on a large file. A string is hashed as its UTF-8 bytes.
 */
export function hash(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let lo = 0x84222325, hi = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    // h * 0x100000001b3 = h * 0x1b3 + (h << 40), modulo 2^64.
    const a = lo * 0x1b3;
    const carry = Math.floor(a / 4294967296);
    hi = (Math.imul(hi, 0x1b3) + (lo << 8) + carry) >>> 0;
    lo = a >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p2 = (n) => String(n).padStart(2, '0');
const utf8 = new TextDecoder('utf-8', { fatal: true });
/** The bytes as text, or null when they are not UTF-8. */
const textOrNull = (buf) => { try { return utf8.decode(buf); } catch { return null; } };
/** A vault path as the page sees it: forward slashes, no leading or trailing slash. */
const clean = (p) => String(p ?? '').replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mtimeOf = async (full) => { try { return Math.floor((await fs.stat(full)).mtimeMs); } catch { return 0; } };

/** `20260925-101500`, UTC: the time an unsaved copy was set aside. */
const unsavedStamp = (ms = Date.now()) => {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
};

// ---------------------------------------------------------------- writeAtomic

/** Refusals that pass: a scanner, the indexer or a sync client holding the file a moment. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_BUDGET_MS = 2000;
let tmpN = 0;

/** The rename is durable only once the folder's entry is on disk: fsync the folder on unix. */
async function syncDir(dir) {
  if (IS_WIN) return;
  try { const h = await fs.open(dir, 'r'); try { await h.sync(); } finally { await h.close(); } } catch { /* best effort */ }
}

/** The set-aside this process made for each target (vault.rs `asides`). */
const asides = new Map();

/** The new bytes, out of the hidden temp file and into `<stem>.unsaved-<stamp>.<ext>` beside the
 *  target; the temp file itself when even that is refused. The copy this process already set
 *  aside for the same target is replaced, so a save retried for an hour leaves one file.
 *  Answers where the bytes are. */
async function keepUnsaved(tmp, full) {
  const earlier = asides.get(full);
  if (earlier && fss.existsSync(earlier)) {
    try { await fs.rename(tmp, earlier); return earlier; } catch { /* a new name below */ }
  }
  const name = path.basename(full);
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const stamp = unsavedStamp();
  for (let k = 1; k < 100; k++) {
    const candidate = path.join(path.dirname(full), `${stem}.unsaved-${stamp}${k === 1 ? '' : '-' + k}${ext}`);
    if (fss.existsSync(candidate)) continue;
    try { await fs.rename(tmp, candidate); asides.set(full, candidate); return candidate; } catch { return tmp; }
  }
  return tmp;
}

/** A target with the read-only attribute refuses every rename, for good (Windows only). */
const readOnly = (full) => {
  if (!IS_WIN) return false;
  try { return (fss.statSync(full).mode & 0o200) === 0; } catch { return false; }
};

/**
 * Write `data` to `full` so that the target is always the old bytes or the new ones, and the
 * new ones are never thrown away (vault.rs `write_atomic`):
 * 1. `.<name>.<pid>.<n>.tmp` beside the target, written and synced;
 * 2. renamed over the target, with no delete first (Node's rename replaces on Windows too);
 * 3. EPERM / EACCES / EBUSY retried with backoff (10, 20, 40 … ms, about 2 s in all); a
 *    read-only target fails at once (`the file is read-only`) with nothing set aside;
 * 4. on final failure the temp file becomes a visible `<stem>.unsaved-<stamp>.<ext>` (one per
 *    target per run) and the error carries `.kept`, where the bytes are. With
 *    `opts.aside: 'discard'` (a draft, a version, the state file: the caller still has the
 *    bytes) the temp file is removed instead and `.kept` is null.
 * A temp file whose own write failed is removed: the target was never touched.
 * `opts.beforeRename(tmp)` runs once before the first rename; when it throws, the temp file is
 * removed, the target is untouched and its error is thrown with `.kept` null. saveFile uses it
 * for its last look at the target; tests use it to hold the temp file the way a scanner does.
 */
export async function writeAtomic(full, data, opts = {}) {
  const budget = opts.budget ?? RENAME_BUDGET_MS;
  const dir = path.dirname(full);
  const tmp = path.join(dir, `.${path.basename(full)}.${process.pid}.${tmpN++}.tmp`);
  let fh = null;
  try {
    fh = await fs.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
  } catch (e) {
    try { await fh?.close(); } catch { /* already closed */ }
    try { await fs.unlink(tmp); } catch { /* never written */ }
    e.kept = null;
    throw e;
  }
  if (opts.beforeRename) {
    try { await opts.beforeRename(tmp); } catch (e) {
      try { await fs.unlink(tmp); } catch { /* gone */ }
      e.kept = null;
      throw e;
    }
  }
  let waited = 0, step = 10;
  for (;;) {
    try {
      await fs.rename(tmp, full);
      await syncDir(dir);
      return;
    } catch (e) {
      if (readOnly(full)) {
        try { await fs.unlink(tmp); } catch { /* gone */ }
        const err = new Error('the file is read-only');
        err.code = e.code;
        err.kept = null;
        throw err;
      }
      if (TRANSIENT.has(e.code) && waited < budget) {
        const pause = Math.min(step, budget - waited);
        await sleep(pause);
        waited += pause;
        step = Math.min(step * 2, 640);
        continue;
      }
      if (opts.aside === 'discard') {
        try { await fs.unlink(tmp); } catch { /* gone */ }
        e.kept = null;
        throw e;
      }
      e.kept = await keepUnsaved(tmp, full);
      throw e;
    }
  }
}

// ---------------------------------------------------------------- one lock per path

const locks = new Map();
/** Runs `fn` after every earlier call for the same key has finished. */
async function withLock(full, fn) {
  const key = FOLDS_CASE ? full.toLowerCase() : full;
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

// ---------------------------------------------------------------- versions (versions.rs)

const H_ROOT = '.ose/history';
const H_OLD = '.ose/versions';
const MIN_INTERVAL_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const REASONS = new Set(['save', 'conflict', 'reload', 'restore']);

/** `2026-09-10-201500`, UTC. */
const idFromMs = (ms) => {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
};
/** The inverse, to the second; a `-<n>` a merge added after the time is the same moment. */
const msFromId = (id) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};
const idOk = (id) => /^[0-9-]{1,40}$/.test(String(id ?? ''));
/** The extension of a vault path's last segment, without the dot; none for `.env`. */
const extOf = (rel) => {
  const name = String(rel).split(/[\\/]/).pop();
  const i = name.lastIndexOf('.');
  return i > 0 && i + 1 < name.length ? name.slice(i + 1) : '';
};
const vFileName = (id, reason, session, ext) => `${id}.${reason}${session ? '-s' : ''}${ext ? '.' + ext : ''}`;
/** `{id, reason, session}` of a version file, or null. `<id>.md` is the pre-1.1 name. */
const parseVName = (name) => {
  const dot = name.indexOf('.');
  if (dot < 0) return null;
  const id = name.slice(0, dot), rest = name.slice(dot + 1);
  if (!idOk(id)) return null;
  // A copy writeAtomic set aside is not a version: it would list the same id twice.
  if (rest.includes('.unsaved-')) return null;
  let tag = rest.split('.')[0];
  const session = tag.endsWith('-s');
  if (session) tag = tag.slice(0, -2);
  if (REASONS.has(tag)) return { id, reason: tag, session };
  if (rest.toLowerCase() === 'md') return { id, reason: 'save', session: false };
  return null;
};
const HIDE = new Set(['.git', '.obsidian', '.claude', '.vscode', '.trash', 'node_modules', 'App', '.tmp.driveupload', '.makemd', '.space',
  'ose.exe', 'ose.pdb', 'Ose.app', 'os.exe', 'os.pdb', 'os.app']);
const hiddenSegment = (s) => !s || HIDE.has(s) || s.startsWith('.');

/** Which versions of one file survive at `now` (newest-first list in, parallel booleans out). */
function survivors(list, now) {
  const hours = new Set(), days = new Set();
  return list.map((e, i) => {
    const age = now - e.at;
    const guarded = e.session || e.reason !== 'save';
    if (i === 0 || age < HOUR_MS || (guarded && age < MONTH_MS)) return true;
    if (age < DAY_MS) { const k = Math.floor(e.at / HOUR_MS); if (hours.has(k)) return false; hours.add(k); return true; }
    if (age < MONTH_MS) { const k = Math.floor(e.at / DAY_MS); if (days.has(k)) return false; days.add(k); return true; }
    return false;
  });
}

// ---------------------------------------------------------------- names (files.rs check_name)

function checkName(rel) {
  const c = clean(rel);
  const name = c.split('/').pop();
  // eslint-disable-next-line no-control-regex
  if (!name || name === '.' || name === '..' || /[. ]$/.test(name) || /[\u0000-\u001f<>"|?*]/.test(c)) {
    throw coded('bad_name', `not a file name: ${rel}`);
  }
}

// ---------------------------------------------------------------- the commands

/**
 * The filesystem commands of the host, for one vault. `root` is the vault's absolute path,
 * `dataDir` the per-machine folder that holds drafts and the log (the app's local data folder;
 * `work/dev-appdata` under the dev server). `epoch` is what `rootInfo` answers; a mutating call
 * naming another is refused with `[stale_vault]`.
 * @param {{ root: string, dataDir: string, epoch?: number, log?: (line: string) => void }} o
 */
export function createFiles({ root, dataDir, epoch = 1, log = () => {} }) {
  root = path.resolve(root);
  const logDir = path.join(dataDir, 'logs');
  const logPath = path.join(logDir, 'ose.log');

  /** The absolute path of a vault path; never outside the root (vault.rs `resolve`). */
  const abs = (p) => {
    const rel = String(p ?? '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
    if (rel.split('/').some((s) => s.includes(':') || s.includes('\0'))) throw coded('escapes_vault', `path must be vault-relative: ${p}`);
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) throw coded('escapes_vault', `path escapes the vault: ${p}`);
    return full;
  };
  const relOf = (full) => path.relative(root, full).split(path.sep).join('/');

  /** The vault folder must still exist before anything is written into it (vault.rs
   *  `require_vault`): a lost root is `[no_vault]`, never recreated as an empty ghost vault. */
  const requireVault = () => {
    let ok = false;
    try { ok = fss.statSync(root).isDirectory(); } catch { ok = false; }
    if (!ok) throw coded('no_vault', `the vault folder is gone: ${root}`);
  };

  const checkEpoch = (opts) => {
    if (isObj(opts) && opts.epoch !== undefined && opts.epoch !== null && Number(opts.epoch) !== epoch) {
      throw coded('stale_vault', `this page belongs to vault epoch ${opts.epoch}, the open vault is epoch ${epoch}`);
    }
  };

  // -------------------------------------------------------------- the log (M54)
  const LOG_MAX = 2 * 1024 * 1024, LOG_KEEP = 3;
  const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
  /** One line into `<dataDir>/logs/ose.log`, rotated at 2 MB with three files kept. */
  const writeLog = (level, text) => {
    const line = `${stamp()} ${level} ${text}\n`;
    try {
      fss.mkdirSync(logDir, { recursive: true });
      let size = 0;
      try { size = fss.statSync(logPath).size; } catch { size = 0; }
      if (size + line.length > LOG_MAX) {
        const nth = (n) => (n === 0 ? logPath : path.join(logDir, `ose.${n}.log`));
        try { fss.rmSync(nth(LOG_KEEP - 1), { force: true }); } catch { /* none */ }
        for (let n = LOG_KEEP - 2; n >= 0; n--) { try { fss.renameSync(nth(n), nth(n + 1)); } catch { /* none */ } }
      }
      fss.appendFileSync(logPath, line, 'utf8');
    } catch { /* logging never breaks a command */ }
    log(line.trimEnd());
  };
  const warn = (text) => writeLog('warn', text);

  /** The atomic write, with the host's `[write_failed]` wording on failure. */
  const writeVault = async (rel, full, data, opts = {}) => {
    requireVault();
    await fs.mkdir(path.dirname(full), { recursive: true });
    try {
      await writeAtomic(full, data, opts);
    } catch (e) {
      if (opts.rethrow?.(e)) throw e;
      const where = e.kept ? (e.kept.startsWith(root + path.sep) ? relOf(e.kept) : e.kept) : null;
      throw coded('write_failed', `${rel}: ${e.message}${where ? `; your text is in ${where}` : ''}`);
    }
  };

  const readExisting = async (full, rel) => {
    try { return await fs.readFile(full); } catch (e) { if (e.code === 'ENOENT') return null; throw ioError(rel, e); }
  };

  // -------------------------------------------------------------- versions
  const session = new Set();
  const migrate = () => {
    const oldDir = path.join(root, H_OLD), newDir = path.join(root, H_ROOT);
    if (fss.existsSync(oldDir) && !fss.existsSync(newDir)) {
      try { fss.renameSync(oldDir, newDir); } catch (e) { warn(`history: could not move .ose/versions to .ose/history: ${e.message}`); }
    }
  };
  const vDir = (p) => {
    const rel = clean(p);
    if (!rel) throw coded('bad_arg', 'a version needs a file');
    const base = abs(H_ROOT), full = abs(H_ROOT + '/' + rel);
    if (full === base || !full.startsWith(base + path.sep)) throw coded('escapes_vault', `path escapes the version history: ${p}`);
    return full;
  };
  const entriesIn = async (dir) => {
    let names = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const v = parseVName(name);
      if (!v) continue;
      try {
        const st = await fs.stat(path.join(dir, name));
        if (!st.isFile()) continue;
        out.push({ ...v, at: msFromId(v.id) ?? Math.floor(st.mtimeMs), bytes: st.size, full: path.join(dir, name) });
      } catch { /* gone */ }
    }
    out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return out;
  };
  const entries = async (p) => entriesIn(vDir(p));
  const pruneFile = async (p, now) => {
    const list = await entries(p);
    const keep = survivors(list, now);
    for (let i = 0; i < list.length; i++) if (!keep[i]) { try { await fs.unlink(list[i].full); } catch { /* gone */ } }
  };
  const pruneVault = async (now) => {
    const all = [];
    const walk = async (dir, depth) => {
      if (depth > 32) return;
      let ents;
      try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      if (ents.some((e) => !e.isDirectory())) for (const e of await entriesIn(dir)) all.push({ dir, ...e });
      for (const e of ents) if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
    };
    await walk(abs(H_ROOT), 0);
    let total = all.reduce((n, e) => n + e.bytes, 0);
    if (total <= MAX_TOTAL_BYTES) return total;
    const newest = new Map();
    for (const e of all) if (!newest.has(e.dir) || e.id > newest.get(e.dir)) newest.set(e.dir, e.id);
    all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const e of all) {
      if (total <= MAX_TOTAL_BYTES) break;
      if (newest.get(e.dir) === e.id || now - e.at < DAY_MS) continue;
      try { await fs.unlink(e.full); total -= e.bytes; } catch { /* gone */ }
    }
    return total;
  };
  // The history's size as last walked plus every version kept since (versions.rs `TOTALS`):
  // only ever too high, so the walk is skipped only when the history is surely under the cap.
  let historyTotal = null;
  const pruneVaultIfOver = async (now) => {
    if (historyTotal !== null && historyTotal <= MAX_TOTAL_BYTES) return;
    historyTotal = await pruneVault(now);
  };
  /** Keep `bytes` as a version of `p` (versions.rs `keep_at`), one keep of a file at a time, then
   *  hold the vault under its cap unless `opts.settle` is false. Answers `{kept, id}`. */
  const keepVersion = async (p, bytes, force, reason, now = Date.now(), opts = {}) => {
    migrate();
    if (!bytes || !bytes.length) return { kept: false, id: null };
    requireVault();
    const r = await withLock(vDir(p), () => keepLocked(p, bytes, force, reason, now));
    if (opts.settle !== false) await pruneVaultIfOver(now);
    return r;
  };
  const keepLocked = async (p, bytes, force, reason, now) => {
    const list = await entries(p);
    const newest = list[0];
    if (newest) {
      try { if ((await fs.readFile(newest.full)).equals(bytes)) return { kept: false, id: null }; } catch { /* unreadable */ }
      if (!force && now - newest.at < MIN_INTERVAL_MS) return { kept: false, id: null };
    }
    const key = `${root}|${clean(p)}`;
    const first = !session.has(key);
    let ms = now, id = idFromMs(ms);
    while (list.some((e) => e.id === id)) { ms += 1000; id = idFromMs(ms); }
    const dir = vDir(p);
    await fs.mkdir(dir, { recursive: true });
    await writeVault(`version of ${clean(p)}`, path.join(dir, vFileName(id, reason, first, extOf(p))), bytes);
    if (historyTotal !== null) historyTotal += bytes.length;
    session.add(key);
    await pruneFile(p, now);
    return { kept: true, id };
  };
  const findVersion = async (p, id) => {
    if (!idOk(id)) throw coded('bad_arg', `not a version id: ${id}`);
    const e = (await entries(p)).find((x) => x.id === id);
    if (!e) throw coded('not_found', `no version ${id} of ${p}`);
    return e;
  };
  /** Every entry of `src` into `dst`; a taken name moves aside as `<id>-<n>.<rest>`. */
  const merge = async (src, dst) => {
    let ents = [];
    try { ents = await fs.readdir(src, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const from = path.join(src, e.name), target = path.join(dst, e.name);
      if (!fss.existsSync(target)) { try { await fs.rename(from, target); } catch { /* left */ } continue; }
      if (e.isDirectory()) { await merge(from, target); try { await fs.rmdir(from); } catch { /* not empty */ } continue; }
      const dot = e.name.indexOf('.');
      const [id, rest] = dot < 0 ? [e.name, ''] : [e.name.slice(0, dot), e.name.slice(dot + 1)];
      for (let n = 1; n < 1000; n++) {
        const free = path.join(dst, `${id}-${n}.${rest}`);
        if (!fss.existsSync(free)) { try { await fs.rename(from, free); } catch { /* left */ } break; }
      }
    }
  };
  /** The history follows a rename (versions.rs `move_history`). */
  const moveHistory = async (from, to) => {
    migrate();
    const hidden = (p) => clean(p).split('/').some(hiddenSegment);
    if (hidden(from) || hidden(to)) return;
    const src = vDir(from), dst = vDir(to);
    if (!fss.existsSync(src) || src === dst) return;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    if (src.toLowerCase() === dst.toLowerCase()) {
      const via = path.join(path.dirname(src), `.${from.length}.${process.pid}.move`);
      await fs.rename(src, via);
      await fs.rename(via, dst);
      return;
    }
    if (!fss.existsSync(dst)) { await fs.rename(src, dst); return; }
    await merge(src, dst);
    try { await fs.rmdir(src); } catch { /* not empty */ }
  };

  // -------------------------------------------------------------- drafts (drafts.rs)
  const draftsDir = () => {
    let key = root.replace(/\\/g, '/');
    if (FOLDS_CASE) key = key.toLowerCase();
    return path.join(dataDir, 'drafts', hash(key));
  };
  const draftFile = (p) => path.join(draftsDir(), `${hash(clean(p))}.json`);
  /** A draft's file name: 16 lowercase hex digits and `.json`; anything else is not a draft. */
  const isDraftName = (n) => /^[0-9a-f]{16}\.json$/.test(n);
  /** One draft command at a time (drafts.rs `GATE`): a drop can never remove a draft written
   *  after its rev check. */
  let draftGate = Promise.resolve();
  const gated = (fn) => {
    const run = draftGate.then(fn, fn);
    draftGate = run.catch(() => {});
    return run;
  };
  const readDraftFile = async (file) => {
    try {
      const o = JSON.parse(await fs.readFile(file, 'utf8'));
      return isObj(o) && o.v === 1 ? o : null;
    } catch { return null; }
  };
  const toDraft = (o) => ({
    path: o.path ?? null, text: o.text ?? '', baselineHash: o.baselineHash ?? null,
    mode: o.mode ?? 'rich', exact: o.exact ?? true, rev: o.rev ?? 0, at: o.at ?? 0,
  });
  const writeDraftFile = async (file, o) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await writeAtomic(file, JSON.stringify(o), { budget: 500, aside: 'discard' }); } catch (e) { throw coded('write_failed', `draft: ${e.message}`); }
  };
  /** A rename of `from` (a file or a folder) re-keys every draft at or under it. When the new
   *  path already has a draft, the newer stays the draft and the older becomes a version of the
   *  new path (reason `conflict`); when that version cannot be kept, both drafts stay. */
  const rekeyDrafts = (from, to) => gated(() => rekeyLocked(from, to));
  const rekeyLocked = async (from, to) => {
    from = clean(from); to = clean(to);
    if (!from || from === to) return;
    let names = [];
    try { names = await fs.readdir(draftsDir()); } catch { return; }
    for (const n of names) {
      if (!isDraftName(n)) continue;
      const oldFile = path.join(draftsDir(), n);
      const o = await readDraftFile(oldFile);
      if (!o || typeof o.path !== 'string') continue;
      let moved;
      if (o.path === from) moved = to;
      else if (o.path.startsWith(from + '/')) moved = to + o.path.slice(from.length);
      else continue;
      const newFile = draftFile(moved);
      const there = newFile === oldFile ? null : await readDraftFile(newFile);
      if (there) {
        const thereIsNewer = (there.at || 0) > (o.at || 0);
        const older = thereIsNewer ? o : there;
        try { await keepVersion(moved, Buffer.from(String(older.text ?? ''), 'utf8'), true, 'conflict'); } catch (e) {
          warn(`drafts: ${o.path} -> ${moved}: both drafts stay, the older could not be kept: ${e.message}`);
          continue;
        }
        if (thereIsNewer) { try { await fs.unlink(oldFile); } catch { /* gone */ } continue; }
      }
      await writeDraftFile(newFile, { ...o, path: moved });
      if (newFile !== oldFile) { try { await fs.unlink(oldFile); } catch { /* gone */ } }
    }
  };

  // -------------------------------------------------------------- line helpers (files.rs)
  const eolOf = (buf) => {
    const i = buf.lastIndexOf(0x0a);
    return i > 0 && buf[i - 1] === 0x0d ? '\r\n' : '\n';
  };
  /** Content ranges of the lines of `text`; a `\r` before a `\n` is the separator's, and the
   *  empty piece after a final `\n` is not a line. */
  const lineSpans = (text) => {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        out.push([start, i > start && text.charCodeAt(i - 1) === 13 ? i - 1 : i]);
        start = i + 1;
      }
    }
    if (start < text.length) out.push([start, text.length]);
    return out;
  };

  /** Exclusive create, synced; never overwrites (`[exists]`). */
  const createExclusive = async (full, rel, bytes) => {
    await fs.mkdir(path.dirname(full), { recursive: true });
    let fh;
    try { fh = await fs.open(full, 'wx'); } catch (e) {
      if (e.code === 'EEXIST') throw coded('exists', `already exists: ${rel}`);
      throw ioError(rel, e);
    }
    try { await fh.writeFile(bytes); await fh.sync(); await fh.close(); } catch (e) {
      try { await fh.close(); } catch { /* closed */ }
      try { await fs.unlink(full); } catch { /* gone */ }
      throw coded('write_failed', `${rel}: ${e.message}`);
    }
  };

  /** `{status:'conflict', disk}`: what the disk holds instead of what the page expected. */
  const conflictOf = (disk) => ({ status: 'conflict', disk: { exists: !!disk, text: disk ? textOrNull(disk) : null, hash: disk ? hash(disk) : null } });

  const logSave = (rel, r) => {
    if (r.status === 'saved') writeLog('info', `save ok ${rel}${r.unchanged ? ' (unchanged)' : ''}`);
    else writeLog('warn', `save conflict ${rel}`);
  };

  const files = {
    // ------------------------------------------------------------ plain reads and writes
    readText: async (p) => {
      const full = abs(p);
      let buf;
      try { buf = await fs.readFile(full); } catch (e) { throw ioError(p, e); }
      const text = textOrNull(buf);
      if (text === null) throw coded('not_utf8', `not valid UTF-8: ${p}`);
      return text;
    },
    writeText: async (p, text, opts) => { checkEpoch(opts); await writeVault(clean(p), abs(p), Buffer.from(String(text ?? ''), 'utf8')); return null; },
    appendText: async (p, text, opts) => {
      checkEpoch(opts);
      const f = abs(p);
      requireVault();
      await fs.mkdir(path.dirname(f), { recursive: true });
      try { await fs.appendFile(f, String(text ?? ''), 'utf8'); } catch (e) { throw ioError(p, e); }
      return null;
    },
    writeBinary: async (p, b64, opts) => { checkEpoch(opts); await writeVault(clean(p), abs(p), Buffer.from(String(b64 ?? ''), 'base64')); return null; },
    readBinary: async (p) => { const full = abs(p); try { return (await fs.readFile(full)).toString('base64'); } catch (e) { throw ioError(p, e); } },
    mkdir: async (p, opts) => { checkEpoch(opts); const full = abs(p); requireVault(); await fs.mkdir(full, { recursive: true }); return null; },
    // Never overwrites (vault.rs `rename`); a case-only rename goes through a temporary name.
    // The history and the drafts follow the file.
    rename: async (a, b, opts) => {
      checkEpoch(opts);
      const src = abs(a), dst = abs(b);
      if (!fss.existsSync(src)) throw coded('not_found', `nothing to rename: ${a}`);
      if (src === dst) return null;
      if (src.toLowerCase() === dst.toLowerCase()) {
        const via = path.join(path.dirname(dst), `.${path.basename(dst)}.${process.pid}.case`);
        await fs.rename(src, via);
        try { await fs.rename(via, dst); } catch (e) { await fs.rename(via, src).catch(() => {}); throw coded('io', `${a} -> ${b}: ${e.message}`); }
      } else {
        if (fss.existsSync(dst)) throw coded('exists', `target already exists: ${b}`);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        try { await fs.rename(src, dst); } catch (e) { throw coded('io', `${a} -> ${b}: ${e.message}`); }
      }
      try { await moveHistory(a, b); } catch (e) { warn(`history: ${a} -> ${b}: ${e.message}`); }
      try { await rekeyDrafts(a, b); } catch (e) { warn(`drafts: ${a} -> ${b}: ${e.message}`); }
      return null;
    },
    // `mode` is 'system' or 'vault' (S37). Node has no recycle bin, so this always does what
    // 'vault' means and never deletes anything outright. History and drafts stay.
    trash: async (p, opts) => {
      checkEpoch(opts);
      const full = abs(p);
      if (full === root) throw coded('bad_arg', 'refusing to trash the vault root');
      if (!fss.existsSync(full)) throw coded('not_found', `nothing to trash: ${p}`);
      const t = path.join(root, '.trash');
      await fs.mkdir(t, { recursive: true });
      await fs.rename(full, path.join(t, Date.now() + '-' + path.basename(full)));
      return null;
    },

    // ------------------------------------------------------------ the save path (files.rs)
    readFile: async (p) => {
      const full = abs(p);
      let buf;
      try { buf = await fs.readFile(full); } catch (e) { throw ioError(p, e); }
      const text = textOrNull(buf);
      if (text === null) throw coded('not_utf8', `not valid UTF-8: ${p}`);
      return { text, hash: hash(buf), mtime: await mtimeOf(full), size: buf.length };
    },
    saveFile: async (p, text, opts) => {
      checkEpoch(opts);
      const rel = clean(p);
      try {
        if (typeof text !== 'string') throw coded('bad_arg', 'argument 1 must be the text');
        if (!isObj(opts)) throw coded('bad_arg', 'saveFile needs {expectedHash}');
        const expected = opts.expectedHash;
        if (!(expected === null || typeof expected === 'string')) throw coded('bad_arg', 'expectedHash must be a hash or null');
        const mode = opts.version ?? 'save';
        if (!['save', 'conflict', 'none'].includes(mode)) throw coded('bad_arg', `not a version mode: ${mode}`);
        const full = abs(p);
        if (full === root) throw coded('bad_arg', 'no file name to write');
        // A lost vault folder is not a deleted page (files.rs `save_file`).
        requireVault();
        const r = await withLock(full, async () => {
          const disk = await readExisting(full, rel);
          const bytes = Buffer.from(text, 'utf8');
          if (disk && disk.equals(bytes)) return { status: 'saved', hash: hash(bytes), mtime: await mtimeOf(full), unchanged: true };
          const diskHash = disk ? hash(disk) : null;
          const matches = expected === null ? !disk : !!disk && diskHash === expected;
          if (!matches) return conflictOf(disk);
          // The last look before the rename: an outside write made while the new bytes were
          // being synced wins, and the page is shown the conflict (files.rs `save_file`).
          let moved;
          const still = async () => {
            const now = await readExisting(full, rel);
            if (now === null ? disk === null : (disk !== null && now.equals(disk)) || now.equals(bytes)) return;
            moved = { now };
            throw new Error('changed on disk while saving');
          };
          try {
            await writeVault(rel, full, bytes, { beforeRename: still, rethrow: () => moved !== undefined });
          } catch (e) {
            if (moved) return conflictOf(moved.now);
            throw e;
          }
          const saved = { status: 'saved', hash: hash(bytes), mtime: await mtimeOf(full) };
          // The replaced bytes become a version after the write, from memory.
          if (disk && mode !== 'none') {
            try { await keepVersion(rel, disk, mode === 'conflict', mode === 'conflict' ? 'conflict' : 'save', Date.now(), { settle: false }); }
            catch (e) { warn(`version of ${rel} not kept: ${e.message}`); }
          }
          return saved;
        });
        await pruneVaultIfOver(Date.now());
        logSave(rel, r);
        return r;
      } catch (e) {
        writeLog('error', `save failed ${rel}: ${errorText(e)}`);
        throw e;
      }
    },
    createNew: async (p, text = '', opts) => {
      if (isObj(text)) { opts = text; text = ''; }
      checkEpoch(opts);
      checkName(p);
      const full = abs(p);
      requireVault();
      const bytes = Buffer.from(String(text ?? ''), 'utf8');
      await withLock(full, () => createExclusive(full, clean(p), bytes));
      return { path: clean(p), hash: hash(bytes) };
    },
    copyFile: async (from, to, opts) => {
      checkEpoch(opts);
      checkName(to);
      const src = abs(from), dst = abs(to);
      requireVault();
      let bytes;
      try {
        if ((await fs.stat(src)).isDirectory()) throw coded('bad_arg', `not a file: ${from}`);
        bytes = await fs.readFile(src);
      } catch (e) { throw e.message?.startsWith('[') ? e : ioError(from, e); }
      await withLock(dst, () => createExclusive(dst, clean(to), bytes));
      return { path: clean(to), hash: hash(bytes) };
    },
    appendLine: async (p, line, opts) => {
      checkEpoch(opts);
      line = String(line ?? '');
      if (/[\r\n]/.test(line)) throw coded('bad_arg', 'a line cannot hold a line break');
      const full = abs(p);
      if (full === root) throw coded('bad_arg', 'no file name to write');
      requireVault();
      return withLock(full, async () => {
        const before = (await readExisting(full, p)) || Buffer.alloc(0);
        const eol = eolOf(before);
        const sep = before.length && before[before.length - 1] !== 0x0a ? eol : '';
        const add = Buffer.from(sep + line + eol, 'utf8');
        await fs.mkdir(path.dirname(full), { recursive: true });
        try {
          const fh = await fs.open(full, 'a');
          try { await fh.writeFile(add); await fh.sync(); } finally { await fh.close(); }
        } catch (e) { throw coded('write_failed', `${p}: ${e.message}`); }
        return { hash: hash(Buffer.concat([before, add])) };
      });
    },
    replaceLine: async (p, index, expected, next, opts) => {
      checkEpoch(opts);
      if (!Number.isInteger(index)) throw coded('bad_arg', 'argument 1 must be a line index');
      if (typeof expected !== 'string' || typeof next !== 'string') throw coded('bad_arg', 'expected and next must be strings');
      if (/[\r\n]/.test(next)) throw coded('bad_arg', 'a line cannot hold a line break');
      const full = abs(p);
      requireVault();
      const r = await withLock(full, async () => {
        let buf;
        try { buf = await fs.readFile(full); } catch (e) { throw ioError(p, e); }
        const text = textOrNull(buf);
        if (text === null) throw coded('not_utf8', `not valid UTF-8: ${p}`);
        const span = index >= 0 ? lineSpans(text)[index] : undefined;
        if (!span) return { status: 'conflict', actual: null };
        const actual = text.slice(span[0], span[1]);
        if (actual !== expected) return { status: 'conflict', actual };
        if (expected === next) return { status: 'replaced', hash: hash(buf) };
        const out = Buffer.from(text.slice(0, span[0]) + next + text.slice(span[1]), 'utf8');
        // As saveFile: the last look before the rename, and the version after the write.
        let moved;
        const still = async () => {
          const now = await readExisting(full, p);
          if (now !== null && (now.equals(buf) || now.equals(out))) return;
          const t = now === null ? null : textOrNull(now);
          const s = t === null ? undefined : lineSpans(t)[index];
          moved = { actual: s ? t.slice(s[0], s[1]) : null };
          throw new Error('changed on disk while saving');
        };
        try {
          await writeVault(clean(p), full, out, { beforeRename: still, rethrow: () => moved !== undefined });
        } catch (e) {
          if (moved) return { status: 'conflict', actual: moved.actual };
          throw e;
        }
        try { await keepVersion(clean(p), buf, false, 'save', Date.now(), { settle: false }); } catch (e) { warn(`version of ${p} not kept: ${e.message}`); }
        return { status: 'replaced', hash: hash(out) };
      });
      await pruneVaultIfOver(Date.now());
      return r;
    },

    // ------------------------------------------------------------ drafts
    draftWrite: async (p, draft, opts) => {
      checkEpoch(opts);
      if (!isObj(draft)) throw coded('bad_arg', 'a draft is an object');
      if (typeof draft.text !== 'string') throw coded('bad_arg', 'a draft needs its text');
      const at = Date.now();
      await gated(() => writeDraftFile(draftFile(p), {
        v: 1, vault: root, path: clean(p), text: draft.text,
        baselineHash: typeof draft.baselineHash === 'string' ? draft.baselineHash : null,
        mode: draft.mode === 'source' ? 'source' : 'rich',
        exact: typeof draft.exact === 'boolean' ? draft.exact : true,
        rev: typeof draft.rev === 'number' ? draft.rev : 0,
        at,
      }));
      return { at };
    },
    draftList: async () => {
      let names = [];
      try { names = await fs.readdir(draftsDir()); } catch { return []; }
      const out = [];
      for (const n of names) {
        if (!isDraftName(n)) continue;
        const o = await readDraftFile(path.join(draftsDir(), n));
        if (!o) continue;
        const { text, ...info } = toDraft(o);
        out.push({ ...info, bytes: Buffer.byteLength(String(text), 'utf8') });
      }
      return out.sort((a, b) => b.at - a.at);
    },
    draftRead: async (p) => { const o = await readDraftFile(draftFile(p)); return o ? toDraft(o) : null; },
    // A drop sent late from a page of the vault that was just left names its epoch and is
    // refused (`[stale_vault]`).
    draftDrop: async (p, opts) => {
      checkEpoch(opts);
      const file = draftFile(p);
      return gated(async () => {
        const o = await readDraftFile(file);
        if (!o) return { dropped: false };
        if (isObj(opts) && typeof opts.ifRev === 'number' && (o.rev || 0) > opts.ifRev) return { dropped: false };
        try { await fs.unlink(file); return { dropped: true }; } catch (e) {
          if (e.code === 'ENOENT') return { dropped: false };
          throw coded('io', `draft of ${p}: ${e.message}`);
        }
      });
    },

    // ------------------------------------------------------------ versions
    // `versionKeep(path, text, opts)`: opts is the old boolean `force` or `{force?, reason?}`.
    versionKeep: async (p, text, opts = false) => {
      let force = false, reason = 'save';
      checkEpoch(opts);
      if (typeof opts === 'boolean') force = opts;
      else if (isObj(opts)) {
        force = !!opts.force;
        if (opts.reason !== undefined) {
          if (!REASONS.has(opts.reason)) throw coded('bad_arg', `not a version reason: ${opts.reason}`);
          reason = opts.reason;
        }
      }
      return keepVersion(clean(p), Buffer.from(String(text ?? ''), 'utf8'), force, reason);
    },
    versionList: async (p) => { migrate(); return (await entries(p)).map(({ id, at, bytes, reason, session: s }) => ({ id, at, bytes, reason, session: s })); },
    versionRead: async (p, id) => {
      migrate();
      const e = await findVersion(p, id);
      const text = textOrNull(await fs.readFile(e.full));
      if (text === null) throw coded('not_utf8', `not valid UTF-8: version ${id} of ${p}`);
      return text;
    },
    // Only "there is no file" means there is nothing to keep (F3): a file that cannot be read
    // holds bytes no version has, so the restore fails and writes nothing.
    versionRestore: async (p, id, opts) => {
      checkEpoch(opts);
      migrate();
      const e = await findVersion(p, id);
      const bytes = await fs.readFile(e.full);
      const full = abs(p);
      requireVault();
      const kept = await withLock(full, async () => {
        const current = (await readExisting(full, p)) || Buffer.alloc(0);
        const k = !current.length || current.equals(bytes)
          ? { kept: false, id: null }
          : await keepVersion(clean(p), current, true, 'restore', Date.now(), { settle: false });
        await writeVault(clean(p), full, bytes);
        return k;
      });
      await pruneVaultIfOver(Date.now());
      return { ...kept, hash: hash(bytes) };
    },

    // ------------------------------------------------------------ the log
    // `log(text, level)`: `<stamp> <level> ui: <text>` into the log file (docs/HOST.md "Log").
    log: async (text, level = 'info') => {
      const l = String(level || 'info').toLowerCase();
      writeLog(['error', 'warn', 'info', 'debug'].includes(l) ? l : 'info', `ui: ${String(text)}`);
      return null;
    },
  };

  return { files, abs, logPath, epoch, checkEpoch, requireVault, moveHistory, rekeyDrafts, writeLog, keepVersion, _survivors: survivors };
}

export { survivors, idFromMs, msFromId };
