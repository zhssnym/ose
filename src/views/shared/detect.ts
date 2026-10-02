// Finding the planner's files by name (M29). Pure: `detectPaths(tree)` takes the tree the host
// answers (`ose.files.tree()`: `{ name, path, kind, children }`) and names nothing it did not
// find there. It only proposes: Settings › Views shows what it found and "These look right"
// confirms it once.
//
// The rules:
//   - names are compared without case, and without a leading number (`4-journal`,
//     `1-general-todo.md`, `04 journal`, `2_reports`);
//   - when several match, the shallowest wins, then natural order;
//   - hidden entries (a dot name, or `hidden: true`) and links are never walked or proposed;
//   - a `.md` file with `todo` or `todos` as a word of its name is a todo file (`todo.md`,
//     `1-general-todo.md`, `School TODO.md`), never as a part of one (`Mastodon.md`, `autodoc.md`);
//   - a folder holding `systems.jsonl` is the plannings folder (the `reports` key) even when its
//     name says nothing (`3-execution`), because that file is what the plannings folder is for.

const CALENDAR = ['calendar', 'calendrier', 'timetable', 'schedule', 'emploi du temps', 'emploi-du-temps', 'edt'];
const REPORTS = ['planner', 'plannings', 'planning', 'reports', 'report', 'plans', 'monthly plans', 'monthly-plans', 'execution'];
const JOURNAL = ['journal', 'journals', 'journaling', 'diary'];

const lower = (s) => String(s ?? '').normalize('NFC').toLowerCase();
const stem = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; };
const ext = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
/** `4-journal` -> `journal`, `1-general-todo` -> `general-todo`, `04. Journal` -> `journal`. */
const bare = (name) => lower(name).replace(/^\d+\s*[-_.)]?\s*/, '').trim();
/** `todo` or `todos` as a word: not between two letters. */
const TODO_WORD = /(^|[^\p{L}])todos?([^\p{L}]|$)/u;
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/** Every visible entry, with its depth; hidden entries and links are skipped with their subtree. */
function flatten(node, depth = 0, out: any[] = []) {
  for (const c of (node && Array.isArray(node.children)) ? node.children : []) {
    const name = String((c && c.name) || '');
    if (!name || name.startsWith('.') || c.hidden || c.link) continue;
    out.push({ entry: c, depth });
    if (c.kind === 'dir') flatten(c, depth + 1, out);
  }
  return out;
}

const shallowest = (rows) => [...rows].sort((a, b) => a.depth - b.depth || natural(a.entry.path, b.entry.path))[0] || null;

/**
 * Propose the four planner paths from a tree.
 */
export function detectPaths(tree: { children?: any[]; }): { calendar: string | null; todo: string[]; reports: string | null; journal: string | null; } {
  const rows = flatten(tree);
  const files = rows.filter((r) => r.entry.kind !== 'dir');
  const dirs = rows.filter((r) => r.entry.kind === 'dir');
  const md = files.filter((r) => ext(r.entry.name) === 'md');

  const calendar = shallowest(md.filter((r) => CALENDAR.includes(bare(stem(r.entry.name)))));

  const todo = md
    .filter((r) => TODO_WORD.test(bare(stem(r.entry.name))))
    .sort((a, b) => a.depth - b.depth || natural(a.entry.path, b.entry.path))
    .map((r) => r.entry.path);

  // a folder whose direct children hold `systems.jsonl` is the strongest sign; among those a
  // matching name wins, then depth
  const holdsLog = (r) => (r.entry.children || []).some((c) => c && c.kind !== 'dir' && lower(c.name) === 'systems.jsonl');
  const named = (r) => REPORTS.includes(bare(r.entry.name));
  const withLog = dirs.filter(holdsLog);
  const reports = shallowest(withLog.filter(named)) || shallowest(withLog) || shallowest(dirs.filter(named));

  const journal = shallowest(dirs.filter((r) => JOURNAL.includes(bare(r.entry.name))));

  return {
    calendar: calendar ? calendar.entry.path : null,
    todo,
    reports: reports ? reports.entry.path : null,
    journal: journal ? journal.entry.path : null,
  };
}
