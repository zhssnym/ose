// Bridge facade. Picks the Tauri adapter inside the Tauri host, the WebView2 adapter inside the
// .NET host, the HTTP adapter in a browser.
// Adapters implement `call(cmd, args) -> Promise` and `subscribe(fn({event, data}))`, and may
// add `win`, `platform` and `assetUrl` when the host does not route those through the RPC.
// This file is the contract surface; see CONTRACT.md. Nothing else imports an adapter.

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
 * that when the save needs an answer from the user (CONTRACT.md batch 9, B1/B2). A handler
 * that throws is logged and counts as done; the close must never hang on a bug.
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

const call = async (cmd, ...args) => { await ready; return adapter.call(cmd, args); };

// Window control: the Tauri adapter owns it, the other hosts answer it over the RPC.
const WIN_RPC = {
  minimize: 'winMinimize', maximize: 'winMaximize', close: 'winClose',
  isMaximized: 'winIsMaximized', startDrag: 'winStartDrag',
  startResize: 'winStartResize', setTheme: 'winSetTheme', setTitle: 'winSetTitle',
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
  // The vault itself (CONTRACT.md "Vault resolution"): `rootInfo` answers {root:null, name:null}
  // while no vault is open; `pickVault` opens the native folder picker and adopts the choice;
  // `vaultInfo` adds where the root came from; `forgetVault` drops the remembered root.
  vaultInfo: () => call('vaultInfo'),
  pickVault: () => call('pickVault'),
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
  writeText: (path, text) => call('writeText', path, text),
  appendText: (path, text) => call('appendText', path, text),
  writeBinary: (path, base64) => call('writeBinary', path, base64),
  // Round four (docs/KERNEL.md `ose.files.readBinary`): the file's bytes as base64. K1a adds
  // the host command; until it exists the call rejects, which is what `ose.files.readBinary`
  // reports to whoever asked.
  readBinary: (path) => call('readBinary', path),
  mkdir: (path) => call('mkdir', path),
  rename: (from, to) => call('rename', from, to),
  // `mode`: 'system' (the recycle bin, the default) or 'vault' (`.trash` inside the vault),
  // from settings (S37). A host that does not know the option ignores it and uses the bin.
  trash: (path, opts) => (opts === undefined ? call('trash', path) : call('trash', path, opts)),
  search: (query, opts = {}) => call('search', query, opts),
  // Versions (CONTRACT.md batch 12): the text a save is about to replace, kept under
  // `.ose/versions/<path>/<yyyy-mm-dd-hhmmss>.md`. `versionKeep` answers {kept, id} and keeps
  // nothing when the newest version of that file is younger than five minutes, unless `force`.
  versionKeep: (path, text, force = false) => call('versionKeep', path, text, force),
  versionList: (path) => call('versionList', path),
  versionRead: (path, id) => call('versionRead', path, id),
  versionRestore: (path, id) => call('versionRestore', path, id),
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
  },

  // The window's own title (S13): "<page> — <vault>" in the host, the tab title in a browser.
  // Called by the router on every route change; never rejects the caller's flow.
  setTitle: (text) => winCall('setTitle', String(text ?? '')),
  // Quit through the close path, so the editor's last save is awaited exactly as it is when
  // the window's close button is pressed (S16). No-op in the browser.
  quit: () => call('quit'),

  openExternal: (url) => call('openExternal', url),
  reveal: (path) => call('reveal', path),
  // A vault file in the platform's default application (batch 12, N10/N24). Vault-relative, so
  // the host resolves it inside the root; `openExternal` keeps refusing every unknown scheme.
  openPath: (path) => call('openPath', path),
  getState: () => call('getState'),
  setState: (obj) => call('setState', obj),
  log: (text) => call('log', text),
  // Round four, K1a. Spawn a program (never a shell): `opts` is {cwd, timeout, env, input},
  // stdout and stderr arrive as the bridge event `run` — {id, stream, line} per line, then
  // {id, done:true, code, timedOut}.
  run: (id, cmd, args = [], opts = {}) => call('run', id, cmd, args, opts),
  runKill: (id) => call('runKill', id),
  // The page the window is on, reloaded (Ctrl+R): only the host knows where the app's own
  // files are. `riceReady` tells it the kernel booted; the host keeps both names.
  reloadRice: () => call('reloadRice'),
  riceReady: () => call('riceReady'),
};

if (typeof window !== 'undefined') window.__bridge = bridge; // debugging only
