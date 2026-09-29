// An in-memory File System Access API for the Ose Web tests (docs/HOST.md "Testing"): a
// FileSystemDirectoryHandle / FileSystemFileHandle pair over a tree held in memory, with
// createWritable, getFile, removeEntry, entries/keys/values, resolve, isSameEntry, move,
// queryPermission and requestPermission, plus a FileSystemObserver twin and helpers to seed
// files, read bytes back and change the tree "from outside" (as another program would).
//
//   import { createFsa } from '../stubs/fsa.js';
//   const fsa = createFsa({ files: { 'a.md': '# A\n', 'notes/b.md': 'b' } });
//   const root = fsa.root;                       // a FileSystemDirectoryHandle
//   fsa.readText('a.md');                        // '# A\n', or null when there is no such file
//   fsa.write('a.md', 'changed');                // an outside edit: new bytes, new mtime, an event
//   const off = fsa.install();                   // showDirectoryPicker, showOpenFilePicker and
//                                                // FileSystemObserver on globalThis; off() undoes
//
// What it models of Chrome, because the code under test must survive it:
// - Handles are path-based, as Chrome's are: a handle names a place, and `getFile()` on a file
//   that was removed or moved away fails with NotFoundError.
// - `createWritable()` writes into a swap file `<name>.crswap` beside the target (listed while it
//   is open, as Chrome's is) and replaces the target in one step on `close()`; `abort()` drops it.
//   `{ swapFiles: false }` turns the visible swap file off.
// - `move()` refuses a destination that exists (InvalidModificationError). Chrome's behaviour
//   there is not something to rely on, so code must look first either way. `{ dirMove: false }`
//   makes moving a folder fail with NotSupportedError, for the copy-and-remove fallback.
// - Names are case-sensitive; `{ foldCase: true }` makes lookups case-insensitive (Windows,
//   macOS), the stored name keeping its spelling.
// - Folder mtimes are not exposed by the API, so only files have one (File.lastModified).
// - `fail(op, path?, name?)` makes the next `op` (getFile, createWritable, write, close, move,
//   removeEntry, getFileHandle, getDirectoryHandle, entries) on `path` (any path when omitted)
//   throw a DOMException named `name` (default NotReadableError), once.
// - Observer records come after a macrotask, in one batch per tick, with the Chrome shapes:
//   `{ type: 'appeared'|'disappeared'|'modified'|'moved'|'unknown'|'errored', root,
//   changedHandle, relativePathComponents, relativePathMovedFrom? }`. Writes made through the
//   handles are reported too, as Chrome reports the page's own changes.

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** @param {string} name @param {string} message */
const domError = (name, message) => new DOMException(message, name);

/** @param {string | Uint8Array | ArrayBuffer | ArrayBufferView} data */
function toBytes(data) {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  throw new TypeError('fsa stub: bytes must be a string, a Uint8Array or an ArrayBuffer');
}

/** @param {string} p */
const segs = (p) => String(p ?? '').split('/').filter((s) => s && s !== '.');

/** A name the API refuses (TypeError in Chrome). @param {string} name */
function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new TypeError(`Name is not allowed: ${JSON.stringify(name)}`);
  }
}

/**
 * @typedef {{ kind: 'file', name: string, bytes: Uint8Array, mtime: number }} MemFile
 * @typedef {{ kind: 'directory', name: string, children: Map<string, MemNode> }} MemDir
 * @typedef {MemFile | MemDir} MemNode
 */

/**
 * @param {{ files?: Record<string, string | Uint8Array>, dirs?: string[], name?: string,
 *   swapFiles?: boolean, dirMove?: boolean, foldCase?: boolean, now?: () => number,
 *   permission?: PermissionState }} [opts]
 */
