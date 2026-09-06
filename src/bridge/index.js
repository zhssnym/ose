// Bridge facade. Picks the Tauri adapter inside the Tauri host, the WebView2 adapter inside the
// .NET host, the HTTP adapter in a browser.
// Adapters implement `call(cmd, args) -> Promise` and `subscribe(fn({event, data}))`, and may
// add `win`, `platform` and `assetUrl` when the host does not route those through the RPC.
// This file is the contract surface; see CONTRACT.md. Modules never import adapters directly.

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
function dispatch({ event, data }) {
  const set = listeners.get(event);
  if (set) for (const fn of [...set]) { try { fn(data); } catch (e) { console.error(`[bridge:${event}]`, e); } }
  if (event === 'fs') bus.emit('fs', data);
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
  startResize: 'winStartResize', setTheme: 'winSetTheme',
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
  tree: () => call('tree'),
  list: (path) => call('list', path),
  stat: (path) => call('stat', path),
  exists: (path) => call('exists', path),
  readText: (path) => call('readText', path),
  writeText: (path, text) => call('writeText', path, text),
  appendText: (path, text) => call('appendText', path, text),
  writeBinary: (path, base64) => call('writeBinary', path, base64),
  mkdir: (path) => call('mkdir', path),
  rename: (from, to) => call('rename', from, to),
  trash: (path) => call('trash', path),
  search: (query, opts = {}) => call('search', query, opts),
  assetUrl: (path) => (adapter && adapter.assetUrl ? adapter.assetUrl(path) : staticAssetUrl(path)),

  claudeInfo: () => call('claudeInfo'),

  // A pseudo-terminal per session; the Claude Code CLI runs inside one (CONTRACT.md, batch 6).
  // `data` out is base64 of the raw bytes, `data` in is a UTF-8 string.
  ptyStart: (opts) => call('ptyStart', opts),
  ptyWrite: (id, data) => call('ptyWrite', id, data),
  ptyResize: (id, cols, rows) => call('ptyResize', id, cols, rows),
  ptyKill: (id) => call('ptyKill', id),

  win: {
    minimize: () => winCall('minimize'),
    maximize: () => winCall('maximize'),
    close: () => winCall('close'),
    isMaximized: () => winCall('isMaximized'),
    startDrag: () => winCall('startDrag'),
    startResize: (edge) => winCall('startResize', edge),
    setTheme: (theme) => winCall('setTheme', theme),
  },

  openExternal: (url) => call('openExternal', url),
  reveal: (path) => call('reveal', path),
  getState: () => call('getState'),
  setState: (obj) => call('setState', obj),
  log: (text) => call('log', text),
};

if (typeof window !== 'undefined') window.__bridge = bridge; // debugging only
