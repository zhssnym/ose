// The undo journal for file operations (docs/CORE.md `ose.fileops.journal`, M17). Every
// create, new folder, rename, move, copy, duplicate, trash and restore that `ose.fileops` makes
// is written down here as the steps that undo it, newest first, for this session only (at most
// fifty). Ctrl+Z on the tree and the [Undo] of a toast run `undo`, which walks the steps back
// through the ordinary file operations, so an open page follows and links are rewritten back.
// An undo is not journaled, and there is no redo.
//
//   JournalEntry = { id, at, verb, label, steps, undone, undoable }
//   Step = { op: 'created', path, dir, hash }            undone by a trash, if unchanged (a
//                                                        folder: if still empty)
//        | { op: 'moved', from, to }                     undone by a move back
//        | { op: 'copied', from, to, dir, hash, manifest? }  undone by a trash of `to`, if unchanged
//        | { op: 'trashed', path, id, where }            undone by a restore of `id`
//        | { op: 'restored', id, path, dir, hash, manifest? }  undone by a trash, if unchanged
//
// A step that is refused (changed since, left in place) keeps its entry: the entry is marked
// undone only once every step has been undone, and the steps that were undone are dropped from
// it so none is ever applied twice. Ctrl+Z therefore stops at a refusal instead of walking past
// it to an older entry that may depend on it (the folder a refused new page is in).
//
// The steps' undo is fileops.js's (`undoSteps`); this file keeps the list and says when it
// changed: `fileops:journal` `{ entries }` on the bus.

import { bus, uid } from './registry.ts';
import { baseName } from './paths.ts';
import { undoSteps } from './fileops.ts';

/** How many entries the session keeps. */
export const MAX_ENTRIES = 50;

let entries: any[] = [];
let platform = 'windows';

/** The core tells the journal where it runs, so a label can name the bin the way the OS does. */
export function setPlatform(p) { platform = p || 'windows'; }

/** "the Recycle Bin", "the Trash" or ".trash in this vault": where a trashed item went. */
export function binName(where) {
  if (where === 'vault') return '.trash in this vault';
  return platform === 'windows' ? 'the Recycle Bin' : 'the Trash';
}

/** `name` for one path, `N items` for several. */
export function itemsLabel(paths) {
  return paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`;
}

/** A folder as a label names it: its name, or "the vault root". */
export const folderLabel = (folder) => baseName(folder) || 'the vault root';

function emit() {
  bus.emit('fileops:journal', { entries: list() });
}

/**
 * Write an entry down. `undoable` defaults to true; a step that cannot be undone (a trash the
 * platform cannot restore, `id: null`) makes the whole entry not undoable. Answers the entry.
 */
export function record(e: { verb: string; label: string; steps: any[]; undoable?: boolean; }) {
  const steps = Array.isArray(e.steps) ? e.steps : [];
  const cannot = steps.some((s) => s && s.op === 'trashed' && !s.id);
  const entry = {
    id: uid(),
    at: Date.now(),
    verb: e.verb,
    label: e.label,
    steps,
    undone: false,
    undoable: e.undoable !== false && !cannot && steps.length > 0,
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  emit();
  return entry;
}

/** `ose.fileops.journal.list()`: every entry, newest first. Copies; the journal stays the journal's. */
export function list() {
  return entries.map(({ busy, ...e }) => ({ ...e, steps: e.steps.map((s) => ({ ...s })) }));
}

/**
 * The entry Ctrl+Z undoes next: the newest one not undone yet, if it can be undone. Undone
 * entries are stepped over, so Ctrl+Z walks back one operation at a time; an entry that cannot
 * be undone stops the walk, because what came before it may depend on it.
 */
function newestUndoable() {
  const e = entries.find((x) => !x.undone);
  return e && e.undoable && !e.busy ? e : null;
}

/** `path` is `other`, or inside it, or holds it. */
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

/** Every path an entry's steps name. */
function pathsOf(entry) {
  const out: any[] = [];
  for (const s of entry.steps) for (const k of ['path', 'from', 'to']) if (typeof s[k] === 'string' && s[k]) out.push(s[k]);
  return out;
}

/**
 * A newer entry, not undone, that touches the same paths as `entry` (a toast's [Undo] of an
 * older operation): its undo must come first, or undoing `entry` would take the newer work
 * with it (a folder created, then files moved into it).
 */
function newerOver(entry) {
  const mine = pathsOf(entry);
  for (const e of entries) {
    if (e === entry) return null;
    if (e.undone) continue;
    const theirs = pathsOf(e);
    const hit = theirs.find((t) => mine.some((m) => overlaps(m, t)));
    if (hit) return { entry: e, path: hit };
  }
  return null;
}

/** `ose.fileops.journal.canUndo()`: the newest entry not undone yet can be undone. */
export function canUndo() { return !!newestUndoable(); }

/**
 * `ose.fileops.journal.undo(id?)` -> `{ ok, entry, failed: [{ step, error }] }`. Without an id
 * the newest entry not undone yet (repeated, it walks back); with one, that entry (a toast's
 * [Undo] names its own), refused while a newer entry not undone touches the same paths.
 * Steps are undone in reverse order; a step that fails is listed and the others still run.
 * The steps that were undone leave the entry, so none is applied twice; the entry is marked
 * undone once none is left, and otherwise stays, holding the refused ones.
 */
export async function undo(id: string) {
  const entry = id ? entries.find((e) => e.id === id) : newestUndoable();
  if (!entry) return { ok: false, entry: null, failed: [{ step: null, error: 'nothing to undo' }] };
  if (entry.undone) return { ok: false, entry: { ...entry }, failed: [{ step: null, error: 'already undone' }] };
  if (!entry.undoable) return { ok: false, entry: { ...entry }, failed: [{ step: null, error: 'this cannot be undone' }] };
  if (entry.busy) return { ok: false, entry: { ...entry }, failed: [{ step: null, error: 'already being undone' }] };
  const over = newerOver(entry);
  if (over) {
    return { ok: false, entry: { ...entry }, failed: [{ step: null, error: `${baseName(over.path)} changed later (${over.entry.label}); undo that first` }] };
  }
  entry.busy = true;
  let failed;
  try {
    failed = await undoSteps(entry.steps.slice().reverse());
  } catch (err) {
    const e = (err as { code?: string, message?: string });
    failed = [{ step: null, error: String((e && e.message) || e) }];
  } finally {
    entry.busy = false;
  }
  // A throw from outside the steps names no step: nothing is known to be undone, all stay.
  if (!failed.some((f) => f.step === null)) {
    const left = new Set(failed.map((f) => f.step));
    entry.steps = entry.steps.filter((s) => left.has(s));
  }
  entry.undone = entry.steps.length === 0;
  emit();
  return { ok: failed.length === 0, entry: { ...entry }, failed };
}

/** `ose.fileops.journal.on(fn)`: fn({ entries }) on every change. -> unsubscribe */
export function on(fn) { return bus.on('fileops:journal', fn); }

/** Empty the journal (tests, and a change of vault). */
export function clearJournal() { entries = []; emit(); }
