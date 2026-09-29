// `ose:kernel` (docs/KERNEL.md). One object, composed from the files beside this one, and
// nothing else exported. The kernel never draws and knows no view and no file of the shell: it
// serves and it answers.
//
// Everything that touches the host is async and goes through `./bridge/index.js`. Everything
// that is a registry (commands, views, status, settings sections) lives in `./registry.js` and
// `./settings-core.js`. The router is `./router.js`, with the tabs' model in `./tabs.js`; it
// reaches the page editor and the folder view through `./pagehost.js`, so that `ose:editor`
// stays a separate bundle and the shell's folder view stays the shell's.
//
// There are no plugins any more (W2): Day, Week, Month and Journal are `ose:planner`, a module
// built into the app that registers through the same seams the shell does (views, commands,
// settings sections).

/// <reference path="./globals.d.ts" />
import { bus, store, commands, views, status, uid, debounce, esc } from './registry.js';
import { bridge, setEpoch, currentEpoch, HostError } from './bridge/index.js';
import * as router from './router.js';
import { leaveWindow, stayWindow, onLeave, abandonWindow } from './leave.js';
import { logLine, forwardErrors } from './log.js';
import * as fileops from './fileops.js';
import * as names from './names.js';
import * as linksLib from './links.js';
import { linkTarget, relativeHref } from './href.js';
import * as settingsCore from './settings-core.js';
import { patchState, stateCache, loadState, flushState } from './state.js';
import { themePref, setTheme, resolvedTheme, initTheme } from './theme.js';
import { KEYMAP, BODY_KEYS, shortcutFor, bindKey, comboLabel, initKeys } from './keys.js';
import { watch } from './watch.js';
import { setPageHost, setFolderHost, setPageList, pageList } from './pagehost.js';
import * as tabs from './tabs.js';
import * as session from './session.js';
import { local, loadLocal, flushLocal, migrateLocal } from './local.js';
import * as journal from './journal.js';
import * as focusLib from './focus.js';
import { toast, confirm } from './dialog.js';
import { initOpens } from './opens.js';
import { isOutside, absOf, MARKDOWN_EXTS, TEXT_EXTS, isMarkdownPath, isTextPath } from './paths.js';

// `ose:ui` is a facade over this bundle (see ./ui-surface.js): the names are exported here so
// there is one overlay stack, one toast queue and one icon set in a running Ose.
export * from './ui-surface.js';

/* ------------------------------------------------------------------------------- the stamp */

// Vite replaces these at build time (vite.config.js `define`). In the dev server they are the
// dev defaults, which is the honest answer there.
const VERSION = {
  kernel: typeof __OSE_VERSION__ === 'string' ? __OSE_VERSION__ : '0.0.0-dev',
  sha: typeof __OSE_SHA__ === 'string' ? __OSE_SHA__ : 'dev',
  short: typeof __OSE_SHORT__ === 'string' ? __OSE_SHORT__ : 'dev',
  date: typeof __OSE_DATE__ === 'string' ? __OSE_DATE__ : '',
};

/* ------------------------------------------------------------------------------- the assets */

// The kernel's assets are served beside the page (docs/KERNEL.md "Where the app is served"):
// the site's own origin, or the dev server's. No origin is spelled here.
const assets = {
  /** @param {string} name */
  url(name) {
    const base = typeof location !== 'undefined' ? location.origin : '';
    return `${base}/${String(name || '').replace(/^\/+/, '')}`;
  },
};

/* ---------------------------------------------------------------------------------- bytes */

/**
 * Base64 from the host as bytes; bytes or an array of numbers are taken as they are.
 * @param {unknown} v
 * @returns {Uint8Array}
 */
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  if (typeof v !== 'string') return new Uint8Array(0);
  const bin = atob(v);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Bytes (or an ArrayBuffer, or an array of numbers) as the base64 the host takes; a string is
 * taken to be base64 already.
 * @param {string | Uint8Array | ArrayBuffer | number[]} v
 */
function toBase64(v) {
  if (typeof v === 'string') return v;
  return fileops.bytesToBase64(v instanceof Uint8Array ? v : new Uint8Array(v));
}

