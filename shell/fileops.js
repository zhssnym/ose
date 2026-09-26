// File operations as a person asks for them: New file…, New folder, Rename…, Move to…,
// Duplicate, Move to the trash, Cut, Copy, Paste and Undo (H12, H13, C6, M17, M18). This is the
// only UI for them. The tree and its context menu, the folder view, the palette, the title
// bar's New file button and quick open's Shift+Enter all end here, and every one of them ends
// at `ose.fileops`, the kernel's one implementation, which asks the open page to save before
// anything on disk changes and refuses when it cannot (docs/KERNEL.md `ose.fileops`). The
// kernel draws nothing: the name prompt, the extension question, the trash confirmation and
// every notice are this file's.
//
// A name is literal. What is typed is what is written: no `.md` appended, no extension kept
// behind the user's back, no character "cleaned" away. `ose.names.check` refuses what no file
// system can hold and says why; the prompt comes back with the reason and the text as typed.
//
// Every operation that completes says so in a toast with its journal label ("Renamed notes.md
// to notes.txt") and an Undo that takes exactly that operation back (`ose.fileops.journal`).
// Undo is the safety net, so a single item goes to the trash without a question; a batch gets
// one confirm, and both name the real destination — the Recycle Bin, the Trash, or the
// vault's own `.trash` — rather than a generic "trash" (M18).
//
// Every function takes an optional target `{ path, kind }` (a list, for the ones that act on a
// selection). Without one, a command acts on what the context says: the list that has the
// keyboard (`addContext`, the folder view), else the focused tree row, else the page on screen
// (`setContext`, which the sidebar fills in).

import { ose } from 'ose:kernel';
import { prompt, confirm, pickFolder, toast, focusOrigin } from 'ose:ui';
import { clean, join, baseName, dirName } from './paths.js';

const { bus, commands, route } = ose;

/** @typedef {{path: string, kind: 'file'|'dir'}} Target */

const under = (p, folder) => p === folder || p.startsWith(folder + '/');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const countOf = (items) => plural(items.length, 'item');

/** The page on screen as a target, or null on a view, a folder or Home. */
function openPageTarget() {
  const r = route.current();
  return r && r.type === 'page' && r.path ? { path: clean(r.path), kind: 'file' } : null;
}

/** The folder on screen as a target (a folder route), or null. */
function openFolderTarget() {
  const r = route.current();
  return r && r.type === 'folder' ? { path: clean(r.path || ''), kind: 'dir' } : null;
}

// What a command acts on when it is not handed a target. The sidebar replaces both: `target`
// is the focused row (else the open page), `batch` the selection that row is part of.
let context = {
  target: () => openPageTarget() || openFolderTarget(),
  batch: () => { const t = openPageTarget(); return t ? [t] : []; },
};

// Lists that answer for "here" only while they have the keyboard (the folder view): the newest
// one whose `active()` says yes wins over the sidebar's context.
const providers = [];

/**
 * The sidebar says what "here" is: `{ target, batch }`, two functions answering a Target and a
 * list of them. Either may be left out; the open page stands in for it.
 * @param {{target?: () => Target|null, batch?: () => Target[]}} c
 */
export function setContext(c) {
  context = {
    target: typeof c.target === 'function' ? c.target : context.target,
    batch: typeof c.batch === 'function' ? c.batch : context.batch,
  };
}

/**
 * Another list that answers for "here" while it has the keyboard: the folder view, whose
 * selected rows are what Cut, Copy, Rename and the trash act on when it holds focus. `folder`
 * is where Paste and New folder land from it.
 * @param {{active: () => boolean, target?: () => Target|null, batch?: () => Target[], folder?: () => string}} c
 * @returns {() => void} removes it
 */
export function addContext(c) {
  if (!c || typeof c.active !== 'function') return () => {};
  providers.push(c);
  return () => { const i = providers.indexOf(c); if (i >= 0) providers.splice(i, 1); };
}

