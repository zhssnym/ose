// File operations as a person asks for them: New file…, Rename…, Move to…, Duplicate and
// Move to trash (H12, H13, C6). This is the only UI for the five. The tree and its context
// menu, the palette, the title bar's New file button and quick open's Shift+Enter all end
// here, and every one of them ends at `ose.fileops`, the kernel's one implementation, which
// asks the open page to save before anything on disk changes and refuses when it cannot
// (docs/KERNEL.md `ose.fileops`). The kernel draws nothing: the name prompt, the extension
// question, the trash confirmation and every notice are this file's.
//
// A name is literal. What is typed is what is written: no `.md` appended, no extension kept
// behind the user's back, no character "cleaned" away. `ose.names.check` refuses what no file
// system can hold and says why; the prompt comes back with the reason and the text as typed.
//
// Every function takes an optional target `{ path, kind }` (a list, for the ones that act on a
// selection). Without one, a command acts on what the context says: the focused tree row, else
// the page on screen (`setContext`, which the sidebar fills in).

import { ose } from 'ose:kernel';
import { prompt, confirm, pickFolder, toast, focusOrigin } from 'ose:ui';
import { clean, join, baseName, dirName, extOf, isMd, isTextFile } from './paths.js';
import { closeTabsUnder } from './tabs.js';
import { isMediaFile } from './media.js';

const { bus, commands, route } = ose;

/** @typedef {{path: string, kind: 'file'|'dir'}} Target */

const under = (p, folder) => p === folder || p.startsWith(folder + '/');
const countOf = (items) => `${items.length} item${items.length === 1 ? '' : 's'}`;

/** The page on screen as a target, or null on a view or the home. */
function openPageTarget() {
  const r = route.current();
  return r && r.type === 'page' && r.path ? { path: clean(r.path), kind: 'file' } : null;
}

// What a command acts on when it is not handed a target. The sidebar replaces both: `target`
// is the focused row (else the open page), `batch` the selection that row is part of.
let context = {
  target: openPageTarget,
  batch: () => { const t = openPageTarget(); return t ? [t] : []; },
};

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

const isTarget = (t) => !!t && typeof t === 'object' && !(t instanceof Event) && typeof t.path === 'string';
const norm = (t) => ({ path: clean(t.path), kind: t.kind === 'dir' ? 'dir' : 'file' });

/** One target: the one handed in, the first of a list handed in, else the context's. */
function one(arg) {
  if (isTarget(arg)) return norm(arg);
  if (Array.isArray(arg)) return arg.length && isTarget(arg[0]) ? norm(arg[0]) : null;
  const t = context.target();
  return isTarget(t) ? norm(t) : null;
}

