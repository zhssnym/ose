// The one door out of the editor bundle (round four, K1c).
//
// `ose:editor` is a library: it knows the kernel and nothing else. Every other file under
// `src/editor/` imports what it needs from here, so the whole bundle has exactly one place
// that names anything outside the folder — and `ose:kernel` and `ose:ui` are
// external to this bundle (vite.kernel.config.js), so there is one bridge, one overlay stack
// and one toast queue in a running Ose, never two.
//
// The names below are the ones the editor has always used: `bridge.readText(path)`,
// `commands`, `toast`. Renaming a thousand call sites would have been a refactor with no
// reader; what changed is which module answers. `bridge` here is a thin reading of
// `ose.files` under the shape the editor was written against, and nothing else in the folder
// knows there is an `ose` at all.

import { ose } from 'ose:kernel';
import {
  confirm, contextMenu, copyText, esc, fuzzy, highlight, icon, openOverlay, pageItems,
  pickPage, prompt, toast,
} from 'ose:ui';

export {
  confirm, contextMenu, copyText, esc, fuzzy, highlight, icon, openOverlay, pageItems,
  pickPage, prompt, toast,
};

export const bus = ose.bus;
/** Resolves when the kernel has the platform, the vault and the state (`ose.ready`). */
export const ready = ose.ready;
/** `{ root, name }` of the open vault, or nulls while none is open. */
export const vault = () => ({ root: ose.vault.root, name: ose.vault.name });
export const store = ose.store;
export const status = ose.status;
export const debounce = ose.debounce;

/** Every `.md` in the vault, as the shell's tree and focus folder see it (`ose.pages()`). */
export const allPages = () => ose.pages();
/** The paths the user opened last, newest first: the `[[` menu ranks by it. */
export const recentFiles = () => ose.route.recent();

export const navigate = (route, opts) => ose.route.navigate(route, opts);
export const clearRoute = (opts) => ose.route.close(opts);

/**
 * Where `page.new` writes (wave 2): the focused folder, else the folder on screen or the open
 * page's, else `''`, the vault root. There is no scratch folder any more.
 */
export const defaultNewFolder = () => ose.focus.defaultNewFolder();

export const findInbound = (path) => ose.links.inbound(path);

/**
 * The splices the kernel's link rewrite would make in `text`, the file at `path`, for the moves
 * `pairs` (`ose.links.planRewrite`, H5): `[{from, to, insert}]`, UTF-16 offsets into `text`.
 * `opts.settled` is the kernel's second pass. Resolves null on a kernel that has no planner, so
 * the caller can hand the file back to the disk path.
 */
export async function planRewrite(text, path, pairs, opts = {}) {
  const fn = ose.links && ose.links.planRewrite;
  if (typeof fn !== 'function') return null;
  const out = await fn(text, path, pairs, opts);
  return Array.isArray(out) ? out : [];
}
export const rewriteInbound = (from, to) => ose.links.rewriteMoved([[from, to]]);

/**
 * `path/to/a-page.md` -> `a-page.md`: the file's name as every surface shows it (W8, M20),
 * through `ose.names.display`, which strips `.md` only when `hideMdExt` is on. The backlinks
 * box labels a row with it.
 */
export const titleOf = (p) => {
  const base = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
  try {
    const fn = ose.names && ose.names.display;
    if (typeof fn === 'function') return fn(p) || base;
  } catch { /* the base name */ }
  return base;
};

/**
 * The window is about to go — closed, reloaded, or switched to another vault — and `fn` is
 * awaited first: `false` keeps it (docs/KERNEL.md `ose.window.onLeave`, C5). A kernel from
 * before the leave gate only knows the close, so that is all that is heard there.
 */
export const onWindowLeave = (fn) => (typeof ose.window.onLeave === 'function'
  ? ose.window.onLeave(fn)
  : ose.window.onClose(() => fn({ reason: 'close' })));

