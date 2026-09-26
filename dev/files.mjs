// The dev bridge's filesystem: the Node twin of the host's vault.rs, hide.rs, files.rs,
// trashbin.rs, versions.rs, drafts.rs and local.rs (docs/HOST.md). Same commands, same answers,
// same `[code] message` errors, same hash, the same one hide rule, the same file names under
// `.ose/history` and `.trash/.info`, and the same draft and local-store keys, so a page behaves in
// the browser exactly as it does in the app. Two things Node cannot do are said where they
// matter: it has no system bin (every trash goes to `.trash`), and it reads Windows' hidden flag
// by asking cmd (`winHidden`), since Node's stat does not carry it. The vite plugin (./bridge-plugin.mjs) serves these over HTTP;
// tests call them directly on a temp folder:
//
//   import { createFiles, hash } from './dev/files.mjs';
//   const f = createFiles({ root, dataDir });
//   await f.saveFile('a.md', 'text', { expectedHash: null });
//
// Every write goes through `writeAtomic`: a temp file beside the target, synced, renamed over
// it with no delete first, the rename retried while Windows says the file is busy, and the new
// bytes never thrown away (C3).
//
// Wave 3 (CONTRACT §4.1): files outside the vault, as `abs:<absolute path>` once `outsideOpen`
// has registered them (only under the folders `outsideRoots` names: a dev server is not the
// app, and a browser page must not reach the whole disk); text in UTF-16 and windows-1252 as well
// as UTF-8 (`decodeText`, `encodeText`), with no new dependency: Node decodes what it knows, and
// windows-1252 has a table of its own here; `createNewBinary` and `importOutside`.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const FOLDS_CASE = IS_WIN || process.platform === 'darwin';
/** The prefix of a path outside the vault, in JS (CONTRACT §5.2): `abs:D:/Notes/a.md`. */
export const ABS = 'abs:';

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
  return /^\s*\[[a-z0-9_]+\]/.test(msg) ? msg : `[io] ${msg}`;
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
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
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
// ---------------------------------------------------------------- the one hide rule (hide.rs)

// Excluded anywhere, in any letter case: the app's state and git's.
const EXCLUDED_ANYWHERE = new Set(['.ose', '.git']);
// Excluded at the vault root only: what the app leaves beside a vault. The host adds the
// running executable's own name; the dev bridge runs no executable of the app's.
const EXCLUDED_AT_ROOT = new Set(['ose.exe', 'ose.pdb', 'ose.exe.new', 'ose.exe.old', 'ose.app', 'ose.app.old',
  'ose-update.zip', 'ose-update-tmp', 'webview2loader.dll', 'os.exe', 'os.pdb', 'os.exe.new', 'os.exe.old',
  'os.app', 'os.app.old', 'os-update.zip', 'os-update-tmp']);

/** Somebody's temp file: the atomic writer's `.<name>.<pid>.<n>.tmp`, a case-only rename's
 *  `.<name>.<pid>.case`, an Office owner file `~$x`, a LibreOffice lock `.~lock.x#`. */
function isTemp(name) {
  return /^\..+\.\d+\.\d+\.tmp$/.test(name) || /^\..+\.\d+\.case$/.test(name)
    || name.startsWith('~$') || (name.startsWith('.~lock.') && name.endsWith('#'));
}

const segmentsOf = (rel) => String(rel ?? '').split(/[\\/]/).filter((s) => s && s !== '.');

/** Is the vault path excluded (never listed, walked, searched or reported)? True when any of
 *  its segments is: a file inside `.git` is as excluded as `.git`. The vault bin's sidecars
 *  (`.trash/.info`) are the app's bookkeeping, excluded like `.ose`. */
export function isExcluded(rel) {
  const segs = segmentsOf(rel);
  if (segs.length >= 2 && segs[0].toLowerCase() === '.trash' && segs[1].toLowerCase() === '.info') return true;
  return segs.some((seg, depth) => {
    const low = seg.toLowerCase();
    return EXCLUDED_ANYWHERE.has(low) || isTemp(seg) || (depth === 0 && EXCLUDED_AT_ROOT.has(low));
  });
}

/** Inside the vault's own bin, `.trash` at the root (hide.rs `in_bin`): never searched. */
export const isInBin = (rel) => (segmentsOf(rel)[0] || '').toLowerCase() === '.trash';

/** A dotfile or dotfolder. The system's hidden flag is the other half of hidden (`winHidden`). */
export const isHiddenName = (name) => String(name).startsWith('.');

/**
 * Windows' hidden flag (hide.rs `os_hidden`), which Node's stat does not carry: `dir /a:h /b`
 * through cmd, with `/u` so names come back as UTF-16 whatever the code page. Answers the set of
 * lowercased full paths under `dir` that carry the flag (every level with `deep`); empty
 * elsewhere than on Windows, and empty when the folder name holds a `%` cmd would expand.
 * Answers are kept for a second, so one listing, its tree patch and its stats spawn one cmd.
 */
