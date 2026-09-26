// Pins: the paths a person keeps at hand, in the order they were pinned.
//
// One list in `ose.state('pins')` (the vault's `.ose/state.json`, synced with it), an array of
// vault paths, exactly as before this file existed. The sidebar draws it at the top of the
// tree and the home draws it under the planner row; both read it here and nowhere else.
//
// A pin is never dropped because its file went away (L22). A trashed file, a folder renamed
// in Explorer, a drive that is not plugged in: the pin stays, greyed and marked missing, and
// comes back to life when the path does — a restore from the trash, the drive back. Only
// Unpin removes one. A rename or move the app makes, or one the watcher pairs, carries the pin
// along (`paths:moved`, `fs` renames).
//
// What a pin is (file or folder) and whether it is there is not stored: the tree knows, and
// the sidebar lends this file its lookup (`setLookup`). Until it has, a pin with no extension
// is taken for a folder, and nothing is called missing on a guess.

import { ose } from 'ose:kernel';

const { bus } = ose;

const slot = ose.state('pins');
const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
const baseName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? c : c.slice(i + 1); };

const dotted = (p) => clean(p).split('/').some((seg) => seg.startsWith('.'));
/** A move from a visible path into a hidden one (the vault's `.trash`, say). */
const intoHidden = (from, to) => dotted(to) && !dotted(from);

let pins = null;
let lookup = null;
const listeners = new Set();
let wired = false;

/** The stored list, read once the state file is in. */
function load() {
  if (pins) return pins;
  const saved = slot.get();
  pins = Array.isArray(saved) ? [...new Set(saved.filter((p) => typeof p === 'string' && p).map(clean))].filter(Boolean) : [];
  wire();
  return pins;
}

function persist() { slot.set([...pins]); }

function emit() {
  const snapshot = list();
  for (const fn of [...listeners]) {
    try { fn(snapshot); } catch (e) { console.error('[shell] pins listener', e); }
  }
}

/** A path and everything under it follows a move; answers whether anything changed. */
function follow(moves) {
  let changed = false;
  pins = load().map((p) => {
    for (const m of moves) {
      if (p === m.from) { changed = true; return m.to; }
      if (p.startsWith(m.from + '/')) { changed = true; return m.to + p.slice(m.from.length); }
    }
    return p;
  });
  if (changed) { pins = [...new Set(pins)]; persist(); }
  return changed;
}

/** The bus: moves the app made, and renames the watcher paired (made outside the app). */
function wire() {
  if (wired) return;
  wired = true;
  bus.on('paths:moved', (d) => {
    const moves = ((d && d.moves) || []).filter((m) => m && m.from && m.to).map((m) => ({ from: clean(m.from), to: clean(m.to) }));
    if (moves.length && follow(moves)) emit();
  });
  bus.on('fs', (payload) => {
    const changes = payload && Array.isArray(payload.changes) ? payload.changes : [];
    // A rename into a hidden place (`.trash/…`, a dot folder) is the file leaving, not moving:
    // the pin stays where it was and turns missing (L22), and comes back with a restore.
    const moves = changes.filter((c) => c && c.kind === 'rename' && c.path && c.to && !intoHidden(c.path, c.to))
      .map((c) => ({ from: clean(c.path), to: clean(c.to) }));
    if (moves.length && follow(moves)) emit();
  });
}

/**
 * Every pin, in pin order, with what it is and whether it is there.
 * @returns {Array<{ path: string, kind: 'dir'|'file', missing: boolean }>}
 */
export function list() {
  return load().map((path) => {
    const node = lookup ? lookup(path) : undefined;
    if (node) return { path, kind: node.kind === 'dir' ? 'dir' : 'file', missing: false };
    // `null` from the lookup is "the tree is loaded and it is not there"; `undefined` is "the
    // tree does not know yet", which says nothing about the file.
    const guess = baseName(path).includes('.') ? 'file' : 'dir';
    return { path, kind: guess, missing: node === null };
  });
}

/**
 * Whether `path` is pinned.
 * @param {string} path
 * @returns {boolean}
 */
export function has(path) { return load().includes(clean(path)); }

/**
 * Pin paths, at the end, in the order given. One already pinned stays where it is.
 * @param {string|string[]} paths
 */
export function add(paths) {
  const cur = load();
  const next = (Array.isArray(paths) ? paths : [paths]).map(clean).filter((p) => p && !cur.includes(p));
  if (!next.length) return;
  pins = [...cur, ...new Set(next)];
  persist();
  emit();
}

/**
 * Unpin paths. The only way a pin goes.
 * @param {string|string[]} paths
 */
export function remove(paths) {
  const drop = new Set((Array.isArray(paths) ? paths : [paths]).map(clean));
  const cur = load();
  const next = cur.filter((p) => !drop.has(p));
  if (next.length === cur.length) return;
  pins = next;
  persist();
  emit();
}

/**
 * Be told when the list changes, or when what the pins point at does (a file comes or goes).
 * @param {(pins: ReturnType<typeof list>) => void} fn
 * @returns {() => void} unsubscribe
 */
export function on(fn) {
  load();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The sidebar's tree lookup: `path -> Entry` when it is there, `null` when the tree is loaded
 * and it is not, `undefined` while the tree is not loaded. Setting it tells the listeners.
 * @param {(path: string) => ({kind: string}|null|undefined)} fn
 */
export function setLookup(fn) {
  lookup = typeof fn === 'function' ? fn : null;
  if (pins) emit();
}

/** The sidebar says the tree changed under the pins: listeners redraw missing and present. */
export function refresh() { if (pins) emit(); }
