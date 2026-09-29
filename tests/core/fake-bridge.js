// A bridge for the core tests: the methods src/core/bridge/index.ts answers, over an
// in-memory vault, with every call written down in order. The core modules under test import
// `bridge` from './bridge/index.js'; each test file swaps that module for this one:
//
//   vi.mock('../../src/core/bridge/index.ts', () => import('./fake-bridge.js'));
//
// Errors are thrown the way the real facade throws them (CONTRACT 4.2): an Error with `.code`.
// `fail(cmd, code)` makes the next call of `cmd` fail with that code.

const files = new Map();     // vault path -> text
const dirs = new Set();      // vault paths of folders
const failures = new Map();  // cmd -> code of the next failure
const listeners = new Map(); // event -> Set(fn)
const bin = new Map();       // trash id -> { path, kind, files: [[path, text]], dirs: [path], at }
const local = { app: {}, vault: {} };  // localGet / localSet
let binSeq = 0;
let restorable = true;       // false: `trash` answers `id: null`, as macOS's system Trash does

/** Every call, in order: `[cmd, ...args]`. */
export const calls = [];

const parent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function coded(code, message, cmd) {
  return Object.assign(new Error(message), { code, cmd });
}

function note(cmd, args) {
  calls.push([cmd, ...args]);
  const code = failures.get(cmd);
  if (code) { failures.delete(cmd); throw coded(code, `${cmd} refused (test)`, cmd); }
}

function addDirs(path) {
  for (let p = parent(path); p; p = parent(p)) dirs.add(p);
}

/** A folder, or a path inside one, moved: every key under `from` re-keyed under `to`. */
function moveUnder(from, to) {
  for (const [k, v] of [...files]) {
    if (k === from || k.startsWith(from + '/')) { files.delete(k); files.set(to + k.slice(from.length), v); }
  }
  for (const d of [...dirs]) {
    if (d === from || d.startsWith(from + '/')) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
  }
  addDirs(to);
}

function treeOf(path) {
  const kids = new Map();
  const prefix = path ? path + '/' : '';
  for (const d of dirs) if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/') && d !== path) kids.set(d, { kind: 'dir' });
  for (const f of files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) kids.set(f, { kind: 'file' });
  return {
    name: path.split('/').pop() || 'vault', path, kind: 'dir',
    children: [...kids].map(([p, k]) => (k.kind === 'dir' ? treeOf(p) : { name: p.split('/').pop(), path: p, kind: 'file' })),
  };
}