const hiddenCache = new Map();
export function winHidden(dir, deep = false) {
  if (process.platform !== 'win32' || dir.includes('%') || dir.includes('"')) return Promise.resolve(new Set());
  const key = `${deep ? 'deep' : 'flat'}|${dir.toLowerCase()}`;
  const hit = hiddenCache.get(key);
  if (hit && Date.now() - hit.at < 1000) return hit.set;
  const set = new Promise((resolve) => {
    execFile('cmd.exe', ['/d', '/u', '/c', `dir /a:h /b${deep ? ' /s' : ''} "${dir}"`],
      { encoding: 'buffer', windowsVerbatimArguments: true, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (_err, out) => {
        // No hidden item at all is "File Not Found" and a non-zero exit: an empty set.
        const lines = out ? out.toString('utf16le').split(/\r?\n/).filter(Boolean) : [];
        resolve(new Set(lines.map((l) => (deep ? l : path.join(dir, l)).toLowerCase())));
      });
  });
  hiddenCache.set(key, { at: Date.now(), set });
  if (hiddenCache.size > 256) hiddenCache.delete(hiddenCache.keys().next().value);
  return set;
}

/** Does `full` itself carry Windows' hidden flag? */
export async function osHidden(full) {
  if (process.platform !== 'win32') return false;
  return (await winHidden(path.dirname(full))).has(full.toLowerCase());
}

/** Does any segment of the path start with a dot? The watcher's `hidden` flag. */
export const isPathHidden = (rel) => segmentsOf(rel).some(isHiddenName);

/** `'excluded' | 'hidden' | 'shown'` for one entry, judged by its own name (hide.rs `classify`). */
export function classify(rel) {
  if (isExcluded(rel)) return 'excluded';
  const segs = segmentsOf(rel);
  return isHiddenName(segs[segs.length - 1] || '') ? 'hidden' : 'shown';
}

/** vault.rs `natural_compare`: runs of digits compare as numbers, everything else by lowercased
 *  code point, so both hosts sort a folder the same way. */
export function naturalCompare(a, b) {
  const A = [...String(a)], B = [...String(b)];
  const digit = (c) => c >= '0' && c <= '9';
  const lower = (c) => [...c.toLowerCase()][0] || c;
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (digit(A[i]) && digit(B[j])) {
      const si = i, sj = j;
      while (i < A.length && digit(A[i])) i++;
      while (j < B.length && digit(B[j])) j++;
      const na = A.slice(si, i).join('').replace(/^0+/, ''), nb = B.slice(sj, j).join('').replace(/^0+/, '');
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
    } else {
      const ca = lower(A[i]).codePointAt(0), cb = lower(B[j]).codePointAt(0);
      if (ca !== cb) return ca - cb;
      i++; j++;
    }
  }
  return (A.length - i) - (B.length - j);
}

/** Folders first, then natural name order. */
export const byEntry = (a, b) => (a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1);

/** Text, by content: no NUL in the first 8 KB and valid UTF-8 there; a character cut by the
 *  8 KB edge does not count against the file (vault.rs `sniff_text`). */
export function sniffText(head, full = head.length >= SNIFF_BYTES) {
  if (head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head); return true; } catch { /* maybe cut */ }
  if (!full) return false;
  // The file may end its first 8 KB in the middle of a character: the last 1 to 3 bytes are
  // then a lead byte and continuation bytes, fewer than the lead byte announces.
  for (let cut = 1; cut <= 3 && cut < head.length; cut++) {
    const lead = head[head.length - cut];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0;
    if (!need) continue;
    const tail = head.subarray(head.length - cut + 1);
    if (need <= cut || tail.some((b) => (b & 0xc0) !== 0x80)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - cut)); return true; } catch { return false; }
  }
  return false;
}
const SNIFF_BYTES = 8192;

// ---------------------------------------------------------------- encodings (encoding.rs)

/** windows-1252 bytes 0x80..0x9F, as WHATWG maps them (the five holes to their C1 controls, so
 *  every byte decodes and every decode encodes back to the same bytes). */
const CP1252 = [0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178];
const CP1252_BACK = new Map(CP1252.map((cp, i) => [cp, 0x80 + i]));

/** The WHATWG labels this bridge knows, to their encoding's name; the host knows every one
 *  encoding_rs does. */
const LABELS = new Map([
  ...['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8'].map((l) => [l, 'utf-8']),
  ...['utf-16le', 'utf-16', 'ucs-2', 'unicode', 'csunicode', 'iso-10646-ucs-2', 'unicodefeff'].map((l) => [l, 'utf-16le']),
  ...['utf-16be', 'unicodefffe'].map((l) => [l, 'utf-16be']),
  ...['windows-1252', 'cp1252', 'x-cp1252', 'latin1', 'l1', 'iso-8859-1', 'iso8859-1', 'iso_8859-1', 'iso88591', 'iso_8859-1:1987',
    'iso-ir-100', 'ibm819', 'cp819', 'csisolatin1', 'ascii', 'us-ascii', 'ansi_x3.4-1968'].map((l) => [l, 'windows-1252']),
]);

/** The encoding a label names, or `[unsupported]`. */
export function encodingOf(label) {
  const name = LABELS.get(String(label ?? '').trim().toLowerCase());
  if (!name) throw coded('unsupported', `the dev bridge reads and writes utf-8, utf-16le, utf-16be and windows-1252, not ${label}`);
  return name;
}

const swap16 = (buf) => { const out = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2))); out.swap16(); return out; };

/** `text` in the encoding `name` (a name `encodingOf` answered). A character windows-1252 cannot
 *  hold is `[unencodable]`, and nothing is written. UTF-16 is encoded by hand, as the host does:
 *  a BOM in the text (U+FEFF) is kept, like UTF-8's. */