function activeProvider() {
  for (let i = providers.length - 1; i >= 0; i--) {
    try { if (providers[i].active()) return providers[i]; } catch { /* a gone view answers nothing */ }
  }
  return null;
}

const isTarget = (t) => !!t && typeof t === 'object' && !(t instanceof Event) && typeof t.path === 'string';
const norm = (t) => ({ path: clean(t.path), kind: t.kind === 'dir' ? 'dir' : 'file' });

/** One target: the one handed in, the first of a list handed in, else the context's. */
function one(arg) {
  if (isTarget(arg)) return norm(arg);
  if (Array.isArray(arg)) return arg.length && isTarget(arg[0]) ? norm(arg[0]) : null;
  const p = activeProvider();
  const t = p && typeof p.target === 'function' ? p.target() : context.target();
  return isTarget(t) ? norm(t) : null;
}

/** Every target: a list handed in, one handed in, else the context's selection. */
function many(arg) {
  if (Array.isArray(arg)) return arg.filter(isTarget).map(norm);
  if (isTarget(arg)) return [norm(arg)];
  const p = activeProvider();
  const list = p && typeof p.batch === 'function' ? p.batch() : context.batch();
  return (list || []).filter(isTarget).map(norm);
}

/**
 * The selection a prompt starts with: the stem of the last segment, so typing replaces the
 * name and keeps the extension (`Untitled.md` selects `Untitled`). A folder, or a name with no
 * extension, is selected whole.
 */
function stemRange(value, kind = 'file') {
  const s = String(value);
  const start = s.lastIndexOf('/') + 1;
  if (kind === 'dir') return [start, s.length];
  const { ext } = ose.names.split(s.slice(start));
  return [start, ext ? s.length - ext.length - 1 : s.length];
}

/** A `[code] message` string, or an Error with a code, as `{ code, message }`. */
function errorOf(e) {
  if (e && typeof e === 'object') {
    const m = /^\[(\w+)\]\s*(.*)$/s.exec(String(e.message || ''));
    return { code: e.code || (m ? m[1] : null), message: m ? m[2] : String(e.message || '') };
  }
  const m = /^\[(\w+)\]\s*(.*)$/s.exec(String(e || ''));
  return m ? { code: m[1], message: m[2] } : { code: null, message: String(e || '') };
}

const cap = (s) => { const t = String(s || '').replace(/\.$/, ''); return t ? t[0].toUpperCase() + t.slice(1) : t; };

/**
 * Say that an operation did not happen. Sticky, because a file that did not move is not news
 * that should leave on its own. A page that would not save first (`not_saved`) offers the
 * editor's own explanation (`page.show-problem`), which is where the way out is.
 */
function fail(text, e) {
  const err = errorOf(e);
  const line = err.message ? `${text}: ${err.message}` : text;
  try { Promise.resolve(ose.log(line, 'warn')).catch(() => {}); } catch { /* the log is best effort */ }
  if (err.code === 'not_saved') {
    toast(line, 'err', 0, { actions: [{ label: 'Show', run: () => commands.run('page.show-problem') }] });
    return;
  }
  toast(line, 'err', 0);
}

/** " · 3 links in 2 files updated", or nothing when nothing linked there. */
function linkTail(links) {
  const n = (links && links.links) || 0;
  const f = (links && links.files) || 0;
  return n ? ` · ${plural(n, 'link')} in ${plural(f, 'file')} updated` : '';
}

/** A page whose links could not be rewritten is named; the move itself stands. */
function linkFailures(links) {
  if (!links) return;
  if (links.error) toast('Links not updated: ' + links.error, 'err', 0);
  for (const p of links.failed || []) toast('Could not update links in ' + (p && p.path ? p.path : p), 'err', 0);
}

const journal = () => (ose.fileops && ose.fileops.journal) || null;

/**
 * The toast of a completed operation: its journal label (or `fallback` from a kernel that
 * keeps no journal), and an Undo for exactly that entry when it can be undone.
 */