/**
 * Say where a page went without mounting anything (`ose.route.repoint`, C6): the tab, the
 * breadcrumb, back and forward and the window title follow a rename the page made itself.
 */
export const repointRoute = (moves) => {
  const fn = ose.route && ose.route.repoint;
  return typeof fn === 'function' ? fn(moves) : undefined;
};

/** Where the router is, or null. */
export const currentRoute = () => { try { return ose.route.current(); } catch { return null; } };

/**
 * The one implementation of create and rename (`ose.fileops`, H12/H13): the editor names a
 * file and never builds a path into the host. Null on a kernel that does not have it yet.
 */
export const fileops = () => ose.fileops || null;
/** `ose.names`: split, check and the free-name search, or null. */
export const names = () => ose.names || null;

/** One line in the app's log (`ose.log`, M54), mirrored to the console. Never throws. */
export function log(text, level = 'info') {
  const line = String(text);
  try {
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    out('[editor] ' + line);
  } catch { /* no console */ }
  try {
    const r = typeof ose.log === 'function' ? ose.log(line, level) : null;
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* a log that cannot be written is not an error of the page */ }
}

/** The chord a command answers to, as the menus print it. The key engine is the kernel's. */
export const shortcutFor = (commandId) => ose.keys.shortcutFor(commandId);

// ---------------------------------------------------------------------------
// settings the editor reads
//
// Three readings of `ose.settings.get()`, which is the whole hose: the editor is told what the
// user chose and decides what that means for a page. The keys are the ones the shell's settings
// dialog writes (docs/SHELL.md); each default is beside its reading below.

/** `spellcheck` on the body, on by default (S36). */
export const spellcheckOn = () => ose.settings.get().spellcheck !== false;

/**
 * `titleSync` (wave 2, M13): a page still named `Untitled` takes its H1 as its file name when
 * the title is left. Off by default: a file has one name, and it is the one on disk.
 */
export const titleSyncOn = () => ose.settings.get().titleSync === true;

/** One line for the trash confirmation, so it says where the file is going (S37). */
export const trashDestination = () =>
  (ose.settings.get().trash === 'vault' ? '.trash in the vault' : 'the system recycle bin');

/**
 * The folder an attachment dropped on `pagePath` belongs in (S35). Default: `attachments/`
 * beside the page, which is what the editor did before this was a setting. Otherwise the one
 * vault folder the user named, wherever the page lives. Always a vault-relative folder path,
 * never a leading slash.
 */
export function attachmentFolder(pagePath) {
  const s = ose.settings.get().attachments;
  if (typeof s === 'string' && s !== 'beside') return s.replace(/^\/+|\/+$/g, '');
  const dir = String(pagePath || '').replace(/[^/]*$/, '').replace(/\/+$/, '');
  return dir ? `${dir}/attachments` : 'attachments';
}

// ---------------------------------------------------------------------------
// the file system, under the name the editor uses

export const bridge = {
  readText: (path) => ose.files.read(path),
  writeText: (path, text) => ose.files.write(path, text),
  writeBinary: (path, base64) => ose.files.writeBinary(path, base64),
  exists: (path) => ose.files.exists(path),
  stat: (path) => ose.files.stat(path),
  list: (path) => ose.files.list(path),
  tree: () => ose.files.tree(),
  rename: (from, to) => ose.files.rename(from, to),
  // Where a deleted file goes is the user's setting, and the kernel applies it: the editor
  // says which file, never which bin.
  trash: (path) => ose.files.trash(path),
  reveal: (path) => ose.files.reveal(path),
  openPath: (path) => ose.files.open(path),
  openExternal: (url) => ose.openExternal(url),
  assetUrl: (path) => ose.files.assetUrl(path),
  // `opts` is `{force, reason}`, or the old boolean `force` (docs/HOST.md "Versions").
  versionKeep: (path, text, opts) => ose.files.versions.keep(path, text, opts),
  versionList: (path) => ose.files.versions.list(path),
  versionRead: (path, id) => ose.files.versions.read(path, id),
  versionRestore: (path, id) => ose.files.versions.restore(path, id),
};

