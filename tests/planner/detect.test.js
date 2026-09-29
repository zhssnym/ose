// Finding the planner's files by name (CONTRACT §9.2, M29): `detectPaths` on a synthetic tree
// of the shape `ose.files.tree()` answers. Numbered prefixes allowed, case ignored, the
// shallowest wins, every `*todo*.md` is a todo file, hidden entries and links never proposed.
// Also the one-time migration from the old plugin settings, which copies and never deletes.
//
// Depends on: planner (src/planner/detect.ts, settings.js). Skipped until they exist.

import { describe, expect, it } from 'vitest';

const { detectPaths } = await import('../../src/planner/detect.ts');
const settings = await import('../../src/planner/settings.ts');

/** A tree from `{ 'a/b.md': '', 'a/c/': '' }`: every folder on the way made, names kept. */
function tree(paths, extra = {}) {
  const root = { name: 'vault', path: '', kind: 'dir', children: [] };
  const at = new Map([['', root]]);
  const ensure = (p) => {
    if (at.has(p)) return at.get(p);
    const parent = ensure(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const n = { name: p.split('/').pop(), path: p, kind: 'dir', children: [], ...(extra[p] || {}) };
    parent.children.push(n);
    at.set(p, n);
    return n;
  };
  for (const p of paths) {
    if (p.endsWith('/')) { ensure(p.slice(0, -1)); continue; }
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    ensure(dir).children.push({ name: p.split('/').pop(), path: p, kind: 'file', ...(extra[p] || {}) });
  }
  return root;
}

describe('detectPaths', () => {
  it('finds the four with numbered prefixes and any case', () => {
    const t = tree([
      '0-tasks/1-general-todo.md', '0-tasks/2-School-TODO.md', '0-tasks/notes.md',
      '1-personal/4-Journal/2026-09-25.md',
      '1-personal/Calendar.md',
      '3-execution/reports/systems.jsonl', '3-execution/reports/2026/2026-09.md',
    ]);
    const r = detectPaths(t);
    expect(r.calendar).toBe('1-personal/Calendar.md');
    expect(r.journal).toBe('1-personal/4-Journal');
    expect(r.reports).toBe('3-execution/reports');
    expect(r.todo).toEqual(['0-tasks/1-general-todo.md', '0-tasks/2-School-TODO.md']);
  });

  it('the shallowest match wins', () => {
    const r = detectPaths(tree(['a/b/journal/x.md', 'journal/y.md', 'a/calendar.md', 'a/b/c/calendar.md']));
    expect(r.journal).toBe('journal');
    expect(r.calendar).toBe('a/calendar.md');
  });

  it('names nothing it did not find', () => {
    expect(detectPaths(tree(['notes/a.md']))).toEqual({ calendar: null, todo: [], reports: null, journal: null });
    expect(detectPaths({ name: 'v', path: '', kind: 'dir' })).toEqual({ calendar: null, todo: [], reports: null, journal: null });
  });

  it('only a .md file is a calendar or a todo; only a folder is the journal', () => {
    const r = detectPaths(tree(['calendar.txt', 'todo.txt', 'journal.md', 'x/todo-list.md']));
    expect(r.calendar).toBe(null);
    expect(r.journal).toBe(null);
    expect(r.todo).toEqual(['x/todo-list.md']);
  });

  it('never proposes a hidden entry or a link', () => {
    const t = tree(['.hidden/journal/a.md', 'linked/calendar.md', 'x/todo.md'], {
      linked: { link: 'dir' }, 'x/todo.md': { hidden: true },
    });
    expect(detectPaths(t)).toEqual({ calendar: null, todo: [], reports: null, journal: null });
  });
});

describe('planner settings: migration and normalising', () => {
  it('copies the old plugin paths (M29)', () => {
    const plugins = {
      day: { paths: { calendar: 'cal.md', todo: '0-tasks/todo.md', reports: 'r' } },
      week: { paths: { calendar: 'other.md' } },
      month: { paths: { reports: 'other-r' } },
      journal: { paths: { journal: 'j' }, mode: 'compact' },
    };
    const before = JSON.stringify(plugins);
    expect(settings.migrate(plugins)).toEqual({ calendar: 'cal.md', todo: ['0-tasks/todo.md'], reports: 'r', journal: 'j', journalMode: 'compact' });
    expect(JSON.stringify(plugins)).toBe(before);
    expect(settings.migrate({ week: { paths: { calendar: 'w.md' } }, month: { paths: { reports: 'm' } } })).toEqual({ calendar: 'w.md', reports: 'm' });
    expect(settings.migrate(undefined)).toEqual({});
  });

  it('normalises anything into a complete PlannerSettings', () => {
    expect(settings.normalize(undefined)).toEqual({
      v: 1, calendar: null, todo: [], reports: null, journal: null, q1Parity: null, journalMode: 'full', confirmed: false,
    });
    const n = settings.normalize({ todo: 'a.md', q1Parity: 'odd', journal: '/j/', confirmed: true });
    expect(n).toMatchObject({ todo: ['a.md'], q1Parity: 'odd', journal: 'j', confirmed: true });
    expect(settings.normalize({ q1Parity: 'sometimes' }).q1Parity).toBe(null);
  });

  it('detection only fills what is missing', () => {
    const s = settings.normalize({ calendar: 'mine.md' });
    const f = settings.fillMissing(s, { calendar: 'found.md', todo: ['t.md'], reports: 'r', journal: null });
    expect(f).toMatchObject({ calendar: 'mine.md', todo: ['t.md'], reports: 'r', journal: null });
  });
});

describe('detectPaths, todo as a word', () => {
  it('matches todo or todos as a whole word, not inside another word', () => {
    const r = detectPaths(tree(['Mastodon.md', 'photodocs.md', 'todos.md', 'a/3-todo list.md']));
    expect(r.todo).toEqual(['todos.md', 'a/3-todo list.md']);
  });
});