function done(entry, fallback, tail = '') {
  const text = ((entry && entry.label) || fallback) + tail;
  const j = journal();
  const canUndo = !!(entry && entry.id && entry.undoable !== false && j && typeof j.undo === 'function');
  toast(text, 'info', canUndo ? 6000 : 2600, canUndo ? { actions: [{ label: 'Undo', run: () => void undo(entry.id) }] } : {});
}

/** A path may go into `folder`: not into itself or under itself, and not where it already is. */
export function canMoveInto(from, folder) {
  const src = clean(from), dest = clean(folder);
  if (!src) return false;
  if (under(dest, src)) return false;
  return dirName(src) !== dest;
}

/**
 * Ask the tree to show a path: expand down to it and, with `focus`, put the keyboard on its
 * row. The kernel's `paths:*` events say what changed; this says what the person should see.
 */
function reveal(path, focus) { bus.emit('tree:reveal', { path, focus: !!focus && fromSidebar() }); }

/**
 * Whether the gesture came from the sidebar (a row, its menu, its tool strip): only then does
 * the new row take the keyboard. From the folder view or the palette over a page, focus stays
 * where the person is working.
 */
function fromSidebar() {
  const o = focusOrigin();
  return !!(o && o.closest && o.closest('.sidebar'));
}

/* ------------------------------------------------------------------------------ new file */

/**
 * The folder a new file goes in, first match wins: the target's folder (a folder target is its
 * own), then `ose.focus.defaultNewFolder()` (the focused folder, the route's folder, the root).
 */
function folderFor(target) {
  if (isTarget(target)) return target.kind === 'dir' ? clean(target.path) : dirName(target.path);
  const p = activeProvider();
  if (p && typeof p.folder === 'function') return clean(p.folder() || '');
  const page = openPageTarget();
  if (page) return dirName(page.path);
  const folder = openFolderTarget();
  if (folder) return folder.path;
  try { return clean(ose.focus.defaultNewFolder() || ''); } catch { return ''; }
}

/**
 * New file… (H12): a name prompt prefilled `Untitled.md` with the stem selected. Any extension
 * or none; `a/b/c.ext` makes the folders. A `.md` starts with its H1 and anything else starts
 * empty (`ose.fileops.create`), and nothing is ever written over: a name that is taken brings
 * the prompt back saying so. The new file opens, whatever it is: the page host decides how
 * (H17), and a binary it cannot show gets its own box with the ways out.
 *
 * With `name` the prompt is skipped (quick open's Shift+Enter has already asked), and comes
 * back only if that name cannot be used.
 *
 * @param {Target} [target]
 * @param {{name?: string}} [opts]
 * @returns {Promise<string|null>} the new path, or null when nothing was created
 */
export async function newFile(target, { name = null } = {}) {
  const folder = folderFor(target);
  const where = folder ? `In ${folder}.` : 'In the vault root.';
  let value = name == null ? 'Untitled.md' : String(name);
  let reason = '';
  let ask = name == null;
  for (;;) {
    if (ask) {
      const typed = await prompt({
        title: 'New file', value, select: stemRange(value), ok: 'Create',
        body: reason || `${where} Any name and any extension; a/b/name.ext makes the folders.`,
      });
      if (!typed) return null;
      value = typed;
    }
    ask = true;
    const c = ose.names.check(value, { folders: true });
    if (!c.ok) { reason = `${cap(c.reason)}.`; continue; }
    try {
      const res = await ose.fileops.create(folder, c.name, {});
      reveal(res.path, false);
      await route.navigate({ type: 'page', path: res.path });
      done(res.entry, `Created ${baseName(res.path)}`);
      return res.path;
    } catch (e) {
      const err = errorOf(e);
      if (err.code === 'exists') { reason = `${join(folder, c.name)} already exists.`; value = c.name; continue; }
      if (err.code === 'bad_name') { reason = `${cap(err.message)}.`; value = c.name; continue; }
      fail(`Could not create ${c.name}`, e);
      return null;
    }
  }
}