/** Every target: a list handed in, one handed in, else the context's selection. */
function many(arg) {
  if (Array.isArray(arg)) return arg.filter(isTarget).map(norm);
  if (isTarget(arg)) return [norm(arg)];
  return (context.batch() || []).filter(isTarget).map(norm);
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

/** Where the trash confirmation says a file goes, in the platform's own word. */
function trashWhere() {
  if (ose.settings.get().trash === 'vault') return '.trash in the vault';
  return ose.platform === 'macos' ? 'the Trash' : 'the Recycle Bin';
}

/** A `[code] message` string, or an Error with a code, as `{ code, message }`. */
function errorOf(e) {
  if (e && typeof e === 'object') return { code: e.code || null, message: String(e.message || '') };
  const m = /^\[(\w+)\]\s*(.*)$/s.exec(String(e || ''));
  return m ? { code: m[1], message: m[2] } : { code: null, message: String(e || '') };
}

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

/** "renamed · 3 links in 2 pages updated", or the verb alone when nothing linked there. */
function summary(verb, links) {
  const n = (links && links.links) || 0;
  const f = (links && links.files) || 0;
  return verb + (n ? ` · ${n} link${n === 1 ? '' : 's'} in ${f} page${f === 1 ? '' : 's'} updated` : '');
}

/** A page whose links could not be rewritten is named; the move itself stands. */
function linkFailures(links) {
  if (!links) return;
  if (links.error) toast('links not updated: ' + links.error, 'err', 0);
  for (const p of links.failed || []) toast('could not update links in ' + (p && p.path ? p.path : p), 'err', 0);
}

/** A path may go into `folder`: not into itself or under itself, and not where it already is. */
export function canMoveInto(from, folder) {
  const src = clean(from), dest = clean(folder);
  if (!src) return false;
  if (under(dest, src)) return false;
  return dirName(src) !== dest;
}

/* ------------------------------------------------------------------------------ new file */

/**
 * The folder a new file goes in, first match wins: the target's folder (a folder target is its
 * own), the open page's folder, the focused folder, the vault root.
 */
function folderFor(target) {
  if (isTarget(target)) return target.kind === 'dir' ? clean(target.path) : dirName(target.path);
  const page = openPageTarget();
  if (page) return dirName(page.path);
  return clean(ose.focus.get() || '');
}

/**
 * New file… (H12): a name prompt prefilled `Untitled.md` with the stem selected. Any extension
 * or none; `a/b/c.ext` makes the folders. A `.md` starts with its H1 and anything else starts
 * empty (`ose.fileops.create`), and nothing is ever written over: a name that is taken brings
 * the prompt back saying so. The new file opens.
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
        title: 'New File', value, select: stemRange(value), ok: 'Create',
        body: reason || `${where} Any name and any extension; a/b/name.ext makes the folders.`,
      });
      if (!typed) return null;
      value = typed;
    }
    ask = true;
    const c = ose.names.check(value, { folders: true });
    if (!c.ok) { reason = `${cap(c.reason)}.`; continue; }
    try {
      const { path } = await ose.fileops.create(folder, c.name, {});
      // What the app can show opens: markdown, a text file, one with no extension (plain
      // text), an image or a PDF. Anything else (an empty `.xlsx`, say) is the platform's to
      // open, as it is from the tree: its row is shown and focused instead.
      const opens = !extOf(path) || isMd(path) || isTextFile(path) || isMediaFile(path);
      bus.emit('paths:created', { paths: [path], focus: !opens });
      if (opens) await route.navigate({ type: 'page', path });
      else toast(`created ${baseName(path)}`, 'info', 2200);
      return path;
    } catch (e) {
      const err = errorOf(e);
      if (err.code === 'exists') { reason = `${join(folder, c.name)} already exists.`; value = c.name; continue; }
      if (err.code === 'bad_name') { reason = `${cap(err.message)}.`; value = c.name; continue; }
      fail(`could not create ${c.name}`, e);
      return null;
    }
  }
}

const cap = (s) => { const t = String(s || '').replace(/\.$/, ''); return t ? t[0].toUpperCase() + t.slice(1) : t; };

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
      title: dir ? 'Rename Folder' : 'Rename', value, select: stemRange(value, t.kind), ok: 'Rename',
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
      toast(summary('renamed', res.links), 'info', 2600);
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
  try { res = await ose.fileops.move(paths, dest); } catch (e) { fail('move failed', e); return null; }
  for (const s of res.skipped || []) fail(`${baseName(s.path)} was not moved`, s.error);
  if (res.moved && res.moved.length) toast(summary(`moved to ${dest || 'the vault root'}`, res.links), 'info', 2600);
  linkFailures(res.links);
  return res;
}

/* --------------------------------------------------------------------------------- trash */

/**
 * Move to trash: one confirm naming where the files really go (the setting, in the platform's
 * word), then the trash. The page is asked first and a refusal keeps it and its file; only
 * once a file is gone do its tabs close and the page in front land on its neighbour (C6).
 *
 * @param {Target|Target[]} [targets]
 */
export async function trashPaths(targets) {
  const list = many(targets).filter((t) => t.path);
  if (!list.length) return null;
  // From the tree, focus stays in the tree, on the row that takes the gap; from anywhere else
  // it goes wherever the tab that takes this one's place puts it.
  const origin = focusOrigin();
  const fromTree = !!(origin && origin.closest && origin.closest('.sb-scroll'));
  const lone = list.length === 1 ? list[0] : null;
  const dest = trashWhere();
  const ok = await confirm({
    title: lone ? (lone.kind === 'dir' ? 'Move Folder to Trash' : 'Move to Trash') : `Move ${countOf(list)} to Trash`,
    body: lone
      ? `${lone.path} goes to ${dest}. Nothing is deleted permanently.`
      : `${countOf(list)} go to ${dest}: ${list.map((t) => baseName(t.path)).join(', ')}. Nothing is deleted permanently.`,
    ok: 'Move to Trash', danger: true,
  });
  if (!ok) return null;
  const r = route.current();
  let res;
  try { res = await ose.fileops.trash(list.map((t) => t.path)); } catch (e) { fail('trash failed', e); return null; }
  for (const f of res.failed || []) fail(`${baseName(f.path)} was not moved to the trash`, f.error);
  let hit = false;
  let handled = false;
  for (const p of res.trashed || []) {
    if (r && r.type === 'page' && under(clean(r.path), clean(p))) hit = true;
    // A trashed page takes its tab with it: the strip never holds a row for a file that is gone.
    if (closeTabsUnder(p, { focus: !fromTree })) handled = true;
  }
  // No tab held it: the page was not in the strip, so the column simply closes it.
  if (hit && !handled) await route.close({ focus: !fromTree });
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
    const { path } = await ose.fileops.duplicate(t.path);
    bus.emit('paths:created', { paths: [path], focus: true });
    toast('duplicated · ' + baseName(path), 'info', 2200);
    return path;
  } catch (e) {
    fail(`${baseName(t.path)} was not duplicated`, e);
    return null;
  }
}

/* ------------------------------------------------------------------------------ commands */

/**
 * The five commands (docs/SHELL.md "Files"). Each takes an optional target from whoever runs
 * it — the tree's menu hands it the row under the pointer — and otherwise acts on the context.
 * `file.new` is Ctrl+Alt+N and `file.rename` F2, both in `keys.json`.
 */
export function initFileOps() {
  const hasPath = (t) => !!t && !!t.path;
  commands.register({
    id: 'file.new', title: 'New file…', group: 'file', icon: 'plus',
    hint: 'any name, any extension',
    run: (arg) => newFile(isTarget(arg) ? norm(arg) : one(arg) || undefined),
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
    id: 'file.trash', title: 'Move to trash', group: 'file', icon: 'trash',
    when: (arg) => many(arg).some(hasPath),
    run: (arg) => trashPaths(many(arg)),
  });
}
