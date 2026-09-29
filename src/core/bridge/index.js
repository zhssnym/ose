// Bridge facade. The one host is the browser: src/host/adapter.ts answers every command over the
// File System Access API (docs/HOST.md). The adapter implements `invoke(name, args) -> Promise`
// and `subscribe(fn({event, data}))`, and adds `win`, `platform` and `assetUrl` for what is not
// a host command. This file is the surface the adapter answers to. Nothing else imports it.
//
// Every method below is one host command, typed in ./commands.ts. A name the host does not have
// is `[unknown_command]`, a hard error: nothing here guesses what an older host might have
// answered.

/// <reference path="../globals.d.ts" />
/// <reference path="../../host/web.d.ts" />
import { bus } from '../registry.js';
import { HostError, hostError } from './errors.js';

export { HostError, hostError };

/** @typedef {import('../types.js').Adapter} Adapter */
/** @typedef {import('../types.js').AdapterWindow} AdapterWindow */
/** @typedef {import('./commands.ts').ReadFile} ReadFile */
/** @typedef {import('./commands.ts').SaveOutcome} SaveOutcome */
/** @typedef {import('./commands.ts').Created} Created */
/** @typedef {import('./commands.ts').OutsideFile} OutsideFile */
/** @typedef {import('./commands.ts').OpenRequest} OpenRequest */
/** @typedef {import('./commands.ts').RootInfo} RootInfo */
/** @typedef {import('./commands.ts').VaultInfo} VaultInfo */
/** @typedef {import('./commands.ts').RecentVault} RecentVault */
/** @typedef {import('./commands.ts').OpenVault} OpenVault */
/** @typedef {import('./commands.ts').WindowOpened} WindowOpened */
/** @typedef {import('./commands.ts').PlatformInfo} PlatformInfo */
/** @typedef {import('./commands.ts').Entry} Entry */
/** @typedef {import('./commands.ts').Stat} Stat */
/** @typedef {import('./commands.ts').SearchResult} SearchResult */
/** @typedef {import('./commands.ts').Trashed} Trashed */
/** @typedef {import('./commands.ts').TrashPlace} TrashPlace */
/** @typedef {import('./commands.ts').TrashItem} TrashItem */
/** @typedef {import('./commands.ts').Restored} Restored */
/** @typedef {import('./commands.ts').Copied} Copied */
/** @typedef {import('./commands.ts').Hashed} Hashed */
/** @typedef {import('./commands.ts').ReplaceOutcome} ReplaceOutcome */
/** @typedef {import('./commands.ts').DraftAt} DraftAt */
/** @typedef {import('./commands.ts').DraftInfo} DraftInfo */
/** @typedef {import('./commands.ts').Draft} Draft */
/** @typedef {import('./commands.ts').Dropped} Dropped */
/** @typedef {import('./commands.ts').Kept} Kept */
/** @typedef {import('./commands.ts').VersionInfo} VersionInfo */
/** @typedef {import('./commands.ts').RestoredVersion} RestoredVersion */


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
 * matter for `window {closing:true}` only, where a handler that resolves `false` means the page
 * cannot be left yet (the editor does that when the save needs an answer from the user). A
 * handler that throws is logged and counts as done; leaving must never hang on a bug.
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
  const mod = await import('../../host/adapter.ts');
  const a = /** @type {Adapter} */ (await mod.create());
  adapter = a;
  a.subscribe(dispatch);
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
  // An option left out is absent, not null: the adapter reads `forgetVault()` apart from
  // `forgetVault(null)`.
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
 * The vault epoch (docs/HOST.md "Identity: vaults, roots, epochs, tabs"): the host counts every vault a window adopts, and a
 * mutating call that carries an older count than the window's is refused with `[stale_vault]`
 * instead of landing in the vault that replaced it. The core sets it from `rootInfo` at boot;
 * every mutating call below adds it to its options struct, so no caller can forget it. Unknown
 * (no vault yet) means nothing is added.
 */
/** @type {number | null} */
let epoch = null;
/** Set by the core from `rootInfo`. @param {unknown} n */
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