/* ---------------------------------------------------------------------------- new folder */

/**
 * New folder (Ctrl+Shift+N): a name prompt, then `ose.fileops.mkdir`. The same literal rule
 * as every name; `a/b` makes both. The tree opens down to it and its row takes the keyboard.
 *
 * @param {Target|string} [target] a folder target, a file (its folder), or a folder path
 * @returns {Promise<string|null>} the new folder's path
 */
export async function newFolder(target) {
  const folder = typeof target === 'string' ? clean(target) : folderFor(isTarget(target) ? norm(target) : one(target) || undefined);
  const where = folder ? `In ${folder}.` : 'In the vault root.';
  let value = '';
  let reason = '';
  for (;;) {
    const typed = await prompt({ title: 'New folder', value, placeholder: 'folder name', ok: 'Create', body: reason || where });
    if (!typed) return null;
    value = typed;
    const c = ose.names.check(typed, { folders: true });
    if (!c.ok) { reason = `${cap(c.reason)}.`; continue; }
    try {
      let res;
      if (typeof ose.fileops.mkdir === 'function') res = await ose.fileops.mkdir(folder, c.name);
      else { const path = join(folder, c.name); await ose.files.mkdir(path); res = { path }; bus.emit('paths:created', { paths: [path] }); }
      reveal(res.path, true);
      done(res.entry, `Created folder ${baseName(res.path)}`);
      return res.path;
    } catch (e) {
      const err = errorOf(e);
      if (err.code === 'exists' || err.code === 'bad_name') { reason = `${cap(err.message || `${c.name} already exists`)}.`; continue; }
      fail(`Could not create folder ${c.name}`, e);
      return null;
    }
  }
}

/* -------------------------------------------------------------------------------- rename */

/**
 * Rename… (H13): the prompt holds the full name with the stem selected. The name typed is the
 * name written; changing the extension asks once ("Change .md to .txt?"), and No goes back to
 * the prompt with the text as typed. The open page, or any page under a renamed folder, is
 * saved first and follows its file without being reopened (`ose.fileops.rename`).
 *
 * @param {Target} [target]
 * @returns {Promise<string|null>} the new path, or null when nothing was renamed
 */
export async function renamePath(target) {
  const t = one(target);
  if (!t || !t.path) return null;
  const old = baseName(t.path);
  const dir = t.kind === 'dir';
  let value = old;
  let reason = '';
  for (;;) {
    const typed = await prompt({
      title: dir ? 'Rename folder' : 'Rename', value, select: stemRange(value, t.kind), ok: 'Rename',
      body: reason,
    });
    if (!typed) return null;
    value = typed;
    const c = ose.names.check(typed);
    if (!c.ok) { reason = `${cap(c.reason)}.`; continue; }
    if (c.name === old) return null;
    if (!dir && ose.names.extChanged(old, c.name)) {
      const a = ose.names.split(old).ext, b = ose.names.split(c.name).ext;
      const said = (x) => (x ? '.' + x : 'no extension');
      const ok = await confirm({
        title: `Change ${said(a)} to ${said(b)}?`,
        body: `${old} becomes ${c.name}. Its bytes stay as they are; what opens it may change.`,
        ok: b ? `Use .${b}` : 'Remove it',
      });
      if (!ok) { reason = ''; continue; }
    }
    try {
      // The watcher reports this a moment later; the sidebar must not ask about it (N19).
      bus.emit('paths:moving', { moves: [{ from: t.path, to: join(dirName(t.path), c.name) }] });
      const res = await ose.fileops.rename(t.path, c.name);
      done(res.entry, `Renamed ${old} to ${c.name}`, linkTail(res.links));
      linkFailures(res.links);
      return res.to;
    } catch (e) {
      const err = errorOf(e);
      if (err.code === 'exists' || err.code === 'bad_name') { reason = `${cap(err.message)}.`; continue; }
      fail(`${old} was not renamed`, e);
      return null;
    }
  }
}

