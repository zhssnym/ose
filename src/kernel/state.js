// App/state.json, read once at boot and written back debounced. Every module goes through
// patchState so nobody clobbers another module's keys (CONTRACT.md "Additions").
// Merge is shallow at the top level: pass the whole sub-object for a key you own.
import { bridge } from './bridge/index.js';

let cache = {};
let loaded = false;
let timer = null;
let writing = null;

export function stateCache() { return cache; }

export async function loadState() {
  try {
    const s = await bridge.getState();
    cache = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  } catch (e) {
    console.warn('[shell] state load failed:', e.message || e);
    cache = {};
  }
  loaded = true;
  return cache;
}

function write() {
  writing = bridge.setState(cache).catch((e) => console.warn('[shell] state write failed:', e.message || e));
  return writing;
}

export function patchState(partial) {
  if (!partial || typeof partial !== 'object') return Promise.resolve();
  for (const k of Object.keys(partial)) {
    const v = partial[k];
    if (v === undefined) delete cache[k]; else cache[k] = v;
  }
  if (!loaded) return Promise.resolve();
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; write(); }, 300);
  return Promise.resolve();
}

export function flushState() {
  if (!loaded) return Promise.resolve();
  if (timer) { clearTimeout(timer); timer = null; }
  return write();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; write(); } });
}
