// Tabs (docs/CORE.md `ose.tabs`, M23). The core owns them: a strip of tabs, each with a
// history of its own (a back and forward stack of routes), and one column that shows the
// active tab's current entry. `shell/tabs.js` draws the strip and registers the tab commands;
// it keeps no model of its own.
//
// This file is the model and the public calls. The model is plain data: tab records, which one
// is active, the closed tabs Ctrl+Shift+T brings back whole, and the order tabs were last used
// in (where a close goes). Everything that has to put something on screen — open, activate,
// close, navigate, back — is the router's (./router.js), which changes the model here under a
// snapshot and rolls it back when the page on screen refuses to be left (C1).
//
// A record is `{ id, stack: Route[], index, scroll: Map<routeKey, px>, select: Map<routeKey,
// name> }`. The route objects in `stack` are the router's: the entry on screen is the same
// object as the router's current route. `scroll` and `select` are per tab, so two tabs on one
// folder remember two places in it.

import { bus, uid } from './registry.js';
import * as router from './router.js';

/** How many closed tabs Ctrl+Shift+T walks back through. */
export const MAX_CLOSED = 20;
/** How many entries one tab's history keeps. */
export const MAX_HISTORY = 100;
/** Scroll and selection memories kept per tab. */
export const MAX_MEMORY = 50;

let tabs = [];          // records, in strip order
let activeId = null;
let closed = [];        // [{ rec, at }], newest first
let mru = [];           // ids, most recently active first
let home = null;        // the route a last closed tab falls back to (`ose.route.setHome`)

/*
 * The model as it was before the oldest change that has not been let through yet (C1). A
 * change the page on screen refuses is rolled back to it exactly; one that is superseded by a
 * newer change leaves it where it is, so the newer one, if refused, rolls back past both.
 * Background changes made while one is pending (a tab opened behind, a tab moved, a background
 * tab closed) are written into the snapshot too, so a rollback never undoes them.
 */
let pending = null;

/* ------------------------------------------------------------------------------ records */

/**
 * A new tab record holding `route` as its one entry (or nothing).
 * @param {object|null} route  a normalised route
 */
export function newRecord(route) {
  return {
    id: uid(),
    stack: route ? [route] : [],
    index: route ? 0 : -1,
    scroll: new Map(),
    select: new Map(),
  };
}

/** Every open tab record, in strip order. The array is the model's own: do not mutate it. */
export const records = () => tabs;
/** The closed tabs, newest first: `[{ rec, at }]`. */
export const closedRecords = () => closed;
/** The record with this id, or null. */
export const recordOf = (id) => tabs.find((t) => t.id === id) || null;
/** The active tab's id, or null. */
export const activeTabId = () => activeId;
/** The active record, or null. */
export const activeRecord = () => recordOf(activeId);
/** The entry a record shows: its current route, or null. */
export const currentOf = (rec) => (rec && rec.index >= 0 ? rec.stack[rec.index] || null : null);

/** Make `id` the active tab (null: none). Records the use, for where a close goes. */
export function setActive(id) {
  activeId = id || null;
  if (activeId) mru = [activeId, ...mru.filter((x) => x !== activeId)];
}

/**
 * Put `rec` into the strip at `index` (default: the end). `background`: the insert is not part
 * of the change a pending navigation may roll back (a tab opened behind), so it is written
 * into the snapshot as well.
 */
export function insertRecord(rec, index, { background = false } = {}) {
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, tabs.length)) : tabs.length;
  tabs.splice(at, 0, rec);
  if (pending && background && !pending.tabs.some((e) => e.rec === rec)) {
    pending.tabs.splice(Math.min(at, pending.tabs.length), 0, { rec, stack: rec.stack.slice(), index: rec.index });
  }
  return at;
}

/**
 * Take `id` out of the strip. It goes on the closed stack unless `remember` is false, with the
 * place it held, so a reopen puts it back there. `background` as for `insertRecord`. Answers
 * the record, or null.
 */
export function removeRecord(id, { remember = true, background = false } = {}) {
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return null;
  const [rec] = tabs.splice(at, 1);
  mru = mru.filter((x) => x !== id);
  if (activeId === id) activeId = null;
  if (remember) closed = [{ rec, at }, ...closed.filter((e) => e.rec !== rec)].slice(0, MAX_CLOSED);
  if (pending && background) {
    pending.tabs = pending.tabs.filter((e) => e.rec !== rec);
    pending.mru = pending.mru.filter((x) => x !== id);
    if (remember) pending.closed = [{ rec, at }, ...pending.closed.filter((e) => e.rec !== rec)].slice(0, MAX_CLOSED);
  }
  return rec;
}

/** The newest closed tab, taken off the closed stack, or null. */
export function takeClosed() {
  const e = closed.shift();
  return e || null;
}

/** Move `id` to `index` in the strip. */
export function moveRecord(id, index) {
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return false;
  const [rec] = tabs.splice(at, 1);
  const to = Math.max(0, Math.min(Number.isInteger(index) ? index : tabs.length, tabs.length));
  tabs.splice(to, 0, rec);
  if (pending) {
    const order = new Map(tabs.map((t, i) => [t, i]));
    pending.tabs.sort((a, b) => (order.get(a.rec) ?? 1e9) - (order.get(b.rec) ?? 1e9));
  }
  return to !== at;
}

/** A new entry on `rec`'s history after its current one; what was forward of it goes. */
export function pushEntry(rec, route) {
  rec.stack = rec.stack.slice(0, rec.index + 1);
  rec.stack.push(route);
  if (rec.stack.length > MAX_HISTORY) rec.stack = rec.stack.slice(-MAX_HISTORY);
  rec.index = rec.stack.length - 1;
}