export function encodeText(text, name) {
  if (name === 'utf-8') return Buffer.from(text, 'utf8');
  if (name === 'utf-16le') return Buffer.from(text, 'utf16le');
  if (name === 'utf-16be') return swap16(Buffer.from(text, 'utf16le'));
  const out = Buffer.alloc(text.length);
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const b = cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : CP1252_BACK.get(cp);
    if (b === undefined) throw coded('unencodable', `${JSON.stringify(ch)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) cannot be written in windows-1252`);
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/**
 * The bytes as text (encoding.rs `decode`): `{text, encoding, bom, lossy}`. Detection is
 * conservative: a UTF-16 byte-order mark first, then UTF-8, then windows-1252 (the host asks
 * chardetng there). `forced` names the encoding instead; a forced UTF-8 that is not UTF-8 is
 * `[not_utf8]`. A byte-order mark stays in the text, as U+FEFF, whatever the encoding, so the
 * text encodes back to the same bytes. `lossy` is a decode that does not encode back to the
 * same bytes: such a page opens read-only and is never saved.
 */
export function decodeText(buf, forced = null) {
  let name = forced ? encodingOf(forced) : null;
  if (!name) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) name = 'utf-16le';
    else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) name = 'utf-16be';
    else name = textOrNull(buf) !== null ? 'utf-8' : 'windows-1252';
  }
  let text;
  if (name === 'utf-8') {
    text = textOrNull(buf);
    if (text === null) throw coded('not_utf8', 'not valid UTF-8');
  } else if (name === 'windows-1252') {
    let out = '';
    for (let i = 0; i < buf.length; i++) { const b = buf[i]; out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252[b - 0x80] : b); }
    text = out;
  } else {
    text = new TextDecoder('utf-16le', { ignoreBOM: true }).decode(name === 'utf-16le' ? buf.subarray(0, buf.length - (buf.length % 2)) : swap16(buf));
  }
  const bom = name === 'utf-8' ? buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    : name === 'windows-1252' ? false : text.charCodeAt(0) === 0xfeff;
  let lossy = false;
  try { lossy = !encodeText(text, name).equals(buf); } catch { lossy = true; }
  return { text, encoding: name, bom, lossy };
}

/** The sniff for a file that is not UTF-8 (encoding.rs `sniff`): a UTF-16 byte-order mark, or,
 *  standing in for a confident chardetng answer, no NUL and no control character but tab, line
 *  breaks and form feed in the first 8 KB. Answers the encoding, or null. */
export function sniffEncoding(head) {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return head[0] === 0xff ? 'utf-16le' : 'utf-16be';
  if (!head.length) return null;
  for (const b of head) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return null;
  return 'windows-1252';
}

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
 * naming another is refused with `[stale_vault]`. `outsideRoots` are the folders under which
 * `outsideOpen` registers a file outside the vault (none: every outside open is refused), and
 * `onOutside(native)` is told of each registration, so the bridge can watch its folder.
 * @param {{ root: string, dataDir: string, epoch?: number, log?: (line: string) => void,
 *   outsideRoots?: string[], onOutside?: (native: string) => void }} o
 */