/* ---------------------------------------------------------------------------------- move */

/**
 * Move to… : one target or a selection into `folder`, asked for with the folder picker when it
 * is not given (a drag gives it). A path already there, or a folder into itself, is passed by;
 * one that cannot go is named, and the rest still move. One toast for the batch.
 *
 * @param {Target|Target[]} [targets]
 * @param {string} [folder]
 */
export async function movePaths(targets, folder) {
  const list = many(targets).filter((t) => t.path);
  if (!list.length) return null;
  let dest = folder;
  if (dest === undefined || dest === null) {
    const first = list[0].path;
    const title = list.length === 1 ? `Move ${baseName(first)} to…` : `Move ${countOf(list)} to…`;
    // A single folder is not offered its own subtree; several are checked one by one.
    dest = await pickFolder({
      title, current: dirName(first), enterLabel: 'move here',
      hide: list.length === 1 && list[0].kind === 'dir' ? first : null,
    });
    if (dest === null || dest === undefined) return null;
  }
  dest = clean(dest);
  const paths = list.map((t) => t.path).filter((p) => canMoveInto(p, dest));
  if (!paths.length) return null;
  // The watcher reports these a moment later; the sidebar must not ask about them (N19).
  bus.emit('paths:moving', { moves: paths.map((p) => ({ from: p, to: join(dest, baseName(p)) })) });
  let res;
  try { res = await ose.fileops.move(paths, dest); } catch (e) { fail('Move failed', e); return null; }
  for (const s of res.skipped || []) fail(`${baseName(s.path)} was not moved`, s.error);
  const moved = res.moved || [];
  if (moved.length) {
    const what = moved.length === 1 ? baseName(moved[0].from || moved[0]) : countOf(moved);
    done(res.entry, `Moved ${what} to ${dest || 'the vault root'}`, linkTail(res.links));
  }
  linkFailures(res.links);
  return res;
}

/* --------------------------------------------------------------------------------- trash */

/** The words for where the trash puts things (M18): `{ to, title }` for a `where`. */
function trashWords(where) {
  if (where === 'vault') return { to: '.trash in this vault', title: 'Move to .trash in this vault' };
  if (ose.platform === 'windows') return { to: 'the Recycle Bin', title: 'Move to the Recycle Bin' };
  return { to: 'the Trash', title: 'Move to the Trash' };
}

/**
 * Where `path` would go, asked of the host (`ose.files.trashWhere`, which knows a volume with
 * no Recycle Bin); a kernel without it answers from the setting.
 */
async function whereFor(path) {
  try {
    if (typeof ose.files.trashWhere === 'function') {
      const r = await ose.files.trashWhere(path);
      if (r && (r.where === 'vault' || r.where === 'system')) return r.where;
    }
  } catch { /* the setting is the next best answer */ }
  return ose.settings.get().trash === 'vault' ? 'vault' : 'system';
}

/**
 * Move to the trash (M18). A single item goes without a question: the toast says where it went
 * and its Undo brings it back. Several ask once, naming the real destination. Nothing is ever
 * deleted permanently: where the platform's bin refuses, the host puts it in the vault's
 * `.trash` and says so. The page is asked first and a refusal keeps it and its file (C6); the
 * tabs that showed a trashed file turn into its folder (the kernel's `paths:trashed`).
 *
 * @param {Target|Target[]} [targets]
 */
