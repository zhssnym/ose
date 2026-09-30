// Todo lines (docs/FORMATS.md "Todo lines", M31, M34): a toggle rewrites exactly one line and
// keeps its markers, `parseTasks` gives the 0-based index and the exact text `replaceLine`
// needs, and several todo files are grouped per file.
//
// Depends on: planner (src/planner/tasks.ts). Skipped until it exists.

import { describe, expect, it } from 'vitest';

const t = await import('../../src/planner/tasks.ts');

const DUE = '\u{1F4C5}';
const DONE = '\u{2705}';

describe('todo lines', () => {
  const text = `# Todo\r\n\r\n- [ ] Write the essay ${DUE} 2026-09-26\r\n  - [x] Outline ${DONE} 2026-09-20\r\n- [ ] Undated\r\nNot a task\r\n`;

  it('parseTasks gives the replaceLine index and the exact line, CRLF not included', () => {
    const tasks = t.parseTasks(text, 'todo.md');
    expect(tasks.map((x) => x.line)).toEqual([2, 3, 4]);
    expect(tasks[0].raw).toBe(`- [ ] Write the essay ${DUE} 2026-09-26`);
    expect(tasks[0]).toMatchObject({ done: false, due: '2026-09-26', text: 'Write the essay', path: 'todo.md' });
    expect(tasks[1]).toMatchObject({ done: true, doneDate: '2026-09-20' });
  });

  it('a toggle changes the box and the done marker, and nothing else on the line', () => {
    const raw = `- [ ] Write the essay ${DUE} 2026-09-26`;
    const on = t.toggleTaskLine(raw, true, '2026-09-26');
    expect(on).toBe(`- [x] Write the essay ${DUE} 2026-09-26 ${DONE} 2026-09-26`);
    expect(t.toggleTaskLine(on, false, '2026-09-26')).toBe(raw);
    expect(on).not.toMatch(/[\r\n]/);
  });

  it('groups the tasks of a day per todo file, in the order given (M34)', () => {
    const a = t.parseTasks(`- [ ] Late ${DUE} 2026-09-01\n- [ ] Today ${DUE} 2026-09-26\n`, 'a.md');
    const b = t.parseTasks('- [x] Done\n', 'b.md');
    const groups = t.groupsForDay(new Date(2026, 8, 26), [{ path: 'a.md', tasks: a }, { path: 'b.md', tasks: b }]);
    expect(groups.map((g) => [g.path, g.count])).toEqual([['a.md', 2], ['b.md', 0]]);
    expect(groups[0].overdue.map((x) => x.text)).toEqual(['Late']);
    expect(groups[0].due.map((x) => x.text)).toEqual(['Today']);
  });
});
