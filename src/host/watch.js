// Module watch (docs/HOST.md "The watcher"): what changes on disk under the vault, and in the
// files from outside it the tab has open, becomes the `fs` event, in the shape
// src-tauri/src/watcher.rs sends: `{ changes: [{ path, kind, to?, dir?, hidden? }], rescan?, lost? }`.
//
// Two ways to hear about changes. `FileSystemObserver` (Chrome) observes the root recursively
// and its records gather in a batch for 150 ms of quiet, then go out as one event, each path's
// records merged and its kind decided at flush from whether the path still exists, as
// watcher.rs does. Where there is no observer, or `observe()` throws, a poll walks the vault
// under the hide rule every 2 s (10 s while the document is hidden, and at once when it is shown
// again), compares `{kind, size, lastModified}` and pairs a delete and a create into a rename.
//
// Excluded paths (rules.js `isExcluded`: `.ose`, `.git`, `.trash/.info`, the temp files and
// Chrome's `.crswap`) are never reported. A move into or out of `.trash` is a delete and a
// create, never a rename. A rename seen on disk is followed (`fs.followRename`: the history and
// the drafts) when `from` is gone and `to` is there. The root going away, or its permission
// being withdrawn, is `lost: true` once, and `lost: false` then `rescan: true` when it is back.

import { isExcluded, isInBin, isPathHidden, segmentsOf } from './rules.js';

/** Quiet time before a batch goes out (watcher.rs DEBOUNCE). */
const DEBOUNCE = 150;
/** A batch that keeps being fed still goes out after this long. */
const MAX_WAIT = 1000;
/** A flood (a checkout, a sync) is flushed rather than accumulated (watcher.rs MAX_PENDING). */
const MAX_PENDING = 2000;
/** As deep as the tree goes. */
const MAX_DEPTH = 24;
/** Files read at once by the poll. */
const PARALLEL = 16;

/**
 * @typedef {{ path: string, kind: 'create' | 'modify' | 'delete' | 'rename', to?: string,
 *   dir?: true, hidden?: true }} FsChange
 * @typedef {{ changes: FsChange[], rescan?: true, lost?: boolean }} FsEvent
 * @typedef {'create' | 'modify' | 'delete' | 'ambiguous' | 'check'} Raw
 * @typedef {{ path: string, to?: string, outside?: boolean, kinds: Raw[] }} Item
 * @typedef {{ kind: 'file' | 'directory', size: number, mtime: number }} Seen
 * @typedef {{ followRename?: (from: string, to: string) => unknown }} WatchFs
 * @typedef {{ list(): Promise<{ path: string, handle: FileSystemFileHandle }[]> }} OutsideList
 * @typedef {{ outside?: OutsideList, interval?: number, hiddenInterval?: number,
 *   liveness?: number, observer?: any, document?: any }} WatchOpts
 * @typedef {(() => void) & { ready: Promise<'observer' | 'poll'>, mode: () => 'observer' | 'poll' | null,
 *   refresh: () => Promise<void> }} Stop
 */

/** @param {string[] | null | undefined} parts */
const joinRel = (parts) => segmentsOf((parts || []).join('/')).join('/');
/** @param {string} p */
const parentOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
/** @param {string} p */
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
/** @param {string} p @param {string} dir */
const under = (p, dir) => p.startsWith(`${dir}/`);

/**
 * One change as it goes out: `dir` when the path (the new one, for a rename) is a folder that is
 * there, `hidden` when it is a dot path.
 * @param {string} path @param {FsChange['kind']} kind @param {string | undefined} to
 * @param {'file' | 'directory' | null} there
 * @returns {FsChange}
 */
function change(path, kind, to, there) {
  /** @type {FsChange} */
  const c = { path, kind };
  if (to !== undefined) c.to = to;
  if (there === 'directory') c.dir = true;
  if (isPathHidden(to ?? path)) c.hidden = true;
  return c;
}

/**
 * The kind a path's gathered records come to, given what is there now (watcher.rs `changes_of`
 * with the debouncer's merging): created then deleted is nothing, created then changed is a
 * create, a file removed and made again (or renamed onto) is a modify, anything else that is
 * back is a create.
 * @param {Raw[]} kinds @param {'file' | 'directory' | null} there
 * @returns {FsChange['kind'] | null}
 */
