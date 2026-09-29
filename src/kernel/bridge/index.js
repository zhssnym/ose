// Bridge facade. Picks the Tauri adapter inside the Tauri host, the Ose Web adapter in the web
// build (docs/WEB.md "The seam", `__OSE_WEB__`), the HTTP adapter in any other browser.
// Adapters implement `invoke(name, args) -> Promise` and `subscribe(fn({event, data}))`, and may
// add `win`, `platform`, `assetUrl` and `dragOut` for what is not a host command.
// This file is the surface every adapter answers to. Nothing else imports an adapter.
//
// Every method below is one typed host command (docs/HOST.md "Commands"): the Tauri adapter
// calls the function tauri-specta generated for it in `./bindings.ts`, the HTTP adapter posts
// the same name to the dev bridge. A name the host does not have is `[unknown_command]`, a hard
// error: nothing here guesses what an older host might have answered.

/// <reference path="../globals.d.ts" />
/// <reference path="../../web/web.d.ts" />
import { bus } from '../registry.js';
import { assetPath } from '../paths.js';
import { HostError, hostError } from './errors.js';

export { HostError, hostError };

/** @typedef {import('../types.js').Adapter} Adapter */
/** @typedef {import('../types.js').AdapterWindow} AdapterWindow */
/** @typedef {import('./bindings.ts').ReadFile} ReadFile */
/** @typedef {import('./bindings.ts').SaveOutcome} SaveOutcome */
/** @typedef {import('./bindings.ts').Created} Created */
/** @typedef {import('./bindings.ts').OutsideFile} OutsideFile */
/** @typedef {import('./bindings.ts').OpenRequest} OpenRequest */
/** @typedef {import('./bindings.ts').RootInfo} RootInfo */
/** @typedef {import('./bindings.ts').VaultInfo} VaultInfo */
/** @typedef {import('./bindings.ts').RecentVault} RecentVault */
/** @typedef {import('./bindings.ts').OpenVault} OpenVault */
/** @typedef {import('./bindings.ts').WindowOpened} WindowOpened */
/** @typedef {import('./bindings.ts').PlatformInfo} PlatformInfo */
/** @typedef {import('./bindings.ts').Entry} Entry */
/** @typedef {import('./bindings.ts').Stat} Stat */
/** @typedef {import('./bindings.ts').SearchResult} SearchResult */
/** @typedef {import('./bindings.ts').Trashed} Trashed */
/** @typedef {import('./bindings.ts').TrashPlace} TrashPlace */
/** @typedef {import('./bindings.ts').TrashItem} TrashItem */
/** @typedef {import('./bindings.ts').Restored} Restored */
/** @typedef {import('./bindings.ts').Copied} Copied */
/** @typedef {import('./bindings.ts').Hashed} Hashed */
/** @typedef {import('./bindings.ts').ReplaceOutcome} ReplaceOutcome */
/** @typedef {import('./bindings.ts').DraftAt} DraftAt */
/** @typedef {import('./bindings.ts').DraftInfo} DraftInfo */
/** @typedef {import('./bindings.ts').Draft} Draft */
/** @typedef {import('./bindings.ts').Dropped} Dropped */
/** @typedef {import('./bindings.ts').Kept} Kept */
/** @typedef {import('./bindings.ts').VersionInfo} VersionInfo */
/** @typedef {import('./bindings.ts').RestoredVersion} RestoredVersion */
/** @typedef {import('./bindings.ts').PdfOutcome} PdfOutcome */
/** @typedef {import('./bindings.ts').Shown} Shown */

const hasWindow = typeof window !== 'undefined';
const isTauri = hasWindow && !!window.__TAURI_INTERNALS__;
// The web build defines `__OSE_WEB__` true; the desktop build defines it false, so this branch
// and the adapter it imports drop out of `dist/`. Absent (the dev server, the tests): false.
const isWeb = typeof __OSE_WEB__ !== 'undefined' && __OSE_WEB__ === true && !isTauri;