// ---------------------------------------------------------------------------
// the page's own reads and writes (wave 1: C2, C4, M2)
//
// A page reads with the hash of what it read and writes against that hash, in one host call
// that compares and writes under one lock (`saveFile`); the host keeps the replaced bytes as a
// version. The hash is the host's: this side carries it and compares it by equality, nothing
// more. The epoch that stops a write landing in the wrong vault is added by the kernel.

/** Call `obj[key](...args)`, or reject `[unknown_command]` on a kernel that lacks it. */
async function hose(obj, key, name, args) {
  const fn = obj && obj[key];
  if (typeof fn !== 'function') {
    const e = new Error(`${name} is not available in this kernel`);
    e.code = 'unknown_command';
    e.cmd = name;
    throw e;
  }
  return fn.apply(obj, args);
}

const drafts = () => ose.files.drafts;

export const pageFiles = {
  /** `{text, hash, mtime, size}` of a vault file. */
  readFile: (path) => hose(ose.files, 'readFile', 'readFile', [path]),
  /** `SaveOutcome`: `{status:'saved', hash, mtime, unchanged?}` or `{status:'conflict', disk}`. */
  save: (path, text, opts) => hose(ose.files, 'save', 'saveFile', [path, text, opts]),
  /** `{path, hash}`; refuses with `[exists]`, never overwrites. */
  createNew: (path, text) => hose(ose.files, 'createNew', 'createNew', [path, text]),
  /** A version of `path` holding `text`: `opts` is `{force, reason}`. */
  keepVersion: (path, text, opts) => hose(ose.files.versions, 'keep', 'versionKeep', [path, text, opts]),
  drafts: {
    write: (path, draft) => hose(drafts(), 'write', 'draftWrite', [path, draft]),
    read: (path) => hose(drafts(), 'read', 'draftRead', [path]),
    drop: (path, opts) => hose(drafts(), 'drop', 'draftDrop', [path, opts]),
    list: () => hose(drafts(), 'list', 'draftList', []),
  },
};

// ---------------------------------------------------------------------------
// state
//
// `.ose/state.json` under the editor's own key, as every module gets it. `sourcePages` and
// `editor.last` are the two things the editor remembers between sessions.

const slot = ose.state('editor');

/** Merge into the editor's own subtree. Top-level keys of the old `patchState` are kept. */
export function patchState(partial) {
  slot.set({ ...(slot.get() || {}), ...(partial || {}) });
  return Promise.resolve();
}

/** The editor's state, read-only. `{}` before the kernel has loaded it. */
export function stateCache() {
  const v = slot.get();
  return v && typeof v === 'object' ? v : {};
}

// ---------------------------------------------------------------------------
// commands
//
// `ose.commands.register` answers the function that removes the command again, and every
// module inside the bundle registers through this object. `collectCommands` catches those
// answers so the page editor can put every command it owns — its own and its extensions' —
// back when the last page closes, which is what "registers on mount, removes on close" means
// for a module that never sees the extension modules' call sites.

/** @type {null | Array<() => void>} */
let collector = null;

export const commands = {
  register(cmd) {
    const off = ose.commands.register(cmd);
    if (collector) collector.push(off);
    return off;
  },
  run: (id, ...args) => ose.commands.run(id, ...args),
  get: (id) => ose.commands.get(id),
  list: () => ose.commands.list(),
};

/** Run `fn`, and answer one function that unregisters everything it registered. */
export function collectCommands(fn) {
  const before = collector;
  const mine = [];
  collector = mine;
  try { fn(); } finally { collector = before; }
  return () => {
    for (const off of mine) { try { off(); } catch (e) { console.error('[editor] unregister', e); } }
    mine.length = 0;
  };
}
