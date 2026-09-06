// The task index, used by the Day view. One source: the `todo` key, whatever settings points it
// at. The file is read on demand and again after the bridge reports a change to that path, so
// there is no vault walk, no search narrowing and no per-file mtime cache. Nesting in the file
// (`  - [ ]` under a parent item) is kept as indentation on the row. Toggling rewrites the
// exact source line after checking it has not moved, and nothing else in the file.

import { esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { parseTasks, toggleTaskLine, ymd, PRIORITY_RANK } from '../lib/md.js';
import { getSource, onSources } from './sources-compat.js';

const INDENT_UNIT = 2;     // spaces per nesting level in the file
const MAX_DEPTH = 4;       // deeper nesting still renders, it just stops moving right

/**
 * The file the index reads. Normally the `todo` source; `setTaskSource` overrides it for this
 * session only, which is how the harness points at a scratch copy without touching settings.
 */
let OVERRIDE = null;
export function setTaskSource(path) {
  OVERRIDE = path ? String(path).replace(/^\/+/, '').replace(/\/+$/, '') : null;
  forget();
}
export function getTaskSource() { return OVERRIDE || getSource('todo'); }

/** Drop what was read: the path changed, or the file did. */
function forget() { all = []; loaded = false; missing = false; stale = true; }

let all = [];              // every task line of the source file, in file order
let loaded = false;        // the file has been read at least once
let missing = false;       // the last read found no file there
let stale = true;          // the file changed under us (or was never read)
let reading = null;        // the in-flight read, so callers coalesce

// Two subscriptions for the life of the module: the index cares about its own path changing
// on disk, and about that path being pointed somewhere else in settings.
bridge.on('fs', (d) => {
  const src = getTaskSource();
  const changes = (d && d.changes) || [];
  if (changes.some((c) => c && (c.path === src || c.to === src))) stale = true;
});
onSources((e) => { if (!e || e.key === 'todo') forget(); });

/* ------------------------------------------------------------------ index */

async function build() {
  const src = getTaskSource();
  let text = '';
  try {
    if (src && await bridge.exists(src)) { text = await bridge.readText(src); missing = false; }
    else { missing = true; }
  } catch (e) {
    console.warn('[tasks-index] unreadable', src, e);
    missing = true;
  }
  all = missing ? [] : parseTasks(text, src);
  loaded = true;
  stale = false;
  return all;
}

/**
 * Read the source file when it has never been read or has changed since. Concurrent calls
 * coalesce onto the same read. `{force:true}` re-reads even when nothing looked stale.
 */
export function indexTasks({ force = false } = {}) {
  if (reading) return reading;
  if (loaded && !stale && !force) return Promise.resolve(all);
  reading = build().finally(() => { reading = null; });
  return reading;
}

/** The last indexed set. Empty until `indexTasks()` has resolved once. */
export const allTasks = () => all;
/** True when the last read found no file at the source path. */
export const taskSourceMissing = () => loaded && missing;
/** Forget what was read, so the next `indexTasks()` reads the file again. */
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

/** One task row: check, text, chips, source line. The source button navigates to the file. */
export function taskRow(t) {
  const depth = taskDepth(t);
  return `<div class="tk-row${t.done ? ' done' : ''}${depth ? ' sub' : ''}" data-id="${esc(t.id)}" style="--tk-depth:${depth}">
    <button class="tk-check" data-toggle="${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}"><span class="check${t.done ? ' on' : ''}"></span></button>
    <div class="tk-body"><span class="tk-text">${esc(t.text)}</span>${taskChips(t)}</div>
    <button class="tk-src mono-sm" data-path="${esc(t.path)}" title="${esc(t.path)}:${t.line + 1}">${esc(t.path)}:${t.line + 1}</button>
  </div>`;
}

/* ----------------------------------------------------------------- toggle */

/** Look one up by the id the index gave it (`path:line`). */
export const taskById = (id) => all.find((t) => t.id === id);

/**
 * Flip a task in its source file. Returns 'ok' when the line was rewritten, 'moved' when the
 * file changed underneath us (the index is refreshed and nothing is written). Throws on I/O.
 */
export async function toggleTask(t) {
  if (!t) return 'moved';
  const text = await bridge.readText(t.path);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[t.line] !== t.raw) {
    stale = true;
    await indexTasks();
    return 'moved';
  }
  lines[t.line] = toggleTaskLine(t.raw, !t.done, ymd(new Date()));
  await bridge.writeText(t.path, lines.join(eol));
  stale = true;
  await indexTasks();
  return 'ok';
}
