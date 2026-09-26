// A bridge for the kernel tests: the methods src/kernel/bridge/index.js answers, over an
// in-memory vault, with every call written down in order. The kernel modules under test import
// `bridge` from './bridge/index.js'; each test file swaps that module for this one:
//
//   vi.mock('../../src/kernel/bridge/index.js', () => import('./fake-bridge.js'));
//
// Errors are thrown the way the real facade throws them (CONTRACT 4.2): an Error with `.code`.
// `fail(cmd, code)` makes the next call of `cmd` fail with that code.

const files = new Map();     // vault path -> text
const dirs = new Set();      // vault paths of folders
const failures = new Map();  // cmd -> code of the next failure
const listeners = new Map(); // event -> Set(fn)

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
  async trash(p, opts) {
    note('trash', [p, opts]);
    if (!files.has(p) && !dirs.has(p)) throw coded('not_found', `${p} not found`, 'trash');
    for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k);
    for (const d of [...dirs]) if (d === p || d.startsWith(p + '/')) dirs.delete(d);
  },
  async mkdir(p) { note('mkdir', [p]); dirs.add(p); addDirs(p); },
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
export const vault = { files, dirs };

/** Empty the vault and the call log, then add `seed` (`{ path: text }`; a path ending in `/` is a folder). */
export function reset(seed = {}) {
  files.clear();
  dirs.clear();
  failures.clear();
  calls.length = 0;
  for (const [p, text] of Object.entries(seed)) {
    if (p.endsWith('/')) { dirs.add(p.slice(0, -1)); addDirs(p.slice(0, -1)); } else { files.set(p, text); addDirs(p); }
  }
}

/** The next call of `cmd` fails with `[code]`. */
export function fail(cmd, code = 'io') { failures.set(cmd, code); }

/** Fire a bridge event at the kernel's listeners; answers what they returned. */
export function emit(event, data) {
  return [...(listeners.get(event) || [])].map((fn) => fn(data));
}

/** The bridge calls made so far that change something, in order (a test's own log entries left out). */
export function writes() {
  const reads = new Set(['stat', 'exists', 'readText', 'readFile', 'tree', 'list', 'setTitle', 'search']);
  return calls.filter(([c]) => !reads.has(c) && typeof bridge[c] === 'function');
}

export class HostError extends Error {
  constructor(message, code = 'io', cmd = '') { super(message); this.code = code; this.cmd = cmd; }
}
export const hostError = (cmd, raw) => (raw instanceof HostError ? raw : new HostError(String(raw), 'io', cmd));
export const setEpoch = () => {};
export const currentEpoch = () => 1;
