// Bridge facade. Picks the WebView2 adapter inside the host, the HTTP adapter in a browser.
// Adapters implement `call(cmd, args) -> Promise` and `subscribe(fn({event, data}))`.
// This file is the contract surface; see CONTRACT.md. Modules never import adapters directly.

import { bus } from '../registry.js';

const isWebView = typeof window !== 'undefined' && !!window.chrome?.webview?.postMessage;

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
  const mod = isWebView ? await import('./webview.js') : await import('./http.js');
  adapter = await mod.create();
  adapter.subscribe(dispatch);
  return adapter;
})();

const call = async (cmd, ...args) => { await ready; return adapter.call(cmd, args); };

export const bridge = {
  kind: isWebView ? 'webview' : 'http',
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
  assetUrl: (path) => {
    const p = String(path).replace(/^\.?\//, '').split('/').map(encodeURIComponent).join('/');
    return isWebView ? `https://vault.os/${p}` : `/vault/${p}`;
  },

  claudeInfo: () => call('claudeInfo'),
  claudeStart: (opts) => call('claudeStart', opts),
  claudeSend: (id, text) => call('claudeSend', id, text),
  claudeInterrupt: (id) => call('claudeInterrupt', id),
  claudeStop: (id) => call('claudeStop', id),
  claudeTranscript: (sessionId) => call('claudeTranscript', sessionId),

  win: {
    minimize: () => call('winMinimize'),
    maximize: () => call('winMaximize'),
    close: () => call('winClose'),
    isMaximized: () => call('winIsMaximized'),
    startDrag: () => call('winStartDrag'),
    startResize: (edge) => call('winStartResize', edge),
    setTheme: (theme) => call('winSetTheme', theme),
  },

  openExternal: (url) => call('openExternal', url),
  reveal: (path) => call('reveal', path),
  getState: () => call('getState'),
  setState: (obj) => call('setState', obj),
};

if (typeof window !== 'undefined') window.__bridge = bridge; // debugging only