export async function trashPaths(targets) {
  const list = many(targets).filter((t) => t.path);
  if (!list.length) return null;
  const lone = list.length === 1 ? list[0] : null;
  if (!lone) {
    const words = trashWords(await whereFor(list[0].path));
    const ok = await confirm({
      title: `${words.title.replace(/^Move/, `Move ${countOf(list)}`)}?`,
      body: `${list.map((t) => baseName(t.path)).join(', ')}. Nothing is deleted permanently, and Undo brings them back.`,
      ok: words.title, danger: true,
    });
    if (!ok) return null;
  }
  let res;
  try { res = await ose.fileops.trash(list.map((t) => t.path)); } catch (e) { fail('Could not move to the trash', e); return null; }
  for (const f of res.failed || []) fail(`${baseName(f.path)} was not moved to the trash`, f.error);
  const trashed = res.trashed || [];
  if (trashed.length) {
    // Where it really went: the host's answer per item, which beats any prediction.
    const items = res.items || [];
    const wheres = new Set(items.map((it) => it && it.where).filter(Boolean));
    const where = wheres.size === 1 ? [...wheres][0] : wheres.size ? 'mixed' : ose.settings.get().trash === 'vault' ? 'vault' : 'system';
    const what = trashed.length === 1 ? baseName(trashed[0]) : countOf(trashed);
    const fallback = where === 'mixed' ? `Moved ${what} to the trash` : `Moved ${what} to ${trashWords(where).to}`;
    // The journal's label names the bin (M18); ours says the same for a kernel without one.
    done(res.entry, fallback);
  }
  return res;
}

/* ----------------------------------------------------------------------------- duplicate */

/**
 * Duplicate: `stem 2.ext` beside the file, byte for byte, whatever its type (N23). The open
 * page is saved first, so the copy holds what is on screen.
 *
 * @param {Target} [target]
 */
export async function duplicatePath(target) {
  const t = one(target);
  if (!t || !t.path || t.kind === 'dir') return null;
  try {
    const res = await ose.fileops.duplicate(t.path);
    reveal(res.path, true);
    done(res.entry, `Duplicated ${baseName(t.path)} as ${baseName(res.path)}`);
    return res.path;
  } catch (e) {
    fail(`${baseName(t.path)} was not duplicated`, e);
    return null;
  }
}

/* ---------------------------------------------------------------------- the clipboard (M17) */

// The app's own file clipboard: vault paths, never the system clipboard (which holds text the
// person may still want). A cut is only a mark until Paste: nothing moves, the rows dim.
let clip = null;
const clipListeners = new Set();

function emitClip() {
  for (const fn of [...clipListeners]) {
    try { fn(clip); } catch (e) { console.error('[shell] clipboard listener', e); }
  }
}

function setClip(next) {
  clip = next && next.paths && next.paths.length ? { mode: next.mode, paths: [...next.paths] } : null;
  emitClip();
}

/**
 * Cut: the targets are marked to move on the next Paste. Their rows show dimmed; nothing moves
 * until then, and Esc or another Cut or Copy forgets it.
 * @param {Target|Target[]} [targets]
 */
export function cut(targets) {
  const list = many(targets).filter((t) => t.path);
  if (!list.length) return;
  setClip({ mode: 'cut', paths: list.map((t) => t.path) });
  toast(`Cut ${list.length === 1 ? baseName(list[0].path) : countOf(list)} · paste where it should go`, 'info', 2200);
}

/**
 * Copy: the targets are copied on the next Paste, as many times as it is pasted.
 * @param {Target|Target[]} [targets]
 */
export function copy(targets) {
  const list = many(targets).filter((t) => t.path);
  if (!list.length) return;
  setClip({ mode: 'copy', paths: list.map((t) => t.path) });
  toast(`Copied ${list.length === 1 ? baseName(list[0].path) : countOf(list)}`, 'info', 2200);
}

/**
 * Paste into `folder`: a cut moves (and the clipboard empties), a copy copies (`x 2.ext` when
 * the name is taken, so pasting into the same folder duplicates). One toast, with Undo.
 * @param {string|Target} [folder] a folder path, or a target whose folder is meant
 * @returns {Promise<object|null>} the kernel's result
 */
