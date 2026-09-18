// The task index of the Day plugin. One source: the `todo` path, one markdown file, whatever
// `ose.paths` resolved it to. It is read on demand and again after the host reports a change to
// it, so there is no vault walk, no search narrowing and no per-file mtime cache. Nesting in the
// file (`  - [ ]` under a parent item) is kept as indentation on the row. Toggling rewrites the
// exact source line, after checking it has not moved, and nothing else; adding appends one line
// at the end and touches nothing above it.

import { esc } from 'ose:ui';
import { ymd } from 'ose:md';
import { parseTasks, toggleTaskLine, PRIORITY_RANK } from '../_lib/tasks.js';

// The plugin's `ose`, handed over by `activate` before anything here runs.
let ose = null;
export function initTasks(app) {
  ose = app;
  // One subscription for the life of the plugin, taken back by the kernel on unload: the index
  // cares about its own file changing on disk. `watch(fn)` with no folders is the whole vault,
  // so the change list is filtered here rather than at subscription time, because the resolved
  // path changes when the user chooses another file.
  ose.watch((d) => {
    for (const c of (d && d.changes) || []) if (c && (touches(c.path) || touches(c.to))) { stale = true; return; }
  });
}

const INDENT_UNIT = 2;     // spaces per nesting level in the file
const MAX_DEPTH = 4;       // deeper nesting still renders, it just stops moving right

/** The file the index reads: the resolved `todo` path, set by the view after `ose.paths.get`. */
let src = '';
export function setTaskPath(path) {
  const next = path ? String(path).replace(/^\/+/, '').replace(/\/+$/, '') : '';
  if (next === src) return;
  src = next;
  forget();
}
export function taskPath() { return src; }

/** Drop what was read: the path changed, or the file under it did. */
function forget() { all = []; groups = []; loaded = false; missing = false; stale = true; }

let all = [];              // every task line of the file, in file order
let groups = [];           // [{ path, name, label, tasks }]: one entry, the file
let loaded = false;        // the file has been read at least once
let missing = false;       // the last read found nothing at the path
let stale = true;          // something changed under us (or it was never read)
let reading = null;        // the in-flight read, so callers coalesce

/** A change that touches the file the index read. */
function touches(p) {
  return !!p && !!src && p === src;
}

/* ------------------------------------------------------------------ index */

/**
 * The one markdown file -> one group. It carries no label: a single list has nothing to be
 * told apart from, so the Day view draws its rows flat with no heading above them.
 */
async function readGroup(path) {
  let text = '';
  try { text = await ose.files.read(path); }
  catch (e) { console.warn('[tasks-index] unreadable', path, e); }
  return { path, name: path.split('/').pop(), label: null, tasks: parseTasks(text, path) };
}

async function build() {
  groups = [];
  missing = true;
  try {
    const st = src ? await ose.files.stat(src) : { exists: false };
    if (st && st.exists) {
      missing = false;
      groups = [await readGroup(src)];
    }
  } catch (e) {
    console.warn('[tasks-index] unreadable source', src, e);
    missing = true;
    groups = [];
  }
  all = groups.flatMap((g) => g.tasks);
  loaded = true;
  stale = false;
  return groups;
}

/**
 * Read the file when it has never been read or has changed since. Concurrent calls coalesce
 * onto the same read. `{force:true}` re-reads even when nothing looked stale.
 */
export function indexTasks({ force = false } = {}) {
  if (reading) return reading;
  if (loaded && !stale && !force) return Promise.resolve(groups);
  reading = build().finally(() => { reading = null; });
  return reading;
}

/** The list of the last index. Empty until `indexTasks()` has resolved once. */
export const taskGroups = () => groups;
/** Every task of the file, flat. */
export const allTasks = () => all;
/** True when the last read found nothing at the resolved path. */
export const taskSourceMissing = () => loaded && missing;
/** The files actually read, for the Day view's meta line. */
export const taskFiles = () => groups.map((g) => g.path);
/** Forget what was read, so the next `indexTasks()` reads again. */
export const dropSource = () => { stale = true; };

/* ---------------------------------------------------------------- buckets */

const whenOf = (t) => t.due || t.scheduled || null;

export const byDate = (a, b) => String(whenOf(a)).localeCompare(String(whenOf(b)))
  || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  || a.line - b.line;
export const byPriority = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  || a.line - b.line;

/**
 * The open tasks that belong on one day: what is late, what is due that day, and what carries
 * no date at all. File order breaks every tie, so a nested item stays under its parent.
 * -> { overdue, due, undated }
 */
export function tasksForDay(date, list = all) {
  const day = ymd(date);
  const overdue = [], due = [], undated = [];
  for (const t of list) {
    if (t.done) continue;
    const w = whenOf(t);
    if (!w) { undated.push(t); continue; }
    if (w < day) overdue.push(t);
    else if (w === day) due.push(t);
  }
  overdue.sort(byDate);
  due.sort(byDate);
  undated.sort(byPriority);
  return { overdue, due, undated };
}