/* --------------------------------------------------------------------------------- booting */

/** @type {{ root: string | null, name: string | null }} */
let vaultInfo = { root: null, name: null };

/** 'windows', 'macos' or 'linux', from the host at boot (`ose.platform`). */
let platformName = 'windows';

/**
 * The vault the host has open, and its epoch (docs/HOST.md "Identity: vaults, roots, epochs, tabs"). Read once at boot; after
 * that the epoch only moves forward with a reload, on purpose: a write that a page started
 * against the old vault must be refused by the host (`[stale_vault]`), not land in the new one.
 * The one exception is a window that had no vault at all (the first run's chooser): nothing
 * was open to protect, so the adopted vault's epoch is taken at once.
 */
async function readRoot() {
  const info = await bridge.rootInfo();
  vaultInfo = { root: (info && info.root) || null, name: (info && info.name) || null };
  if (info && Number.isFinite(info.epoch)) setEpoch(info.epoch);
  store.set('root', vaultInfo);
  return vaultInfo;
}

/**
 * After a pick or an open: take the new vault's epoch only when none was open (see above).
 * @template T
 * @param {T} answer
 * @returns {Promise<T>}
 */
async function adopted(answer) {
  const a = /** @type {{ root?: unknown } | null | undefined} */ (answer);
  if (a && a.root && !vaultInfo.root) {
    try { await readRoot(); } catch (e) { console.warn('[kernel] rootInfo', e); }
  }
  return answer;
}

/**
 * `ose.vault.open(path)`: the vault adopted in this window, or, when another window already has
 * it open, that window brought forward and `{ focused: true, label }` (X6). There are never two
 * windows on one vault.
 * @param {string} path
 */
async function openVault(path) {
  const r = await bridge.openVault(path);
  if (r && r.status === 'focused') return { focused: true, label: r.label };
  return adopted(r);
}

/**
 * `ose.files.openOutside(path, opts)`: a file anywhere on the machine, in a tab. The host
 * registers it for this window (X7) and answers where it is: a file inside this vault opens as
 * the vault file it is, a file elsewhere as an `abs:` page marked "outside vault", and a folder
 * outside the vault opens as a vault, in its own window (X6). `path` is a native absolute path
 * or an `abs:` one. -> Promise<boolean>, whether something opened.
 * @param {string} path
 * @param {{ line?: number, activate?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function openOutside(path, opts = {}) {
  const r = await bridge.outsideOpen(path);
  if (!r || !r.path) return false;
  if (r.kind === 'dir' && !r.inside) {
    await bridge.openVaultWindow(absOf(r.path));
    return true;
  }
  /** @type {import('./types.js').Route} */
  const route = r.kind === 'dir' ? { type: 'folder', path: r.path } : { type: 'page', path: r.path };
  if (route.type === 'page' && typeof opts.line === 'number' && opts.line > 0) route.line = opts.line;
  const t = await router.openTab(route, { reuse: true, activate: opts.activate !== false });
  return !!t.id;
}

// Every error nobody caught goes to the host log (M54), from the first line the kernel runs.
forwardErrors();

const ready = (async () => {
  await bridge.ready;
  // The host's own description of itself, and the vault it resolved. Neither throws the boot:
  // a kernel that cannot reach the host still answers, and the shell shows what it shows.
  try {
    const info = await bridge.platformInfo();
    if (info) {
      if (info.os) platformName = info.os === 'win' ? 'windows' : info.os === 'mac' ? 'macos' : String(info.os);
    }
  } catch (e) { console.warn('[kernel] platform', e); }
  journal.setPlatform(platformName);
  try { await loadState(); } catch (e) { console.warn('[kernel] state', e); }
  // The per-machine store (W5), and the one-time copy of what used to live in the synced state
  // file and belongs to the machine now: recent files, the sidebar, the reading settings.
  try { await loadLocal(); } catch (e) { console.warn('[kernel] local', e); }
  try { migrateLocal(stateCache(), [...settingsCore.MACHINE_KEYS]); } catch (e) { console.warn('[kernel] local migration', e); }
  session.initSession();
  try { focusLib.loadFocus(stateCache()); focusLib.initFocus(); } catch (e) { console.warn('[kernel] focus', e); }
  try { await readRoot(); } catch (e) { console.warn('[kernel] rootInfo', e); }
  // What the OS asks this window to open: taken once the first surface is up (./opens.js).
  initOpens();
})();

