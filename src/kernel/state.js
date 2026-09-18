// `.ose/state.json`, read once at boot and written back debounced. Everything goes through
// patchState so nobody clobbers anybody else's keys.
// Merge is shallow at the top level: pass the whole sub-object for a key you own.
import { bridge } from './bridge/index.js';
import { toast } from './dialog.js';

let cache = {};
let loaded = false;
let timer = null;
let writing = null;

// The two keys of the file the host owns and patches itself: `window`, the bounds it saves at
// the close request, and `theme`, the colour the next launch paints before the page exists.
// Nothing above this file reads either. They were loaded with the rest at boot and sent back
// verbatim on every write, so the host's own patch was reverted by the next kernel write a few
// hundred milliseconds later and the window bounds were lost on every close. They are read back
// off the file just before a write instead.
const HOST_KEYS = ['window', 'theme'];

export function stateCache() { return cache; }

export async function loadState() {
  try {
    const s = await bridge.getState();
    cache = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
    loaded = true;
  } catch (e) {
    // A file that cannot be read is not an empty file. Writing over it would take the recent
    // files, the settings, every saved path choice and every plugin's state with it, so the
    // cache serves reads and nothing goes to disk for the rest of the session.
    console.warn('[shell] state load failed:', e.message || e);
    cache = {};
    loaded = false;
    try { toast(`could not read the state file: ${e.message || e}. Nothing will be saved this session.`, 'err', 8000); } catch { /* no DOM */ }
  }
  return cache;
}

async function refreshHostKeys() {
  try {
    const disk = await bridge.getState();
    if (!disk || typeof disk !== 'object' || Array.isArray(disk)) return;
    for (const key of HOST_KEYS) {
      if (key in disk) cache[key] = disk[key]; else delete cache[key];
    }
  } catch { /* unreadable: the write goes with what is in hand */ }
}

/**
 * One write at a time, in the order they were asked for. Two writes in flight were not ordered
 * and the older one could land last, which on a reload is the one that loses what an `unmount`
 * had just banked. `host: false` is the `pagehide` path, where there is no time for the extra
 * read of the file and the write is best effort anyway.
 */
function write({ host = true } = {}) {
  const send = async () => {
    if (host) await refreshHostKeys();
    try { await bridge.setState(cache); } catch (e) { console.warn('[shell] state write failed:', e.message || e); }
  };
  writing = (writing || Promise.resolve()).then(send, send);
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
  window.addEventListener('pagehide', () => {
    if (!loaded || !timer) return;
    clearTimeout(timer);
    timer = null;
    write({ host: false });
  });
}