export async function paste(folder) {
  if (!clip) { toast('Nothing to paste', 'info', 1800); return null; }
  const dest = typeof folder === 'string' ? clean(folder) : folderFor(isTarget(folder) ? norm(folder) : one(folder) || undefined);
  const { mode } = clip;
  let paths = clip.paths;
  if (mode === 'cut') {
    // Where it already is, or into itself: passed by, as a drag would.
    paths = paths.filter((p) => canMoveInto(p, dest));
    if (!paths.length) {
      toast(clip.paths.some((p) => under(dest, p)) ? 'A folder cannot go inside itself' : 'Already in this folder', 'info', 2200);
      return null;
    }
    bus.emit('paths:moving', { moves: paths.map((p) => ({ from: p, to: join(dest, baseName(p)) })) });
  }
  let res;
  try {
    if (typeof ose.fileops.paste === 'function') res = await ose.fileops.paste({ mode, paths }, dest);
    else if (mode === 'cut') res = await ose.fileops.move(paths, dest);
    else if (typeof ose.fileops.copy === 'function') res = await ose.fileops.copy(paths, dest);
    else throw new Error('copying files needs a newer kernel');
  } catch (e) { fail(mode === 'cut' ? 'Move failed' : 'Copy failed', e); return null; }
  if (mode === 'cut') setClip(null);
  for (const s of (res && res.skipped) || []) fail(`${baseName(s.path)} was not ${mode === 'cut' ? 'moved' : 'copied'}`, s.error);
  const landed = mode === 'cut' ? (res && res.moved) || [] : (res && res.copied) || [];
  if (landed.length) {
    const first = landed[0];
    const last = landed[landed.length - 1];
    const what = landed.length === 1 ? baseName(first.from || first) : countOf(landed);
    const to = dest || 'the vault root';
    done(res.entry, mode === 'cut' ? `Moved ${what} to ${to}` : `Copied ${what} to ${to}`, linkTail(res.links));
    if (last && last.to) reveal(last.to, true);
  }
  linkFailures(res && res.links);
  return res;
}

/** Forget the clipboard: Esc in the tree after a Cut, so the dimmed rows are themselves again. */
export function clearClipboard() { if (clip) setClip(null); }

/**
 * What is on the clipboard.
 * @returns {{mode: 'cut'|'copy', paths: string[]}|null}
 */
export function clipboard() { return clip ? { mode: clip.mode, paths: [...clip.paths] } : null; }

/**
 * Be told when the clipboard changes (to dim cut rows, to show Paste).
 * @param {(clip: {mode: string, paths: string[]}|null) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onClipboard(fn) {
  clipListeners.add(fn);
  return () => clipListeners.delete(fn);
}

/** The clipboard follows what it points at: a moved path is carried, a trashed one dropped. */
function followClipboard() {
  bus.on('paths:moved', (d) => {
    if (!clip) return;
    const moves = ((d && d.moves) || []).filter((m) => m && m.from && m.to).map((m) => ({ from: clean(m.from), to: clean(m.to) }));
    if (!moves.length) return;
    let changed = false;
    const paths = clip.paths.map((p) => {
      for (const m of moves) {
        if (p === m.from) { changed = true; return m.to; }
        if (p.startsWith(m.from + '/')) { changed = true; return m.to + p.slice(m.from.length); }
      }
      return p;
    });
    if (changed) setClip({ mode: clip.mode, paths });
  });
  bus.on('paths:trashed', (d) => {
    if (!clip) return;
    const gone = ((d && d.paths) || []).map(clean);
    const paths = clip.paths.filter((p) => !gone.some((g) => under(p, g)));
    if (paths.length !== clip.paths.length) setClip({ mode: clip.mode, paths });
  });
}

/* ---------------------------------------------------------------------------------- undo */

/**
 * Undo the newest file operation, or the one named by `id` (a toast's Undo). The result is a
 * toast: what was undone, or each step that could not be, which is left as it is.
 * @param {string} [id]
 * @returns {Promise<{ok: boolean}|null>}
 */