export function resolveKind(kinds, there) {
  const first = kinds[0];
  if (!there) return first === 'create' ? null : 'delete';
  if (first === 'create') return 'create';
  if (first === 'modify') return 'modify';
  // Removed, then made again or written over by a temp file's rename: the file changing.
  return there === 'file' && kinds.length > 1 && (kinds.includes('create') || kinds.includes('modify')) ? 'modify' : 'create';
}

/** What gathers between two flushes. */
class Batch {
  constructor() {
    /** @type {Map<string, Item>} */
    this.items = new Map();
    this.rescan = false;
    this.since = 0;
  }
  get size() { return this.items.size; }
  /** @param {Raw} kind @param {string} path */
  add(kind, path) {
    if (!path || isExcluded(path)) return;
    this.push(`p\0${path}`, { path, kinds: [] }, kind);
  }
  /** @param {Raw} kind @param {string} path */
  addOutside(kind, path) { this.push(`o\0${path}`, { path, outside: true, kinds: [] }, kind); }
  /** A move seen whole, sorted out as watcher.rs `Batch::rename` does. @param {string} from @param {string} to */
  rename(from, to) {
    const exFrom = !from || isExcluded(from);
    const exTo = !to || isExcluded(to);
    if (exFrom && exTo) return;
    // A temp file renamed onto the page is the page changing (an atomic save).
    if (exFrom) return this.add('modify', to);
    // Moved into an excluded place: gone, as far as the vault is concerned.
    if (exTo) return this.add('ambiguous', from);
    // Into the bin or out of it: the file left the vault or came back.
    if (isInBin(from) !== isInBin(to)) { this.add('ambiguous', from); this.add('ambiguous', to); return; }
    const key = `r\0${from}\0${to}`;
    if (!this.items.has(key)) this.items.set(key, { path: from, to, kinds: [] });
    this.touch();
  }
  /** @param {string} key @param {Item} fresh @param {Raw} kind */
  push(key, fresh, kind) {
    let it = this.items.get(key);
    if (!it) { it = fresh; this.items.set(key, it); }
    if (it.kinds[it.kinds.length - 1] !== kind) it.kinds.push(kind);
    this.touch();
  }
  touch() { if (!this.since) this.since = Date.now(); }
  take() {
    const out = { items: [...this.items.values()], rescan: this.rescan };
    this.items = new Map();
    this.rescan = false;
    this.since = 0;
    return out;
  }
  clear() { this.take(); }
}

/**
 * What is at a vault path now: a lookup from the root, never a walk.
 * @param {FileSystemDirectoryHandle} root @param {string} rel
 * @returns {Promise<'file' | 'directory' | null>}
 */
export async function lookup(root, rel) {
  const segs = segmentsOf(rel);
  const last = segs.pop();
  if (last === undefined) return 'directory';
  try {
    let dir = root;
    for (const s of segs) dir = await dir.getDirectoryHandle(s);
    try {
      await dir.getFileHandle(last);
      return 'file';
    } catch (e) {
      if (!e || /** @type {any} */ (e).name !== 'TypeMismatchError') throw e;
      await dir.getDirectoryHandle(last);
      return 'directory';
    }
  } catch {
    return null;
  }
}