export function createFsa(opts = {}) {
  const swapFiles = opts.swapFiles !== false;
  const dirMove = opts.dirMove !== false;
  const foldCase = !!opts.foldCase;
  let clock = typeof opts.now === 'function' ? opts.now : null;
  let fakeNow = 1_700_000_000_000;
  const now = () => (clock ? clock() : (fakeNow += 1));

  /** @type {MemDir} */
  const top = { kind: 'directory', name: opts.name || 'vault', children: new Map() };
  const key = (name) => (foldCase ? name.toLowerCase() : name);
  /** The vault folder itself is gone (`loseRoot`): every lookup fails, the root's too. */
  let gone = false;

  const state = {
    /** @type {PermissionState} */
    permission: opts.permission || 'granted',
    /** What `requestPermission` turns the state into (the user's answer). @type {PermissionState} */
    answer: /** @type {PermissionState} */ ('granted'),
    requests: 0,
  };
  /** @type {{ op: string, path: string | null, name: string }[]} */
  const faults = [];

  /** @param {string} op @param {string[]} path */
  function fault(op, path) {
    const p = path.join('/');
    const i = faults.findIndex((f) => f.op === op && (f.path === null || f.path === p));
    if (i < 0) return;
    const [f] = faults.splice(i, 1);
    throw domError(f.name, `injected ${f.name} on ${op} ${p}`);
  }

  // ------------------------------------------------------------------ the tree
  /** @param {string[]} path @returns {MemNode | null} */
  function nodeAt(path) {
    if (gone) return null;
    /** @type {MemNode} */
    let n = top;
    for (const s of path) {
      if (n.kind !== 'directory') return null;
      const c = n.children.get(key(s));
      if (!c) return null;
      n = c;
    }
    return n;
  }
  /** @param {string[]} path @returns {MemDir} */
  function dirAt(path) {
    const n = nodeAt(path);
    if (!n) throw domError('NotFoundError', `A requested file or directory could not be found: ${path.join('/')}`);
    if (n.kind !== 'directory') throw domError('TypeMismatchError', `not a directory: ${path.join('/')}`);
    return n;
  }
  /** The stored spelling of a path (foldCase keeps the name it was made with). @param {string[]} path */
  function spelled(path) {
    const out = [];
    /** @type {MemNode | undefined} */
    let n = top;
    for (const s of path) {
      n = n && n.kind === 'directory' ? n.children.get(key(s)) : undefined;
      out.push(n ? n.name : s);
    }
    return out;
  }

  // ------------------------------------------------------------------ observers
  /** @type {Set<Observer>} */
  const observers = new Set();
  /** @type {{ type: string, path: string[], from?: string[], kind: 'file' | 'directory' }[]} */
  let queue = [];
  let flushTimer = null;
  /** @param {string} type @param {string[]} path @param {'file' | 'directory'} kind @param {string[]} [from] */
  function record(type, path, kind, from) {
    if (!observers.size) return;
    queue.push({ type, path: [...path], kind, from: from ? [...from] : undefined });
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
  }
  function flush() {
    flushTimer = null;
    const batch = queue;
    queue = [];
    for (const o of [...observers]) o._deliver(batch);
  }

  // ------------------------------------------------------------------ files
  class MemFileHandle {
    /** @param {string[]} path */
    constructor(path) { this._path = path; this._owner = top; this.kind = 'file'; }
    get name() { return this._path[this._path.length - 1] || ''; }
    /** @returns {MemFile} */
    _node() {
      const n = nodeAt(this._path);
      if (!n) throw domError('NotFoundError', `A requested file or directory could not be found: ${this._path.join('/')}`);
      if (n.kind !== 'file') throw domError('TypeMismatchError', `not a file: ${this._path.join('/')}`);
      return n;
    }
    async getFile() {
      fault('getFile', this._path);
      const n = this._node();
      return new File([n.bytes.slice()], n.name, { lastModified: n.mtime });
    }
    /** @param {{ keepExistingData?: boolean }} [o] */
    async createWritable(o = {}) {
      fault('createWritable', this._path);
      const n = this._node();
      return new MemWritable(this._path, o.keepExistingData ? n.bytes.slice() : new Uint8Array(0));
    }
    /** @param {FileSystemHandle} other */
    async isSameEntry(other) { return sameEntry(this, other); }
    async queryPermission() { return state.permission; }
    async requestPermission() { state.requests++; state.permission = state.answer; return state.permission; }
    /** `move(newName)` or `move(newParent, newName?)`. @param {any} a @param {string} [b] */
    async move(a, b) { await moveHandle(this, a, b); }
    async remove() { await removeAt(this._path, { recursive: false }); }
  }

  class MemWritable {
    /** @param {string[]} path @param {Uint8Array} bytes */
    constructor(path, bytes) {
      this._path = path;
      this._bytes = bytes;
      this._pos = 0;
      this._closed = false;
      this._swap = null;
      if (swapFiles) {
        const parent = dirAt(path.slice(0, -1));
        const swapName = `${path[path.length - 1]}.crswap`;
        if (!parent.children.has(key(swapName))) {
          parent.children.set(key(swapName), { kind: 'file', name: swapName, bytes: new Uint8Array(0), mtime: now() });
          this._swap = [...path.slice(0, -1), swapName];
          record('appeared', this._swap, 'file');
        }
      }
    }
    _open() { if (this._closed) throw new TypeError('the stream is closed'); }
    /** @param {any} data */
    async write(data) {
      this._open();
      fault('write', this._path);
      if (data && typeof data === 'object' && 'type' in data && !(data instanceof Blob)) {
        if (data.type === 'seek') { this._pos = Number(data.position) || 0; return; }
        if (data.type === 'truncate') { this._truncate(Number(data.size) || 0); return; }
        if (typeof data.position === 'number') this._pos = data.position;
        data = data.data;
      }
      const add = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : toBytes(data);
      const end = this._pos + add.length;
      if (end > this._bytes.length) { const grown = new Uint8Array(end); grown.set(this._bytes); this._bytes = grown; }
      this._bytes.set(add, this._pos);
      this._pos = end;
    }
    /** @param {number} position */
    async seek(position) { this._open(); this._pos = position; }
    /** @param {number} size */
    async truncate(size) { this._open(); this._truncate(size); }
    /** @param {number} size */
    _truncate(size) {
      const next = new Uint8Array(size);
      next.set(this._bytes.subarray(0, Math.min(size, this._bytes.length)));
      this._bytes = next;
      if (this._pos > size) this._pos = size;
    }
    _dropSwap() {
      if (!this._swap) return;
      const parent = nodeAt(this._swap.slice(0, -1));
      if (parent && parent.kind === 'directory') parent.children.delete(key(this._swap[this._swap.length - 1] || ''));
      record('disappeared', this._swap, 'file');
      this._swap = null;
    }
    async close() {
      this._open();
      this._closed = true;
      try { fault('close', this._path); } catch (e) { this._dropSwap(); throw e; }
      const parent = dirAt(this._path.slice(0, -1));
      const name = this._path[this._path.length - 1] || '';
      const had = parent.children.get(key(name));
      if (had && had.kind !== 'file') { this._dropSwap(); throw domError('TypeMismatchError', `not a file: ${this._path.join('/')}`); }
      parent.children.set(key(name), { kind: 'file', name: had ? had.name : name, bytes: this._bytes, mtime: now() });
      this._dropSwap();
      record(had ? 'modified' : 'appeared', this._path, 'file');
    }
    async abort() { this._closed = true; this._dropSwap(); }
    getWriter() { throw new Error('fsa stub: getWriter is not modelled; use write()'); }
  }

  // ------------------------------------------------------------------ folders
  class MemDirHandle {
    /** @param {string[]} path */
    constructor(path) { this._path = path; this._owner = top; this.kind = 'directory'; }
    get name() { return this._path.length ? this._path[this._path.length - 1] : top.name; }
    /** @param {string} name @param {{ create?: boolean }} [o] */
    async getFileHandle(name, o = {}) {
      checkName(name);
      fault('getFileHandle', [...this._path, name]);
      const dir = dirAt(this._path);
      const n = dir.children.get(key(name));
      if (n && n.kind !== 'file') throw domError('TypeMismatchError', `not a file: ${name}`);
      if (!n) {
        if (!o.create) throw domError('NotFoundError', `A requested file or directory could not be found: ${[...this._path, name].join('/')}`);
        dir.children.set(key(name), { kind: 'file', name, bytes: new Uint8Array(0), mtime: now() });
        record('appeared', [...this._path, name], 'file');
      }
      return new MemFileHandle([...this._path, n ? n.name : name]);
    }
    /** @param {string} name @param {{ create?: boolean }} [o] */
    async getDirectoryHandle(name, o = {}) {
      checkName(name);
      fault('getDirectoryHandle', [...this._path, name]);
      const dir = dirAt(this._path);
      const n = dir.children.get(key(name));
      if (n && n.kind !== 'directory') throw domError('TypeMismatchError', `not a directory: ${name}`);
      if (!n) {
        if (!o.create) throw domError('NotFoundError', `A requested file or directory could not be found: ${[...this._path, name].join('/')}`);
        dir.children.set(key(name), { kind: 'directory', name, children: new Map() });
        record('appeared', [...this._path, name], 'directory');
      }
      return new MemDirHandle([...this._path, n ? n.name : name]);
    }
    /** @param {string} name @param {{ recursive?: boolean }} [o] */
    async removeEntry(name, o = {}) {
      checkName(name);
      await removeAt([...this._path, name], o);
    }
    /** @param {FileSystemHandle} other @returns {Promise<string[] | null>} */
    async resolve(other) {
      const p = /** @type {any} */ (other)._path;
      if (/** @type {any} */ (other)._owner !== top || !Array.isArray(p) || p.length < this._path.length) return null;
      for (let i = 0; i < this._path.length; i++) if (key(p[i]) !== key(this._path[i] || '')) return null;
      return spelled(p).slice(this._path.length);
    }
    async *entries() {
      fault('entries', this._path);
      const dir = dirAt(this._path);
      // A snapshot, as a real listing is: changes made while iterating are not guaranteed.
      for (const n of [...dir.children.values()]) {
        const p = [...this._path, n.name];
        yield /** @type {[string, MemFileHandle | MemDirHandle]} */ ([n.name, n.kind === 'file' ? new MemFileHandle(p) : new MemDirHandle(p)]);
      }
    }
    async *keys() { for await (const [name] of this.entries()) yield name; }
    async *values() { for await (const [, h] of this.entries()) yield h; }
    [Symbol.asyncIterator]() { return this.entries(); }
    /** @param {FileSystemHandle} other */
    async isSameEntry(other) { return sameEntry(this, other); }
    async queryPermission() { return state.permission; }
    async requestPermission() { state.requests++; state.permission = state.answer; return state.permission; }
    /** @param {any} a @param {string} [b] */
    async move(a, b) { await moveHandle(this, a, b); }
    async remove(o = {}) { await removeAt(this._path, o); }
  }

  /** @param {any} a @param {any} b */
  function sameEntry(a, b) {
    if (!b || b._owner !== top || a.kind !== b.kind || !Array.isArray(b._path) || a._path.length !== b._path.length) return false;
    return a._path.every((/** @type {string} */ s, /** @type {number} */ i) => key(s) === key(b._path[i]));
  }

  /** @param {string[]} path @param {{ recursive?: boolean }} o */
  async function removeAt(path, o) {
    fault('removeEntry', path);
    if (!path.length) throw domError('InvalidModificationError', 'cannot remove the root');
    const parent = dirAt(path.slice(0, -1));
    const name = path[path.length - 1] || '';
    const n = parent.children.get(key(name));
    if (!n) throw domError('NotFoundError', `A requested file or directory could not be found: ${path.join('/')}`);
    if (n.kind === 'directory' && n.children.size && !o.recursive) throw domError('InvalidModificationError', `the folder is not empty: ${path.join('/')}`);
    parent.children.delete(key(name));
    record('disappeared', spelled(path.slice(0, -1)).concat(n.name), n.kind);
  }

  /** @param {MemFileHandle | MemDirHandle} h @param {any} a @param {string} [b] */
  async function moveHandle(h, a, b) {
    fault('move', h._path);
    const from = h._path;
    const n = nodeAt(from);
    if (!n) throw domError('NotFoundError', `A requested file or directory could not be found: ${from.join('/')}`);
    if (n.kind === 'directory' && !dirMove) throw domError('NotSupportedError', 'moving a directory is not supported here');
    let destDir = from.slice(0, -1);
    let name = n.name;
    if (typeof a === 'string') name = a;
    else if (a && Array.isArray(a._path)) { destDir = a._path; if (typeof b === 'string') name = b; }
    else throw new TypeError('move needs a new name or a directory handle');
    checkName(name);
    const target = dirAt(destDir);
    const to = [...destDir, name];
    if (n.kind === 'directory' && to.length > from.length && from.every((s, i) => key(s) === key(to[i] || ''))) {
      throw domError('InvalidModificationError', 'a folder cannot move into itself');
    }
    const there = target.children.get(key(name));
    if (there && there !== n) throw domError('InvalidModificationError', `the destination exists: ${to.join('/')}`);
    const parent = dirAt(from.slice(0, -1));
    parent.children.delete(key(n.name));
    n.name = name;
    target.children.set(key(name), n);
    h._path = to;
    record('moved', to, n.kind, spelled(from.slice(0, -1)).concat(from[from.length - 1] || ''));
  }

  // ------------------------------------------------------------------ the observer
  class Observer {
    /** @param {(records: any[], observer: Observer) => void} callback */
    constructor(callback) {
      this._callback = callback;
      /** @type {{ handle: MemDirHandle | MemFileHandle, recursive: boolean }[]} */
      this._targets = [];
    }
    /** @param {MemDirHandle | MemFileHandle} handle @param {{ recursive?: boolean }} [o] */
    async observe(handle, o = {}) {
      if (!nodeAt(handle._path)) throw domError('NotFoundError', 'nothing to observe');
      this._targets.push({ handle, recursive: !!o.recursive });
      observers.add(this);
    }
    /** @param {MemDirHandle | MemFileHandle} handle */
    unobserve(handle) {
      this._targets = this._targets.filter((t) => !sameEntry(t.handle, handle));
      if (!this._targets.length) observers.delete(this);
    }
    disconnect() { this._targets = []; observers.delete(this); }
    /** @param {{ type: string, path: string[], from?: string[], kind: 'file' | 'directory' }[]} batch */
    _deliver(batch) {
      const out = [];
      for (const r of batch) {
        for (const t of this._targets) {
          const base = t.handle._path;
          const rel = relTo(base, r.path);
          const relFrom = r.from ? relTo(base, r.from) : null;
          const inside = (x) => x !== null && (t.recursive || x.length <= 1);
          if (!inside(rel) && !inside(relFrom)) continue;
          const changed = r.kind === 'file' ? new MemFileHandle(r.path) : new MemDirHandle(r.path);
          if (r.type === 'moved' && !inside(relFrom)) out.push({ type: 'appeared', root: t.handle, changedHandle: changed, relativePathComponents: rel });
          else if (r.type === 'moved' && !inside(rel)) out.push({ type: 'disappeared', root: t.handle, changedHandle: changed, relativePathComponents: relFrom });
          else out.push({ type: r.type, root: t.handle, changedHandle: changed, relativePathComponents: rel ?? [], ...(r.type === 'moved' ? { relativePathMovedFrom: relFrom } : {}) });
          break;
        }
      }
      if (out.length) this._callback(out, this);
    }
    /** Test hook: deliver a record Chrome sends on its own (`unknown`, `errored`). @param {'unknown' | 'errored'} type */
    _signal(type) {
      const t = this._targets[0];
      if (!t) return;
      setTimeout(() => this._callback([{ type, root: t.handle, changedHandle: t.handle, relativePathComponents: [] }], this), 0);
    }
  }
  /** @param {string[]} base @param {string[]} path @returns {string[] | null} */
  function relTo(base, path) {
    if (path.length < base.length) return null;
    for (let i = 0; i < base.length; i++) if (key(base[i] || '') !== key(path[i] || '')) return null;
    return path.slice(base.length);
  }

  // ------------------------------------------------------------------ outside helpers
  /** @param {string} p @param {boolean} [event] */
  function mkdirP(p, event = true) {
    /** @type {MemDir} */
    let d = top;
    const done = [];
    for (const s of segs(p)) {
      done.push(s);
      let c = d.children.get(key(s));
      if (!c) {
        c = { kind: 'directory', name: s, children: new Map() };
        d.children.set(key(s), c);
        if (event) record('appeared', done, 'directory');
      }
      if (c.kind !== 'directory') throw new Error(`fsa stub: ${done.join('/')} is a file`);
      d = c;
    }
    return d;
  }
  /** @param {string} p @param {string | Uint8Array} data @param {boolean} event @param {number} [mtime] */
  function put(p, data, event, mtime) {
    const s = segs(p);
    const name = s.pop();
    if (!name) throw new Error('fsa stub: a file needs a name');
    const dir = mkdirP(s.join('/'), event);
    const had = dir.children.get(key(name));
    if (had && had.kind !== 'file') throw new Error(`fsa stub: ${p} is a folder`);
    dir.children.set(key(name), { kind: 'file', name: had ? had.name : name, bytes: toBytes(data), mtime: mtime ?? now() });
    if (event) record(had ? 'modified' : 'appeared', [...s, name], 'file');
  }

  for (const d of opts.dirs || []) mkdirP(d, false);
  for (const [p, data] of Object.entries(opts.files || {})) put(p, data, false);

  /** @type {Array<() => void>} */
  const undo = [];

  const fsa = {
    /** The vault folder: a FileSystemDirectoryHandle. */
    root: /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ (new MemDirHandle([]))),
    /** The FileSystemObserver twin, bound to this tree. */
    Observer,
    /** Permission state and the user's answer to the next `requestPermission`. */
    permission: state,
    /** Seed files without events (setup). @param {Record<string, string | Uint8Array>} files */
    seed(files) { for (const [p, data] of Object.entries(files)) put(p, data, false); },
    /** A handle for a vault path, as the page would get it by walking. @param {string} p */
    handle(p) {
      const s = segs(p);
      const n = nodeAt(s);
      if (!n) return null;
      return /** @type {any} */ (n.kind === 'file' ? new MemFileHandle(spelled(s)) : new MemDirHandle(spelled(s)));
    },
    /** The bytes of a file, or null. @param {string} p */
    read(p) { const n = nodeAt(segs(p)); return n && n.kind === 'file' ? n.bytes.slice() : null; },
    /** The file as text (UTF-8, a BOM kept as U+FEFF), or null. @param {string} p */
    readText(p) { const b = fsa.read(p); return b ? dec.decode(b) : null; },
    /** @param {string} p */
    exists(p) { return nodeAt(segs(p)) !== null; },
    /** @param {string} p @returns {'file' | 'directory' | null} */
    kind(p) { const n = nodeAt(segs(p)); return n ? n.kind : null; },
    /** @param {string} p */
    mtime(p) { const n = nodeAt(segs(p)); return n && n.kind === 'file' ? n.mtime : null; },
    /** Every path in the tree, sorted, folders with a trailing slash. */
    list() {
      const out = [];
      /** @param {MemDir} d @param {string} at */
      const walk = (d, at) => {
        for (const n of d.children.values()) {
          const p = at ? `${at}/${n.name}` : n.name;
          out.push(n.kind === 'directory' ? `${p}/` : p);
          if (n.kind === 'directory') walk(n, p);
        }
      };
      walk(top, '');
      return out.sort();
    },
    // Changes from outside (another program): observers hear them.
    /** @param {string} p @param {string | Uint8Array} data @param {{ mtime?: number }} [o] */
    write(p, data, o = {}) { put(p, data, true, o.mtime); },
    /** @param {string} p */
    mkdir(p) { mkdirP(p, true); },
    /** @param {string} p */
    remove(p) {
      const s = segs(p);
      const n = nodeAt(s);
      if (!n || !s.length) throw new Error(`fsa stub: nothing at ${p}`);
      const parent = /** @type {MemDir} */ (nodeAt(s.slice(0, -1)));
      parent.children.delete(key(n.name));
      record('disappeared', spelled(s.slice(0, -1)).concat(n.name), n.kind);
    },
    /** A rename or move from outside; refuses a taken destination. @param {string} from @param {string} to */
    rename(from, to) {
      const a = segs(from), b = segs(to);
      const n = nodeAt(a);
      if (!n || !a.length || !b.length) throw new Error(`fsa stub: cannot move ${from}`);
      const dest = mkdirP(b.slice(0, -1).join('/'), true);
      const name = b[b.length - 1] || '';
      if (dest.children.has(key(name)) && dest.children.get(key(name)) !== n) throw new Error(`fsa stub: ${to} exists`);
      const fromSpelled = spelled(a);
      /** @type {MemDir} */ (nodeAt(a.slice(0, -1))).children.delete(key(n.name));
      n.name = name;
      dest.children.set(key(name), n);
      record('moved', b, n.kind, fromSpelled);
    },
    /** Set a file's mtime without changing it (a touch). @param {string} p @param {number} ms */
    touch(p, ms) { const n = nodeAt(segs(p)); if (n && n.kind === 'file') { n.mtime = ms; record('modified', segs(p), 'file'); } },
    /** The vault folder itself gone, or back (`lost` in the watcher). */
    loseRoot() { gone = true; },
    restoreRoot() { gone = false; },
    /** Make the next `op` on `path` throw a DOMException `name`. @param {string} op @param {string | null} [path] @param {string} [name] */
    fail(op, path = null, name = 'NotReadableError') { faults.push({ op, path: path === null ? null : segs(path).join('/'), name }); },
    /** Every observer currently observing (for `_signal('unknown')`). */
    observers() { return [...observers]; },
    /** Deliver queued observer records now, without waiting for the timer. */
    flush() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } flush(); },
    /** Use this clock for mtimes. @param {() => number} fn */
    setClock(fn) { clock = fn; },
    /**
     * `showDirectoryPicker` (answers this root, or AbortError when `cancel` is set),
     * `showOpenFilePicker` (answers `pickFiles`, set by the test) and `FileSystemObserver` on
     * globalThis. Answers the undo.
     */
    install() {
      const g = /** @type {any} */ (globalThis);
      const saved = ['showDirectoryPicker', 'showOpenFilePicker', 'FileSystemObserver'].map((k) => [k, g[k], k in g]);
      g.showDirectoryPicker = async () => { if (fsa.cancel) throw domError('AbortError', 'The user aborted a request.'); return fsa.root; };
      g.showOpenFilePicker = async () => { if (fsa.cancel) throw domError('AbortError', 'The user aborted a request.'); return fsa.pickFiles.slice(); };
      g.FileSystemObserver = Observer;
      const off = () => { for (const [k, v, had] of saved) { if (had) g[k] = v; else delete g[k]; } };
      undo.push(off);
      return off;
    },
    /** Set true to make the pickers throw AbortError. */
    cancel: false,
    /** What `showOpenFilePicker` answers. @type {FileSystemFileHandle[]} */
    pickFiles: [],
    /** A free-standing file handle, as a file picker or the launch queue hands one over from
     *  outside the vault: its own little tree. @param {string} name @param {string | Uint8Array} data */
    outsideFile(name, data) {
      const other = createFsa({ files: { [name]: data }, name: 'outside' });
      return /** @type {FileSystemFileHandle} */ (other.handle(name));
    },
  };
  return fsa;
}