/**
 * The same split, per list, in file order. A group with nothing on that day is dropped, so a
 * day with nothing on it prints one line rather than an empty heading.
 * -> [{ path, label, overdue, due, undated, count }]
 */
export function groupsForDay(date, list = groups) {
  const out = [];
  for (const g of list) {
    const b = tasksForDay(date, g.tasks);
    const count = b.overdue.length + b.due.length + b.undated.length;
    if (count) out.push({ path: g.path, label: g.label, ...b, count });
  }
  return out;
}

/* ----------------------------------------------------------------- render */

/** The date and priority chips for one task. */
export function taskChips(t) {
  const out = [];
  const today = ymd(new Date());
  if (t.due) {
    const cls = t.due < today ? 'err' : t.due === today ? 'accent' : '';
    out.push(`<span class="chip ${cls}" title="due">${esc(t.due)}</span>`);
  } else if (t.scheduled) {
    out.push(`<span class="chip" title="scheduled">${esc(t.scheduled)}</span>`);
  }
  if (t.priority !== 'none') {
    const cls = t.priority === 'high' || t.priority === 'highest' ? 'err' : t.priority === 'medium' ? 'accent' : '';
    out.push(`<span class="chip ${cls}" title="priority">${esc(t.priority)}</span>`);
  }
  if (t.recurrence) out.push(`<span class="chip" title="recurrence">${esc(t.recurrence)}</span>`);
  return out.join('');
}

/**
 * Nesting level of a task line. Obsidian writes either a tab or two spaces per level and both
 * appear in Hassan's files, so a tab counts as one level and spaces as one per two.
 */
export function taskDepth(t) {
  const lead = /^[\t ]*/.exec(t.raw ?? '')[0];
  const tabs = (lead.match(/\t/g) || []).length;
  const spaces = lead.length - tabs;
  return Math.min(MAX_DEPTH, tabs + Math.floor(spaces / INDENT_UNIT));
}

/**
 * One task row: check, text, chips, source line. The source button navigates to the file and
 * carries the 1-based line it prints in `data-line`, so the click can ask for that line rather
 * than the top of the file. The column prints the line number alone and keeps the full path in
 * its tooltip: the file is named above the rows or is the one file the card reads, so a path
 * repeated on every row says nothing the line number does not say better.
 */
export function taskRow(t) {
  const depth = taskDepth(t);
  const source = `${t.path}:${t.line + 1}`;
  return `<div class="tk-row${t.done ? ' done' : ''}${depth ? ' sub' : ''}" data-id="${esc(t.id)}" style="--tk-depth:${depth}">
    <button class="tk-check" data-toggle="${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}"><span class="check${t.done ? ' on' : ''}"></span></button>
    <div class="tk-body"><span class="tk-text">${esc(t.text)}</span>${taskChips(t)}</div>
    <button class="tk-src mono-sm" data-path="${esc(t.path)}" data-line="${t.line + 1}" title="${esc(source)}">${esc(`:${t.line + 1}`)}</button>
  </div>`;
}

/* -------------------------------------------------------------------- add */

/**
 * One new task at the end of the file: exactly one `- [ ] <text>` line, appended.
 *
 * The file is read only to learn how it ends — which line ending it uses, and whether it has
 * one — and `append` then puts the new bytes after the old ones, so nothing above is read back
 * into the write and nothing is reformatted. A file that does not end with a newline is given
 * one first, so the new task is a line of its own; an empty file is not given a blank first
 * line. Whatever was typed goes on the line as typed, markers and all: a `📅 2026-09-24` in it
 * is read off the line by `parseTaskLine` exactly as one written by hand.
 *
 * -> 'ok', or 'missing' when there is no file to write to. Throws on I/O.
 */
export async function addTask(text) {
  const line = String(text ?? '').trim();
  if (!src || !line) return 'missing';
  const st = await ose.files.stat(src);
  if (!st || !st.exists) { missing = true; loaded = true; return 'missing'; }
  const current = await ose.files.read(src);
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lead = current && !current.endsWith('\n') ? eol : '';
  await ose.files.append(src, `${lead}- [ ] ${line}${eol}`);
  stale = true;
  await indexTasks();
  return 'ok';
}

/* ----------------------------------------------------------------- toggle */

/** Look one up by the id the index gave it (`path:line`). */
export const taskById = (id) => all.find((t) => t.id === id);

/**
 * Flip a task in its own source file. Returns 'ok' when the line was rewritten, 'moved' when
 * the file changed underneath us (the index is refreshed and nothing is written). Throws on I/O.
 */
export async function toggleTask(t) {
  if (!t) return 'moved';
  const text = await ose.files.read(t.path);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[t.line] !== t.raw) {
    stale = true;
    await indexTasks();
    return 'moved';
  }
  lines[t.line] = toggleTaskLine(t.raw, !t.done, ymd(new Date()));
  await ose.files.write(t.path, lines.join(eol));
  stale = true;
  await indexTasks();
  return 'ok';
}