/* ------------------------------------------------------------------------ leaving (C5) */

// Closing the window through the app (`ose.window.close`, Ctrl+Q) goes through the same gate as
// a reload and a change of vault (./leave.js). The adapter awaits what this answers, and a
// `false` keeps the window. The router's own `closing` handler (unmount the view, flush the
// state file) stays beside it.
bridge.on('window', (d) => (d && d.closing ? leaveWindow('close') : undefined));

let abandoning = false;

commands.register({
  id: 'app.close-anyway', title: 'Close window without saving', group: 'app',
  hint: 'unsaved text stays in the recovered changes',
  // No `closing` fan-out: the user was told the page could not be saved and chose this. What
  // the hint promises is made true first: every handler is asked to keep its unsaved text as a
  // draft (`abandonWindow`), and when one could not, the user is asked again, by name, before
  // anything goes. The command is in the palette at any time, not only after a refusal, so
  // this is not a formality. The state file is flushed last; the drafts live outside the
  // window and survive it.
  run: async () => {
    if (abandoning) return false;
    abandoning = true;
    try {
      const lost = await abandonWindow();
      if (lost.length) {
        const names = [...new Set(lost.filter(Boolean))];
        const who = names.length === 1 ? names[0]
          : names.length ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
          : 'A page';
        const ok = await confirm({
          title: 'Close without saving?',
          body: `${who} ${names.length > 1 ? 'have' : 'has'} unsaved text that could not be kept anywhere. Closing now loses it.`,
          ok: 'Close and lose it',
          danger: true,
        });
        if (!ok) {
          logLine('close anyway: cancelled, unsaved text was not kept', 'warn');
          stayWindow();
          return false;
        }
      }
      logLine(lost.length ? 'close anyway: the window goes, and unsaved text with it' : 'close anyway: the window goes without saving', 'warn');
      try { await flushState(); } catch (e) { console.warn('[kernel] state', e); }
      try { await flushLocal(); } catch (e) { console.warn('[kernel] local', e); }
      return bridge.win.destroy();
    } finally {
      abandoning = false;
    }
  },
});

/** `ose.files.save` needs to be told what the file was: a hash, or null for "not there". */
function saveArgs(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!('expectedHash' in o)) {
    throw new HostError('files.save needs expectedHash: the hash readFile answered, or null for a new file', 'bad_arg', 'saveFile');
  }
  return o;
}

/**
 * One save through the facade. The host logs every outcome it reaches (saved, conflict,
 * failed); a refusal it may not have logged (a stale epoch, a transport error, an old host)
 * is logged here.
 */
async function saveThrough(path, text, opts) {
  try {
    return await bridge.saveFile(path, text, saveArgs(opts));
  } catch (err) {
    const e = /** @type {{ code?: string, message?: string }} */ (err);
    logLine(`files.save failed ${path}: ${(e && e.code) || 'io'} ${(e && e.message) || e}`, 'error');
    throw e;
  }
}

/** `opts` with the user's Show hidden setting as `hidden`, unless the caller named one (H16). */
function withHidden(opts) {
  const o = opts && typeof opts === 'object' ? { ...opts } : {};
  if (o.hidden === undefined) o.hidden = settingsCore.showHidden();
  return o;
}

/* ------------------------------------------------------------------------------- the object */