// Window control is the adapter's own (a browser tab has its title and little else). None of it
// is a host command: what the adapter does not have does nothing and answers null.
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
 * Ose Web's `vault/` form before the adapter is ready (src/host/adapter.ts `assetUrlFor`, which
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

// Synchronous, and used in <img src> possibly before `ready` resolves; the adapter's own
// version takes over as soon as there is one.
const staticAssetUrl = webAssetUrl;

/**
 * A typed answer: the value `call` resolved, named as ./commands.ts declares it. A cast, not a
 * check: the host and the core ship together (M47), in one build.
 * @template T
 * @param {Promise<unknown>} p
 * @returns {Promise<T>}
 */
const as = (p) => /** @type {Promise<T>} */ (p);

export const bridge = {
  /** The one host there is: the browser, through src/host/adapter.ts. */
  kind: /** @type {'web'} */ ('web'),
  /** 'windows', 'macos' or 'linux', once the adapter has said; 'windows' until then. */
  get platform() { return platform.os; },
  ready,
  on,
  /** Any command by its name, positional arguments: what the methods below are made of. */
  call,

  /** -> RootInfo `{ root, name, epoch }` for this window. @returns {Promise<RootInfo>} */
  rootInfo: () => as(call('rootInfo')),
  // The vault itself (docs/HOST.md "Identity: vaults, roots, epochs, tabs"): `rootInfo` answers {root:null, name:null}
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
  // Listings (docs/HOST.md "The hide rule"): `opts { hidden }` lists hidden entries too
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
  // The file's bytes as base64 (docs/CORE.md `ose.files.readBinary`).
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

  // The per-machine store (docs/HOST.md "Machine-local state", W5): `app` for this machine, `vault`
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

  // Drafts (docs/HOST.md "Machine-local state"): the buffer a page could not write, per machine, outside
  // the vault. `draftRead` answers null when there is none, so it is the one that may.
  /** -> { at } @param {string} path @param {object} draft @param {object} [opts] @returns {Promise<DraftAt>} */
  draftWrite: (path, draft, opts) => as(valued('draftWrite', path, draft, withEpoch(opts))),
  /** -> DraftInfo[], newest first @returns {Promise<DraftInfo[]>} */
  draftList: () => as(valued('draftList')),
  /** -> Draft | null @param {string} path @returns {Promise<Draft | null>} */
  draftRead: (path) => as(call('draftRead', path)),
  /** opts { ifRev? } -> { dropped } @param {string} path @param {object} [opts] @returns {Promise<Dropped>} */
  draftDrop: (path, opts) => as(valued('draftDrop', path, withEpoch(opts))),

  // Versions (docs/HOST.md "Commands"): `.ose/history`, tiered. `opts` is `{ force?, reason? }`,
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

  // The tab's title (S13): "<page> — <vault>". Called by the router on every route change;
  // never rejects the caller's flow.
  /** @param {string} text */
  setTitle: (text) => winCall('setTitle', String(text ?? '')),

  /** @param {string} url @returns {Promise<null>} */
  openExternal: (url) => as(call('openExternal', url)),
  // A vault file in a browser tab, for the types a browser shows (batch 12, N10/N24).
  // Vault-relative, or a registered `abs:` path; never a program.
  /** @param {string} path @returns {Promise<null>} */
  openPath: (path) => as(call('openPath', path)),
  /** @returns {Promise<unknown>} */
  getState: () => call('getState'),
  // The whole state object, with the epoch: a write armed in the vault this window left (a
  // debounced save, the pagehide of the reload after an adopt) is refused, never landed in the
  // vault that replaced it.
  /** @param {unknown} obj @returns {Promise<null>} */
  setState: (obj) => as(call('setState', obj, withEpoch())),
  // `<stamp> <level> ui: <text>` in the host's log (docs/HOST.md "Machine-local state"). Never rejects: a log
  // line that cannot be written must not become an error of its own.
  /** @param {string} text @param {string} [level] */
  log: (text, level = 'info') => call('log', String(text ?? ''), level).catch(() => null),
};

if (typeof window !== 'undefined') window.__bridge = bridge; // debugging only