/** The platform the adapter reported, read by `bridge.platform`. */
const platform = { os: 'windows' };

/** @type {Map<string, Set<(data: any) => unknown>>} event -> handlers */
const listeners = new Map();
/**
 * @param {string} event
 * @param {(data: any) => unknown} fn
 * @returns {() => void}
 */
function on(event, fn) {
  let set = listeners.get(event);
  if (!set) { set = new Set(); listeners.set(event, set); }
  set.add(fn);
  return () => { listeners.get(event)?.delete(fn); };
}
/**
 * Fan an event out and hand every handler's return value back to the adapter. The values
 * matter for one event only: on `window {closing:true}` the Tauri adapter awaits whatever
 * promises come back (the editor's last save, the router's state flush) before it destroys
 * the window, and a handler that resolves `false` keeps the window open — the editor does
 * that when the save needs an answer from the user. A handler that throws is logged and
 * counts as done; the close must never hang on a bug.
 * @param {{ event: string, data: any }} msg
 * @returns {unknown[]}
 */
function dispatch({ event, data }) {
  /** @type {unknown[]} */
  const results = [];
  const set = listeners.get(event);
  if (set) {
    for (const fn of [...set]) {
      try { results.push(fn(data)); } catch (e) { console.error(`[bridge:${event}]`, e); }
    }
  }
  if (event === 'fs') bus.emit('fs', data);
  return results;
}

/** @type {Adapter | null} */
let adapter = null;
/** @type {Promise<Adapter>} */
const ready = (async () => {
  /** @type {{ create: () => Promise<unknown> }} */
  let mod;
  // The build flag first, alone, so the desktop build folds it to false and drops the import.
  if (typeof __OSE_WEB__ !== 'undefined' && __OSE_WEB__ === true && !isTauri) mod = await import('../../web/adapter.js');
  else if (isTauri) mod = await import('./tauri.js');
  else mod = await import('./http.js');
  const a = /** @type {Adapter} */ (await mod.create());
  adapter = a;
  a.subscribe(dispatch);
  // Only the Tauri host reports one; 'windows' stays right for the browser.
  if (a.platform) platform.os = a.platform;
  return a;
})();

/**
 * One host command: `adapter.invoke(name, args)`, every refusal a HostError.
 * The answer is `unknown` on purpose: each method below names its type from the bindings, so
 * a field the host does not send is a type error, not a silent `undefined`.
 * @param {string} cmd
 * @param {...unknown} args
 * @returns {Promise<unknown>}
 */
const call = async (cmd, ...args) => {
  // An option left out is absent, not null: the dev bridge reads `forgetVault()` apart from
  // `forgetVault(null)`, and a typed command reads a missing trailing argument as None.
  while (args.length && args[args.length - 1] === undefined) args.pop();
  const a = await ready;
  try {
    return await a.invoke(cmd, args);
  } catch (e) {
    throw hostError(cmd, e);
  }
};

/**
 * The commands whose answer is always a value (docs/HOST.md). A `null` from `saveFile` read as
 * a successful write is exactly the failure that must never happen, so for these no answer is
 * an error. With typed commands the host cannot answer null to them; this stays as the belt.
 * @param {string} cmd
 * @param {...unknown} args
 * @returns {Promise<unknown>}
 */
const valued = async (cmd, ...args) => {
  const r = await call(cmd, ...args);
  if (r === null || r === undefined) throw new HostError(`the host does not answer ${cmd}`, 'unknown_command', cmd);
  return r;
};

/**
 * The vault epoch (docs/HOST.md "Epoch"): the host counts every vault a window adopts, and a
 * mutating call that carries an older count than the window's is refused with `[stale_vault]`
 * instead of landing in the vault that replaced it. The kernel sets it from `rootInfo` at boot;
 * every mutating call below adds it to its options struct, so no caller can forget it. Unknown
 * (no vault yet) means nothing is added.
 */