export const ose = {
  version: VERSION,
  /** 'windows', 'macos' or 'linux': what the host said at boot, 'windows' until then. */
  get platform() { return platformName; },
  ready,

  /** The one host there is: the browser (src/web/adapter.js). */
  host: 'browser',

  vault: {
    get root() { return vaultInfo.root; },
    get name() { return vaultInfo.name; },
    /**
     * `{root, name, remembered, source, exeDir, logPath}`; exeDir is the chooser's suggestion,
     * logPath the host's persistent log (the boot error page names it).
     */
    info: async () => {
      const [v, p] = await Promise.all([bridge.vaultInfo(), bridge.platformInfo().catch(() => null)]);
      return { ...(v || {}), exeDir: (p && p.exeDir) || null, logPath: (p && p.logPath) || null };
    },
    /**
     * The count of vaults the host has adopted, as this window read it at boot (docs/HOST.md
     * "Epoch"). Every mutating call carries it, and the host refuses one from an older vault.
     */
    get epoch() { return currentEpoch(); },
    /**
     * Kept for old callers. The host no longer switches a window's vault on its own (a second
     * launch asks instead: `onChangeRequested`), so it never fires.
     */
    onChange: (fn) => bridge.on('vault', (d) => (d && d.changed ? fn(d) : undefined)),
    /**
     * A second launch named another folder (C5). The host did not adopt it: `fn({root, name})`
     * decides, and the shell leaves the window (`ose.window.leave('vault-change')`) before it
     * opens the folder and reloads.
     */
    onChangeRequested: (fn) => bridge.on('vault', (d) => (d && d.requested ? fn({ root: d.root, name: d.name }) : undefined)),
    /**
     * The native folder picker. `{adopt:false}` only chooses (`{root, name}` with the normalised
     * path, nothing adopted and nothing recorded), for a caller that must leave the window
     * before it opens the folder; without it the choice is adopted, as before.
     */
    pick: (opts) => bridge.pickVault(opts).then(adopted),
    recent: () => bridge.recentVaults(),
    /**
     * Adopt `path` in this window, as before; or `{ focused: true, label }` when another window
     * has that vault open, which the host brought forward instead (X6).
     */
    open: (path) => openVault(path),
    forget: (path) => bridge.forgetVault(path),
  },

  /** Windows (X6, docs/KERNEL.md `ose.windows`): one per vault, never two on one. */
  windows: {
    /**
     * A window for the vault at `vaultPath` (a native folder path), or a new window with no
     * vault, which opens on the chooser. The window that already has the vault is brought
     * forward instead. -> `{ label, created }`
     * @param {string} [vaultPath]
     */
    open: (vaultPath) => bridge.openVaultWindow(vaultPath),
  },

  files: {
    /** True for an `abs:` path: a file outside the vault, opened where it is (X7). */
    isOutside: (path) => isOutside(path),
    openOutside: (path, opts) => openOutside(path, opts),
    /** The native open-file dialog: a native absolute path, or null when cancelled. */
    pick: (opts) => bridge.pickFile(opts),
    /**
     * A registered file outside the vault, copied byte for byte to the vault path `to`,
     * create-only (`[exists]`). -> { path, hash }
     */
    importOutside: (from, to) => bridge.importOutside(from, to),
    read: (path) => bridge.readText(path),
    write: (path, text) => bridge.writeText(path, text),
    append: (path, text) => bridge.appendText(path, text),
    // The host speaks base64 over the RPC; KERNEL.md promises bytes out and takes either in.
    readBinary: (path) => bridge.readBinary(path).then(toBytes),
    writeBinary: (path, bytes) => bridge.writeBinary(path, toBase64(bytes)),
    // Listings follow the user's Show hidden setting unless the caller says `{ hidden }` (H16).
    // What the host excludes (`.ose`, `.git`, the executable, temp files) is never listed.
    /** -> Entry[] `{ name, path, kind, ext, mtime, size, hidden, link?, readable? }`, folders first */
    list: (path, opts) => bridge.list(path, withHidden(opts)),
    /** -> the root Entry, `name` the vault's, with `children` */
    tree: (opts) => bridge.tree(withHidden(opts)),
    /** -> `{ exists, kind, mtime, size, hidden, link?, text? }`; `text` with `{ sniff: true }` */
    stat: (path, opts) => bridge.stat(path, opts),
    exists: (path) => bridge.exists(path),
    mkdir: (path) => bridge.mkdir(path),
    rename: (from, to) => bridge.rename(from, to),
    // The destination is the user's setting, not the caller's: `system` (the recycle bin) or
    // `vault` (`.trash` inside the vault). -> `{ id, where }` (`ose.fileops.trash` is the one
    // the app uses: it asks the open page first and writes the undo journal).
    trash: (path) => bridge.trash(path, { mode: settingsCore.trashMode() }),
    /** -> `{ where: 'system' | 'vault' }`: where `trash` would put `path`, for honest wording (M18). */
    trashWhere: (path) => bridge.trashWhere(path, { mode: settingsCore.trashMode() }),
    /** -> TrashItem[], newest first */
    trashList: () => fileops.trashList(),
    /** A file or a whole folder, bytes, create-only (`[exists]`). -> `{ path, files }` */
    copyPath: (from, to) => bridge.copyPath(from, to),
    open: (path) => bridge.openPath(path),
    assetUrl: (path) => bridge.assetUrl(path),

    // The save path (docs/KERNEL.md "Saving a file"). The host compares and writes in one call
    // under one lock, keeps the replaced bytes as a version, and answers a SaveOutcome; the
    // kernel adds the vault epoch to every mutating call. The hash is the host's: JavaScript
    // carries it from `readFile` to `save` and never computes one.
    /**
     * -> `{ text, hash, mtime, size, encoding, bom, lossy }`. A file that is not UTF-8 is
     * decoded from its own encoding (`encoding`, a WHATWG label); `lossy` says the decoding
     * would not write the same bytes back, and such a text must not be saved. `opts.encoding`
     * forces a decoding (X10).
     */
    readFile: (path, opts) => bridge.readFile(path, opts),
    /**
     * `opts { expectedHash: string|null, version?: 'save'|'conflict'|'none', encoding? }`, the
     * `encoding` `readFile` answered, so the file is written back in it -> SaveOutcome:
     * `{status:'saved', hash, mtime, unchanged?}` or `{status:'conflict', disk:{exists, text, hash}}`.
     * `expectedHash: null` means "the file must not exist yet". A conflict writes nothing.
     */
    save: (path, text, opts) => saveThrough(path, text, opts),
    /** Exclusive create, parent folders made; never overwrites (`[exists]`). -> { path, hash } */
    createNew: (path, text = '') => bridge.createNew(path, text),
    /**
     * The same exclusive create, written with its bytes in one call, so a failure leaves no
     * empty file behind. `bytes` as for `writeBinary`. -> { path, hash }
     */
    createNewBinary: (path, bytes) => bridge.createNewBinary(path, toBase64(bytes)),
    /** A byte copy under the same create-only rule. -> { path, hash } */
    copy: (from, to) => bridge.copyFile(from, to),
    /** One line at the end, with the separator and line ending the file needs. -> { hash } */
    appendLine: (path, line) => bridge.appendLine(path, line),
    /**
     * Line `index` (0-based) replaced by `next`, only if it still reads `expected`.
     * -> `{status:'replaced', hash}` | `{status:'conflict', actual}`
     */
    replaceLine: (path, index, expected, next) => bridge.replaceLine(path, index, expected, next),

    /**
     * Drafts (docs/KERNEL.md "Drafts", D5): the buffer a page could not write, kept per machine
     * outside the vault until a save that leaves the page clean drops it.
     */
    drafts: {
      /** `draft {text, baselineHash, mode, exact, rev}` -> { at } */
      write: (path, draft) => bridge.draftWrite(path, draft),
      /** -> DraftInfo[] for the open vault, newest first */
      list: () => bridge.draftList(),
      /** -> Draft | null */
      read: (path) => bridge.draftRead(path),
      /** `opts {ifRev}`: drop only a draft written at or before that edit. -> { dropped } */
      drop: (path, opts) => bridge.draftDrop(path, opts),
    },

    versions: {
      /** `opts`: `{ force?, reason? }`. -> { kept, id } */
      keep: (path, text, opts) => bridge.versionKeep(path, text, opts),
      /** -> VersionInfo[] `{id, at, bytes, reason, session}`, newest first */
      list: (path) => bridge.versionList(path),
      read: (path, id) => bridge.versionRead(path, id),
      /** The version back on disk, the current text kept first. -> { kept, id, hash } */
      restore: (path, id) => bridge.versionRestore(path, id),
    },
  },

  /**
   * File operations (docs/KERNEL.md `ose.fileops`, H12, C6): the one create, rename, move,
   * trash and duplicate. Each asks the open page first and touches nothing if it cannot let
   * go; none of them navigates.
   */
  fileops: {
    create: (folder, name, opts) => fileops.create(folder, name, opts),
    mkdir: (folder, name) => fileops.mkdir(folder, name),
    rename: (path, name) => fileops.rename(path, name),
    move: (paths, folder) => fileops.move(paths, folder),
    copy: (paths, folder) => fileops.copy(paths, folder),
    paste: (clip, folder) => fileops.paste(clip, folder),
    trash: (paths) => fileops.trash(paths),
    restore: (ids) => fileops.restore(ids),
    trashList: () => fileops.trashList(),
    duplicate: (path) => fileops.duplicate(path),
    /**
     * What the shell gathered from an OS drop, copied in byte for byte, one undo step (§5.5).
     * -> `{ created, failed, files, entry }`
     */
    importEntries: (entries, folder, opts) => fileops.importEntries(entries, folder, opts),
    /** The undo journal of file operations (M17): session memory, newest first. */
    journal: {
      list: () => journal.list(),
      canUndo: () => journal.canUndo(),
      undo: (id) => journal.undo(id),
      on: (fn) => journal.on(fn),
    },
  },

  /** File names (docs/KERNEL.md `ose.names`): literal, checked, never rewritten. */
  names: {
    split: (name) => names.split(name),
    check: (name, opts) => names.check(name, opts),
    free: (folder, name, opts) => names.free(folder, name, opts),
    extChanged: (a, b) => names.extChanged(a, b),
    /** The name the chrome shows: the real name, `.md` stripped only with `settings.hideMdExt`. */
    display: (path) => names.display(path),
  },

  watch,
  assets,

  /**
   * What a file is by its name (docs/KERNEL.md `ose.paths`): the one list of markdown and text
   * extensions the editor, the tree, the folder view, the palette and backlinks agree on.
   */
  paths: {
    markdownExts: MARKDOWN_EXTS,
    textExts: TEXT_EXTS,
    /** @param {string} path */
    isMarkdown: (path) => isMarkdownPath(path),
    /** @param {string} path */
    isText: (path) => isTextPath(path),
  },

  route: {
    current: () => router.currentRoute(),
    // navigate, back, forward and close answer Promise<boolean>: false when the page on screen
    // could not be left (its save failed or is waiting on a question), and then nothing moved.
    // `opts.tab`: 'current' (default), 'new', or a tab id (M23).
    navigate: (route, opts) => router.navigate(route, opts),
    back: () => router.back(),
    forward: () => router.forward(),
    canBack: () => router.canBack(),
    canForward: () => router.canForward(),
    /** Close the active tab (Ctrl+W); the last one goes Home. */
    close: (opts) => router.clearRoute(opts),
    reopenClosed: () => router.reopenClosedTab(),
    /** The route the last tab falls back to instead of the empty surface. */
    setHome: (route) => router.setHome(route),
    /** A file or folder moved and the page followed it: every tab, history and title re-pointed. */
    repoint: (moves) => router.repoint(moves),
    recent: () => router.recentFiles(),
    on: (fn) => router.onRoute(fn),
    // The shell mounts the router into its page column; nothing else may. `{ start: false }`
    // skips the empty surface the mount draws, for a shell that opens on a surface of its own.
    init: (el, opts) => router.initRouter(el, opts),
  },

  /** The tabs (M23): the kernel owns them, `shell/tabs.js` draws them. */
  tabs: {
    list: () => tabs.list(),
    active: () => tabs.active(),
    open: (route, opts) => tabs.open(route, opts),
    activate: (id) => tabs.activate(id),
    close: (id) => tabs.close(id),
    closeOthers: (id) => tabs.closeOthers(id),
    move: (id, index) => tabs.move(id, index),
    reopenClosed: () => tabs.reopenClosed(),
    on: (fn) => tabs.on(fn),
  },

  /** Session restore (H19): the tabs and their histories, per machine and per vault. */
  session: {
    snapshot: () => session.snapshot(),
    restore: (s) => session.restore(s),
  },

  /**
   * `ose.local(key)` -> `{ get(), set(value), flush() }`, per machine and per vault;
   * `ose.local.app(key)`, per machine for every vault (W5). Outside the vault, never synced.
   */
  local,

  commands,
  views,
  status,

  keys: {
    bind: (combo, commandId, opts) => bindKey(combo, commandId, opts),
    shortcutFor,
    defaults: () => KEYMAP.concat(BODY_KEYS),
    label: comboLabel,
  },

  settings: {
    get: () => settingsCore.settings(),
    set: (partial) => settingsCore.save(partial),
    on: (fn) => settingsCore.onSettings(fn),
    section: (def) => settingsCore.sections.register(def),
    sections: () => settingsCore.sections.list(),
    apply: () => settingsCore.applySettings(),
    zoom: settingsCore.zoom,
    setZoom: settingsCore.setZoom,
    onRepaint: settingsCore.onRepaint,
  },

  /**
   * `ose.state(key)` — the vault's own state in `.ose/state.json`, synced with it (pins, the
   * planner's paths, vault settings), one key per concern, written debounced. A dotted key is
   * a path into the object. What belongs to this machine is `ose.local`.
   */
  /** @param {string} key */
  state(key) {
    const path = String(key).split('.').filter(Boolean);
    /** @returns {unknown} */
    const readAt = () => path.reduce((/** @type {any} reason: a walk into untyped JSON */ o, k) => (o && typeof o === 'object' ? o[k] : undefined), stateCache());
    return {
      get: () => readAt(),
      /** @param {unknown} value */
      set(value) {
        const [rootKey, ...rest] = path;
        if (rootKey === undefined) return;
        if (!rest.length) { patchState({ [rootKey]: value }); return; }
        /** @type {Record<string, any>} */
        const next = { ...(stateCache()[rootKey] || {}) };
        let at = next;
        const last = /** @type {string} */ (rest.pop());
        for (const k of rest) { at[k] = { ...(at[k] || {}) }; at = at[k]; }
        at[last] = value;
        patchState({ [rootKey]: next });
      },
      flush: () => flushState(),
    };
  },

  bus,
  store,

  search: (query, opts = {}) => bridge.search(query, withHidden(opts)),

  links: {
    resolve: (fromPath, href) => linkTarget(fromPath, href),
    href: (fromPath, target) => relativeHref(fromPath, target),
    inbound: (path) => linksLib.findInbound(path),
    rewriteMoved: (pairs) => linksLib.rewriteInboundMany(pairs),
    /** -> Promise<[{ from, to, insert }]>: the splices a rewrite would make in `text` (H5). */
    planRewrite: (text, filePath, pairs, opts) => linksLib.planRewrite(text, filePath, pairs, opts),
  },

  theme: {
    get: () => themePref(),
    set: (next) => setTheme(next),
    resolved: () => resolvedTheme(),
    on: (fn) => bus.on('theme', fn),
  },

  /**
   * The markdown pages the shell offers: the page picker and the editor's `[[` menu ask here,
   * so both offer the same rows. The shell registers the list through `setPageList` (the
   * sidebar narrows it to the focused folder); with nothing registered the vault is walked.
   */
  async pages() {
    const provider = pageList();
    if (provider) return [...(await provider())];
    const out = [];
    const walk = (n) => {
      if (!n || !n.children) return;
      for (const c of n.children) {
        if (c.kind === 'dir') walk(c);
        else if (/\.md$/i.test(c.name)) out.push(c.path);
      }
    };
    walk(await bridge.tree());
    return out;
  },

  /**
   * The focused folder: what narrows the tree, the page list and where a new page is created.
   * The kernel keeps it because `ose.pages()` and `page.new` both need it; the sidebar UI
   * that sets it is the shell's.
   */
  focus: {
    get: () => focusLib.getFocus(),
    set: (path) => focusLib.setFocus(path),
    exit: () => focusLib.exitFocus(),
    name: () => focusLib.focusName(),
    isUnder: (path) => focusLib.isUnderFocus(path),
    defaultNewFolder: () => focusLib.defaultNewFolder(),
    on: (fn) => bus.on('focus', fn),
  },

  /** An http/https/mailto link inside a note. The host refuses every other scheme. */
  openExternal: (url) => bridge.openExternal(url),

  window: {
    title: (text) => bridge.setTitle(text),
    /** This window, through its close path: the `closing` handlers run, as for the OS button. */
    close: () => bridge.win.close(),
    /**
     * The window is closing. `fn()` may return a promise and the host **awaits it** before the
     * window is destroyed, so the open page's last save finishes; resolving `false` keeps the
     * window open, which is what the editor does when the save needs an answer from the user.
     * A handler that throws is logged and counts as done: the close must never hang on a bug.
     */
    onClose: (fn) => bridge.on('window', (d) => (d && d.closing ? fn(d) : undefined)),
    /**
     * The leave gate (C5, docs/KERNEL.md "Leaving the window"): `reason` is 'close', 'reload'
     * or 'vault-change'. Every `onLeave` handler is awaited; one `false` and the window stays
     * (a sticky notice says why) and this answers false. True leaves the pages frozen: the
     * caller goes, or calls `stay()`.
     */
    leave: (reason) => leaveWindow(reason),
    /** A successful `leave` whose caller changed its mind (the new vault would not open). */
    stay: () => stayWindow(),
    /** `fn({reason})` -> boolean | Promise<boolean>; false keeps the window. -> unsubscribe */
    onLeave: (fn) => onLeave(fn),
  },

  /**
   * One line in the host's log file, `<stamp> <level> ui: <text>` (docs/HOST.md "Machine-local state").
   * `level` is 'error', 'warn', 'info' (the default) or 'debug'. Never rejects.
   */
  /** @param {string} text @param {'error' | 'warn' | 'info' | 'debug'} [level] */
  log: (text, level = 'info') => { logLine(text, level); return Promise.resolve(null); },
  /**
   * `ose.reload()` (`app.reload`, "Reload window"; no chord since D8): the page again. It
   * leaves the window first (`window.leave('reload')`):
   * a page that cannot be saved keeps the window, and this answers false. `{skipLeave:true}`
   * is for a caller that has already left (Change vault). Answers true once the reload is on
   * its way. The app is served from where the window loaded it (X4), so the document reloads
   * itself, in the host as in a browser.
   * @param {{ skipLeave?: boolean }} [opts]
   */
  async reload(opts = {}) {
    if (!(opts && opts.skipLeave) && !(await leaveWindow('reload'))) return false;
    location.reload();
    return true;
  },

  /* The seams the shell fills: whoever draws a file, whoever draws a folder, and whoever knows
     the page list. All three are documented in ./pagehost.js; each is the shell's to call once. */
  setPageHost,
  setFolderHost,
  setPageList,

  /**
   * What the shell calls once, after its own surfaces exist: the key engine and the theme.
   * `start: false` mounts the router without drawing the empty surface, for a shell that opens
   * on a surface of its own and would otherwise flash the kernel's on every boot.
   */
  /** @param {{ page?: HTMLElement, keys?: boolean, theme?: boolean, start?: boolean }} [o] */
  init({ page, keys = true, theme = true, start = true } = {}) {
    if (theme) initTheme();
    if (keys) initKeys();
    if (page) router.initRouter(page, { start });
  },

  // Small shared helpers the shell would otherwise write again.
  uid,
  debounce,
  esc,
  toast,
};

if (typeof window !== 'undefined') {
  window.__ose = ose;   // debugging only, exactly as `window.__bridge` has always been
}

export default ose;