export function createFiles({ root, dataDir, epoch = 1, log = () => {}, outsideRoots = [], onOutside = () => {} }) {
  root = path.resolve(root);
  const logDir = path.join(dataDir, 'logs');
  const logPath = path.join(logDir, 'ose.log');

  /** The absolute path of a vault path; never outside the root (vault.rs `resolve`). Taken
   *  literally (M49): nothing is trimmed, a `..` is refused rather than folded into another
   *  file, and on Windows a name the system would read as another one is `[bad_name]`. */
  const abs = (p) => {
    const raw = String(p ?? '');
    if (raw.startsWith(ABS)) throw coded('escapes_vault', `a file outside the vault is not allowed here: ${p}`);
    const rel = (IS_WIN ? raw.replace(/\\/g, '/') : raw).replace(/^\/+/, '');
    const segs = rel.split('/').filter((s) => s && s !== '.');
    for (const s of segs) {
      if (s === '..') throw coded('escapes_vault', `path escapes the vault: ${p}`);
      if (s.includes('\0') || (IS_WIN && s.includes(':'))) throw coded('escapes_vault', `path must be vault-relative: ${p}`);
      if (IS_WIN && (/[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s.split('.')[0].trimEnd()))) {
        throw coded('bad_name', `Windows would read another name for: ${p}`);
      }
    }
    const full = segs.length ? path.join(root, ...segs) : root;
    if (full !== root && !full.startsWith(root + path.sep)) throw coded('escapes_vault', `path escapes the vault: ${p}`);
    return full;
  };
  const relOf = (full) => path.relative(root, full).split(path.sep).join('/');

  // -------------------------------------------------------------- files outside the vault (outside.rs)
  const fold = (p) => (FOLDS_CASE ? p.toLowerCase() : p);
  const under = (full, dir) => fold(full) === fold(dir) || fold(full).startsWith(fold(dir.endsWith(path.sep) ? dir : dir + path.sep));
  const allowed = outsideRoots.map((d) => path.resolve(d));
  /** folded native path -> native path, for every file `outsideOpen` registered. */
  const registered = new Map();
  /** `abs:` + the absolute path with forward slashes and an uppercase drive letter. */
  const absForm = (native) => ABS + (IS_WIN ? native.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`) : native);
  /** The native path of an `abs:` path. */
  const nativeOf = (p) => { const rest = String(p).slice(ABS.length); return path.resolve(IS_WIN ? rest.replace(/\//g, '\\') : rest); };
  /** Where a command marked **A** reads or writes: `{full, outside, rel}`. An `abs:` path this
   *  bridge has not registered is `[not_registered]`. */
  const target = (p) => {
    if (typeof p === 'string' && p.startsWith(ABS)) {
      const full = nativeOf(p);
      if (!registered.has(fold(full))) throw coded('not_registered', `not opened in this window: ${p}`);
      return { full, outside: true, rel: absForm(full) };
    }
    return { full: abs(p), outside: false, rel: clean(p) };
  };
  const refuseOutside = (p, what) => {
    if (typeof p === 'string' && p.startsWith(ABS)) throw coded('unsupported', `${what} is not available for a file outside the vault: ${p}`);
  };
  /** A file under the folder of a registered outside file, for the media origin's `/~abs/`, or null. */
  const outsideMedia = (native) => {
    const full = path.resolve(native);
    for (const f of registered.values()) if (under(full, path.dirname(f))) return full;
    return null;
  };

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

  /** The atomic write, with the host's `[write_failed]` wording on failure. A file outside the
   *  vault (`opts.outside`) does not need the vault folder. */
  const writeVault = async (rel, full, data, opts = {}) => {
    if (!opts.outside) requireVault();
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
    // A path the hide rule excludes (a temp file, anything under .git) has no history to move.
    if (isExcluded(from) || isExcluded(to)) return;
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
  // The drafts of files outside the vault are kept under the vault key `outside`.
  const draftsDir = (outside = false) => {
    let key = root.replace(/\\/g, '/');
    if (FOLDS_CASE) key = key.toLowerCase();
    return path.join(dataDir, 'drafts', hash(outside ? 'outside' : key));
  };
  const draftFile = (p) => {
    const t = typeof p === 'string' && p.startsWith(ABS) ? target(p) : null;
    return t ? path.join(draftsDir(true), `${hash(t.rel)}.json`) : path.join(draftsDir(), `${hash(clean(p))}.json`);
  };
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

  // -------------------------------------------------------------- listings (vault.rs, hide.rs)
  const MAX_DEPTH = 24;
  let rootReal = null;
  const realRoot = () => { if (!rootReal) { try { rootReal = fss.realpathSync.native(root); } catch { rootReal = root; } } return rootReal; };
  const insideReal = (real) => real === realRoot() || real.startsWith(realRoot() + path.sep);

  /** What a link points at (hide.rs `link_kind`): `file`/`dir` inside the vault, `broken`,
   *  `outside`, or `loop` for a folder link to its own folder or an ancestor. */
  const linkKind = async (full) => {
    let real, st;
    try { real = await fs.realpath(full); st = await fs.stat(real); } catch { return { link: 'broken', st: null }; }
    if (!insideReal(real)) return { link: 'outside', st };
    if (st.isDirectory()) {
      let parent = null;
      try { parent = await fs.realpath(path.dirname(full)); } catch { parent = null; }
      if (parent && (parent === real || parent.startsWith(real + path.sep))) return { link: 'loop', st };
      return { link: 'dir', st };
    }
    return { link: 'file', st };
  };

  /** One entry (docs/HOST.md "Entry") from its own lstat: a link is described by its target.
   *  `flagged` is the set of paths carrying Windows' hidden flag (`winHidden`). */
  const entryOf = async (full, own, flagged = null) => {
    const name = path.basename(full);
    let meta = own, link;
    if (own.isSymbolicLink()) {
      const k = await linkKind(full);
      link = k.link;
      if (k.st) meta = k.st;
    }
    const dir = meta.isDirectory();
    const e = {
      name, path: relOf(full), kind: dir ? 'dir' : 'file',
      ext: dir ? '' : (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''),
      mtime: Math.floor(meta.mtimeMs), size: dir ? 0 : meta.size,
      hidden: isHiddenName(name) || !!flagged?.has(full.toLowerCase()),
    };
    if (link) e.link = link;
    return e;
  };

  /** `list(path, {hidden})`: folders first, natural order; excluded never, hidden on request. */
  const list = async (p, opts) => {
    const hidden = !!(isObj(opts) && opts.hidden);
    if (isExcluded(p)) throw coded('not_found', `not listed: ${p}`);
    const dir = abs(p);
    let st;
    try { st = await fs.stat(dir); } catch (e) { throw ioError(p, e); }
    if (!st.isDirectory()) throw coded('not_found', `not a folder: ${p}`);
    try { if (!insideReal(await fs.realpath(dir))) throw coded('escapes_vault', `the folder is a link out of the vault: ${p}`); } catch (e) { if (e.code === 'escapes_vault') throw e; }
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { throw ioError(p, e); }
    const flagged = await winHidden(dir);
    const out = [];
    for (const d of ents) {
      const full = path.join(dir, d.name);
      let c = classify(relOf(full));
      if (c === 'shown' && flagged.has(full.toLowerCase())) c = 'hidden';
      if (c === 'excluded' || (c === 'hidden' && !hidden)) continue;
      let own;
      try { own = await fs.lstat(full); } catch { continue; }
      const e = await entryOf(full, own, flagged);
      if (e.kind === 'dir' && !e.link) { try { (await fs.opendir(full)).close(); } catch { e.readable = false; } }
      out.push(e);
    }
    return out.sort(byEntry);
  };

  /** Every entry under `dir` the rule lets through, depth first, never into a link. `visit`
   *  answers false to stop the walk (a newer search). Unreadable folders are reported.
   *  `flagged` is Windows' hidden flag for the whole walk (`winHidden`, deep): asked once, and
   *  only when it decides something (hidden items left out) unless the caller passes it. */
  const walk = async (dir, hidden, visit, depth = 0, unreadable = null, flagged = undefined) => {
    if (depth > MAX_DEPTH) return true;
    if (flagged === undefined) flagged = hidden ? new Set() : await winHidden(dir, true);
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { unreadable?.add(dir); return true; }
    for (const d of ents) {
      const full = path.join(dir, d.name);
      let c = classify(relOf(full));
      if (c === 'shown' && flagged.has(full.toLowerCase())) c = 'hidden';
      if (c === 'excluded' || (c === 'hidden' && !hidden)) continue;
      let own;
      try { own = await fs.lstat(full); } catch { continue; }
      if (await visit(full, own, flagged) === false) return false;
      if (own.isDirectory() && !own.isSymbolicLink()) {
        if (!(await walk(full, hidden, visit, depth + 1, unreadable, flagged))) return false;
      }
    }
    return true;
  };

  /** `tree({hidden})`: the vault as one entry named after it. */
  const tree = async (opts) => {
    const hidden = !!(isObj(opts) && opts.hidden);
    let st;
    try { st = await fs.stat(root); } catch (e) { throw coded('io', `cannot read the vault root: ${e.message}`); }
    const byParent = new Map();
    const unreadable = new Set();
    const flagged = await winHidden(root, true);
    await walk(root, hidden, async (full, own) => {
      const e = await entryOf(full, own, flagged);
      const parent = path.dirname(full);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push([full, e]);
    }, 0, unreadable, flagged);
    const assemble = (dir) => (byParent.get(dir) || []).map(([full, e]) => {
      if (e.kind === 'dir' && !e.link) {
        if (unreadable.has(full)) e.readable = false;
        e.children = assemble(full);
      }
      return e;
    }).sort(byEntry);
    return { name: path.basename(root), path: '', kind: 'dir', ext: '', mtime: Math.floor(st.mtimeMs), size: 0, hidden: false, children: assemble(root) };
  };

  /** `stat(path, {sniff})` -> `{exists, kind, mtime, size, hidden, link?, text?, encoding?}`.
   *  With a sniff, a file that is not UTF-8 is text when it is UTF-16 with a byte-order mark or
   *  looks like windows-1252 (`sniffEncoding`), and `encoding` says which. */
  const stat = async (p, opts) => {
    const { full, outside } = target(p);
    let own;
    try { own = await fs.lstat(full); } catch { return { exists: false, kind: null, mtime: 0, size: 0, hidden: false }; }
    const e = await entryOf(full, own);
    const hidden = outside ? isHiddenName(path.basename(full)) || await osHidden(full) : classify(clean(p)) !== 'shown' || await osHidden(full);
    const out = { exists: true, kind: e.kind, mtime: e.mtime, size: e.size, hidden };
    if (e.link && !outside) out.link = e.link;
    if (isObj(opts) && opts.sniff && e.kind === 'file') {
      try {
        const fh = await fs.open(full, 'r');
        try {
          const buf = Buffer.alloc(SNIFF_BYTES);
          const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
          const head = buf.subarray(0, bytesRead);
          if (sniffText(head)) { out.text = true; out.encoding = 'utf-8'; }
          else {
            const enc = sniffEncoding(head);
            out.text = !!enc;
            if (enc) out.encoding = enc;
          }
        } finally { await fh.close(); }
      } catch { out.text = false; }
    }
    return out;
  };

  // -------------------------------------------------------------- copyPath (vault.rs copy_path)
  const copyOne = async (src, dst) => {
    const input = await fs.readFile(src);
    let fh;
    try { fh = await fs.open(dst, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw coded('exists', `already exists: ${relOf(dst)}`); throw e; }
    try { await fh.writeFile(input); await fh.sync(); await fh.close(); } catch (e) {
      try { await fh.close(); } catch { /* closed */ }
      try { await fs.unlink(dst); } catch { /* gone */ }
      throw e;
    }
  };
  const copyLink = async (src, dst) => {
    const target = await fs.readlink(src);
    let type = 'file';
    try { if ((await fs.stat(src)).isDirectory()) type = IS_WIN ? 'junction' : 'dir'; } catch { /* broken */ }
    await fs.symlink(target, dst, type);
  };
  const copyTree = async (src, dst, count) => {
    for (const d of await fs.readdir(src, { withFileTypes: true })) {
      const from = path.join(src, d.name), to = path.join(dst, d.name);
      if (d.isSymbolicLink()) {
        try { await copyLink(from, to); count.n++; } catch (e) {
          warn(`copyPath: link ${relOf(from)} left out: ${e.message}`);
          count.leftOut.push(relOf(from));
        }
      } else if (d.isDirectory()) {
        await fs.mkdir(to);
        await copyTree(from, to, count);
      } else {
        await copyOne(from, to);
        count.n++;
      }
    }
  };
  /** Is `dst` (which need not exist) `src` or under it (vault.rs `inside_or_same`)? By the
   *  spelling, case folded on Windows and macOS, and through links by real paths. */
  const insideOrSame = (dst, src) => {
    const fold = (p) => (IS_WIN || process.platform === 'darwin' ? p.toLowerCase() : p);
    const under = (a, b) => fold(a) === fold(b) || fold(a).startsWith(fold(b.endsWith(path.sep) ? b : b + path.sep));
    if (under(dst, src)) return true;
    let srcReal;
    try { srcReal = fss.realpathSync.native(src); } catch { return false; }
    let base = dst;
    const rest = [];
    for (;;) {
      try { return under(path.join(fss.realpathSync.native(base), ...[...rest].reverse()), srcReal); } catch { /* not there yet */ }
      const up = path.dirname(base);
      if (up === base) return false;
      rest.push(path.basename(base));
      base = up;
    }
  };
  /** `copyPath(from, to)` -> `{path, files, leftOut?}`: a file or a folder, bytes, create-only;
   *  `leftOut`, only when there are any, names the links under `from` that could not be made. */
  const copyPath = async (from, to, opts) => {
    checkEpoch(opts);
    const src = abs(from), dst = abs(to);
    requireVault();
    if (dst === root) throw coded('bad_name', `not a name to copy to: ${to}`);
    let own;
    try { own = await fs.lstat(src); } catch (e) { throw ioError(from, e); }
    if (fss.existsSync(dst) || (() => { try { fss.lstatSync(dst); return true; } catch { return false; } })()) throw coded('exists', `already exists: ${to}`);
    if (own.isDirectory() && insideOrSame(dst, src)) throw coded('bad_arg', `a folder cannot be copied into itself: ${from} -> ${to}`);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    const count = { n: 0, leftOut: [] };
    try {
      if (own.isSymbolicLink()) { await copyLink(src, dst); count.n = 1; }
      else if (own.isDirectory()) {
        await fs.mkdir(dst);
        try { await copyTree(src, dst, count); } catch (e) { await fs.rm(dst, { recursive: true, force: true }); throw e; }
      } else { await copyOne(src, dst); count.n = 1; }
    } catch (e) {
      if (e.code === 'exists' || e.code === 'EEXIST') throw coded('exists', `already exists: ${to}`);
      throw e.message?.startsWith('[') ? e : coded('io', `${to}: ${e.message}`);
    }
    return count.leftOut.length ? { path: relOf(dst), files: count.n, leftOut: count.leftOut } : { path: relOf(dst), files: count.n };
  };

  // -------------------------------------------------------------- trash (trashbin.rs)
  // Node has no system bin: every trash goes to `.trash` in the vault, with the host's sidecar,
  // and `trashWhere` says so honestly.
  const BIN = '.trash', INFO = '.info';
  const infoFile = (entry) => path.join(root, BIN, INFO, `${entry}.json`);
  const validEntry = (e) => !!e && e !== INFO && e !== '.' && e !== '..' && !/[\\/]/.test(e) && !isExcluded(e);
  const unstamped = (entry) => { const m = /^(\d+)-(.+)$/.exec(entry); return m ? [m[2], Number(m[1])] : [entry, null]; };
  const sizeOf = async (full, depth = 0) => {
    let st;
    try { st = await fs.lstat(full); } catch { return 0; }
    if (!st.isDirectory()) return st.size;
    if (depth > 24) return 0;
    let n = 0;
    for (const name of await fs.readdir(full).catch(() => [])) n += await sizeOf(path.join(full, name), depth + 1);
    return n;
  };
  const trash = async (p, opts) => {
    checkEpoch(opts);
    const full = abs(p);
    if (full === root) throw coded('bad_arg', 'refusing to trash the vault root');
    let own;
    try { own = await fs.lstat(full); } catch { throw coded('not_found', `nothing to trash: ${p}`); }
    requireVault();
    await fs.mkdir(path.join(root, BIN, INFO), { recursive: true });
    const at = Date.now();
    let entry = `${at}-${path.basename(full)}`;
    for (let n = 2; fss.existsSync(path.join(root, BIN, entry)); n++) entry = `${at}-${n}-${path.basename(full)}`;
    try { await fs.rename(full, path.join(root, BIN, entry)); } catch (e) { throw coded('io', `${p}: .trash: ${e.message}`); }
    try {
      await writeAtomic(infoFile(entry), JSON.stringify({ v: 1, original: clean(p), deletedAt: at, kind: own.isDirectory() ? 'dir' : 'file' }), { budget: 500, aside: 'discard' });
    } catch (e) { warn(`trash: sidecar of ${entry}: ${e.message}`); }
    return { id: `vault:${entry}`, where: 'vault' };
  };
  const trashList = async () => {
    const out = [];
    let names = [];
    try { names = await fs.readdir(path.join(root, BIN)); } catch { return out; }
    for (const entry of names) {
      if (!validEntry(entry)) continue;
      const full = path.join(root, BIN, entry);
      let st;
      try { st = await fs.lstat(full); } catch { continue; }
      let info = null;
      try { info = JSON.parse(await fs.readFile(infoFile(entry), 'utf8')); } catch { info = null; }
      const [bare, stamp] = unstamped(entry);
      const known = typeof info?.original === 'string';
      const original = known ? info.original : bare;
      out.push({
        id: `vault:${entry}`, name: original.split('/').pop(), original,
        // No sidecar: where it was is not known, and a restore puts it at the root (trash.js).
        ...(known ? {} : { known: false }),
        deletedAt: typeof info?.deletedAt === 'number' ? info.deletedAt : (stamp ?? Math.floor(st.mtimeMs)),
        kind: st.isDirectory() ? 'dir' : 'file', size: await sizeOf(full), where: 'vault',
      });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  };
  const trashRestore = async (ids, opts) => {
    checkEpoch(opts);
    requireVault();
    const restored = [], failed = [];
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      try {
        const entry = typeof id === 'string' && id.startsWith('vault:') ? id.slice(6) : null;
        if (!entry || !validEntry(entry)) throw coded('bad_arg', `not a trash id: ${id}`);
        const src = path.join(root, BIN, entry);
        if (!fss.existsSync(src)) throw coded('not_found', `no longer in .trash: ${entry}`);
        let original = unstamped(entry)[0];
        try { const info = JSON.parse(await fs.readFile(infoFile(entry), 'utf8')); if (typeof info.original === 'string') original = info.original; } catch { /* no sidecar */ }
        const dst = abs(original);
        let taken = false;
        try { await fs.lstat(dst); taken = true; } catch { taken = false; }
        if (taken) throw coded('exists', `A file with that name is already there: ${original}`);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.rename(src, dst);
        try { await fs.unlink(infoFile(entry)); } catch { /* none */ }
        restored.push({ id, path: clean(original) });
      } catch (e) {
        failed.push({ id, error: errorText(e) });
      }
    }
    return { restored, failed };
  };

  // -------------------------------------------------------------- local state (local.rs)
  // `<dataDir>/local/app.json` and `<dataDir>/local/vaults/<vaultKey>.json`; the dev bridge's
  // data folder stands in for the app's config folder.
  const LOCAL_MAX = 1024 * 1024;
  const HOST_KEYS = ['window', 'theme'];
  const vaultKey = () => { let key = root.replace(/\\/g, '/'); if (FOLDS_CASE) key = key.toLowerCase(); return hash(key); };
  const localFile = (scope) => {
    if (scope === 'app') return path.join(dataDir, 'local', 'app.json');
    if (scope === 'vault') return path.join(dataDir, 'local', 'vaults', `${vaultKey()}.json`);
    throw coded('bad_arg', `not a local scope: ${scope}`);
  };
  const readLocal = async (file) => {
    try { const o = JSON.parse(await fs.readFile(file, 'utf8')); return isObj(o) ? o : {}; } catch { return {}; }
  };
  let localGate = Promise.resolve();
  const localGated = (fn) => { const run = localGate.then(fn, fn); localGate = run.catch(() => {}); return run; };
  const localGet = async (scope) => {
    const file = localFile(scope);
    return localGated(async () => {
      const o = await readLocal(file);
      if (scope === 'app') for (const k of HOST_KEYS) delete o[k];
      return o;
    });
  };
  const localSet = async (scope, value, opts) => {
    const file = localFile(scope);
    if (scope === 'vault') checkEpoch(opts);
    if (!isObj(value)) throw coded('bad_arg', 'local state is an object');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, 'utf8') > LOCAL_MAX) throw coded('bad_arg', `local state is ${Buffer.byteLength(text, 'utf8')} bytes, more than the 1 MB it may be`);
    return localGated(async () => {
      const next = { ...value };
      if (scope === 'app') {
        const disk = await readLocal(file);
        for (const k of HOST_KEYS) { delete next[k]; if (k in disk) next[k] = disk[k]; }
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await writeAtomic(file, JSON.stringify(next), { budget: 200, aside: 'discard' }); } catch (e) { throw coded('write_failed', `local state: ${e.message}`); }
      return null;
    });
  };

  const files = {
    // ------------------------------------------------------------ plain reads and writes
    readText: async (p) => {
      const { full } = target(p);
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
    readBinary: async (p) => { const { full } = target(p); try { return (await fs.readFile(full)).toString('base64'); } catch (e) { throw ioError(p, e); } },
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
    // Every trash is kept, never deleted; Node has no system bin, so the vault's .trash it is.
    trash, trashList, trashRestore,
    trashWhere: async (p) => { abs(p); return { where: 'vault' }; },
    // Listings under the one hide rule, a copy of a file or a folder, and the local store.
    list, tree, stat, copyPath, localGet, localSet,
    exists: async (p) => fss.existsSync(target(p).full),

    // ------------------------------------------------------------ the save path (files.rs)
    // `readFile(path, {encoding})`: the text decoded (`decodeText`), with the encoding it was
    // read in, whether it starts with a byte-order mark, and `lossy` when the decode does not
    // encode back to the same bytes. The hash is always the bytes on disk.
    readFile: async (p, opts) => {
      const { full } = target(p);
      let buf;
      try { buf = await fs.readFile(full); } catch (e) { throw ioError(p, e); }
      const forced = isObj(opts) && typeof opts.encoding === 'string' && opts.encoding ? opts.encoding : null;
      let d;
      try { d = decodeText(buf, forced); } catch (e) { throw e.code ? coded(e.code, `${e.message.replace(/^\[[a-z0-9_]+\] /, '')}: ${p}`) : e; }
      return { text: d.text, hash: hash(buf), mtime: await mtimeOf(full), size: buf.length, encoding: d.encoding, bom: d.bom, lossy: d.lossy };
    },
    saveFile: async (p, text, opts) => {
      checkEpoch(opts);
      const rel = clean(p);
      try {
        if (typeof text !== 'string') throw coded('bad_arg', 'argument 1 must be the text');
        if (!isObj(opts)) throw coded('bad_arg', 'saveFile needs {expectedHash}');
        const expected = opts.expectedHash;
        if (!(expected === null || typeof expected === 'string')) throw coded('bad_arg', 'expectedHash must be a hash or null');
        const { full, outside } = target(p);
        // A file outside the vault keeps no versions: they live in the vault's history.
        const mode = outside ? 'none' : (opts.version ?? 'save');
        if (!['save', 'conflict', 'none'].includes(mode)) throw coded('bad_arg', `not a version mode: ${mode}`);
        const encoding = opts.encoding === undefined || opts.encoding === null ? 'utf-8' : encodingOf(opts.encoding);
        if (full === root) throw coded('bad_arg', 'no file name to write');
        // A lost vault folder is not a deleted page (files.rs `save_file`).
        if (!outside) requireVault();
        // Encoded before anything is read or written: a character the encoding cannot hold
        // is `[unencodable]`, and the file is not touched.
        const bytes = encodeText(text, encoding);
        const r = await withLock(full, async () => {
          const disk = await readExisting(full, rel);
          // The bytes on disk do not survive a round trip through this encoding: saving over
          // them would change bytes nobody edited (encoding.rs).
          if (disk && encoding !== 'utf-8' && decodeText(disk, encoding).lossy) throw coded('lossy', `${rel} cannot be read back exactly as ${encoding}; it is not saved`);
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
            await writeVault(rel, full, bytes, { beforeRename: still, rethrow: () => moved !== undefined, outside });
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
        if (!outside) await pruneVaultIfOver(Date.now());
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
    // `createNewBinary(path, base64, opts)`: an exclusive create written with its bytes in one
    // call, so a failure leaves no empty file (wave 1, open).
    createNewBinary: async (p, data, opts) => {
      checkEpoch(opts);
      if (typeof data !== 'string') throw coded('bad_arg', 'argument 1 must be the bytes, in base64');
      checkName(p);
      const full = abs(p);
      requireVault();
      const bytes = Buffer.from(data, 'base64');
      await withLock(full, () => createExclusive(full, clean(p), bytes));
      return { path: clean(p), hash: hash(bytes) };
    },
    // `importOutside(from, to, opts)`: a byte copy of a registered outside file into the vault,
    // create-only.
    importOutside: async (from, to, opts) => {
      checkEpoch(opts);
      if (typeof from !== 'string' || !from.startsWith(ABS)) throw coded('bad_arg', `not a file outside the vault: ${from}`);
      const src = target(from).full;
      checkName(to);
      const dst = abs(to);
      requireVault();
      let bytes;
      try {
        if ((await fs.stat(src)).isDirectory()) throw coded('bad_arg', `not a file: ${from}`);
        bytes = await fs.readFile(src);
      } catch (e) { throw e.message?.startsWith('[') ? e : ioError(from, e); }
      await withLock(dst, () => createExclusive(dst, clean(to), bytes));
      return { path: clean(to), hash: hash(bytes) };
    },
    // `outsideOpen(path)`: a native absolute path, or `abs:`. Inside the vault it answers the
    // vault path and registers nothing; outside, it registers the file for the life of the
    // bridge, when it is under one of `outsideRoots`.
    outsideOpen: async (p) => {
      const raw = String(p ?? '');
      let native;
      if (raw.startsWith(ABS)) native = nativeOf(raw);
      else if (path.isAbsolute(raw) && (!IS_WIN || /^[a-zA-Z]:[\\/]|^\\\\/.test(raw))) native = path.resolve(raw);
      else throw coded('bad_arg', `not an absolute path: ${p}`);
      let st = null;
      try { st = await fs.stat(native); } catch { st = null; }
      const info = { name: path.basename(native), exists: !!st, kind: st ? (st.isDirectory() ? 'dir' : 'file') : null };
      if (under(native, root)) return { path: relOf(native), inside: true, ...info };
      if (!allowed.some((d) => under(native, d))) {
        throw coded('unsupported', `the dev bridge opens files outside the vault only under ${allowed.length ? allowed.join(', ') : 'OSE_E2E_OUTSIDE (not set)'}: ${p}`);
      }
      if (!registered.has(fold(native))) {
        registered.set(fold(native), native);
        try { onOutside(native); } catch (e) { warn(`outside: watch of ${native}: ${e.message}`); }
      }
      return { path: absForm(native), inside: false, ...info };
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
        const found = index >= 0 ? lineSpans(text)[index] : undefined;
        if (!found) return { status: 'conflict', actual: null };
        // As the host (files.rs line_at): line 0 is compared without a leading byte-order mark,
        // and the mark stays in the file.
        const span = index === 0 && text.startsWith('﻿') ? [found[0] + 1, found[1]] : found;
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
      const t = target(p);
      await gated(() => writeDraftFile(draftFile(p), {
        v: 1, vault: t.outside ? 'outside' : root, path: t.rel, text: draft.text,
        baselineHash: typeof draft.baselineHash === 'string' ? draft.baselineHash : null,
        mode: draft.mode === 'source' || draft.mode === 'live' ? draft.mode : 'rich',
        exact: typeof draft.exact === 'boolean' ? draft.exact : true,
        rev: typeof draft.rev === 'number' ? draft.rev : 0,
        at,
      }));
      return { at };
    },
    // The vault's drafts and the drafts of files outside it (`abs:` paths).
    draftList: async () => {
      const out = [];
      for (const dir of [draftsDir(), draftsDir(true)]) {
        let names = [];
        try { names = await fs.readdir(dir); } catch { continue; }
        for (const n of names) {
          if (!isDraftName(n)) continue;
          const o = await readDraftFile(path.join(dir, n));
          if (!o) continue;
          const { text, ...info } = toDraft(o);
          out.push({ ...info, bytes: Buffer.byteLength(String(text), 'utf8') });
        }
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
      refuseOutside(p, 'a version');
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
    versionList: async (p) => { refuseOutside(p, 'a version'); migrate(); return (await entries(p)).map(({ id, at, bytes, reason, session: s }) => ({ id, at, bytes, reason, session: s })); },
    versionRead: async (p, id) => {
      refuseOutside(p, 'a version');
      migrate();
      const e = await findVersion(p, id);
      const text = textOrNull(await fs.readFile(e.full));
      if (text === null) throw coded('not_utf8', `not valid UTF-8: version ${id} of ${p}`);
      return text;
    },
    // Only "there is no file" means there is nothing to keep (F3): a file that cannot be read
    // holds bytes no version has, so the restore fails and writes nothing.
    versionRestore: async (p, id, opts) => {
      refuseOutside(p, 'a version');
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

  return { files, abs, relOf, target, absForm, outsideMedia, walk, list, tree, stat, logPath, epoch, checkEpoch, requireVault, moveHistory, rekeyDrafts, writeLog, keepVersion, _survivors: survivors };
}

export { survivors, idFromMs, msFromId };
