// The one door out of the editor bundle (round four, K1c).
//
// `ose:editor` is a library: it knows the kernel and nothing else. Every other file under
// `src/editor/` imports what it needs from here, so the whole bundle has exactly one place
// that names anything outside the folder — and `ose:kernel`, `ose:ui` and `ose:md` are
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

/** Where `page.new` writes: the focus folder, the `newPages` setting, the scratch folder. */
export const defaultNewFolder = () => ose.focus.defaultNewFolder();
/** The shell's scratch folder (`ose.paths`, owner `app`), or '' for the vault root. */
export const scratchFolder = () => ose.paths.of('app').peek('scratch') || '';

export const findInbound = (path) => ose.links.inbound(path);
export const rewriteInbound = (from, to) => ose.links.rewriteMoved([[from, to]]);

/** `path/to/a-page.md` -> `a-page`. The backlinks box labels a row with it. */
export const titleOf = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop().replace(/\.md$/i, '');

/** The window is closing: the handler's answer is awaited, and `false` keeps the window (B2). */
export const onWindowClose = (fn) => ose.window.onClose(fn);

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
  versionKeep: (path, text, force) => ose.files.versions.keep(path, text, force),
  versionList: (path) => ose.files.versions.list(path),
  versionRead: (path, id) => ose.files.versions.read(path, id),
  versionRestore: (path, id) => ose.files.versions.restore(path, id),
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