export const bridge = {
  kind: 'test',
  platform: 'windows',
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  },
  async stat(p) {
    note('stat', [p]);
    if (files.has(p)) return { exists: true, kind: 'file', mtime: 0, size: files.get(p).length };
    if (dirs.has(p) || p === '') return { exists: true, kind: 'dir', mtime: 0, size: 0 };
    return { exists: false };
  },
  // Case-insensitive, as on Windows and a default macOS volume: `A.md` exists when `a.md` does.
  async exists(p) {
    note('exists', [p]);
    const low = String(p).toLowerCase();
    return [...files.keys(), ...dirs].some((k) => k.toLowerCase() === low);
  },
  async readText(p) {
    note('readText', [p]);
    if (!files.has(p)) throw coded('not_found', `${p} not found`, 'readText');
    return files.get(p);
  },
  async readFile(p) {
    note('readFile', [p]);
    if (!files.has(p)) throw coded('not_found', `${p} not found`, 'readFile');
    return { text: files.get(p), hash: `h:${files.get(p)}`, mtime: 0, size: files.get(p).length };
  },
  async writeText(p, text) { note('writeText', [p, text]); addDirs(p); files.set(p, text); },
  async createNew(p, text = '') {
    note('createNew', [p, text]);
    if (files.has(p) || dirs.has(p)) throw coded('exists', `${p} already exists`, 'createNew');
    addDirs(p);
    files.set(p, text);
    return { path: p, hash: `h:${text}` };
  },
  async copyFile(from, to) {
    note('copyFile', [from, to]);
    if (!files.has(from)) throw coded('not_found', `${from} not found`, 'copyFile');
    if (files.has(to)) throw coded('exists', `${to} already exists`, 'copyFile');
    addDirs(to);
    files.set(to, files.get(from));
    return { path: to, hash: `h:${files.get(to)}` };
  },
  async rename(from, to) {
    note('rename', [from, to]);
    if (!files.has(from) && !dirs.has(from)) throw coded('not_found', `${from} not found`, 'rename');
    moveUnder(from, to);
  },
  // CONTRACT §3.1: `{ id, where }`; the id is what trashRestore takes, null where the platform
  // cannot restore (setRestorable(false)).
  async trash(p, opts) {
    note('trash', [p, opts]);
    if (!files.has(p) && !dirs.has(p)) throw coded('not_found', `${p} not found`, 'trash');
    const item = { path: p, kind: dirs.has(p) ? 'dir' : 'file', files: [], dirs: [], at: Date.now() + binSeq };
    for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) { item.files.push([k, files.get(k)]); files.delete(k); }
    for (const d of [...dirs]) if (d === p || d.startsWith(p + '/')) { item.dirs.push(d); dirs.delete(d); }
    const where = opts && opts.mode === 'vault' ? 'vault' : 'system';
    if (!restorable) return { id: null, where };
    const id = `t${++binSeq}`;
    bin.set(id, { ...item, where });
    return { id, where };
  },
  async trashWhere(p) { note('trashWhere', [p]); return { where: 'system' }; },
  async trashList() {
    note('trashList', []);
    return [...bin].map(([id, it]) => ({
      id, name: it.path.split('/').pop(), original: it.path, deletedAt: it.at, kind: it.kind,
      size: it.files.reduce((n, [, t]) => n + t.length, 0), where: it.where,
    })).sort((a, b) => b.deletedAt - a.deletedAt);
  },
  async trashRestore(ids, opts) {
    note('trashRestore', [ids, opts]);
    const restored = [];
    const failed = [];
    for (const id of ids) {
      const it = bin.get(id);
      if (!it) { failed.push({ id, error: `[not_found] ${id} is not in the trash` }); continue; }
      if (files.has(it.path) || dirs.has(it.path)) { failed.push({ id, error: `[exists] ${it.path} already exists` }); continue; }
      for (const d of it.dirs) { dirs.add(d); addDirs(d); }
      for (const [k, v] of it.files) { files.set(k, v); addDirs(k); }
      bin.delete(id);
      restored.push({ id, path: it.path });
    }
    return { restored, failed };
  },
  // A file or a whole folder, create-only, parents made (CONTRACT §3.1).
  async copyPath(from, to, opts) {
    note('copyPath', [from, to, opts]);
    if (!files.has(from) && !dirs.has(from)) throw coded('not_found', `${from} not found`, 'copyPath');
    if (files.has(to) || dirs.has(to)) throw coded('exists', `${to} already exists`, 'copyPath');
    let n = 0;
    if (files.has(from)) { files.set(to, files.get(from)); addDirs(to); return { path: to, files: 1 }; }
    dirs.add(to); addDirs(to);
    for (const d of [...dirs]) if (d.startsWith(from + '/')) dirs.add(to + d.slice(from.length));
    for (const [k, v] of [...files]) if (k.startsWith(from + '/')) { files.set(to + k.slice(from.length), v); n += 1; }
    return { path: to, files: n };
  },
  async localGet(scope) { note('localGet', [scope]); return structuredClone(local[scope] || {}); },
  async localSet(scope, value, opts) { note('localSet', [scope, value, opts]); local[scope] = structuredClone(value || {}); return null; },
  async mkdir(p) {
    note('mkdir', [p]);
    if (dirs.has(p) || files.has(p)) throw coded('exists', `${p} already exists`, 'mkdir');
    dirs.add(p); addDirs(p);
  },
  async tree() { note('tree', []); return treeOf(''); },
  async list(p) { note('list', [p]); return treeOf(p).children; },
  async saveFile(p, text) { note('saveFile', [p, text]); files.set(p, text); return { status: 'saved', hash: `h:${text}`, mtime: 0 }; },
  async getState() { return {}; },
  async setState() {},
  async setTitle(t) { note('setTitle', [t]); },
  async log() {},
  async search(q) {
    note('search', [q]);
    const needle = String(q).toLowerCase();
    const hits = [...files].filter(([, t]) => t.toLowerCase().includes(needle)).map(([path]) => ({ path, line: 1, text: '' }));
    return { hits, files: hits.length, total: hits.length, capped: false, stale: false };
  },
  async versionKeep(p, text, opts) { note('versionKeep', [p, text, opts]); return { kept: true, id: 'v1' }; },
};

/** The in-memory vault, for assertions. */
export const vault = { files, dirs, bin, local };

/** Empty the vault and the call log, then add `seed` (`{ path: text }`; a path ending in `/` is a folder). */
export function reset(seed = {}) {
  files.clear();
  dirs.clear();
  failures.clear();
  bin.clear();
  local.app = {};
  local.vault = {};
  restorable = true;
  calls.length = 0;
  for (const [p, text] of Object.entries(seed)) {
    if (p.endsWith('/')) { dirs.add(p.slice(0, -1)); addDirs(p.slice(0, -1)); } else { files.set(p, text); addDirs(p); }
  }
}

/** `trash` answers `id: null` from now on (a platform whose bin cannot restore), or again an id. */
export function setRestorable(yes) { restorable = !!yes; }

/** The next call of `cmd` fails with `[code]`. */
export function fail(cmd, code = 'io') { failures.set(cmd, code); }

/** Fire a bridge event at the core's listeners; answers what they returned. */
export function emit(event, data) {
  return [...(listeners.get(event) || [])].map((fn) => fn(data));
}

/** The bridge calls made so far that change something, in order (a test's own log entries left out). */
export function writes() {
  const reads = new Set(['stat', 'exists', 'readText', 'readFile', 'tree', 'list', 'setTitle', 'search', 'trashWhere', 'trashList', 'localGet']);
  return calls.filter(([c]) => !reads.has(c) && typeof bridge[c] === 'function');
}

export class HostError extends Error {
  constructor(message, code = 'io', cmd = '') { super(message); this.code = code; this.cmd = cmd; }
}
export const hostError = (cmd, raw) => (raw instanceof HostError ? raw : new HostError(String(raw), 'io', cmd));
export const setEpoch = () => {};
export const currentEpoch = () => 1;
