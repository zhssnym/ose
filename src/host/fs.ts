// Module fs (docs/HOST.md "fs"): every vault-file command of the host, answered in the browser
// over the FileSystemDirectoryHandle the person picked. The answers, the error codes and the
// file names under `.ose/history` and `.trash/.info` are those of the desktop host this was
// ported from, so a vault keeps its history across the move. The `.rs` and `dev/` names in the
// comments below are where each piece came from: git history, at 6cee39d.
//
//   import { createFs } from './fs.ts';
//   const fs = createFs(root, { vaultId, epoch: () => 1, os: 'windows', log, outside, onRename });
//   await fs.saveFile('a.md', 'text', { expectedHash: null });
//
// What the browser changes:
// - Every write goes through `createWritable()`, which writes into a swap file and replaces the
//   target on `close()`: the bytes on disk are the old ones or the new ones. The last look of
//   saveFile and replaceLine is a read of the target just before `close()`; a change seen there
//   aborts the writable and answers the conflict. A failed `close()` sets the new bytes aside
//   in `<stem>.unsaved-<stamp>.<ext>` and says where (files.rs's set-aside).
// - Creates are exclusive by looking first, under the path's lock (the API has no `O_EXCL`).
// - A path lock is the in-tab chain of dev/files.mjs plus the Web Lock `ose-save:<id>:<path>`,
//   so two tabs never interleave a compare and a write.
// - There is no system bin: a trash always goes to the vault's `.trash`, with its sidecar.
// - There are no links and no system hidden flag: hidden is a dot name, and no entry has `link`.
// - Folder mtimes are not exposed: 0.
// - A folder Chrome will not `move()` is copied and the original removed once the copy is whole.
//
// Every public method converts what the browser threw into the HostError the host would answer
// (rules.ts `fromDom`), so a caller never sees a DOMException.

import {
  ABS, byEntry, checkName, classify, clean, decodeText, encodeText, encodingOf, fail, fromDom, hash, HostError,
  isExcluded, isHiddenName, isInBin, naturalCompare, sameBytes, sniffEncoding, sniffText, SNIFF_BYTES, utf8OrNull,
  vaultSegments,
} from './rules.ts';

export { hash };

export type FsOptions = {
  vaultId: string,
  epoch: () => number,
  os?: 'windows' | 'macos' | 'linux',
  log?: (level: string, text: string) => void,
  outside?: { handle(absPath: string): Promise<FileSystemFileHandle | null> },
  onRename?: (from: string, to: string) => Promise<void>,
  now?: () => number,
};
export type Place = { rel: string, outside: boolean, segs: string[], handle: FileSystemFileHandle | null };
export type Entry = { name: string, path: string, kind: string, ext: string, mtime: number, size: number, hidden: boolean,
  readable?: boolean, children?: Entry[] };
export type VersionEntry = { id: string, reason: string, session: boolean, at: number, bytes: number, name: string,
  dir: FileSystemDirectoryHandle, key: string };
export type Hit = { path: string, line: number, col: number, text: string, kind: string };

/** What a file was when it was copied: its size, its time and the hash of the bytes copied. */
type Seen = { size: number, mtime: number, hash: string };
type Manifest = { files: Map<string, Seen>, dirs: Set<string> };

const MAX_DEPTH = 24;
const H_ROOT = ['.ose', 'history'];
const H_OLD = ['.ose', 'versions'];
const MIN_INTERVAL_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const REASONS = new Set(['save', 'conflict', 'reload', 'restore']);
const BIN = '.trash';
const INFO = '.info';
const SEARCH_EXTS = new Set(['md', 'txt', 'csv', 'jsonl', 'py', 'log', 'tex', 'json', 'yaml', 'toml']);
const LINES_PER_FILE = 20;
const PARALLEL = 16;

// ---------------------------------------------------------------- small helpers

const p2 = (n: number) => String(n).padStart(2, '0');
const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The DOMException's name, or ''. */
const domName = (e: unknown) => (e && typeof e === 'object' && 'name' in e ? String(e.name) : '');
const msgOf = (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
/** A lookup that found nothing: the name is not there, or a segment is the other kind. */
const isGone = (e: unknown) => domName(e) === 'NotFoundError' || domName(e) === 'TypeMismatchError';
const utf8Lenient = new TextDecoder('utf-8', { ignoreBOM: true });
const enc = new TextEncoder();

/** `20260925-101500`, UTC: the time an unsaved copy was set aside. */
const unsavedStamp = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
};

/** `2026-09-10-201500`, UTC: a version's id. */
export const idFromMs = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
};
/** The inverse, to the second; a `-<n>` a merge added after the time is the same moment. */
export const msFromId = (id: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? Date.UTC(+(m[1] ?? 0), +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null;
};
const idOk = (id: unknown) => /^[0-9-]{1,40}$/.test(String(id ?? ''));
/** The extension of a path's last segment, as written, without the dot. */
const extAsWritten = (rel: string) => {
  const name = String(rel).split(/[\\/]/).pop() || '';
  const i = name.lastIndexOf('.');
  return i > 0 && i + 1 < name.length ? name.slice(i + 1) : '';
};
const vFileName = (id: string, reason: string, session: boolean, ext: string) => `${id}.${reason}${session ? '-s' : ''}${ext ? `.${ext}` : ''}`;
/** `{id, reason, session}` of a version file, or null. `<id>.md` is the pre-1.1 name. */
const parseVName = (name: string) => {
  const dot = name.indexOf('.');
  if (dot < 0) return null;
  const id = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  if (!idOk(id)) return null;
  if (rest.includes('.unsaved-')) return null;
  let tag = rest.split('.')[0] || '';
  const session = tag.endsWith('-s');
  if (session) tag = tag.slice(0, -2);
  if (REASONS.has(tag)) return { id, reason: tag, session };
  if (rest.toLowerCase() === 'md') return { id, reason: 'save', session: false };
  return null;
};

/**
 * Which versions of one file survive at `now` (versions.rs, dev/files.mjs `survivors`):
 * newest-first list in, parallel booleans out.
 */
export function survivors(list: { at: number; session: boolean; reason: string; }[], now: number) {
  const hours = new Set();
  const days = new Set();
  return list.map((e, i) => {
    const age = now - e.at;
    const guarded = e.session || e.reason !== 'save';
    if (i === 0 || age < HOUR_MS || (guarded && age < MONTH_MS)) return true;
    if (age < DAY_MS) { const k = Math.floor(e.at / HOUR_MS); if (hours.has(k)) return false; hours.add(k); return true; }
    if (age < MONTH_MS) { const k = Math.floor(e.at / DAY_MS); if (days.has(k)) return false; days.add(k); return true; }
    return false;
  });
}

/** The line ending a file uses: the one of its last line break. */
const eolOf = (buf: Uint8Array) => {
  const i = buf.lastIndexOf(0x0a);
  return i > 0 && buf[i - 1] === 0x0d ? '\r\n' : '\n';
};
/** Content ranges of the lines of `text`; a `\r` before a `\n` belongs to the separator, and the
 *  empty piece after a final `\n` is not a line.   */
const lineSpans = (text: string): [number, number][] => {
  const out: [number, number][] = [];
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

const concat = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

/** Bytes as base64, in chunks so a large file does not overflow the argument list. */
export function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
/** Base64 (standard or URL-safe, padding optional, whitespace ignored) as bytes, leniently as
 *  Node's `Buffer.from(s, 'base64')` reads it.  */
export function fromBase64(b64: string) {
  let s = String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  if (s.length % 4 === 1) s = s.slice(0, -1);
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The whole file's bytes. */
async function bytesOf(fh: FileSystemFileHandle) {
  const f = await fh.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/**
 * Run `fn` over `items`, at most `n` at once.
 * @template T
 */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn((items[k] as T));
    }
  });
  await Promise.all(lanes);
}

// ---------------------------------------------------------------- the module

/**
 * The file commands for one vault (docs/HOST.md "fs").
 * @param root the vault, permission already granted
 */
