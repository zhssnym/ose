// Bridge facade. Picks the Tauri adapter inside the Tauri host, the WebView2 adapter inside the
// .NET host, the HTTP adapter in a browser.
// Adapters implement `call(cmd, args) -> Promise` and `subscribe(fn({event, data}))`, and may
// add `win`, `platform` and `assetUrl` when the host does not route those through the RPC.
// This file is the surface every adapter answers to. Nothing else imports an adapter.

import { bus } from '../registry.js';

const hasWindow = typeof window !== 'undefined';
const isTauri = hasWindow && !!window.__TAURI_INTERNALS__;
const isWebView = hasWindow && !isTauri && !!window.chrome?.webview?.postMessage;

const listeners = new Map(); // event -> Set(fn)
function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
/**
 * Fan an event out and hand every handler's return value back to the adapter. The values
 * matter for one event only: on `window {closing:true}` the Tauri adapter awaits whatever
 * promises come back (the editor's last save, the router's state flush) before it destroys
 * the window, and a handler that resolves `false` keeps the window open — the editor does
 * that when the save needs an answer from the user. A handler that throws is logged and
 * counts as done; the close must never hang on a bug.
 */
function dispatch({ event, data }) {
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

let adapter = null;
const ready = (async () => {
  const mod = isTauri ? await import('./tauri.js')
    : isWebView ? await import('./webview.js')
      : await import('./http.js');
  adapter = await mod.create();
  adapter.subscribe(dispatch);
  // Only the Tauri host reports one; 'windows' stays right for the other two.
  if (adapter.platform) bridge.platform = adapter.platform;
  return adapter;
})();

/**
 * A host refusal as the rest of the app reads it (docs/HOST.md "Errors"): the host answers
 * `[code] message`, and the caller gets an `Error` whose `message` is the text after the code,
 * `.code` the code (`io` when the host gave none, or the transport failed) and `.cmd` the rpc
 * name. `String(e)` is the message alone, so a toast that prints `e` says what it always said.
 */
export class HostError extends Error {
  constructor(message, code = 'io', cmd = '') {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.cmd = cmd;
  }
  toString() { return this.message; }
}

const CODED = /^\s*\[([a-z_]+)\]\s*([\s\S]*)$/;

/** Whatever an adapter rejected with (a string from Tauri, an Error from fetch) as a HostError. */
export function hostError(cmd, raw) {
  if (raw instanceof HostError) return raw;
  const text = raw && typeof raw === 'object' && 'message' in raw ? String(raw.message) : String(raw ?? 'host error');
  const m = CODED.exec(text);
  return m ? new HostError(m[2] || m[1], m[1], cmd) : new HostError(text, 'io', cmd);
}

const call = async (cmd, ...args) => {
  await ready;
  try {
    return await adapter.call(cmd, args);
  } catch (e) {
    throw hostError(cmd, e);
  }
};

/**
 * The commands of the host contract whose answer is always a value (docs/HOST.md). A host that
 * does not know one answered `null` before `[unknown_command]` existed, and a `null` from
 * `saveFile` read as a successful write is exactly the failure that must never happen again:
 * for these, no answer is an error.
 */
const valued = async (cmd, ...args) => {
  const r = await call(cmd, ...args);
  if (r === null || r === undefined) throw new HostError(`the host does not answer ${cmd}`, 'unknown_command', cmd);
  return r;
};

/**
 * The vault epoch (docs/HOST.md "Epoch"): the host counts every vault it adopts, and a mutating
 * call that carries an older count than the current one is refused with `[stale_vault]` instead
 * of landing in the vault that replaced it. The kernel sets it from `rootInfo` at boot; every
 * mutating call below adds it to its trailing options, so no caller can forget it. Unknown (an
 * old host, or no vault yet) means nothing is added.
 */
let epoch = null;
/** Set by the kernel from `rootInfo`. */
export function setEpoch(n) { epoch = Number.isFinite(n) ? n : null; }
/** The current epoch, or null. */
export function currentEpoch() { return epoch; }
/** `opts` with the epoch added, unless the caller named one. */
const withEpoch = (opts) => {
  const o = opts && typeof opts === 'object' ? { ...opts } : {};
  if (epoch !== null && o.epoch === undefined) o.epoch = epoch;
  return o;
};

// Window control: the Tauri adapter owns it, the other hosts answer it over the RPC.
const WIN_RPC = {
  minimize: 'winMinimize', maximize: 'winMaximize', close: 'winClose',
  isMaximized: 'winIsMaximized', startDrag: 'winStartDrag',
  startResize: 'winStartResize', setTheme: 'winSetTheme', setTitle: 'winSetTitle',
  destroy: 'winDestroy',
};
const winCall = async (name, ...args) => {
  await ready;
  const own = adapter.win && adapter.win[name];
  return typeof own === 'function' ? own(...args) : adapter.call(WIN_RPC[name], args);
};

// Synchronous, and used in <img src> possibly before `ready` resolves, so the origin comes from
// the detected host; the adapter's own version takes over as soon as there is one.
const staticAssetUrl = (path) => {
  const p = String(path ?? '').replace(/^\.?\//, '').split('/').map(encodeURIComponent).join('/');
  if (isTauri) return /windows/i.test(navigator?.userAgent || '') ? `http://vault.localhost/${p}` : `vault://localhost/${p}`;
  return isWebView ? `https://vault.os/${p}` : `/vault/${p}`;
};

export const bridge = {
  kind: isTauri ? 'tauri' : isWebView ? 'webview' : 'http',
  platform: 'windows',
  ready,
  on,

  rootInfo: () => call('rootInfo'),
  // The vault itself (docs/HOST.md "The vault root"): `rootInfo` answers {root:null, name:null}
  // while no vault is open; `pickVault` opens the native folder picker and adopts the choice;
  // `vaultInfo` adds where the root came from; `forgetVault` drops the remembered root.
  vaultInfo: () => call('vaultInfo'),
  // `opts` {adopt}: `{adopt:false}` only chooses the folder, and the caller adopts it with
  // `openVault` once the window has let go of the old one (docs/HOST.md `pickVault`).
  pickVault: (opts) => (opts === undefined ? call('pickVault') : call('pickVault', opts)),
  // The vaults this machine has opened, newest first, at most ten (S46): `recentVaults` lists
  // them, `openVault` adopts one without a dialog, and `forgetVault(path)` drops one line.
  // `forgetVault()` with no path still means "stop remembering a root at all".
  recentVaults: () => call('recentVaults'),
  openVault: (path) => call('openVault', path),
  forgetVault: (path) => (path === undefined ? call('forgetVault') : call('forgetVault', path)),
  // The host's own description of itself: {os, version, exe, exeDir, root}. The chooser names
  // `exeDir` as its suggestion; nothing else needs it.
  platformInfo: () => call('platform'),
  tree: () => call('tree'),
  list: (path) => call('list', path),
  stat: (path) => call('stat', path),
  exists: (path) => call('exists', path),
  readText: (path) => call('readText', path),
  writeText: (path, text, opts) => call('writeText', path, text, withEpoch(opts)),
  appendText: (path, text, opts) => call('appendText', path, text, withEpoch(opts)),
  writeBinary: (path, base64, opts) => call('writeBinary', path, base64, withEpoch(opts)),
  // The file's bytes as base64 (docs/KERNEL.md `ose.files.readBinary`). A host that does not
  // implement it rejects, which is what `ose.files.readBinary` reports to whoever asked.
  readBinary: (path) => call('readBinary', path),
  mkdir: (path, opts) => call('mkdir', path, withEpoch(opts)),
  rename: (from, to, opts) => call('rename', from, to, withEpoch(opts)),
  // `mode`: 'system' (the recycle bin, the default) or 'vault' (`.trash` inside the vault),
  // from settings (S37). The same object carries the epoch.
  trash: (path, opts) => call('trash', path, withEpoch(opts)),
  search: (query, opts = {}) => call('search', query, opts),

  // The save path (docs/HOST.md "saveFile"). The JS side never computes a hash: it carries
  // the one `readFile` answered and hands it back as `expectedHash`, and the host compares and
  // writes in one call under one lock. Every one of these answers a value, so a `null` is an
  // `[unknown_command]` error and never a success.
  /** -> { text, hash, mtime, size } */
  readFile: (path) => valued('readFile', path),
  /** opts { expectedHash: string|null, version?: 'save'|'conflict'|'none' } -> SaveOutcome */
  saveFile: (path, text, opts = {}) => valued('saveFile', path, text, withEpoch(opts)),
  /** Exclusive create; never overwrites. -> { path, hash } */
  createNew: (path, text = '', opts) => valued('createNew', path, text, withEpoch(opts)),
  /** A byte copy under the same create-only rule. -> { path, hash } */
  copyFile: (from, to, opts) => valued('copyFile', from, to, withEpoch(opts)),
  /** One line, with the separator the file needs; no `\n` in `line`. -> { hash } */
  appendLine: (path, line, opts) => valued('appendLine', path, line, withEpoch(opts)),
  /** -> { status:'replaced', hash } | { status:'conflict', actual } */
  replaceLine: (path, index, expected, next, opts) => valued('replaceLine', path, index, expected, next, withEpoch(opts)),

  // Drafts (docs/HOST.md "Drafts"): the buffer a page could not write, per machine, outside
  // the vault. `draftRead` answers null when there is none, so it is the one that may.
  /** -> { at } */
  draftWrite: (path, draft, opts) => valued('draftWrite', path, draft, withEpoch(opts)),
  /** -> DraftInfo[], newest first */
  draftList: () => valued('draftList'),
  /** -> Draft | null */
  draftRead: (path) => call('draftRead', path),
  /** opts { ifRev? } -> { dropped } */
  draftDrop: (path, opts) => (opts === undefined ? valued('draftDrop', path) : valued('draftDrop', path, opts)),

  // Versions (docs/HOST.md "Versions"): `.ose/history`, tiered. `opts` is `{ force?, reason? }`,
  // or a boolean, which is the old `force`. The host names the files; nothing here builds a
  // path into the history folder.
  /** -> { kept, id } */
  versionKeep: (path, text, opts = false) => valued('versionKeep', path, text, opts),
  /** -> VersionInfo[], newest first */
  versionList: (path) => valued('versionList', path),
  versionRead: (path, id) => call('versionRead', path, id),
  /** -> { kept, id, hash } */
  versionRestore: (path, id, opts) => valued('versionRestore', path, id, withEpoch(opts)),
  assetUrl: (path) => (adapter && adapter.assetUrl ? adapter.assetUrl(path) : staticAssetUrl(path)),

  win: {
    minimize: () => winCall('minimize'),
    maximize: () => winCall('maximize'),
    close: () => winCall('close'),
    isMaximized: () => winCall('isMaximized'),
    startDrag: () => winCall('startDrag'),
    startResize: (edge) => winCall('startResize', edge),
    setTheme: (theme) => winCall('setTheme', theme),
    setTitle: (text) => winCall('setTitle', text),
    // The window goes, without the `closing` fan-out: `app.close-anyway` only, after the user
    // said so. Drafts are outside the window and survive it.
    destroy: () => winCall('destroy'),
  },

  // The window's own title (S13): "<page> — <vault>" in the host, the tab title in a browser.
  // Called by the router on every route change; never rejects the caller's flow.
  setTitle: (text) => winCall('setTitle', String(text ?? '')),
  // Quit through the close path, so the editor's last save is awaited exactly as it is when
  // the window's close button is pressed (S16). No-op in the browser.
  quit: () => call('quit'),

  // Paper (docs/HOST.md "Print"). `printToPdf` writes the file and resolves with {path, bytes}
  // once it is on disk, or with null when the save dialog was cancelled; with no `path` the
  // host asks where, `opts` being {name, folder} for that dialog. `showPrintUI` opens the
  // system print dialog and returns at once. Both are WebView2's own: a host without them
  // answers null, which is what tells the caller to say so.
  printToPdf: (path, opts = {}) => call('printToPdf', path ?? null, opts),
  showPrintUI: () => call('showPrintUI'),

  openExternal: (url) => call('openExternal', url),
  reveal: (path) => call('reveal', path),
  // A vault file in the platform's default application (batch 12, N10/N24). Vault-relative, so
  // the host resolves it inside the root; `openExternal` keeps refusing every unknown scheme.
  openPath: (path) => call('openPath', path),
  getState: () => call('getState'),
  setState: (obj) => call('setState', obj),
  // `<stamp> <level> ui: <text>` in the host's log (docs/HOST.md "Log"). Never rejects: a log
  // line that cannot be written must not become an error of its own.
  log: (text, level = 'info') => call('log', String(text ?? ''), level).catch(() => null),
  // Spawn a program (never a shell, docs/HOST.md `run`): `opts` is {cwd, timeout, env, input},
  // stdout and stderr arrive as the bridge event `run` — {id, stream, line} per line, then
  // {id, done:true, code, timedOut}.
  run: (id, cmd, args = [], opts = {}) => call('run', id, cmd, args, opts),
  runKill: (id) => call('runKill', id),
  // The page the window is on, reloaded: only the host knows where the app's own files are.
  // Nothing calls it except `ose.reload()`, and only once `leaveWindow('reload')` has let go
  // (docs/KERNEL.md "Leaving the window").
  reloadShell: () => call('reloadShell'),
};

if (typeof window !== 'undefined') window.__bridge = bridge; // debugging only