/**
 * Where closing `id` goes: the tab used most recently before it, else its right-hand
 * neighbour, else its left, else nothing.
 */
export function nextAfterClose(id) {
  const rest = tabs.filter((t) => t.id !== id);
  if (!rest.length) return null;
  for (const x of mru) {
    if (x === id) continue;
    const hit = rest.find((t) => t.id === x);
    if (hit) return hit;
  }
  const at = tabs.findIndex((t) => t.id === id);
  return rest[Math.min(Math.max(0, at), rest.length - 1)];
}

/** Replace the whole model (session restore). */
export function replaceModel(recs, active) {
  tabs = recs.slice();
  closed = [];
  mru = [];
  activeId = null;
  setActive(active || (tabs[0] && tabs[0].id) || null);
}

/**
 * Every route object the model holds — open tabs, closed tabs and the pending snapshot — passed
 * through `fn(route) -> route`, entry by entry, in place. `ose.route.repoint` uses it, so a
 * rename reaches history nobody is looking at, and a rollback cannot bring an old path back.
 */
export function mapRoutes(fn) {
  const seen = new Set();
  const each = (rec) => {
    if (seen.has(rec)) return;
    seen.add(rec);
    rec.stack = rec.stack.map(fn);
  };
  for (const t of tabs) each(t);
  for (const e of closed) each(e.rec);
  if (pending) {
    for (const e of pending.tabs) e.stack = e.stack.map(fn);
    for (const e of pending.closed) each(e.rec);
  }
}

/** Remember a scroll offset or a folder selection in `rec`, oldest out past MAX_MEMORY. */
export function remember(map, key, value) {
  map.delete(key);
  if (value === undefined || value === null) return;
  map.set(key, value);
  while (map.size > MAX_MEMORY) map.delete(map.keys().next().value);
}

/* ------------------------------------------------------------------------------ pending */

/** Take the snapshot, unless an earlier change still in flight already holds one. */
export function beginChange() {
  if (pending) return;
  pending = {
    tabs: tabs.map((rec) => ({ rec, stack: rec.stack.slice(), index: rec.index })),
    activeId,
    closed: closed.slice(),
    mru: mru.slice(),
  };
}

/** The page refused: the model goes back to the snapshot. */
export function rollbackChange() {
  if (!pending) return;
  const p = pending;
  pending = null;
  tabs = p.tabs.map((e) => { e.rec.stack = e.stack.slice(); e.rec.index = e.index; return e.rec; });
  activeId = p.activeId;
  closed = p.closed.slice();
  mru = p.mru.slice();
}

/** The page let go: what the model says now is the truth. */
export function commitChange() { pending = null; }

/** True while a change waits on the page. */
export const changePending = () => !!pending;

/* ------------------------------------------------------------------------------ home */

/** `ose.route.setHome(route)`: where the last tab goes when it is closed (null: the empty surface). */
export function setHome(route) { home = route || null; }
/** The home route, or null. */
export const homeRoute = () => home;

/* ------------------------------------------------------------------------------ public */

/** A route as a tab or a session names it: its identity fields, nothing spent. */
export function identity(r) {
  if (!r) return null;
  if (r.type === 'page') return { type: 'page', path: r.path };
  if (r.type === 'folder') return { type: 'folder', path: r.path };
  if (r.type === 'view') return { type: 'view', name: r.name };
  return null;
}

/** The public shape of a record: `{ id, route, canBack, canForward }`. */
export function publicTab(rec) {
  return {
    id: rec.id,
    route: identity(currentOf(rec)),
    canBack: rec.index > 0,
    canForward: rec.index >= 0 && rec.index < rec.stack.length - 1,
  };
}

/** Say what the strip looks like now: bus `tabs` `{ tabs, active, reason }`. */
export function emitTabs(reason = 'change') {
  bus.emit('tabs', { tabs: list(), active: activeId, reason });
}

/**
 * `ose.tabs.list()`: every tab, in strip order.
 * @returns {Array<{id: string, route: object|null, canBack: boolean, canForward: boolean}>}
 */
export function list() { return tabs.map(publicTab); }

/** `ose.tabs.active()`: the active tab, or null. */
export function active() {
  const rec = activeRecord();
  return rec ? publicTab(rec) : null;
}

/**
 * `ose.tabs.open(route, { activate = true, index, reuse = true })` -> Promise<{ id, shown }>.
 * With `reuse`, a tab whose current route is the same is brought forward instead of a second
 * one made.
 */
export function open(route, opts) { return router.openTab(route, opts); }

/** `ose.tabs.activate(id)` -> Promise<boolean>. */
export function activate(id) { return router.activateTab(id); }

/** `ose.tabs.close(id)` -> Promise<boolean>; false: its page could not be let go, nothing changed. */
export function close(id) { return router.closeTab(id); }

/** `ose.tabs.closeOthers(id)` -> Promise<boolean>; false when one of them refused. */
export function closeOthers(id) { return router.closeOtherTabs(id); }

/** `ose.tabs.move(id, index)`. */
export function move(id, index) { router.moveTab(id, index); }

/** `ose.tabs.reopenClosed()` -> Promise<boolean>: the tab comes back with its whole history. */
export function reopenClosed() { return router.reopenClosedTab(); }

/**
 * `ose.tabs.on(fn)`: fn({ tabs, active, reason }) on every change. The same payload is bus
 * `tabs`. -> unsubscribe
 */
export function on(fn) { return bus.on('tabs', fn); }
