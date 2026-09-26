// Session restore (docs/KERNEL.md `ose.session`, H19, D6, W7). The tabs, each tab's history,
// the active one, and where each route was scrolled to and which child a folder had selected,
// kept per machine and per vault (`ose.local('session')`) and put back at the next start. On by
// default; the machine setting `restoreSession` turns it off, and turning it off clears what
// was kept.
//
// Only identities are written (a page's path, a folder's path, a view's name): a line, a
// heading or a search a route once carried is not the page. A tab whose file is gone by the
// next start is still restored, and says so with the router's own box when it is brought
// forward, which is honest and costs nothing at boot: only the active tab mounts.

import { bus } from './registry.js';
import { local } from './local.js';
import { settings } from './settings-core.js';
import * as T from './tabs.js';
import { normalize, restoreTabs, liveScroll, liveSelection, routeKey } from './router.js';

const WRITE_MS = 500;
const store = () => local('session');

let timer = null;
// Nothing is written until something has changed since boot: a window closed before anything
// was shown must not replace yesterday's session with an empty one.
let dirty = false;
// Something has been shown since boot. The scroll and a folder's selection change on screen
// without always saying so, so the leave and `pagehide` writes go ahead once this is set even
// when nothing is marked dirty: they read the live values.
let seen = false;

/** `settings.restoreSession`, true unless the user turned it off. */
const enabled = () => settings().restoreSession !== false;

/** A Map as a plain object, for JSON. */
const toObject = (map) => Object.fromEntries([...map.entries()].filter(([, v]) => v !== undefined && v !== null));

/**
 * `ose.session.snapshot()` -> Session: what would be written now.
 * @returns {{v: 1, at: number, active: number, tabs: Array<{stack: object[], index: number, scroll: object, select: object}>}}
 */
export function snapshot() {
  const live = liveScroll();
  const picked = liveSelection();
  const recs = T.records();
  const tabs = recs.map((rec) => {
    const stack = rec.stack.map(T.identity).filter(Boolean);
    const scroll = toObject(rec.scroll);
    if (live && live.tab === rec) scroll[live.key] = live.top;
    const select = toObject(rec.select);
    if (picked && picked.tab === rec) {
      if (picked.name) select[picked.key] = picked.name; else delete select[picked.key];
    }
    return {
      stack,
      index: Math.max(0, Math.min(rec.index, stack.length - 1)),
      scroll,
      select,
    };
  }).filter((t) => t.stack.length);
  const activeRec = T.activeRecord();
  const active = Math.max(0, recs.filter((r) => r.stack.length).indexOf(activeRec));
  return { v: 1, at: Date.now(), active, tabs };
}

/** A number map read back from JSON, anything that is not one dropped. */
function numbers(obj) {
  const out = new Map();
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) if (typeof k === 'string' && Number.isFinite(v) && v > 0) out.set(k, v);
  return out;
}

/** A string map read back from JSON. */
function strings(obj) {
  const out = new Map();
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && v) out.set(k, v);
  return out;
}

/**
 * `ose.session.restore(session?)` -> Promise<boolean>. Reads `ose.local('session')` when no
 * session is passed, rebuilds the tabs and mounts only the active one. False when nothing
 * usable was there (no tab with one route the router understands), or when the page on screen
 * refused to be left. Bus `session:restored` `{ tabs }` on success.
 */
export async function restore(session) {
  const s = session === undefined ? store().get() : session;
  if (!s || typeof s !== 'object' || s.v !== 1 || !Array.isArray(s.tabs)) return false;
  const recs = [];
  for (const t of s.tabs) {
    if (!t || !Array.isArray(t.stack)) continue;
    const stack = t.stack.map(normalize).filter(Boolean).map(T.identity);
    if (!stack.length) continue;
    const rec = T.newRecord(null);
    rec.stack = stack;
    rec.index = Number.isInteger(t.index) ? Math.max(0, Math.min(t.index, stack.length - 1)) : stack.length - 1;
    rec.scroll = numbers(t.scroll);
    rec.select = strings(t.select);
    // Only keys this tab can still show are worth keeping.
    const keys = new Set(stack.map(routeKey));
    for (const k of [...rec.scroll.keys()]) if (!keys.has(k)) rec.scroll.delete(k);
    for (const k of [...rec.select.keys()]) if (!keys.has(k)) rec.select.delete(k);
    recs.push(rec);
  }
  if (!recs.length) return false;
  const at = Number.isInteger(s.active) ? Math.max(0, Math.min(s.active, recs.length - 1)) : 0;
  const front = recs[at] || recs[0];
  if (!front) return false;
  const shown = await restoreTabs(recs, front.id);
  if (shown) bus.emit('session:restored', { tabs: T.list() });
  return shown;
}

/**
 * Write the session now, if it changed and the setting allows. `{ live: true }` is the leave
 * gate's: written whenever anything has been shown since boot, for the scroll and selection
 * that moved without an event.
 */
export function flushSession({ live = false } = {}) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!(dirty || (live && seen)) || !enabled()) return Promise.resolve();
  dirty = false;
  store().set(snapshot());
  return store().flush();
}

function schedule() {
  if (!enabled()) return;
  dirty = true;
  seen = true;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flushSession(); }, WRITE_MS);
}

let wired = false;

/** Start keeping the session: called once by the kernel when it boots. */
export function initSession() {
  if (wired) return;
  wired = true;
  bus.on('tabs', schedule);
  bus.on('route', schedule);
  bus.on('route:scroll', schedule);
  // A folder view says when its selection moved (debounced by the shell), so it is kept too.
  bus.on('route:select', schedule);
  // Turning the setting off clears what was kept; turning it back on keeps from now.
  bus.on('settings', (s) => {
    if (s && s.restoreSession === false) {
      clearTimeout(timer);
      timer = null;
      dirty = false;
      if (store().get() !== undefined) { store().set(undefined); void store().flush(); }
    }
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (!(dirty || seen) || !enabled()) return;
      dirty = false;
      if (timer) { clearTimeout(timer); timer = null; }
      store().set(snapshot());
      void store().flush({ fresh: false });
    });
  }
}