/** @type {number | null} */
let epoch = null;
/** Set by the kernel from `rootInfo`. @param {unknown} n */
export function setEpoch(n) { epoch = typeof n === 'number' && Number.isFinite(n) ? n : null; }
/** The current epoch, or null. */
export function currentEpoch() { return epoch; }
/**
 * `opts` with the epoch added, unless the caller named one.
 * @param {unknown} [opts]
 * @returns {Record<string, any>}
 */
const withEpoch = (opts) => {
  /** @type {Record<string, any>} */
  const o = opts && typeof opts === 'object' ? { ...opts } : {};
  if (epoch !== null && o.epoch === undefined) o.epoch = epoch;
  return o;
};

// Window control is the adapter's own (Tauri's window API; a browser tab has only its title).
// None of it is a host command: what an adapter does not have does nothing and answers null.
/**
 * @param {keyof AdapterWindow} name
 * @param {...unknown} args
 * @returns {Promise<unknown>}
 */
const winCall = async (name, ...args) => {
  const a = await ready;
  const own = a.win && a.win[name];
  return typeof own === 'function' ? /** @type {(...x: unknown[]) => unknown} */ (own)(...args) : null;
};

/**
 * Ose Web's `vault/` form before the adapter is ready (src/web/adapter.js `assetUrlFor`, which
 * takes over once it is): `./vault/<vaultId>/<path>` beside the page, the tab's vault from
 * sessionStorage. An `abs:/web/<id>/<name>` file is `./vault/~abs/<id>/<name>`.
 * @param {string} path
 */
const webAssetUrl = (path) => {
  const s = String(path ?? '');
  const out = /^abs:\/web\/([0-9a-f]{16})\/([^/]+)$/.exec(s);
  let id = null;
  try { id = sessionStorage.getItem('ose.web.vault'); } catch { /* storage refused */ }
  const rel = out
    ? `vault/~abs/${out[1]}/${encodeURIComponent(out[2] || '')}`
    : `vault/${id || '_'}/${s.replace(/^\.?\//, '').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  try { return new URL(rel, new URL('./', location.href)).href; } catch { return `./${rel}`; }
};

// Synchronous, and used in <img src> possibly before `ready` resolves, so the origin comes from
// the detected host; the adapter's own version takes over as soon as there is one.
/** @param {string} path */
const staticAssetUrl = (path) => {
  const p = assetPath(path);
  if (isTauri) return /windows/i.test(navigator?.userAgent || '') ? `http://vault.localhost/${p}` : `vault://localhost/${p}`;
  if (isWeb) return webAssetUrl(path);
  return `/vault/${p}`;
};

/**
 * A typed answer: the value `call` resolved, named as the bindings declare it. A cast, not a
 * check: the host and the kernel ship together (M47), and `bindings.ts` is generated from the
 * host's own structs.
 * @template T
 * @param {Promise<unknown>} p
 * @returns {Promise<T>}
 */
const as = (p) => /** @type {Promise<T>} */ (p);

