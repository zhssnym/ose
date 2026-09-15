// The task index of the Day module. One source: the `todo` key, whatever settings points it
// at. Since batch 5 that source is either a folder, in which case every `*.md` directly inside
// it is one task list, or a single markdown file, which is one unlabelled list. The files are
// read on demand and again after the bridge reports a change under that path, so there is no
// vault walk, no search narrowing and no per-file mtime cache. Nesting in a file (`  - [ ]`
// under a parent item) is kept as indentation on the row. Toggling rewrites the exact source
// line of the file the task came from, after checking it has not moved, and nothing else.

import { esc } from 'ose:ui';
import { parseTasks, toggleTaskLine, firstH1, naturalCompare, ymd, PRIORITY_RANK } from 'ose:md';

// The module's facade, handed over by `activate` before anything here runs.
let ose = null;
export function initTasks(app) {
  ose = app;
  // Two subscriptions for the life of the module: the index cares about its own files changing
  // on disk, and about the source being pointed somewhere else in settings.
  const offWatch = ose.watch((d) => {
    for (const c of (d && d.changes) || []) if (c && (touches(c.path) || touches(c.to))) { stale = true; return; }
  });
  const offSources = ose.bus.on('sources', (e) => { if (!e || e.key === 'todo') forget(); });
  return () => { offWatch(); offSources(); };
}

const INDENT_UNIT = 2;     // spaces per nesting level in the file
const MAX_DEPTH = 4;       // deeper nesting still renders, it just stops moving right

/**
 * The path the index reads. Normally the `todo` source; `setTaskSource` overrides it for this
 * session only, which is how the harness points at a scratch copy without touching settings.
 */
let OVERRIDE = null;
export function setTaskSource(path) {
  OVERRIDE = path ? String(path).replace(/^\/+/, '').replace(/\/+$/, '') : null;
  forget();
}
export function getTaskSource() { return OVERRIDE || ose.sources.get('todo'); }

/** Drop what was read: the path changed, or a file under it did. */
function forget() { all = []; groups = []; loaded = false; missing = false; stale = true; }

let all = [];              // every task line of every list, in group then file order
let groups = [];           // [{ path, name, label, tasks }] in natural file order
let isFolder = false;      // the last read found a folder rather than a single file
let loaded = false;        // the source has been read at least once
let missing = false;       // the last read found nothing at the source path
let stale = true;          // something changed under us (or it was never read)
let reading = null;        // the in-flight read, so callers coalesce

/** A change that touches the source: the path itself, or anything inside it when it is a folder. */
function touches(p) {
  const src = getTaskSource();
  if (!p || !src) return false;
  return p === src || p.startsWith(`${src}/`);
}

/* ------------------------------------------------------------------ index */

/** One markdown file -> one group. The label is its first H1, else its name without `.md`. */
async function readGroup(path, name, labelled) {
  let text = '';
  try { text = await ose.files.read(path); }
  catch (e) { console.warn('[tasks-index] unreadable', path, e); }
  return {
    path,
    name,
    label: labelled ? (firstH1(text) || name.replace(/\.md$/i, '')) : null,
    tasks: parseTasks(text, path),
  };
}

async function build() {
  const src = getTaskSource();
  groups = [];
  isFolder = false;
  missing = true;
  try {
    const st = src ? await ose.files.stat(src) : { exists: false };
    if (st && st.exists) {
      missing = false;
      isFolder = st.kind === 'dir';
      if (isFolder) {
        // every markdown file directly in the folder is one list, in natural file order
        const files = (await ose.files.list(src))
          .filter((n) => n.kind === 'file' && /\.md$/i.test(n.name))
          .sort((a, b) => naturalCompare(a.name, b.name));
        groups = await Promise.all(files.map((f) => readGroup(`${src}/${f.name}`, f.name, true)));
      } else {
        // a single file is one group without a label: the Day view shows its sections flat
        groups = [await readGroup(src, src.split('/').pop(), false)];
      }
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
 * Read the source when it has never been read or has changed since. Concurrent calls coalesce
 * onto the same read. `{force:true}` re-reads even when nothing looked stale.
 */
export function indexTasks({ force = false } = {}) {
  if (reading) return reading;
  if (loaded && !stale && !force) return Promise.resolve(groups);
  reading = build().finally(() => { reading = null; });
  return reading;
}

/** The lists of the last index, in file order. Empty until `indexTasks()` has resolved once. */
export const taskGroups = () => groups;
/** Every task of every list, flat. */
export const allTasks = () => all;
/** True when the last read found nothing at the source path. */
export const taskSourceMissing = () => loaded && missing;
/** True when the source is a folder of lists rather than one file. */
export const taskSourceIsFolder = () => isFolder;
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
 * folder of ten lists does not print ten empty headings.
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
 * than the top of the file. Inside a labelled group the file name is already the heading, so
 * the row prints the line number alone and keeps the full path in its tooltip.
 */
export function taskRow(t, { short = false } = {}) {
  const depth = taskDepth(t);
  const src = `${t.path}:${t.line + 1}`;
  return `<div class="tk-row${t.done ? ' done' : ''}${depth ? ' sub' : ''}" data-id="${esc(t.id)}" style="--tk-depth:${depth}">
    <button class="tk-check" data-toggle="${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}"><span class="check${t.done ? ' on' : ''}"></span></button>
    <div class="tk-body"><span class="tk-text">${esc(t.text)}</span>${taskChips(t)}</div>
    <button class="tk-src mono-sm" data-path="${esc(t.path)}" data-line="${t.line + 1}" title="${esc(src)}">${esc(short ? `:${t.line + 1}` : src)}</button>
  </div>`;
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