export async function undo(id) {
  const j = journal();
  if (!j || typeof j.undo !== 'function') { toast('Undo is not available', 'info', 2000); return null; }
  if (!id && typeof j.canUndo === 'function' && !j.canUndo()) { toast('Nothing to undo', 'info', 1800); return null; }
  let r;
  try { r = await j.undo(id); } catch (e) { fail('Could not undo', e); return null; }
  if (!r) return null;
  const label = r.entry && r.entry.label ? r.entry.label : 'the last file operation';
  const failed = r.failed || [];
  if (r.ok && !failed.length) toast(`Undone: ${label}`, 'info', 2600);
  else {
    if (!failed.length) fail(`Could not undo: ${label}`, null);
    for (const f of failed) {
      const step = f && f.step ? f.step : null;
      const where = step ? baseName(step.path || step.to || step.from || '') : '';
      fail(where ? `Could not undo ${where}` : `Could not undo ${label}`, f && f.error);
    }
  }
  return r;
}

/* ------------------------------------------------------------------------------ commands */

/**
 * The file commands (docs/SHELL.md "Files"). Each takes an optional target from whoever runs
 * it — the tree's menu hands it the row under the pointer — and otherwise acts on the context.
 * `file.new` is Ctrl+Alt+N and `file.rename` F2 in `keys.json`; Cut, Copy, Paste and Undo are
 * Ctrl+X, C, V and Z inside the tree and the folder view only, so the editor keeps its own.
 */
export function initFileOps() {
  const hasPath = (t) => !!t && !!t.path;
  followClipboard();
  commands.register({
    id: 'file.new', title: 'New file…', group: 'file', icon: 'plus',
    hint: 'any name, any extension',
    run: (arg) => newFile(isTarget(arg) ? norm(arg) : one(arg) || undefined),
  });
  commands.register({
    id: 'tree.new-folder', title: 'New folder', group: 'file', icon: 'folderPlus',
    run: (arg) => newFolder(typeof arg === 'string' ? arg : isTarget(arg) ? norm(arg) : undefined),
  });
  commands.register({
    id: 'file.rename', title: 'Rename…', group: 'file', icon: 'rename',
    hint: 'the name, as typed',
    when: (arg) => hasPath(one(arg)),
    run: (arg) => renamePath(one(arg)),
  });
  commands.register({
    id: 'file.move', title: 'Move to…', group: 'file', icon: 'folder',
    when: (arg) => many(arg).some(hasPath),
    run: (arg) => movePaths(many(arg)),
  });
  commands.register({
    id: 'file.duplicate', title: 'Duplicate', group: 'file', icon: 'copy',
    when: (arg) => { const t = one(arg); return hasPath(t) && t.kind !== 'dir'; },
    run: (arg) => duplicatePath(one(arg)),
  });
  commands.register({
    id: 'file.cut', title: 'Cut', group: 'file', icon: 'scissors',
    when: (arg) => many(arg).some(hasPath),
    run: (arg) => cut(many(arg)),
  });
  commands.register({
    id: 'file.copy', title: 'Copy', group: 'file', icon: 'copy',
    when: (arg) => many(arg).some(hasPath),
    run: (arg) => copy(many(arg)),
  });
  commands.register({
    id: 'file.paste', title: 'Paste', group: 'file', icon: 'clipboard',
    hint: 'into the folder here',
    when: () => !!clip,
    run: (arg) => paste(typeof arg === 'string' ? arg : isTarget(arg) ? norm(arg) : undefined),
  });
  commands.register({
    id: 'file.undo', title: 'Undo last file operation', group: 'file', icon: 'undo',
    when: () => { const j = journal(); return !!j && typeof j.canUndo === 'function' && j.canUndo(); },
    run: () => undo(),
  });
  commands.register({
    id: 'file.trash', title: 'Move to the trash', group: 'file', icon: 'trash',
    when: (arg) => many(arg).some(hasPath),
    run: (arg) => trashPaths(many(arg)),
  });
}