export const bridge = {
  /** @type {'tauri' | 'http' | 'web'} */
  kind: /** @type {'tauri' | 'http' | 'web'} */ (isTauri ? 'tauri' : isWeb ? 'web' : 'http'),
  /** 'windows', 'macos' or 'linux', once the adapter has said; 'windows' until then. */
  get platform() { return platform.os; },
  ready,
  on,
  /** Any command by its name, positional arguments: what the methods below are made of. */
  call,

  /** -> RootInfo `{ root, name, epoch }` for this window. @returns {Promise<RootInfo>} */
  rootInfo: () => as(call('rootInfo')),
  // The vault itself (docs/HOST.md "The vault root"): `rootInfo` answers {root:null, name:null}
  // while no vault is open; `pickVault` opens the native folder picker and adopts the choice;
  // `vaultInfo` adds where the root came from; `forgetVault` drops the remembered root.
  /** @returns {Promise<VaultInfo>} */
  vaultInfo: () => as(call('vaultInfo')),
  // `opts` {adopt}: `{adopt:false}` only chooses the folder, and the caller adopts it with
  // `openVault` once the window has let go of the old one (docs/HOST.md `pickVault`).
  /** @param {{ adopt?: boolean }} [opts] @returns {Promise<{ root: string, name: string, epoch?: number | null } | null>} */
  pickVault: (opts) => as(call('pickVault', opts)),
  // The vaults this machine has opened, newest first, at most ten (S46): `recentVaults` lists
  // them, `openVault` adopts one without a dialog, and `forgetVault(path)` drops one line.
  // `forgetVault()` with no path still means "stop remembering a root at all".
  /** @returns {Promise<RecentVault[]>} */
  recentVaults: () => as(call('recentVaults')),
  /**
   * -> `{ status: 'adopted', root, name, epoch }`, or `{ status: 'focused', label }` when that
   * vault is open in another window, which the host brought forward (X6).
   * @param {string} path
   * @returns {Promise<OpenVault>}
   */
  openVault: (path) => as(valued('openVault', path)),
  /**
   * A window for `path` (a vault folder), or a new window with no vault. The host focuses the
   * window that already has it. -> `{ label, created }`
   * @param {string} [path]
   * @returns {Promise<WindowOpened>}
   */
  openVaultWindow: (path) => as(valued('openVaultWindow', path)),
  /** @param {string} [path] @returns {Promise<null>} */
  forgetVault: (path) => as(call('forgetVault', path)),
  // The host's own description of itself: {os, version, exe, exeDir, root, logPath, build,
  // dragIcon}. The chooser names `exeDir` as its suggestion; drag out uses `dragIcon`.
  /** @returns {Promise<PlatformInfo>} */
  platformInfo: () => as(call('platform')),
  // Listings (docs/HOST.md "The one hide rule"): `opts { hidden }` lists hidden entries too
  // (a dotfile, or the OS hidden attribute); what is excluded (`.ose`, `.git`, the exe, temp
  // files) is never listed. The facade passes the user's Show hidden setting when the caller
  // names none. `stat` with `{ sniff: true }` adds `text`: whether the file reads as text.
  /** @param {{ hidden?: boolean }} [opts] @returns {Promise<Entry>} */
  tree: (opts) => as(call('tree', opts)),
  /** @param {string} path @param {{ hidden?: boolean }} [opts] @returns {Promise<Entry[]>} */
  list: (path, opts) => as(call('list', path, opts)),
  /** @param {string} path @param {{ sniff?: boolean }} [opts] @returns {Promise<Stat>} */
  stat: (path, opts) => as(call('stat', path, opts)),
  /** @param {string} path @returns {Promise<boolean>} */
  exists: (path) => as(call('exists', path)),
  /** @param {string} path @returns {Promise<string>} */
  readText: (path) => as(call('readText', path)),
  /** @param {string} path @param {string} text @param {object} [opts] @returns {Promise<null>} */
  writeText: (path, text, opts) => as(call('writeText', path, text, withEpoch(opts))),
  /** @param {string} path @param {string} text @param {object} [opts] @returns {Promise<null>} */
  appendText: (path, text, opts) => as(call('appendText', path, text, withEpoch(opts))),
  /** @param {string} path @param {string} base64 @param {object} [opts] @returns {Promise<null>} */
  writeBinary: (path, base64, opts) => as(call('writeBinary', path, base64, withEpoch(opts))),
  // The file's bytes as base64 (docs/KERNEL.md `ose.files.readBinary`).
  /** @param {string} path @returns {Promise<string>} */
  readBinary: (path) => as(call('readBinary', path)),
  /** @param {string} path @param {object} [opts] @returns {Promise<null>} */
  mkdir: (path, opts) => as(call('mkdir', path, withEpoch(opts))),
  /** @param {string} from @param {string} to @param {object} [opts] @returns {Promise<null>} */
  rename: (from, to, opts) => as(call('rename', from, to, withEpoch(opts))),
  // `mode`: 'system' (the recycle bin, the default) or 'vault' (`.trash` inside the vault),
  // from settings (S37). The same object carries the epoch. -> `{ id, where }`: `id` is what
  // `trashRestore` takes, null where the platform cannot restore.
  /**
   * @param {string} path
   * @param {{ mode?: string }} [opts]
   * @returns {Promise<{ id: string | null, where: 'system' | 'vault' }>}
   */
  trash: async (path, opts) => {
    const r = /** @type {Trashed} */ (await valued('trash', path, withEpoch(opts)));
    return { id: r.id ?? null, where: r.where === 'vault' ? 'vault' : 'system' };
  },
  /**
   * -> `{ where: 'system' | 'vault' }`, where `trash` would put `path` with the current mode.
   * @param {string} path @param {{ mode?: string }} [opts]
   * @returns {Promise<TrashPlace>}
   */
  trashWhere: (path, opts) => as(valued('trashWhere', path, opts)),
  /** -> TrashItem[], newest first: what can be restored, inside the open vault. @returns {Promise<TrashItem[]>} */
  trashList: () => as(valued('trashList')),
  /**
   * -> `{ restored: [{id, path}], failed: [{id, error}] }`. Never overwrites (`[exists]`).
   * @param {string[]} ids @param {object} [opts]
   * @returns {Promise<Restored>}
   */
  trashRestore: (ids, opts) => as(valued('trashRestore', ids, withEpoch(opts))),
  /**
   * A file or a whole folder, bytes, create-only, links copied as links. -> `{ path, files }`
   * @param {string} from @param {string} to @param {object} [opts]
   * @returns {Promise<Copied>}
   */
  copyPath: (from, to, opts) => as(valued('copyPath', from, to, withEpoch(opts))),
  /** @param {string} query @param {object} [opts] @returns {Promise<SearchResult>} */
  search: (query, opts = {}) => as(call('search', query, opts)),

  // The per-machine store (docs/HOST.md "Local state", W5): `app` for this machine, `vault`
  // for this machine and the open vault. Outside the vault, never synced. `localGet` answers
  // `{}` when there is nothing; `localSet` writes the whole object (at most 1 MB).
  /** -> object @param {'app' | 'vault'} scope @returns {Promise<unknown>} */
  localGet: (scope) => valued('localGet', scope),
  /** -> null. The vault scope carries the epoch. @param {'app' | 'vault'} scope @param {unknown} value @param {object} [opts] @returns {Promise<null>} */
  localSet: (scope, value, opts) => as(call('localSet', scope, value, scope === 'vault' ? withEpoch(opts) : (opts || {}))),

  // The save path (docs/HOST.md "saveFile"). The JS side never computes a hash: it carries
  // the one `readFile` answered and hands it back as `expectedHash`, and the host compares and
  // writes in one call under one lock. Every one of these answers a value.
  /**
   * -> `{ text, hash, mtime, size, encoding, bom, lossy }`. `opts.encoding` forces a decoding
   * (a WHATWG label), for "Reopen with encoding…".
   * @param {string} path
   * @param {{ encoding?: string }} [opts]
   * @returns {Promise<ReadFile>}
   */
  readFile: (path, opts) => as(valued('readFile', path, opts)),
  /**
   * `opts { expectedHash: string|null, version?: 'save'|'conflict'|'none', encoding? }`
   * @param {string} path @param {string} text @param {{ expectedHash?: string | null, version?: string, encoding?: string }} [opts]
   * @returns {Promise<SaveOutcome>}
   */
  saveFile: (path, text, opts = {}) => as(valued('saveFile', path, text, withEpoch(opts))),
  /**
   * Exclusive create; never overwrites. -> { path, hash }
   * @param {string} path @param {string} [text] @param {object} [opts]
   * @returns {Promise<Created>}
   */
  createNew: (path, text = '', opts) => as(valued('createNew', path, text, withEpoch(opts))),
  /**
   * Exclusive create written with its bytes in one call: a failure leaves no empty file.
   * @param {string} path @param {string} base64 @param {object} [opts]
   * @returns {Promise<Created>}
   */
  createNewBinary: (path, base64, opts) => as(valued('createNewBinary', path, base64, withEpoch(opts))),
  /**
   * A byte copy under the same create-only rule. -> { path, hash }
   * @param {string} from @param {string} to @param {object} [opts]
   * @returns {Promise<Created>}
   */
  copyFile: (from, to, opts) => as(valued('copyFile', from, to, withEpoch(opts))),
  /**
   * A registered file outside the vault (`abs:`), copied byte for byte to a vault path,
   * create-only. -> { path, hash }
   * @param {string} from @param {string} to @param {object} [opts]
   * @returns {Promise<Created>}
   */
  importOutside: (from, to, opts) => as(valued('importOutside', from, to, withEpoch(opts))),
  /**
   * One line, with the separator the file needs; no `\n` in `line`. -> { hash }
   * @param {string} path @param {string} line @param {object} [opts]
   * @returns {Promise<Hashed>}
   */
  appendLine: (path, line, opts) => as(valued('appendLine', path, line, withEpoch(opts))),
  /**
   * -> { status:'replaced', hash } | { status:'conflict', actual }
   * @param {string} path @param {number} index @param {string} expected @param {string} next @param {object} [opts]
   * @returns {Promise<ReplaceOutcome>}
   */
  replaceLine: (path, index, expected, next, opts) => as(valued('replaceLine', path, index, expected, next, withEpoch(opts))),

  // Files outside the vault and OS opens (X7, §5.3).
  /**
   * Register a file outside the vault for this window (idempotent). A path inside this
   * window's vault answers its vault path with `inside: true`.
   * @param {string} path native absolute, or `abs:`
   * @returns {Promise<OutsideFile>}
   */
  outsideOpen: (path) => as(valued('outsideOpen', path)),
  /** -> OpenRequest[]: what the OS asked this window to open, emptied. @returns {Promise<OpenRequest[]>} */
  takeOpens: () => as(valued('takeOpens')),
  /**
   * The native open-file dialog. -> a native absolute path, or null when cancelled.
   * @param {{ title?: string }} [opts]
   * @returns {Promise<string | null>}
   */
  pickFile: (opts) => as(call('pickFile', opts)),

  // Drafts (docs/HOST.md "Drafts"): the buffer a page could not write, per machine, outside
  // the vault. `draftRead` answers null when there is none, so it is the one that may.
  /** -> { at } @param {string} path @param {object} draft @param {object} [opts] @returns {Promise<DraftAt>} */
  draftWrite: (path, draft, opts) => as(valued('draftWrite', path, draft, withEpoch(opts))),
  /** -> DraftInfo[], newest first @returns {Promise<DraftInfo[]>} */
  draftList: () => as(valued('draftList')),
  /** -> Draft | null @param {string} path @returns {Promise<Draft | null>} */
  draftRead: (path) => as(call('draftRead', path)),
  /** opts { ifRev? } -> { dropped } @param {string} path @param {object} [opts] @returns {Promise<Dropped>} */
  draftDrop: (path, opts) => as(valued('draftDrop', path, withEpoch(opts))),

  // Versions (docs/HOST.md "Versions"): `.ose/history`, tiered. `opts` is `{ force?, reason? }`,
  // and carries the epoch like every other write. The host names the files; nothing here
  // builds a path into the history folder.
  /** -> { kept, id } @param {string} path @param {string} text @param {{ force?: boolean, reason?: string }} [opts] @returns {Promise<Kept>} */
  versionKeep: (path, text, opts) => as(valued('versionKeep', path, text, withEpoch(opts))),
  /** -> VersionInfo[], newest first @param {string} path @returns {Promise<VersionInfo[]>} */
  versionList: (path) => as(valued('versionList', path)),
  /** @param {string} path @param {string} id @returns {Promise<string | null>} */
  versionRead: (path, id) => as(call('versionRead', path, id)),
  /** -> { kept, id, hash } @param {string} path @param {string} id @param {object} [opts] @returns {Promise<RestoredVersion>} */
  versionRestore: (path, id, opts) => as(valued('versionRestore', path, id, withEpoch(opts))),
  /** @param {string} path */
  assetUrl: (path) => (adapter && adapter.assetUrl ? adapter.assetUrl(path) : staticAssetUrl(path)),

  /**
   * Native absolute paths dragged out of the window as copies (X8, `tauri-plugin-drag`).
   * Answers false where the host cannot (a browser), true once the drag has started.
   * @param {string[]} paths
   * @param {string | null} icon
   * @returns {Promise<boolean>}
   */
  dragOut: async (paths, icon) => {
    const a = await ready;
    if (typeof a.dragOut !== 'function') return false;
    return a.dragOut(paths, icon);
  },

  win: {
    // Through the close path, so the `closing` handlers run as for the OS button.
    close: () => winCall('close'),
    /** @param {string} theme */
    setTheme: (theme) => winCall('setTheme', theme),
    /** @param {string} text */
    setTitle: (text) => winCall('setTitle', text),
    // The window goes, without the `closing` fan-out: `app.close-anyway` only, after the user
    // said so. Drafts are outside the window and survive it.
    destroy: () => winCall('destroy'),
  },

  // The window's own title (S13): "<page> — <vault>" in the host, the tab title in a browser.
  // Called by the router on every route change; never rejects the caller's flow.
  /** @param {string} text */
  setTitle: (text) => winCall('setTitle', String(text ?? '')),
  // Quit through the close path of every window, so each editor's last save is awaited exactly
  // as it is when the window's close button is pressed (S16).
  /** @returns {Promise<null>} */
  quit: () => as(call('quit')),

  // Paper (docs/HOST.md "Print"). `printToPdf` writes the file and resolves with {path, bytes}
  // once it is on disk, or with {cancelled:true} when the save dialog was cancelled; with no
  // `path` the host asks where, `opts` being {name, folder} for that dialog. `showPrintUI`
  // opens the system print dialog and returns at once.
  /** @param {string | null | undefined} path @param {{ name?: string, folder?: string }} [opts] @returns {Promise<PdfOutcome>} */
  printToPdf: (path, opts = {}) => as(call('printToPdf', path ?? null, opts)),
  /** @returns {Promise<Shown>} */
  showPrintUI: () => as(call('showPrintUI')),

  /** @param {string} url @returns {Promise<null>} */
  openExternal: (url) => as(call('openExternal', url)),
  /** @param {string} path @returns {Promise<null>} */
  reveal: (path) => as(call('reveal', path)),
  // A file in the platform's default application (batch 12, N10/N24). Vault-relative, or a
  // registered `abs:` path; `openExternal` keeps refusing every unknown scheme.
  /** @param {string} path @returns {Promise<null>} */
  openPath: (path) => as(call('openPath', path)),
  /** @returns {Promise<unknown>} */
  getState: () => call('getState'),
  // The whole state object, with the epoch: a write armed in the vault this window left (a
  // debounced save, the pagehide of the reload after an adopt) is refused, never landed in the
  // vault that replaced it.
  /** @param {unknown} obj @returns {Promise<null>} */
  setState: (obj) => as(call('setState', obj, withEpoch())),
  // `<stamp> <level> ui: <text>` in the host's log (docs/HOST.md "Log"). Never rejects: a log
  // line that cannot be written must not become an error of its own.
  /** @param {string} text @param {string} [level] */
  log: (text, level = 'info') => call('log', String(text ?? ''), level).catch(() => null),
};

if (hasWindow) window.__bridge = bridge; // debugging only