/** Can the root be read? A missing folder and a withdrawn permission both say no. @param {FileSystemDirectoryHandle} root */
async function readable(root) {
  try {
    const it = root.entries();
    await it.next();
    await it.return?.(undefined);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} e */
const notFound = (e) => !!e && typeof e === 'object' && 'name' in e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

/**
 * The vault under the hide rule (hidden entries included, excluded ones never entered), as
 * `path -> {kind, size, mtime}`. Throws when the root itself cannot be listed; a folder or file
 * that cannot be read lands in `unreadable`, and what was known under it is kept by `diff`.
 * @param {FileSystemDirectoryHandle} root
 * @returns {Promise<{ map: Map<string, Seen>, unreadable: string[] }>}
 */
export async function snapshot(root) {
  /** @type {Map<string, Seen>} */
  const map = new Map();
  /** @type {string[]} */
  const unreadable = [];
  /** @param {FileSystemDirectoryHandle} dir @param {string} at @param {number} depth */
  const visit = async (dir, at, depth) => {
    /** @type {[string, FileSystemHandle][]} */
    const entries = [];
    try {
      for await (const [name, h] of dir.entries()) entries.push([name, h]);
    } catch (e) {
      if (!at) throw e;
      if (!notFound(e)) unreadable.push(at);
      return;
    }
    /** @type {[string, FileSystemFileHandle][]} */
    const files = [];
    /** @type {[string, FileSystemDirectoryHandle][]} */
    const dirs = [];
    for (const [name, h] of entries) {
      const p = at ? `${at}/${name}` : name;
      if (isExcluded(p)) continue;
      if (h.kind === 'directory') {
        map.set(p, { kind: 'directory', size: 0, mtime: 0 });
        dirs.push([p, /** @type {FileSystemDirectoryHandle} */ (h)]);
      } else {
        files.push([p, /** @type {FileSystemFileHandle} */ (h)]);
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const [p, h] = /** @type {[string, FileSystemFileHandle]} */ (files[next++]);
        try {
          const f = await h.getFile();
          map.set(p, { kind: 'file', size: f.size, mtime: f.lastModified });
        } catch (e) {
          if (!notFound(e)) unreadable.push(p);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));
    if (depth >= MAX_DEPTH) return;
    for (const [p, h] of dirs) await visit(h, p, depth + 1);
  };
  await visit(root, '', 1);
  return { map, unreadable };
}

/**
 * What changed between two snapshots, renames paired (docs/HOST.md "The watcher"): a delete and a
 * create of one poll with the same name and the same size and `lastModified` (a folder: the same
 * contents), or, in one folder, the only such pair. Never across the bin's edge. A folder that
 * moved is one rename; what is under it is not reported again. `next` gets what was known under
 * an unreadable place carried over, so a folder that could not be read is not a delete.
 * @param {Map<string, Seen>} old @param {{ map: Map<string, Seen>, unreadable: string[] }} snap
 * @returns {FsChange[]}
 */
export function diff(old, snap) {
  const next = snap.map;
  for (const bad of snap.unreadable) {
    for (const [p, s] of old) if ((p === bad || under(p, bad)) && !next.has(p)) next.set(p, s);
  }
  /** @type {string[]} */
  const deleted = [];
  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const modified = [];
  for (const [p, s] of old) {
    const n = next.get(p);
    if (!n) deleted.push(p);
    else if (n.kind !== s.kind) modified.push(p);
    else if (n.kind === 'file' && (n.size !== s.size || n.mtime !== s.mtime)) modified.push(p);
  }
  for (const p of next.keys()) if (!old.has(p)) created.push(p);

  // Renames: only the top of what went away and of what appeared can be a move.
  const gone = new Set(deleted);
  const born = new Set(created);
  const tops = (/** @type {string[]} */ list, /** @type {Set<string>} */ set) => list.filter((p) => !set.has(parentOf(p)));
  /** @param {string} p @param {Map<string, Seen>} m */
  const sig = (p, m) => {
    const s = /** @type {Seen} */ (m.get(p));
    if (s.kind === 'file') return `f:${s.size}:${s.mtime}`;
    const inner = [];
    for (const [q, t] of m) if (under(q, p)) inner.push(`${q.slice(p.length)}|${t.kind}:${t.size}:${t.mtime}`);
    return `d:${inner.sort().join('\n')}`;
  };
  const from = tops(deleted, gone).map((p) => ({ p, sig: sig(p, old), used: false }));
  const to = tops(created, born).map((p) => ({ p, sig: sig(p, next), used: false }));
  /** @type {[string, string][]} */
  const renames = [];
  const pair = (/** @type {typeof from[0]} */ a, /** @type {typeof to[0]} */ b) => { a.used = b.used = true; renames.push([a.p, b.p]); };
  const fits = (/** @type {typeof from[0]} */ a, /** @type {typeof to[0]} */ b) => !b.used && b.sig === a.sig && isInBin(a.p) === isInBin(b.p);
  // The same name somewhere else, and only one such.
  for (const a of from) {
    const same = to.filter((b) => fits(a, b) && nameOf(b.p) === nameOf(a.p));
    const rivals = from.filter((c) => !c.used && c.sig === a.sig && nameOf(c.p) === nameOf(a.p));
    if (same.length === 1 && rivals.length === 1) pair(a, /** @type {typeof to[0]} */ (same[0]));
  }
  // Another name in the same folder, and exactly one pair there.
  for (const a of from) {
    if (a.used) continue;
    const here = to.filter((b) => fits(a, b) && parentOf(b.p) === parentOf(a.p));
    const rivals = from.filter((c) => !c.used && c.sig === a.sig && parentOf(c.p) === parentOf(a.p));
    if (here.length === 1 && rivals.length === 1) pair(a, /** @type {typeof to[0]} */ (here[0]));
  }

  const movedFrom = renames.map(([f]) => f);
  const movedTo = renames.map(([, t]) => t);
  const inMoved = (/** @type {string} */ p, /** @type {string[]} */ roots) => roots.some((r) => p === r || under(p, r));
  const kindAt = (/** @type {string} */ p) => next.get(p)?.kind ?? null;
  /** @type {FsChange[]} */
  const out = [];
  for (const [f, t] of renames) out.push(change(f, 'rename', t, kindAt(t)));
  for (const p of deleted) if (!inMoved(p, movedFrom)) out.push(change(p, 'delete', undefined, null));
  for (const p of created) if (!inMoved(p, movedTo)) out.push(change(p, 'create', undefined, kindAt(p)));
  for (const p of modified) {
    const k = kindAt(p);
    // A folder replaced by a file is that file changing; a file replaced by a folder is new.
    out.push(change(p, k === 'directory' && old.get(p)?.kind === 'file' ? 'create' : 'modify', undefined, k));
  }
  return out;
}

/**
 * Starts watching `root`; answers the function that stops it, which also carries `ready` (the
 * mode, once the observer is attached or the poll has its first snapshot), `mode()` and
 * `refresh()` (list the outside files again now, after one was registered).
 * @param {FileSystemDirectoryHandle} root
 * @param {WatchFs | null} fs
 * @param {(event: string, data: FsEvent) => unknown} emit
 * @param {WatchOpts} [opts]
 * @returns {Stop}
 */
export function startWatch(root, fs, emit, opts = {}) {
  const g = /** @type {any} */ (globalThis);
  const interval = opts.interval ?? 2000;
  const hiddenInterval = opts.hiddenInterval ?? 10_000;
  const liveEvery = opts.liveness ?? 1000;
  const Observer = 'observer' in opts ? opts.observer : g.FileSystemObserver;
  const doc = 'document' in opts ? opts.document : g.document;

  let stopped = false;
  /** @type {'observer' | 'poll' | null} */
  let mode = null;
  let lost = false;
  const batch = new Batch();
  /** The poll's last look at the vault. @type {Map<string, Seen> | null} */
  let snap = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let flushTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pollTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let liveTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let outsideTimer = null;
  /** Every flush and poll runs after the one before, so events keep their order. */
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  /** @param {() => Promise<unknown>} fn */
  const serial = (fn) => { chain = chain.then(fn, fn).catch(() => {}); return chain; };

  /** @param {FsChange[]} changes @param {{ rescan?: true, lost?: boolean }} [extra] */
  const send = (changes, extra = {}) => {
    if (stopped) return;
    try { emit('fs', { changes, ...extra }); } catch { /* a subscriber's error is its own */ }
  };
  /** @param {string} from @param {string} to */
  const follow = async (from, to) => {
    try { await fs?.followRename?.(from, to); } catch { /* the rename is still reported */ }
  };

  // ------------------------------------------------------------------ the batch
  const flushSoon = () => {
    if (stopped) return;
    if (flushTimer) clearTimeout(flushTimer);
    if (batch.size >= MAX_PENDING) { flushTimer = null; void serial(flush); return; }
    const wait = Math.max(0, Math.min(DEBOUNCE, batch.since + MAX_WAIT - Date.now()));
    flushTimer = setTimeout(() => { flushTimer = null; void serial(flush); }, batch.since ? wait : DEBOUNCE);
  };

  const flush = async () => {
    if (stopped) return;
    const { items, rescan } = batch.take();
    /** @type {FsChange[]} */
    const out = [];
    const emitted = new Set();
    for (const it of items) {
      if (it.outside) {
        const c = await outsideChange(it);
        if (c && !emitted.has(`${c.kind}|${c.path}`)) { emitted.add(`${c.kind}|${c.path}`); out.push(c); }
      } else if (it.to !== undefined) {
        const [a, b] = await Promise.all([lookup(root, it.path), lookup(root, it.to)]);
        if (!a && b) await follow(it.path, it.to);
        out.push(change(it.path, 'rename', it.to, b));
      } else {
        const there = await lookup(root, it.path);
        const kind = resolveKind(it.kinds, there);
        if (kind && !emitted.has(`${kind}|${it.path}`)) { emitted.add(`${kind}|${it.path}`); out.push(change(it.path, kind, undefined, there)); }
      }
    }
    if (out.length || rescan) send(out, rescan ? { rescan: true } : {});
  };

  // ------------------------------------------------------------------ the observer
  /** @type {any} */
  let observer = null;

  /** @param {any[]} records @param {any} from */
  const onRecords = (records, from) => {
    if (stopped || lost || from !== observer) return;
    for (const r of records) {
      const p = joinRel(r.relativePathComponents);
      switch (r.type) {
        case 'appeared': batch.add('create', p); break;
        case 'disappeared':
          if (!p) { void serial(checkLive); break; }
          batch.add('delete', p);
          break;
        case 'modified': if (p) batch.add('modify', p); break;
        case 'moved': {
          const was = r.relativePathMovedFrom ? joinRel(r.relativePathMovedFrom) : '';
          if (!p) { void serial(checkLive); break; }
          if (was) batch.rename(was, p);
          else batch.add('ambiguous', p);
          break;
        }
        case 'unknown': batch.rescan = true; break;
        case 'errored': void serial(restart); return;
        default: break;
      }
    }
    if (batch.size || batch.rescan) flushSoon();
  };

  const attach = async () => {
    const o = new Observer(/** @param {any[]} records @param {any} self */ (records, self) => onRecords(records, self));
    observer = o;
    try {
      await o.observe(root, { recursive: true });
    } catch (e) {
      if (observer === o) observer = null;
      try { o.disconnect(); } catch { /* already */ }
      throw e;
    }
  };
  const detach = () => {
    const o = observer;
    observer = null;
    try { o?.disconnect(); } catch { /* already */ }
  };

  /** `errored`: restart the observer, and say something may have been missed. */
  const restart = async () => {
    if (stopped) return;
    detach();
    // With no observer, checkLive attaches a new one and says `rescan`, or says `lost`.
    await checkLive();
  };

  /** Is the root still there? Says `lost` once when it goes, and `lost: false` and `rescan` when it is back. */
  const checkLive = async () => {
    if (stopped) return false;
    const ok = await readable(root);
    if (stopped) return false;
    if (!ok) {
      if (!lost) {
        lost = true;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        batch.clear();
        if (mode === 'observer') detach();
        send([], { lost: true });
      }
      return false;
    }
    if (lost) {
      lost = false;
      send([], { lost: false });
      if (mode === 'observer') {
        try { await attach(); } catch { /* tried again next tick */ }
      } else {
        snap = (await snapshot(root).catch(() => null))?.map ?? snap;
      }
      send([], { rescan: true });
      return true;
    }
    if (mode === 'observer' && !observer) {
      try { await attach(); } catch { return true; }
      send([], { rescan: true });
    }
    return true;
  };

  // ------------------------------------------------------------------ the poll
  const hidden = () => !!doc && doc.visibilityState === 'hidden';
  const schedulePoll = () => {
    if (stopped || mode !== 'poll') return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = null; void serial(poll); }, hidden() ? hiddenInterval : interval);
  };
  const poll = async () => {
    if (stopped) return;
    try {
      /** @type {Awaited<ReturnType<typeof snapshot>>} */
      let next;
      try {
        next = await snapshot(root);
      } catch {
        await checkLive();
        return;
      }
      if (stopped) return;
      if (lost) { await checkLive(); return; }
      if (!snap) { snap = next.map; return; }
      const changes = diff(snap, next);
      snap = next.map;
      for (const c of changes) if (c.kind === 'rename' && c.to) await follow(c.path, c.to);
      if (changes.length) send(changes);
      await pollOutside();
    } finally {
      schedulePoll();
    }
  };
  const onVisibility = () => {
    if (stopped || mode !== 'poll' || hidden()) return;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    void serial(poll);
  };

  // ------------------------------------------------------------------ files outside the vault
  /** @type {Map<string, { handle: FileSystemFileHandle, sig: string | null, observer: any }>} */
  const outside = new Map();
  /** @param {FileSystemFileHandle} h */
  const sigOf = async (h) => {
    try { const f = await h.getFile(); return `${f.size}:${f.lastModified}`; } catch { return null; }
  };
  /** @param {Item} it @returns {Promise<FsChange | null>} */
  const outsideChange = async (it) => {
    const o = outside.get(it.path);
    if (!o) return null;
    const sig = await sigOf(o.handle);
    const was = o.sig;
    o.sig = sig;
    if (sig === null) return was === null ? null : { path: it.path, kind: 'delete' };
    if (was === sig && it.kinds.every((k) => k === 'check')) return null;
    return { path: it.path, kind: 'modify' };
  };
  const refreshOutside = async () => {
    if (stopped || !opts.outside) return;
    /** @type {{ path: string, handle: FileSystemFileHandle }[]} */
    let list = [];
    try { list = await opts.outside.list(); } catch { return; }
    const keep = new Set(list.map((x) => x.path));
    for (const [p, o] of outside) {
      if (keep.has(p)) continue;
      try { o.observer?.disconnect(); } catch { /* already */ }
      outside.delete(p);
    }
    for (const { path, handle } of list) {
      if (stopped || outside.has(path)) continue;
      const entry = { handle, sig: await sigOf(handle), observer: /** @type {any} */ (null) };
      outside.set(path, entry);
      if (!Observer) continue;
      try {
        const o = new Observer(/** @param {any[]} records */ (records) => {
          if (stopped || outside.get(path) !== entry) return;
          for (const r of records) {
            const t = r.type;
            batch.addOutside(t === 'modified' || t === 'appeared' ? 'modify' : t === 'disappeared' || t === 'moved' ? 'delete' : 'check', path);
          }
          flushSoon();
        });
        await o.observe(handle);
        entry.observer = o;
      } catch { /* polled by lastModified instead */ }
    }
  };
  const pollOutside = async () => {
    for (const [p, o] of outside) {
      if (o.observer) continue;
      const sig = await sigOf(o.handle);
      if (sig !== o.sig) batch.addOutside('check', p);
    }
    if (batch.size) flushSoon();
  };
  const outsideTick = () => void serial(async () => { await refreshOutside(); if (mode === 'observer') await pollOutside(); });

  // ------------------------------------------------------------------ start
  const ready = (async () => {
    await refreshOutside();
    if (Observer) {
      try {
        mode = 'observer';
        await attach();
      } catch {
        mode = null;
        observer = null;
      }
    }
    if (stopped) return mode ?? 'poll';
    if (mode === 'observer') {
      liveTimer = setInterval(() => void serial(checkLive), liveEvery);
    } else {
      mode = 'poll';
      try { snap = (await snapshot(root)).map; } catch { await checkLive(); }
      doc?.addEventListener?.('visibilitychange', onVisibility);
      schedulePoll();
    }
    if (opts.outside) outsideTimer = setInterval(outsideTick, interval);
    return /** @type {'observer' | 'poll'} */ (mode);
  })();

  const stop = /** @type {Stop} */ (() => {
    if (stopped) return;
    stopped = true;
    for (const t of [flushTimer, pollTimer]) if (t) clearTimeout(t);
    for (const t of [liveTimer, outsideTimer]) if (t) clearInterval(t);
    detach();
    for (const o of outside.values()) { try { o.observer?.disconnect(); } catch { /* already */ } }
    outside.clear();
    doc?.removeEventListener?.('visibilitychange', onVisibility);
  });
  stop.ready = ready;
  stop.mode = () => mode;
  stop.refresh = () => serial(refreshOutside).then(() => {});
  return stop;
}
