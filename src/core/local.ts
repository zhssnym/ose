// The per-machine store (docs/CORE.md `ose.local`, W5, M26). Two objects outside the vault,
// kept by the host: `vault`, for this machine and the open vault (recent files,
// the sidebar, per-folder sort, the side panel, one-time notices), and `app`, for this machine
// and every vault (reading comfort, Show hidden). `.ose/state.json` keeps
// only what belongs to the vault and travels with it: pins, the planner's paths, vault settings.
//
// Both objects are read once in `ose.ready` and written back debounced, the way `state.ts`
// writes the state file. A write sends the whole object, so it is merged first with what is on
// disk: only the keys this window changed are written over, and whatever the host keeps in the
// same file (the window bounds, the theme mirror) is never reverted by a stale copy.
//
// A read that fails, for any reason (an unknown command included: X5, every command is
// typed and a missing one is a hard error), leaves the scope unloaded for the session: it is
// logged, the defaults answer, and nothing is written over what could not be read.

import { bridge } from './bridge/index.ts';
import { logLine } from './log.ts';

const WRITE_MS = 300;

/** One scope: its cache, the keys changed since the last write, its timer. */
function scope(name) {
  return { name, cache: {} as Record<string, any>, loaded: false, touched: new Set<any>(), timer: null, writing: null };
}

const scopes = { vault: scope('vault'), app: scope('app') };

async function load(s) {
  try {
    const v = await bridge.localGet(s.name);
    s.cache = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    s.loaded = true;
  } catch (err) {
    const e = (err as { code?: string, message?: string });
    s.cache = {};
    // No vault open is not a failure of the store: there is simply nothing to read yet.
    if (e && e.code === 'no_vault') { s.loaded = false; return; }
    // Unreadable is not empty: nothing is written over it this session.
    s.loaded = false;
    console.warn(`[local] ${s.name} could not be read:`, (e && e.message) || e);
    logLine(`local state ${s.name} could not be read: ${(e && e.message) || e}`, 'warn');
  }
}

/** Both scopes, once, in `ose.ready`. */
export async function loadLocal() {
  await Promise.all([load(scopes.vault), load(scopes.app)]);
}

/**
 * Write one scope: the keys this window changed, laid over what is on disk now. `fresh: false`
 * is the `pagehide` path, where there is no time to read first; the cache stands in.
 */
function write(s, { fresh = true } = {}) {
  const send = async () => {
    if (!s.loaded || !s.touched.size) return;
    const keys = [...s.touched];
    s.touched.clear();
    if (fresh) {
      try {
        const disk = await bridge.localGet(s.name);
        if (disk && typeof disk === 'object' && !Array.isArray(disk)) {
          // The disk fills in only what this window has not changed: the keys this write
          // carries, and any key set while the read was out (it is in `touched` again, for the
          // next write). The cache is merged into, never replaced, so a `set` made during the
          // await is not overwritten with the disk's older value.
          const mine = new Set([...keys, ...s.touched]);
          for (const k of Object.keys(s.cache)) if (!mine.has(k) && !(k in disk)) delete s.cache[k];
          for (const k of Object.keys(disk)) if (!mine.has(k)) s.cache[k] = disk[k];
        }
      } catch { /* unreadable now: the write goes with what is in hand */ }
    }
    try {
      await bridge.localSet(s.name, { ...s.cache });
    } catch (err) {
      const e = (err as { code?: string, message?: string });
      for (const k of keys) s.touched.add(k);
      console.warn(`[local] ${s.name} write failed:`, (e && e.message) || e);
      logLine(`local state ${s.name} write failed: ${(e && e.code) || 'io'} ${(e && e.message) || e}`, 'warn');
    }
  };
  s.writing = (s.writing || Promise.resolve()).then(send, send);
  return s.writing;
}

function schedule(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { s.timer = null; void write(s); }, WRITE_MS);
}

function patch(s, key, value) {
  if (value === undefined) delete s.cache[key]; else s.cache[key] = value;
  s.touched.add(key);
  schedule(s);
}

/** Every pending write, now. Awaited by the leave gate and the router's close path. */
export async function flushLocal() {
  await Promise.all(Object.values(scopes).map((s) => {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    return write(s);
  }));
}

function handle(s, key) {
  const k = String(key);
  return {
    get: () => s.cache[k],
    set: (value) => patch(s, k, value),
    // `{ fresh: false }` is for `pagehide`: no read of the file first, there is no time.
    flush: (opts?) => { if (s.timer) { clearTimeout(s.timer); s.timer = null; } return write(s, opts); },
  };
}

/**
 * `ose.local(key)` -> `{ get(), set(value), flush() }`, per machine and per vault. `set(undefined)`
 * removes the key. What is stored must survive JSON.
 */
export function local(key: string) { return handle(scopes.vault, key); }

/**
 * `ose.local.app(key)`: the same, per machine for every vault.
 */
local.app = (key: string) => handle(scopes.app, key);

/**
 * The first time a machine opens a vault after the upgrade, what used to live in the synced
 * `.ose/state.json` and now belongs to the machine is copied over: the recent files, the
 * sidebar and the reading settings. Copied, never deleted from the state file, so an older
 * build on another machine still finds what it had. `readingKeys` are the machine settings.
 * @param state  the state file as loaded
 */
export function migrateLocal(state: any, readingKeys: string[]) {
  const v = scopes.vault;
  if (!v.loaded) return false;
  if (v.cache.migrated === 1) return false;
  const st = state && typeof state === 'object' ? state : {};
  if (Array.isArray(st.recent) && v.cache.recent === undefined) patch(v, 'recent', st.recent.slice());
  if (st.sidebar && typeof st.sidebar === 'object' && v.cache.sidebar === undefined) patch(v, 'sidebar', { ...st.sidebar });
  const a = scopes.app;
  const old = st.settings && typeof st.settings === 'object' ? st.settings : {};
  const have = a.cache.settings && typeof a.cache.settings === 'object' ? a.cache.settings : {};
  const next = { ...have };
  let copied = false;
  for (const k of readingKeys) {
    if (k in old && !(k in have)) { next[k] = old[k]; copied = true; }
  }
  if (copied) patch(a, 'settings', next);
  patch(v, 'migrated', 1);
  return true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const s of Object.values(scopes)) {
      if (!s.timer) continue;
      clearTimeout(s.timer);
      s.timer = null;
      void write(s, { fresh: false });
    }
  });
}