export function createFs(root: FileSystemDirectoryHandle, opts: FsOptions) {
  const vaultId = String(opts.vaultId ?? '');
  const epochNow = typeof opts.epoch === 'function' ? opts.epoch : () => 1;
  const win = opts.os === 'windows';
  const folds = opts.os === 'windows' || opts.os === 'macos';
  const fold = (s: string) => (folds ? s.toLowerCase() : s);
  const logTo = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const outsideReg = opts.outside;
  const onRename = typeof opts.onRename === 'function' ? opts.onRename : async () => {};

  const log = (level: string, text: string) => { try { logTo(level, text); } catch { /* the log never breaks a command */ } };
  const warn = (text: string) => log('warn', text);

  // -------------------------------------------------------------- paths and handles
  const segsOf = (p: unknown) => vaultSegments(p, win);
  const relOf = (s: string[]) => s.join('/');

  /** The folder at `segs`, made on the way with `create`. */
  async function dirAt(segs: string[], create: boolean = false) {
    let d = root;
    for (const s of segs) d = await d.getDirectoryHandle(s, { create });
    return d;
  }
  /** The folder at `segs`, or null when it is not there (or a segment is a file). */
  async function dirOrNull(segs: string[]) {
    try { return await dirAt(segs); } catch (e) { if (isGone(e)) return null; throw e; }
  }
  /** The file at `segs`, or null. */
  async function fileOrNull(segs: string[]): Promise<FileSystemFileHandle | null> {
    if (!segs.length) return null;
    const parent = await dirOrNull(segs.slice(0, -1));
    if (!parent) return null;
    try { return await parent.getFileHandle((segs[segs.length - 1] as string)); } catch (e) { if (isGone(e)) return null; throw e; }
  }
  /**
   * What is at `segs`: `{kind, handle, parent, name}`, or null.
   */
  async function lookup(segs: string[]): Promise<{ kind: 'file'; handle: FileSystemFileHandle; parent: FileSystemDirectoryHandle; name: string; } |
  { kind: 'dir'; handle: FileSystemDirectoryHandle; parent: FileSystemDirectoryHandle | null; name: string; } | null> {
    if (!segs.length) return { kind: 'dir', handle: root, parent: null, name: root.name };
    const parent = await dirOrNull(segs.slice(0, -1));
    if (!parent) return null;
    const name = (segs[segs.length - 1] as string);
    try { return { kind: 'file', handle: await parent.getFileHandle(name), parent, name }; } catch (e) {
      if (domName(e) === 'NotFoundError') return null;
      if (domName(e) !== 'TypeMismatchError') throw e;
    }
    try { return { kind: 'dir', handle: await parent.getDirectoryHandle(name), parent, name }; } catch (e) {
      if (isGone(e)) return null;
      throw e;
    }
  }

  /** A command marked **A**: a vault path, or a registered `abs:` one. */
  async function target(p: unknown): Promise<Place> {
    if (typeof p === 'string' && p.startsWith(ABS)) {
      const h = outsideReg ? await outsideReg.handle(p) : null;
      if (!h) throw fail('not_registered', `not opened in this tab: ${p}`);
      return { rel: p, outside: true, segs: [], handle: h };
    }
    const segs = segsOf(p);
    return { rel: relOf(segs), outside: false, segs, handle: null };
  }
  const refuseOutside = (p: unknown, what: string) => {
    if (typeof p === 'string' && p.startsWith(ABS)) throw fail('unsupported', `${what} is not available for a file outside the vault: ${p}`);
  };
  /** The file handle of a place, or null when there is no file. */
  const placeHandle = async (place: Place) => (place.outside ? place.handle : fileOrNull(place.segs));
  /** The bytes of a place, or null when there is no file. */
  async function readPlace(place: Place) {
    const h = await placeHandle(place);
    if (!h) return null;
    try { return await bytesOf(h); } catch (e) { if (isGone(e)) return null; throw e; }
  }

  // -------------------------------------------------------------- the vault and the epoch
  /** The vault folder is there and still ours (vault.rs `require_vault`), or `no_vault`. */
  async function requireVault() {
    let ok = true;
    try {
      if (typeof root.queryPermission === 'function' && (await root.queryPermission({ mode: 'readwrite' })) !== 'granted') ok = false;
      else {
        const it = root.keys();
        await it.next();
        if (typeof it.return === 'function') await it.return(undefined);
      }
    } catch { ok = false; }
    if (!ok) throw fail('no_vault', `the vault folder is gone or no longer allowed: ${root.name}`);
  }
  function checkEpoch(o: unknown) {
    if (isObj(o) && o.epoch !== undefined && o.epoch !== null && Number(o.epoch) !== epochNow()) {
      throw fail('stale_vault', `this page belongs to vault epoch ${o.epoch}, the open vault is epoch ${epochNow()}`);
    }
  }

  // -------------------------------------------------------------- one lock per path
  const locks: Map<string, Promise<unknown>> = new Map();
  /**
   * `fn` after every earlier call for the same key has finished, in this tab, and inside the Web
   * Lock of the same name when `web`, so another tab waits too.
   * @template T
   */
  async function withLock<T>(key: string, fn: () => Promise<T>, web: boolean = true): Promise<T> {
    const k = fold(key);
    for (let t = treeOver([k]); t; t = treeOver([k])) await t;
    const prev = locks.get(k) || Promise.resolve();
    let release: () => void = (): void => {};
    const mine = new Promise((r) => { release = () => r(undefined); });
    const chain = prev.then(() => mine);
    locks.set(k, chain);
    await prev;
    try {
      const nav = (globalThis as any).navigator;
      if (web && nav && nav.locks && typeof nav.locks.request === 'function') {
        return (await nav.locks.request(`ose-save:${vaultId}:${k}`, () => fn()) as T);
      }
      return await fn();
    } finally {
      release();
      if (locks.get(k) === chain) locks.delete(k);
    }
  }
  const lockKey = (place: Place) => (place.outside ? `outside|${place.rel}` : place.rel);

  /** Paths being moved or trashed, whole trees: folded path -> settles when done. */
  const trees: Map<string, Promise<void>> = new Map();
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  /** A tree in flight at, over or under one of `keys`, or null. */
  const treeOver = (keys: string[]) => {
    for (const [t, done] of trees) if (keys.some((k) => overlaps(k, t))) return done;
    return null;
  };
  /**
   * `fn` with the paths `keys` held whole, for a move or a trash: it starts once no path lock at
   * or under them is in flight in this tab (a save there finishes first), and every path lock
   * asked for under them meanwhile waits until it is done (a save there then finds the file
   * gone and answers the conflict, instead of writing into a folder that is being removed).
   * @template T
   */
  async function withTrees<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ks = [...new Set(keys.map(fold))];
    for (let t = treeOver(ks); t; t = treeOver(ks)) await t;
    let release: () => void = (): void => {};
    const done = new Promise((r) => { release = () => r(undefined); });
    for (const k of ks) trees.set(k, (done as Promise<void>));
    try {
      for (;;) {
        const busy = [...locks].filter(([lk]) => ks.some((k) => overlaps(lk, k))).map(([, chain]) => chain.catch(() => {}));
        if (!busy.length) break;
        await Promise.all(busy);
      }
      return await fn();
    } finally {
      for (const k of ks) if (trees.get(k) === done) trees.delete(k);
      release();
    }
  }

  // -------------------------------------------------------------- writes
  const writeFailed = (e: unknown, rel: string) => {
    if (e instanceof HostError) return e;
    const n = domName(e);
    if (n === 'NotAllowedError' || n === 'SecurityError') return fromDom(e, rel);
    return fail('write_failed', `${rel}: ${msgOf(e)}`);
  };

  /** The set-aside this tab made for each target (vault.rs `asides`). */
  const asides: Map<string, string[]> = new Map();
  /**
   * The new bytes into `<stem>.unsaved-<stamp>.<ext>` beside the target (exclusive), or into the
   * copy this tab already set aside for it. Answers the vault path, or null.
   */
  async function setAside(segs: string[], bytes: Uint8Array) {
    const key = fold(relOf(segs));
    try {
      const parent = await dirAt(segs.slice(0, -1));
      const earlier = asides.get(key);
      if (earlier) {
        const h = await fileOrNull(earlier);
        if (h) {
          try { const w = await h.createWritable(); await w.write((bytes as any)); await w.close(); return relOf(earlier); } catch { /* a new name below */ }
        }
      }
      const name = (segs[segs.length - 1] as string);
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      const stamp = unsavedStamp(now());
      for (let k = 1; k < 100; k++) {
        const candidate = `${stem}.unsaved-${stamp}${k === 1 ? '' : `-${k}`}${ext}`;
        const cs = [...segs.slice(0, -1), candidate];
        if (await lookup(cs)) continue;
        await createIn(parent, candidate, bytes, relOf(cs));
        asides.set(key, cs);
        return relOf(cs);
      }
    } catch { /* nowhere to put them: the page keeps the text and its draft */ }
    return null;
  }

  /**
   * The atomic write (vault.rs `write_atomic` in a browser): `createWritable`, the bytes, the
   * last look, `close()`. The target is always the old bytes or the new ones; a missing file is
   * made (empty, then replaced) with its folders, and removed again when the write goes no
   * further. `lastLook(created)` throws to abandon the write before `close()`. When `close()`
   * fails the new bytes are set aside (not with `aside: 'discard'`: a version, the state file)
   * and the error is `write_failed … your text is in <path>`.
   */
  async function writeAtomic(place: Place, bytes: Uint8Array, o: { lastLook?: (created: boolean) => Promise<void>; aside?: 'keep' | 'discard'; } = {}) {
    let fh: FileSystemFileHandle;
    let parent: FileSystemDirectoryHandle | null = null;
    let created = false;
    const name = place.segs[place.segs.length - 1] || '';
    if (place.outside && place.handle) fh = place.handle;
    else {
      if (!place.segs.length) throw fail('bad_arg', 'no file name to write');
      await requireVault();
      parent = await dirAt(place.segs.slice(0, -1), true);
      try { fh = await parent.getFileHandle(name); } catch (e) {
        if (domName(e) !== 'NotFoundError') throw e;
        fh = await parent.getFileHandle(name, { create: true });
        created = true;
      }
    }
    const undoCreate = async () => {
      if (!created || !parent) return;
      try { if ((await fh.getFile()).size === 0) await parent.removeEntry(name); } catch { /* gone */ }
    };
    let w: FileSystemWritableFileStream | null = null;
    try {
      w = await fh.createWritable();
      await w.write((bytes as any));
    } catch (e) {
      if (w) { try { await w.abort(); } catch { /* closed */ } }
      await undoCreate();
      throw writeFailed(e, place.rel);
    }
    if (o.lastLook) {
      try { await o.lastLook(created); } catch (e) {
        try { await w.abort(); } catch { /* closed */ }
        await undoCreate();
        throw e;
      }
    }
    try {
      await w.close();
    } catch (e) {
      await undoCreate();
      const kept = o.aside === 'discard' || place.outside ? null : await setAside(place.segs, bytes);
      if (!kept && writeFailed(e, place.rel).code !== 'write_failed') throw writeFailed(e, place.rel);
      throw fail('write_failed', `${place.rel}: ${msgOf(e)}${kept ? `; your text is in ${kept}` : ''}`);
    }
  }

  /** An exclusive create of `name` in `parent`: the file is made, written and closed, or removed.
   *      */
  async function createIn(parent: FileSystemDirectoryHandle, name: string, bytes: Uint8Array, rel: string) {
    let there = true;
    try { await parent.getFileHandle(name); } catch (e) {
      if (domName(e) === 'NotFoundError') there = false;
      else if (domName(e) !== 'TypeMismatchError') throw e;
    }
    if (there) throw fail('exists', `already exists: ${rel}`);
    const fh = await parent.getFileHandle(name, { create: true });
    let w: FileSystemWritableFileStream | null = null;
    try {
      w = await fh.createWritable();
      await w.write((bytes as any));
      await w.close();
    } catch (e) {
      if (w) { try { await w.abort(); } catch { /* closed */ } }
      try { await parent.removeEntry(name); } catch { /* gone */ }
      throw writeFailed(e, rel);
    }
  }
  /** Exclusive create of a vault path, folders made. */
  async function createExclusive(segs: string[], bytes: Uint8Array) {
    const rel = relOf(segs);
    if (!segs.length) throw fail('bad_name', 'not a file name: ');
    const parent = await dirAt(segs.slice(0, -1), true);
    await createIn(parent, (segs[segs.length - 1] as string), bytes, rel);
  }

  /** `writeBytes(path, bytes)`: atomic, folders made. */
  async function writeBytes(p: string, bytes: Uint8Array) {
    const segs = segsOf(p);
    await writeAtomic({ rel: relOf(segs), outside: false, segs, handle: null }, bytes);
  }
  /** `readBytes(path)`: a vault path or a registered `abs:`; null when missing. */
  async function readBytes(p: string) { return readPlace(await target(p)); }

  // -------------------------------------------------------------- moving and copying handles
  /**
   * Copy every entry of `src` into `dst` (both folders), bytes, create-only; with `seen`, note
   * each file and folder copied, by its path under `src`.
   */
  async function copyTree(src: FileSystemDirectoryHandle, dst: FileSystemDirectoryHandle, count: { n: number; }, rel: string, depth: number = 0, seen: Manifest | null = null, under: string = '') {
    if (depth > 64) throw fail('io', `too deep to copy: ${rel}`);
    for await (const [name, h] of src.entries()) {
      const at = rel ? `${rel}/${name}` : name;
      const key = under ? `${under}/${name}` : name;
      if (h.kind === 'directory') {
        const sub = await dst.getDirectoryHandle(name, { create: true });
        seen?.dirs.add(key);
        await copyTree((h as FileSystemDirectoryHandle), sub, count, at, depth + 1, seen, key);
      } else {
        const f = await (h as FileSystemFileHandle).getFile();
        const bytes = new Uint8Array(await f.arrayBuffer());
        await createIn(dst, name, bytes, at);
        seen?.files.set(key, { size: f.size, mtime: f.lastModified, hash: hash(bytes) });
        count.n++;
      }
    }
  }
  /** The file is still what was copied: size, time and bytes. */
  async function stillAsCopied(fh: FileSystemFileHandle, was: Seen | undefined) {
    if (!was) return false;
    try {
      const f = await fh.getFile();
      if (f.size !== was.size || f.lastModified !== was.mtime) return false;
      return hash(new Uint8Array(await f.arrayBuffer())) === was.hash;
    } catch { return false; }
  }
  /**
   * Every entry under `src` is one the copy took, unchanged since, and nothing was added.
   */
  async function unchangedSince(src: FileSystemDirectoryHandle, seen: Manifest, under: string = '', found: { files: number; dirs: number; } = { files: 0, dirs: 0 }, depth = 0): Promise<boolean> {
    if (depth > 64) return false;
    for await (const [name, h] of src.entries()) {
      const key = under ? `${under}/${name}` : name;
      if (h.kind === 'directory') {
        if (!seen.dirs.has(key)) return false;
        found.dirs++;
        if (!(await unchangedSince((h as FileSystemDirectoryHandle), seen, key, found, depth + 1))) return false;
      } else {
        if (!(await stillAsCopied((h as FileSystemFileHandle), seen.files.get(key)))) return false;
        found.files++;
      }
    }
    return depth > 0 || (found.files === seen.files.size && found.dirs === seen.dirs.size);
  }
  /**
   * Remove what the copy took from `src`, a file at a time, each one looked at just before it
   * goes, then the emptied folders (never recursively): a file written or added since stays,
   * and the answer is false.
   */
  async function removeCopied(src: FileSystemDirectoryHandle, seen: Manifest, under: string = '', depth = 0): Promise<boolean> {
    if (depth > 64) return false;
    const ents: [string, FileSystemHandle][] = [];
    for await (const e of src.entries()) ents.push(e);
    let whole = true;
    for (const [name, h] of ents) {
      const key = under ? `${under}/${name}` : name;
      if (h.kind === 'directory') {
        if (!seen.dirs.has(key) || !(await removeCopied((h as FileSystemDirectoryHandle), seen, key, depth + 1))) { whole = false; continue; }
        try { await src.removeEntry(name); } catch { whole = false; }
      } else if (await stillAsCopied((h as FileSystemFileHandle), seen.files.get(key))) {
        try { await src.removeEntry(name); } catch { whole = false; }
      } else whole = false;
    }
    return whole;
  }

  /**
   * Move an entry to `dstParent/dstName`, which must be free: `move()`, and when Chrome will not
   * move it (a folder on some platforms), a whole copy first and the original removed after,
   * but only what is still as it was copied. Anything written into the original while it was
   * copied (another program, a save) keeps it: the copy is removed and the move fails with `io`,
   * or, when the change comes during the removal itself, both stay and the move fails with `io`.
   * Nothing is ever removed that the copy does not hold.
   */
  async function moveEntry(handle: FileSystemHandle, srcParent: FileSystemDirectoryHandle, srcName: string, dstParent: FileSystemDirectoryHandle, dstName: string, rel: string) {
    if (typeof handle.move === 'function') {
      try { await handle.move(dstParent, dstName); return; } catch (e) {
        if (domName(e) !== 'NotSupportedError') throw e;
      }
    }
    const dropCopy = async () => { try { await dstParent.removeEntry(dstName, { recursive: handle.kind === 'directory' }); } catch { /* gone */ } };
    if (handle.kind === 'file') {
      const fh = (handle as FileSystemFileHandle);
      const f = await fh.getFile();
      const bytes = new Uint8Array(await f.arrayBuffer());
      await createIn(dstParent, dstName, bytes, rel);
      if (!(await stillAsCopied(fh, { size: f.size, mtime: f.lastModified, hash: hash(bytes) }))) {
        await dropCopy();
        throw fail('io', `${rel}: the file changed while it was moved; it is left where it was`);
      }
      await srcParent.removeEntry(srcName);
      return;
    }
    const src = (handle as FileSystemDirectoryHandle);
    const seen: Manifest = { files: new Map(), dirs: new Set() };
    const d = await dstParent.getDirectoryHandle(dstName, { create: true });
    try { await copyTree(src, d, { n: 0 }, rel, 0, seen); } catch (e) {
      await dropCopy();
      throw e;
    }
    if (!(await unchangedSince(src, seen))) {
      await dropCopy();
      throw fail('io', `${rel}: the folder changed while it was moved; it is left where it was`);
    }
    if (!(await removeCopied(src, seen))) {
      warn(`move: ${srcName} changed while it was removed after its copy to ${rel}; both are kept`);
      throw fail('io', `${rel}: the folder changed while it was moved; what changed is left in ${srcName}, the rest is in ${dstName}`);
    }
    await srcParent.removeEntry(srcName);
  }

  // -------------------------------------------------------------- versions (versions.rs)
  const vSegs = (p: unknown) => {
    const s = segsOf(p);
    if (!s.length) throw fail('bad_arg', 'a version needs a file');
    return [...H_ROOT, ...s];
  };
  let migrated = false;
  /** An old `.ose/versions` becomes `.ose/history`. */
  async function migrate() {
    if (migrated) return;
    migrated = true;
    try {
      const old = await dirOrNull(H_OLD);
      if (!old || (await dirOrNull(H_ROOT))) return;
      const ose = await dirAt(['.ose']);
      await moveEntry(old, ose, 'versions', ose, 'history', '.ose/history');
    } catch (e) { warn(`history: could not move .ose/versions to .ose/history: ${msgOf(e)}`); }
  }
  /** The versions in one folder of the history, newest first. */
  async function entriesIn(dir: FileSystemDirectoryHandle, key: string) {
    const out: VersionEntry[] = [];
    const files: [string, FileSystemFileHandle][] = [];
    try {
      for await (const [name, h] of dir.entries()) if (h.kind === 'file') files.push([name, (h as FileSystemFileHandle)]);
    } catch { return out; }
    for (const [name, h] of files) {
      const v = parseVName(name);
      if (!v) continue;
      try {
        const f = await h.getFile();
        out.push({ ...v, at: msFromId(v.id) ?? f.lastModified, bytes: f.size, name, dir, key });
      } catch { /* gone */ }
    }
    out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return out;
  }
  async function versionsOf(p: string): Promise<VersionEntry[]> {
    const s = vSegs(p);
    const d = await dirOrNull(s);
    return d ? entriesIn(d, relOf(s)) : [];
  }
  async function pruneFile(p: string, at: number) {
    const list = await versionsOf(p);
    const keep = survivors(list, at);
    for (let i = 0; i < list.length; i++) {
      const e = (list[i] as VersionEntry);
      if (!keep[i]) { try { await e.dir.removeEntry(e.name); } catch { /* gone */ } }
    }
  }
  /** Hold the whole history under 200 MB; answers its size. */
  async function pruneVault(at: number) {
    const all: VersionEntry[] = [];
    const walkH = async (dir: FileSystemDirectoryHandle, key: string, depth: number) => {
      if (depth > 32) return;
      for (const e of await entriesIn(dir, key)) all.push(e);
      const subs: [string, FileSystemDirectoryHandle][] = [];
      try {
        for await (const [name, h] of dir.entries()) if (h.kind === 'directory') subs.push([name, (h as FileSystemDirectoryHandle)]);
      } catch { return; }
      for (const [name, h] of subs) await walkH(h, `${key}/${name}`, depth + 1);
    };
    const top = await dirOrNull(H_ROOT);
    if (!top) return 0;
    await walkH(top, relOf(H_ROOT), 0);
    let total = all.reduce((n, e) => n + e.bytes, 0);
    if (total <= MAX_TOTAL_BYTES) return total;
    const newest: Map<string, string> = new Map();
    for (const e of all) { const n = newest.get(e.key); if (n === undefined || e.id > n) newest.set(e.key, e.id); }
    all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const e of all) {
      if (total <= MAX_TOTAL_BYTES) break;
      if (newest.get(e.key) === e.id || at - e.at < DAY_MS) continue;
      try { await e.dir.removeEntry(e.name); total -= e.bytes; } catch { /* gone */ }
    }
    return total;
  }
  let historyTotal: number | null = null;
  async function pruneVaultIfOver(at: number) {
    if (historyTotal !== null && historyTotal <= MAX_TOTAL_BYTES) return;
    try { historyTotal = await pruneVault(at); } catch (e) { warn(`history: prune failed: ${msgOf(e)}`); }
  }
  /** Paths that have had a version in this tab: the next one is not the session's first. */
  const session = new Set();
  async function keepLocked(rel: string, bytes: Uint8Array, force: boolean, reason: string, at: number) {
    const list = await versionsOf(rel);
    const newest = list[0];
    if (newest) {
      try {
        const h = await newest.dir.getFileHandle(newest.name);
        if (sameBytes(await bytesOf(h), bytes)) return { kept: false, id: null };
      } catch { /* unreadable */ }
      if (!force && at - newest.at < MIN_INTERVAL_MS) return { kept: false, id: null };
    }
    const first = !session.has(fold(rel));
    let ms = at;
    let id = idFromMs(ms);
    while (list.some((e) => e.id === id)) { ms += 1000; id = idFromMs(ms); }
    const s = [...vSegs(rel), vFileName(id, reason, first, extAsWritten(rel))];
    await writeAtomic({ rel: `version of ${rel}`, outside: false, segs: s, handle: null }, bytes, { aside: 'discard' });
    if (historyTotal !== null) historyTotal += bytes.length;
    session.add(fold(rel));
    await pruneFile(rel, at);
    return { kept: true, id };
  }
  /**
   * Keep `bytes` as a version of `p` (versions.rs `keep_at`), one keep of a file at a time, then
   * hold the history under its cap unless `settle` is false. Answers `{kept, id}`.
   */
  async function keepVersion(p: string, bytes: Uint8Array, o: { force?: boolean; reason?: string; settle?: boolean; at?: number; } = {}): Promise<{ kept: boolean; id: string | null; }> {
    refuseOutside(p, 'a version');
    await migrate();
    if (!bytes || !bytes.length) return { kept: false, id: null };
    await requireVault();
    const rel = relOf(segsOf(p));
    const at = o.at ?? now();
    const r = await withLock(`history|${rel}`, () => keepLocked(rel, bytes, !!o.force, o.reason || 'save', at), false);
    if (o.settle !== false) await pruneVaultIfOver(at);
    return r;
  }
  async function findVersion(p: string, id: unknown) {
    if (!idOk(id)) throw fail('bad_arg', `not a version id: ${String(id)}`);
    const e = (await versionsOf(p)).find((x) => x.id === id);
    if (!e) throw fail('not_found', `no version ${String(id)} of ${p}`);
    return e;
  }
  /** Every entry of `src` into `dst`; a taken name moves aside as `<id>-<n>.<rest>`.
   *     */
  async function merge(src: FileSystemDirectoryHandle, dst: FileSystemDirectoryHandle, rel: string) {
    const ents: [string, FileSystemHandle][] = [];
    try { for await (const e of src.entries()) ents.push(e); } catch { return; }
    for (const [name, h] of ents) {
      let there: FileSystemFileHandle | FileSystemDirectoryHandle | null = null;
      try { there = await dst.getFileHandle(name); } catch (e) {
        if (domName(e) === 'TypeMismatchError') there = await dst.getDirectoryHandle(name);
        else if (domName(e) !== 'NotFoundError') throw e;
      }
      if (!there) { try { await moveEntry(h, src, name, dst, name, `${rel}/${name}`); } catch { /* left */ } continue; }
      if (h.kind === 'directory' && there.kind === 'directory') {
        await merge((h as FileSystemDirectoryHandle), (there as FileSystemDirectoryHandle), `${rel}/${name}`);
        try { await src.removeEntry(name); } catch { /* not empty */ }
        continue;
      }
      const dot = name.indexOf('.');
      const [id, rest] = dot < 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot + 1)];
      for (let n = 1; n < 1000; n++) {
        const free = `${id}-${n}.${rest}`;
        let taken = true;
        try { await dst.getFileHandle(free); } catch (e) { taken = domName(e) !== 'NotFoundError'; }
        if (!taken) { try { await moveEntry(h, src, name, dst, free, `${rel}/${free}`); } catch { /* left */ } break; }
      }
    }
  }
  /** The history follows a rename (versions.rs `move_history`). */
  async function moveHistory(from: string, to: string) {
    await migrate();
    if (isExcluded(from) || isExcluded(to)) return;
    const srcSegs = vSegs(from);
    const dstSegs = vSegs(to);
    const src = await dirOrNull(srcSegs);
    if (!src || relOf(srcSegs) === relOf(dstSegs)) return;
    const srcParent = await dirAt(srcSegs.slice(0, -1));
    const srcName = (srcSegs[srcSegs.length - 1] as string);
    const dstParent = await dirAt(dstSegs.slice(0, -1), true);
    const dstName = (dstSegs[dstSegs.length - 1] as string);
    const there = await lookup(dstSegs);
    if (there && there.kind === 'dir' && (await there.handle.isSameEntry(src))) {
      // A case-only rename on a folding disk: through a temporary name.
      const via = `.${from.length}.${Date.now()}.move`;
      await moveEntry(src, srcParent, srcName, srcParent, via, relOf(srcSegs));
      const moved = await srcParent.getDirectoryHandle(via);
      await moveEntry(moved, srcParent, via, dstParent, dstName, relOf(dstSegs));
      return;
    }
    if (!there) { await moveEntry(src, srcParent, srcName, dstParent, dstName, relOf(dstSegs)); return; }
    if (there.kind !== 'dir') return;
    await merge(src, there.handle, relOf(dstSegs));
    try { await srcParent.removeEntry(srcName); } catch { /* not empty */ }
  }
  /** What a rename does to the app's own data: the history moves and the drafts re-key.
   *    */
  async function followRename(from: string, to: string) {
    const a = clean(from);
    const b = clean(to);
    try { await moveHistory(a, b); } catch (e) { warn(`history: ${a} -> ${b}: ${msgOf(e)}`); }
    try { await onRename(a, b); } catch (e) { warn(`drafts: ${a} -> ${b}: ${msgOf(e)}`); }
  }

  // -------------------------------------------------------------- listings (vault.rs, hide.rs)
  const entryOf = (name: string, rel: string, kind: 'file' | 'dir', file: File | null): Entry => ({
    name, path: rel, kind,
    ext: kind === 'dir' ? '' : (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''),
    mtime: kind === 'dir' || !file ? 0 : Math.floor(file.lastModified), size: kind === 'dir' || !file ? 0 : file.size,
    hidden: isHiddenName(name),
  });

  /**
   * Every entry under `dir` the rule lets through, depth first. `visit` answers false to stop;
   * unreadable folders are noted in `unreadable`.
   */
  async function walkFrom(dir: FileSystemDirectoryHandle, rel: string, hidden: boolean, visit: (path: string, handle: FileSystemHandle) => unknown, depth: number, unreadable: Set<string> | null): Promise<boolean> {
    if (depth > MAX_DEPTH) return true;
    const ents: [string, FileSystemHandle][] = [];
    try { for await (const e of dir.entries()) ents.push(e); } catch { unreadable?.add(rel); return true; }
    for (const [name, h] of ents) {
      const p = rel ? `${rel}/${name}` : name;
      const c = classify(p);
      if (c === 'excluded' || (c === 'hidden' && !hidden)) continue;
      if ((await visit(p, h)) === false) return false;
      if (h.kind === 'directory') {
        if (!(await walkFrom((h as FileSystemDirectoryHandle), p, hidden, visit, depth + 1, unreadable))) return false;
      }
    }
    return true;
  }
  /** `walk(hidden, visit)`: the hide rule's walk of the vault; false when `visit` stopped it.
   *    */
  const walk = (hidden: boolean, visit: (path: string, handle: FileSystemHandle) => unknown) => walkFrom(root, '', !!hidden, visit, 0, null);

  async function tree(o: unknown) {
    const hidden = !!(isObj(o) && o.hidden);
    try { const it = root.entries(); await it.next(); if (typeof it.return === 'function') await it.return(undefined); } catch (e) {
      throw fail('io', `cannot read the vault root: ${msgOf(e)}`);
    }
    const byParent: Map<string, Entry[]> = new Map();
    const unreadable = new Set<string>();
    const files: { entry: Entry; handle: FileSystemFileHandle; parent: string; }[] = [];
    const dirs: Map<string, Entry> = new Map();
    await walkFrom(root, '', hidden, (p, h) => {
      const i = p.lastIndexOf('/');
      const parent = i < 0 ? '' : p.slice(0, i);
      const name = i < 0 ? p : p.slice(i + 1);
      if (h.kind === 'directory') {
        const e = entryOf(name, p, 'dir', null);
        dirs.set(p, e);
        const list = byParent.get(parent) || [];
        list.push(e);
        byParent.set(parent, list);
      } else files.push({ entry: entryOf(name, p, 'file', null), handle: (h as FileSystemFileHandle), parent });
    }, 0, unreadable);
    await pool(files, PARALLEL, async (f) => {
      let file;
      try { file = await f.handle.getFile(); } catch { return; }
      f.entry.mtime = Math.floor(file.lastModified);
      f.entry.size = file.size;
      const list = byParent.get(f.parent) || [];
      list.push(f.entry);
      byParent.set(f.parent, list);
    });
    const assemble = (rel: string): Entry[] => (byParent.get(rel) || []).map((e) => {
      if (e.kind === 'dir') {
        if (unreadable.has(e.path)) e.readable = false;
        e.children = assemble(e.path);
      }
      return e;
    }).sort(byEntry);
    return { name: root.name, path: '', kind: 'dir', ext: '', mtime: 0, size: 0, hidden: false, children: assemble('') };
  }

  async function list(p: string, o: unknown) {
    const hidden = !!(isObj(o) && o.hidden);
    if (isExcluded(String(p ?? ''))) throw fail('not_found', `not listed: ${p}`);
    const segs = segsOf(p);
    const rel = relOf(segs);
    const at = await lookup(segs);
    if (!at) throw fail('not_found', `${p}: no such folder`);
    if (at.kind !== 'dir') throw fail('not_found', `not a folder: ${p}`);
    const ents: [string, FileSystemHandle][] = [];
    try { for await (const e of at.handle.entries()) ents.push(e); } catch (e) { throw fromDom(e, p); }
    const out: Entry[] = [];
    await pool(ents, PARALLEL, async ([name, h]) => {
      const cp = rel ? `${rel}/${name}` : name;
      const c = classify(cp);
      if (c === 'excluded' || (c === 'hidden' && !hidden)) return;
      if (h.kind === 'directory') {
        const e = entryOf(name, cp, 'dir', null);
        try {
          const it = (h as FileSystemDirectoryHandle).entries();
          await it.next();
          if (typeof it.return === 'function') await it.return(undefined);
        } catch { e.readable = false; }
        out.push(e);
        return;
      }
      let file;
      try { file = await (h as FileSystemFileHandle).getFile(); } catch { return; }
      out.push(entryOf(name, cp, 'file', file));
    });
    return out.sort(byEntry);
  }

  async function stat(p: string, o: unknown) {
    const place = await target(p);
    const missing = { exists: false, kind: null, mtime: 0, size: 0, hidden: false };
    let at: { kind: 'file' | 'dir'; handle: FileSystemHandle; } | null;
    if (place.outside) at = { kind: 'file', handle: (place.handle as FileSystemFileHandle) };
    else at = await lookup(place.segs);
    if (!at) return missing;
    let file: File | null = null;
    if (at.kind === 'file') {
      try { file = await (at.handle as FileSystemFileHandle).getFile(); } catch (e) { if (isGone(e)) return missing; throw e; }
    }
    const name = place.outside ? (place.rel.split('/').pop() || '') : (place.segs[place.segs.length - 1] || '');
    const hidden = place.outside ? isHiddenName(name) : place.segs.length > 0 && classify(place.rel) !== 'shown';
    const out: { exists: boolean; kind: string; mtime: number; size: number; hidden: boolean; text?: boolean; encoding?: string; } = { exists: true, kind: at.kind, mtime: file ? Math.floor(file.lastModified) : 0, size: file ? file.size : 0, hidden };
    if (isObj(o) && o.sniff && file) {
      try {
        const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
        if (sniffText(head)) { out.text = true; out.encoding = 'UTF-8'; }
        else {
          const e = sniffEncoding(head);
          out.text = !!e;
          if (e) out.encoding = e;
        }
      } catch { out.text = false; }
    }
    return out;
  }

  // -------------------------------------------------------------- search (bridge-plugin.mjs)
  const searchGen: Map<unknown, number> = new Map();
  /** `a "b c" path:x file:y` -> {terms, paths, files}, lowercased. */
  const parseQuery = (q: unknown) => {
    const out: { terms: string[]; paths: string[]; files: string[]; } = { terms: [], paths: [], files: [] };
    const s = String(q || '');
    let i = 0;
    while (i < s.length) {
      if (/\s/.test(s[i] || '')) { i++; continue; }
      let kind = 0;
      for (const [word, k] of ([['path:', 1], ['file:', 2]] as [string, number][])) {
        if (s.slice(i, i + word.length).toLowerCase() === word) { kind = k; i += word.length; break; }
      }
      let word = '';
      if (s[i] === '"') {
        i++;
        while (i < s.length && s[i] !== '"') word += s[i++];
        i++;
      } else {
        while (i < s.length && !/\s/.test(s[i] || '')) word += s[i++];
      }
      word = word.trim().toLowerCase();
      if (!word) continue;
      if (kind === 1) out.paths.push(word.replace(/\\/g, '/'));
      else if (kind === 2) out.files.push(word);
      else out.terms.push(word);
    }
    return out;
  };
  const searchAllowed = (q: { paths: string[]; files: string[]; }, rel: string, name: string) => {
    const r = rel.toLowerCase();
    return (!q.paths.length || q.paths.some((p) => r.startsWith(p.replace(/\/+$/, ''))))
      && (!q.files.length || q.files.some((f) => name.includes(f)));
  };
  async function search(q: unknown, o: unknown) {
    const { limit = 100, chan = null, hidden = false } = isObj(o) ? o : {};
    const query = parseQuery(q);
    if (!query.terms.length && !query.paths.length && !query.files.length) {
      return { hits: [], files: 0, total: 0, capped: false, stale: false };
    }
    let gen = 0;
    if (chan) { gen = (searchGen.get(chan) || 0) + 1; searchGen.set(chan, gen); }
    const current = () => !chan || searchGen.get(chan) === gen;
    const found: { path: string; kind: string; nameHit: boolean; total: number; lines: Hit[]; }[] = [];
    const finished = await walk(!!hidden, async (p, h) => {
      if (!current()) return false;
      if (isInBin(p)) return true;
      const name = (p.split('/').pop() || '').toLowerCase();
      const ok = searchAllowed(query, p, name);
      const nameHit = !!query.terms.length && query.terms.every((t) => name.includes(t));
      if (h.kind === 'directory') {
        if (ok && nameHit) found.push({ path: p, kind: 'dir', nameHit: true, total: 0, lines: [] });
        return true;
      }
      if (!ok) return true;
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot + 1) : '';
      if (!SEARCH_EXTS.has(ext)) {
        if (nameHit) found.push({ path: p, kind: 'file', nameHit: true, total: 0, lines: [] });
        return true;
      }
      let text;
      try { text = utf8Lenient.decode(await bytesOf((h as FileSystemFileHandle))); } catch { return true; }
      if (!current()) return false;
      const lower = text.toLowerCase();
      const relLower = p.toLowerCase();
      if (!query.terms.every((t) => lower.includes(t) || relLower.includes(t))) {
        if (nameHit) found.push({ path: p, kind: 'file', nameHit: true, total: 0, lines: [] });
        return true;
      }
      const lines: Hit[] = [];
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
        lines.push({ path: p, line: i + 1, col: before.length - lead + 1, text: line.trim().slice(0, 240), kind: 'file' });
      });
      if (lines.length || nameHit) found.push({ path: p, kind: 'file', nameHit, total, lines });
      return true;
    });
    const stale = !finished;
    found.sort((a, b) => (Number(b.nameHit) - Number(a.nameHit)) || (b.total - a.total) || naturalCompare(a.path, b.path));
    const total = found.length;
    const cap = limit === 0 ? Infinity : Number(limit) || 100;
    const capped = total > cap;
    const kept = capped ? found.slice(0, cap) : found;
    const hits: Hit[] = [];
    for (const f of kept) {
      if (f.nameHit) hits.push({ path: f.path, line: 0, col: 0, text: f.path, kind: f.kind });
      hits.push(...f.lines);
    }
    return { hits, files: kept.length, total, capped, stale };
  }

  // -------------------------------------------------------------- trash (trashbin.rs, vault bin)
  const validEntry = (entry: string) => !!entry && entry !== INFO && entry !== '.' && entry !== '..' && !/[\\/]/.test(entry) && !isExcluded(entry);
  const unstamped = (entry: string): [string, number | null] => { const m = /^(\d+)-(.+)$/.exec(entry); return m ? [m[2] || entry, Number(m[1])] : [entry, null]; };
  async function sizeOf(h: FileSystemHandle, depth = 0): Promise<number> {
    if (h.kind === 'file') { try { return (await (h as FileSystemFileHandle).getFile()).size; } catch { return 0; } }
    if (depth > MAX_DEPTH) return 0;
    let n = 0;
    try { for await (const [, c] of (h as FileSystemDirectoryHandle).entries()) n += await sizeOf(c, depth + 1); } catch { /* unreadable */ }
    return n;
  }
  async function readInfo(entry: string) {
    const h = await fileOrNull([BIN, INFO, `${entry}.json`]);
    if (!h) return null;
    try { const o = JSON.parse(utf8Lenient.decode(await bytesOf(h))); return isObj(o) ? o : null; } catch { return null; }
  }

  async function trash(p: string,o: unknown) {
    checkEpoch(o);
    const segs = segsOf(p);
    if (!segs.length) throw fail('bad_arg', 'refusing to trash the vault root');
    return withTrees([relOf(segs)], () => trashLocked(p, segs));
  }
  async function trashLocked(p: string, segs: string[]) {
    const at0 = await lookup(segs);
    if (!at0 || !at0.parent) throw fail('not_found', `nothing to trash: ${p}`);
    await requireVault();
    const bin = await dirAt([BIN], true);
    await bin.getDirectoryHandle(INFO, { create: true });
    const at = now();
    const base = at0.name;
    let entry = `${at}-${base}`;
    for (let n = 2; await lookup([BIN, entry]); n++) entry = `${at}-${n}-${base}`;
    try { await moveEntry(at0.handle, at0.parent, at0.name, bin, entry, `${BIN}/${entry}`); } catch (e) {
      const he = fromDom(e, p);
      throw he.code === 'no_vault' ? he : fail('io', `${p}: .trash: ${msgOf(e)}`);
    }
    try {
      const info = JSON.stringify({ v: 1, original: relOf(segs), deletedAt: at, kind: at0.kind });
      await writeAtomic({ rel: `${BIN}/${INFO}/${entry}.json`, outside: false, segs: [BIN, INFO, `${entry}.json`], handle: null }, enc.encode(info), { aside: 'discard' });
    } catch (e) { warn(`trash: sidecar of ${entry}: ${msgOf(e)}`); }
    return { id: `vault:${entry}`, where: 'vault' };
  }

  async function trashList() {
    const out: { id: string; name: string; original: string; known?: boolean; deletedAt: number; kind: string; size: number; where: string; }[] = [];
    const bin = await dirOrNull([BIN]);
    if (!bin) return out;
    const ents: [string, FileSystemHandle][] = [];
    try { for await (const e of bin.entries()) ents.push(e); } catch { return out; }
    for (const [entry, h] of ents) {
      if (!validEntry(entry)) continue;
      const info = await readInfo(entry);
      const [bare, stamp] = unstamped(entry);
      const known = !!info && typeof info.original === 'string';
      const original = known && info ? String(info.original) : bare;
      let mtime = 0;
      if (h.kind === 'file') { try { mtime = (await (h as FileSystemFileHandle).getFile()).lastModified; } catch { /* gone */ } }
      out.push({
        id: `vault:${entry}`, name: original.split('/').pop() || original, original,
        ...(known ? {} : { known: false }),
        deletedAt: info && typeof info.deletedAt === 'number' ? info.deletedAt : (stamp ?? Math.floor(mtime)),
        kind: h.kind === 'directory' ? 'dir' : 'file', size: await sizeOf(h), where: 'vault',
      });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async function trashRestore(ids: unknown,o: unknown) {
    checkEpoch(o);
    await requireVault();
    const restored: { id: unknown; path: string; }[] = [];
    const failed: { id: unknown; error: string; }[] = [];
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      try {
        const entry = typeof id === 'string' && id.startsWith('vault:') ? id.slice(6) : null;
        if (!entry || !validEntry(entry)) throw fail('bad_arg', `not a trash id: ${String(id)}`);
        const src = await lookup([BIN, entry]);
        if (!src || !src.parent) throw fail('not_found', `no longer in .trash: ${entry}`);
        let original = unstamped(entry)[0];
        const info = await readInfo(entry);
        if (info && typeof info.original === 'string') original = info.original;
        const dst = segsOf(original);
        if (!dst.length) throw fail('bad_arg', `not a place to restore to: ${original}`);
        await withTrees([relOf(dst), `${BIN}/${entry}`], async () => {
          if (await lookup(dst)) throw fail('exists', `A file with that name is already there: ${original}`);
          const parent = await dirAt(dst.slice(0, -1), true);
          await moveEntry(src.handle, (src.parent as FileSystemDirectoryHandle), entry, parent, (dst[dst.length - 1] as string), relOf(dst));
        });
        try { const infoDir = await dirAt([BIN, INFO]); await infoDir.removeEntry(`${entry}.json`); } catch { /* none */ }
        restored.push({ id, path: relOf(dst) });
      } catch (e) {
        const he = fromDom(e);
        failed.push({ id, error: `[${he.code}] ${he.message}` });
      }
    }
    return { restored, failed };
  }

  // -------------------------------------------------------------- appends
  /**
   * An append as a guarded replace (files.rs `append_line` opens with O_APPEND; the browser has
   * no append, and `createWritable({keepExistingData})` copies the file as it is then and puts
   * the copy back on `close()`, over whatever another program wrote meanwhile). So: read the
   * file, write `before + add` whole, and in the last look before `close()` abort unless the
   * file still holds `before` (or already the new bytes). A file that moved on is read again and
   * the append made over the new bytes, a few times, and then `write_failed`: never a close over
   * a change. Answers the bytes written.
   *  @param build the bytes to add
   */
  async function appendGuarded(segs: string[], build: (before: Uint8Array) => Uint8Array) {
    const place = { rel: relOf(segs), outside: false, segs, handle: null };
    return withLock(place.rel, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const disk = await readPlace(place);
        const before = disk || new Uint8Array(0);
        const next = concat(before, build(before));
        let moved = false;
        const lastLook = async (created: boolean) => {
          let cur = await readPlace(place);
          if (created && cur && cur.length === 0) cur = null;
          if (cur === null ? before.length === 0 : sameBytes(cur, before) || sameBytes(cur, next)) return;
          moved = true;
          throw new Error('changed on disk while appending');
        };
        try {
          await writeAtomic(place, next, { lastLook });
          return next;
        } catch (e) {
          if (!moved) throw e;
          warn(`append: ${place.rel} changed on disk while appending; again over the new bytes`);
        }
      }
      throw fail('write_failed', `${place.rel}: the file kept changing on disk; nothing was added`);
    });
  }

  // -------------------------------------------------------------- the commands
  /** `{status:'conflict', disk}`: what the disk holds instead of what the page expected. */
  const conflictOf = (disk: Uint8Array | null) => ({ status: 'conflict', disk: { exists: !!disk, text: disk ? utf8OrNull(disk) : null, hash: disk ? hash(disk) : null } });
  const mtimeOf = async (place: Place) => {
    try { const h = await placeHandle(place); return h ? Math.floor((await h.getFile()).lastModified) : 0; } catch { return 0; }
  };

  /**
   * The rename itself, under the trees of both paths; answers whether anything moved.
   */
  async function renameLocked(a: string, b: string, src: string[], dst: string[]) {
    const from = await lookup(src);
    if (!from || !from.parent) throw fail(src.length ? 'not_found' : 'bad_arg', src.length ? `nothing to rename: ${a}` : 'the vault root cannot be renamed');
    if (!dst.length) throw fail('bad_name', `not a name to rename to: ${b}`);
    const ra = relOf(src);
    const rb = relOf(dst);
    if (ra === rb) return false;
    if (from.kind === 'dir' && fold(rb).startsWith(`${fold(ra)}/`)) throw fail('bad_arg', `a folder cannot move into itself: ${a} -> ${b}`);
    const dstName = (dst[dst.length - 1] as string);
    const there = await lookup(dst);
    if (there && ra.toLowerCase() === rb.toLowerCase() && (await there.handle.isSameEntry(from.handle))) {
      // A case-only rename on a disk that folds case: through `.<name>.<n>.case`.
      const via = `.${dstName}.${Date.now() % 1_000_000}.case`;
      await moveEntry(from.handle, from.parent, from.name, from.parent, via, ra);
      const moved = from.kind === 'dir' ? await from.parent.getDirectoryHandle(via) : await from.parent.getFileHandle(via);
      try { await moveEntry(moved, from.parent, via, from.parent, dstName, rb); } catch (e) {
        try { await moveEntry(moved, from.parent, via, from.parent, from.name, ra); } catch { /* left under the temporary name */ }
        throw fail('io', `${a} -> ${b}: ${msgOf(e)}`);
      }
    } else {
      if (there) throw fail('exists', `target already exists: ${b}`);
      const parent = await dirAt(dst.slice(0, -1), true);
      try { await moveEntry(from.handle, from.parent, from.name, parent, dstName, rb); } catch (e) {
        const he = fromDom(e, `${a} -> ${b}`);
        throw he.code === 'exists' || he.code === 'no_vault' ? he : fail('io', `${a} -> ${b}: ${msgOf(e)}`);
      }
    }
    return true;
  }

  const commands = {
    tree,
    list,
    stat,
    exists: async (p: string) => {
      const place = await target(p);
      if (place.outside) { try { await (place.handle as FileSystemFileHandle).getFile(); return true; } catch (e) { if (isGone(e)) return false; throw e; } }
      return !!(await lookup(place.segs));
    },
    search,

    readText: async (p: string) => {
      const bytes = await readPlace(await target(p));
      if (!bytes) throw fail('not_found', `${p}: no such file`);
      const text = utf8OrNull(bytes);
      if (text === null) throw fail('not_utf8', `not valid UTF-8: ${p}`);
      return text;
    },
    readFile: async (p: string,o: unknown) => {
      const place = await target(p);
      const h = await placeHandle(place);
      if (!h) throw fail('not_found', `${p}: no such file`);
      const file = await h.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      const forced = isObj(o) && typeof o.encoding === 'string' && o.encoding ? o.encoding : null;
      let d;
      try { d = decodeText(buf, forced); } catch (e) { throw e instanceof HostError ? fail(e.code, `${e.message}: ${p}`) : e; }
      return { text: d.text, hash: hash(buf), mtime: Math.floor(file.lastModified), size: buf.length, encoding: d.encoding, bom: d.bom, lossy: d.lossy };
    },

    saveFile: async (p: string,text: unknown,o: unknown) => {
      checkEpoch(o);
      const rel0 = typeof p === 'string' ? clean(p) : String(p);
      try {
        if (typeof text !== 'string') throw fail('bad_arg', 'argument 1 must be the text');
        if (!isObj(o)) throw fail('bad_arg', 'saveFile needs {expectedHash}');
        const expected = o.expectedHash;
        if (!(expected === null || typeof expected === 'string')) throw fail('bad_arg', 'expectedHash must be a hash or null');
        const place = await target(p);
        const mode = place.outside ? 'none' : (o.version ?? 'save');
        if (!['save', 'conflict', 'none'].includes(mode)) throw fail('bad_arg', `not a version mode: ${mode}`);
        const encoding = o.encoding === undefined || o.encoding === null ? 'UTF-8' : encodingOf(o.encoding);
        if (!place.outside && !place.segs.length) throw fail('bad_arg', 'no file name to write');
        if (!place.outside) await requireVault();
        const bytes = encodeText(text, encoding);
        const r = await withLock(lockKey(place), async () => {
          const disk = await readPlace(place);
          if (disk && encoding !== 'UTF-8' && decodeText(disk, encoding).lossy) {
            throw fail('lossy', `${place.rel} cannot be read back exactly as ${encoding}; it is not saved`);
          }
          if (disk && sameBytes(disk, bytes)) return { status: 'saved', hash: hash(bytes), mtime: await mtimeOf(place), unchanged: true };
          const matches = expected === null ? !disk : !!disk && hash(disk) === expected;
          if (!matches) return conflictOf(disk);
          let moved: { now: Uint8Array | null; } | undefined;
          const lastLook = async (created: boolean) => {
            let cur = await readPlace(place);
            if (created && cur && cur.length === 0) cur = null;
            if (cur === null ? disk === null : (disk !== null && sameBytes(cur, disk)) || sameBytes(cur, bytes)) return;
            moved = { now: cur };
            throw new Error('changed on disk while saving');
          };
          try {
            await writeAtomic(place, bytes, { lastLook });
          } catch (e) {
            if (moved) return conflictOf(moved.now);
            throw e;
          }
          const saved = { status: 'saved', hash: hash(bytes), mtime: await mtimeOf(place) };
          if (disk && mode !== 'none') {
            try { await keepVersion(place.rel, disk, { force: mode === 'conflict', reason: mode === 'conflict' ? 'conflict' : 'save', settle: false }); }
            catch (e) { warn(`version of ${place.rel} not kept: ${msgOf(e)}`); }
          }
          return saved;
        });
        if (!place.outside) await pruneVaultIfOver(now());
        if (r.status === 'saved') log('info', `save ok ${place.rel}${'unchanged' in r && r.unchanged ? ' (unchanged)' : ''}`);
        else log('warn', `save conflict ${place.rel}`);
        return r;
      } catch (e) {
        const he = fromDom(e, rel0);
        log('error', `save failed ${rel0}: [${he.code}] ${he.message}`);
        throw he;
      }
    },

    createNew: async (p: string,text: unknown = '',o: unknown = undefined) => {
      if (isObj(text)) { o = text; text = ''; }
      checkEpoch(o);
      checkName(p);
      const segs = segsOf(p);
      await requireVault();
      const bytes = enc.encode(String(text ?? ''));
      await withLock(relOf(segs), () => createExclusive(segs, bytes));
      return { path: relOf(segs), hash: hash(bytes) };
    },
    createNewBinary: async (p: string,data: unknown,o: unknown) => {
      checkEpoch(o);
      if (typeof data !== 'string') throw fail('bad_arg', 'argument 1 must be the bytes, in base64');
      checkName(p);
      const segs = segsOf(p);
      await requireVault();
      const bytes = fromBase64(data);
      await withLock(relOf(segs), () => createExclusive(segs, bytes));
      return { path: relOf(segs), hash: hash(bytes) };
    },
    copyFile: async (from: string,to: string,o: unknown) => {
      checkEpoch(o);
      checkName(to);
      const src = segsOf(from);
      const dst = segsOf(to);
      await requireVault();
      const at = await lookup(src);
      if (!at) throw fail('not_found', `${from}: no such file`);
      if (at.kind !== 'file') throw fail('bad_arg', `not a file: ${from}`);
      const bytes = await bytesOf(at.handle);
      await withLock(relOf(dst), () => createExclusive(dst, bytes));
      return { path: relOf(dst), hash: hash(bytes) };
    },
    importOutside: async (from: unknown,to: string,o: unknown) => {
      checkEpoch(o);
      if (typeof from !== 'string' || !from.startsWith(ABS)) throw fail('bad_arg', `not a file outside the vault: ${String(from)}`);
      const place = await target(from);
      checkName(to);
      const dst = segsOf(to);
      await requireVault();
      const bytes = await readPlace(place);
      if (!bytes) throw fail('not_found', `${from}: no such file`);
      await withLock(relOf(dst), () => createExclusive(dst, bytes));
      return { path: relOf(dst), hash: hash(bytes) };
    },

    appendLine: async (p: string,line: unknown,o: unknown) => {
      checkEpoch(o);
      const l = String(line ?? '');
      if (/[\r\n]/.test(l)) throw fail('bad_arg', 'a line cannot hold a line break');
      const segs = segsOf(p);
      if (!segs.length) throw fail('bad_arg', 'no file name to write');
      await requireVault();
      const next = await appendGuarded(segs, (before) => {
        if (before.length && utf8OrNull(before) === null) throw fail('not_utf8', `not valid UTF-8: ${p}; the line is not added`);
        const eol = eolOf(before);
        const sep = before.length && before[before.length - 1] !== 0x0a ? eol : '';
        return enc.encode(sep + l + eol);
      });
      return { hash: hash(next) };
    },
    replaceLine: async (p: string,index: unknown,expected: unknown,next: unknown,o: unknown) => {
      checkEpoch(o);
      if (!Number.isInteger(index)) throw fail('bad_arg', 'argument 1 must be a line index');
      if (typeof expected !== 'string' || typeof next !== 'string') throw fail('bad_arg', 'expected and next must be strings');
      if (/[\r\n]/.test(next)) throw fail('bad_arg', 'a line cannot hold a line break');
      const idx = (index as number);
      const segs = segsOf(p);
      const place = { rel: relOf(segs), outside: false, segs, handle: null };
      await requireVault();
      const r = await withLock(place.rel, async () => {
        const buf = await readPlace(place);
        if (!buf) throw fail('not_found', `${p}: no such file`);
        const text = utf8OrNull(buf);
        if (text === null) throw fail('not_utf8', `not valid UTF-8: ${p}`);
        const found = idx >= 0 ? lineSpans(text)[idx] : undefined;
        if (!found) return { status: 'conflict', actual: null };
        const span: [number, number] = idx === 0 && text.startsWith('﻿') ? [found[0] + 1, found[1]] : found;
        const actual = text.slice(span[0], span[1]);
        if (actual !== expected) return { status: 'conflict', actual };
        if (expected === next) return { status: 'replaced', hash: hash(buf) };
        const out = enc.encode(text.slice(0, span[0]) + next + text.slice(span[1]));
        let moved: { actual: string | null; } | undefined;
        const lastLook = async () => {
          const cur = await readPlace(place);
          if (cur !== null && (sameBytes(cur, buf) || sameBytes(cur, out))) return;
          const t = cur === null ? null : utf8OrNull(cur);
          const s = t === null ? undefined : lineSpans(t)[idx];
          moved = { actual: s && t !== null ? t.slice(s[0], s[1]) : null };
          throw new Error('changed on disk while saving');
        };
        try {
          await writeAtomic(place, out, { lastLook });
        } catch (e) {
          if (moved) return { status: 'conflict', actual: moved.actual };
          throw e;
        }
        try { await keepVersion(place.rel, buf, { settle: false }); } catch (e) { warn(`version of ${p} not kept: ${msgOf(e)}`); }
        return { status: 'replaced', hash: hash(out) };
      });
      await pruneVaultIfOver(now());
      return r;
    },

    writeText: async (p: string,text: unknown,o: unknown) => {
      checkEpoch(o);
      await writeBytes(p, enc.encode(String(text ?? '')));
      return null;
    },
    appendText: async (p: string,text: unknown,o: unknown) => {
      checkEpoch(o);
      const segs = segsOf(p);
      if (!segs.length) throw fail('bad_arg', 'no file name to write');
      await requireVault();
      const add = enc.encode(String(text ?? ''));
      await appendGuarded(segs, () => add);
      return null;
    },
    writeBinary: async (p: string,b64: unknown,o: unknown) => {
      checkEpoch(o);
      await writeBytes(p, fromBase64(String(b64 ?? '')));
      return null;
    },
    readBinary: async (p: string) => {
      const bytes = await readPlace(await target(p));
      if (!bytes) throw fail('not_found', `${p}: no such file`);
      return toBase64(bytes);
    },
    mkdir: async (p: string,o: unknown) => {
      checkEpoch(o);
      const segs = segsOf(p);
      await requireVault();
      await dirAt(segs, true);
      return null;
    },

    rename: async (a: string,b: string,o: unknown) => {
      checkEpoch(o);
      const src = segsOf(a);
      const dst = segsOf(b);
      await requireVault();
      if (src.length && dst.length && relOf(src) !== relOf(dst)) {
        const moved = await withTrees([relOf(src), relOf(dst)], () => renameLocked(a, b, src, dst));
        if (moved) await followRename(relOf(src), relOf(dst));
        return null;
      }
      await renameLocked(a, b, src, dst);
      return null;
    },

    copyPath: async (from: string,to: string,o: unknown) => {
      checkEpoch(o);
      const src = segsOf(from);
      const dst = segsOf(to);
      await requireVault();
      if (!dst.length) throw fail('bad_name', `not a name to copy to: ${to}`);
      const at = await lookup(src);
      if (!at) throw fail('not_found', `${from}: no such file or folder`);
      if (await lookup(dst)) throw fail('exists', `already exists: ${to}`);
      const rs = fold(relOf(src));
      const rd = fold(relOf(dst));
      if (at.kind === 'dir' && (!src.length || rd === rs || rd.startsWith(`${rs}/`))) throw fail('bad_arg', `a folder cannot be copied into itself: ${from} -> ${to}`);
      const parent = await dirAt(dst.slice(0, -1), true);
      const name = (dst[dst.length - 1] as string);
      const count = { n: 0 };
      try {
        if (at.kind === 'dir') {
          const d = await parent.getDirectoryHandle(name, { create: true });
          try { await copyTree(at.handle, d, count, relOf(dst)); } catch (e) {
            try { await parent.removeEntry(name, { recursive: true }); } catch { /* gone */ }
            throw e;
          }
        } else {
          await createIn(parent, name, await bytesOf(at.handle), relOf(dst));
          count.n = 1;
        }
      } catch (e) {
        const he = fromDom(e, to);
        if (he.code === 'exists') throw fail('exists', `already exists: ${to}`);
        throw he;
      }
      return { path: relOf(dst), files: count.n };
    },

    trash,
    trashWhere: async (p: string) => { segsOf(p); return { where: 'vault' }; },
    trashList,
    trashRestore,

    versionKeep: async (p: string,text: unknown,o: unknown = false) => {
      refuseOutside(p, 'a version');
      checkEpoch(o);
      let force = false;
      let reason = 'save';
      if (typeof o === 'boolean') force = o;
      else if (isObj(o)) {
        force = !!o.force;
        if (o.reason !== undefined) {
          if (!REASONS.has(o.reason)) throw fail('bad_arg', `not a version reason: ${o.reason}`);
          reason = o.reason;
        }
      }
      return keepVersion(p, enc.encode(String(text ?? '')), { force, reason });
    },
    versionList: async (p: string) => {
      refuseOutside(p, 'a version');
      await migrate();
      return (await versionsOf(p)).map(({ id, at, bytes, reason, session: s }) => ({ id, at, bytes, reason, session: s }));
    },
    versionRead: async (p: string,id: unknown) => {
      refuseOutside(p, 'a version');
      await migrate();
      const e = await findVersion(p, id);
      const text = utf8OrNull(await bytesOf(await e.dir.getFileHandle(e.name)));
      if (text === null) throw fail('not_utf8', `not valid UTF-8: version ${String(id)} of ${p}`);
      return text;
    },
    versionRestore: async (p: string,id: unknown,o: unknown) => {
      refuseOutside(p, 'a version');
      checkEpoch(o);
      await migrate();
      const e = await findVersion(p, id);
      const bytes = await bytesOf(await e.dir.getFileHandle(e.name));
      const segs = segsOf(p);
      const place = { rel: relOf(segs), outside: false, segs, handle: null };
      await requireVault();
      const kept = await withLock(place.rel, async () => {
        const current = (await readPlace(place)) || new Uint8Array(0);
        const k = !current.length || sameBytes(current, bytes)
          ? { kept: false, id: null }
          : await keepVersion(place.rel, current, { force: true, reason: 'restore', settle: false });
        await writeAtomic(place, bytes);
        return k;
      });
      await pruneVaultIfOver(now());
      return { ...kept, hash: hash(bytes) };
    },

    getState: async () => {
      try {
        const h = await fileOrNull(['.ose', 'state.json']);
        if (!h) return {};
        const o = JSON.parse(utf8Lenient.decode(await bytesOf(h)));
        return o ?? {};
      } catch { return {}; }
    },
    setState: async (state: unknown,o: unknown) => {
      checkEpoch(o);
      await requireVault();
      const segs = ['.ose', 'state.json'];
      await writeAtomic({ rel: '.ose/state.json', outside: false, segs, handle: null }, enc.encode(JSON.stringify(state ?? {}, null, 2)), { aside: 'discard' });
      return null;
    },
  };

  /** Every command's DOMException as the host's HostError, naming the path. */
  const wrapped: Record<string, (...args: any[]) => Promise<any>> = {};
  for (const [name, fn] of Object.entries(commands)) {
    const f = (fn as (...args: any[]) => Promise<any>);
    wrapped[name] = async (...args) => {
      try { return await f(...args); } catch (e) { throw fromDom(e, typeof args[0] === 'string' ? args[0] : ''); }
    };
  }

  const guard = (fn: (...args: any[]) => Promise<any>) => async (...args: any[]) => {
    try { return await fn(...args); } catch (e) { throw fromDom(e, typeof args[0] === 'string' ? args[0] : ''); }
  };

  return {
    ...wrapped,
    /** The names of the commands this module answers (the adapter's table). */
    commands: Object.keys(commands),
    readBytes: guard(readBytes),
    writeBytes: guard(writeBytes),
    hash,
    walk,
    followRename,
    keepVersion: guard(keepVersion),
    requireVault: guard(requireVault),
    fileHandle: guard(async (p, o = {}) => {
      const segs = segsOf(p);
      if (!segs.length) throw fail('bad_arg', 'the vault root is not a file');
      const parent = await dirAt(segs.slice(0, -1), !!o.create);
      return parent.getFileHandle((segs[segs.length - 1] as string), { create: !!o.create });
    }),
    dirHandle: guard(async (p, o = {}) => dirAt(segsOf(p), !!o.create)),
    checkEpoch,
  };
}
