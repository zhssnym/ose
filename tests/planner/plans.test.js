// The monthly plan and the systems log (CONTRACT §9.4, L16, M30): where a month's plan lives,
// and which days a system has lost. Days before a system's first log record are not losses,
// today unchecked is open, and a system never checked has lost nothing.
//
// Depends on: planner (src/planner/plans.js, dates.js). Skipped until they exist.

import { describe, expect, it } from 'vitest';
import { present as exists } from '../support/present.js';

const present = exists('src/planner/plans.js', 'src/planner/dates.js');
const p = present ? await import('../../src/planner/plans.js') : {};

const day = (y, m, dd) => new Date(y, m - 1, dd);
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const EVERY = new Set([0, 1, 2, 3, 4, 5, 6]);
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe.skipIf(!present)('planPath', () => {
  it('is <reports>/<year>/<YYYY-MM>.md', () => {
    expect(p.planPath(day(2026, 9, 26), 'reports')).toBe('reports/2026/2026-09.md');
    expect(p.planPath(day(2027, 1, 1), '3-execution/reports/')).toBe('3-execution/reports/2027/2027-01.md');
  });
});

describe.skipIf(!present)('lossDays', () => {
  const sys = { name: 'Read', days: EVERY };
  const today = day(2026, 9, 20);

  it('counts nothing before the first log record (L16)', () => {
    const log = p.parseSystemsLog(jsonl([
      { date: '2026-09-10', system: 'Read', done: true, at: 'x' },
      { date: '2026-09-12', system: 'Read', done: true, at: 'x' },
    ]));
    const lost = p.lossDays(sys, day(2026, 9, 1), log, today).map(ymd);
    // From the 10th to the 19th, the 10th and 12th done, today (20th) open.
    expect(lost).toEqual(['2026-09-11', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']);
    expect(lost.some((x) => x < '2026-09-10')).toBe(false);
    expect(lost).not.toContain('2026-09-20');
  });

  it('a system that started in an earlier month counts from the 1st', () => {
    const log = p.parseSystemsLog(jsonl([{ date: '2026-08-02', system: 'Read', done: true, at: 'x' }]));
    const lost = p.lossDays(sys, day(2026, 9, 15), log, day(2026, 9, 4)).map(ymd);
    expect(lost).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('a system never checked has lost nothing', () => {
    const log = p.parseSystemsLog('');
    expect(p.lossDays(sys, day(2026, 9, 1), log, today)).toEqual([]);
  });

  it('only the days a system is due on count', () => {
    const weekdays = { name: 'Run', days: new Set([0, 1, 2, 3, 4]) };
    const log = p.parseSystemsLog(jsonl([{ date: '2026-09-01', system: 'Run', done: true, at: 'x' }]));
    const lost = p.lossDays(weekdays, day(2026, 9, 1), log, day(2026, 9, 8)).map(ymd);
    // 1 Sept 2026 is a Tuesday: 2, 3, 4 and 7 Sept are lost; 5 and 6 are the weekend.
    expect(lost).toEqual(['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07']);
  });

  it('the last record for a day wins, and old `habit` records count', () => {
    const log = p.parseSystemsLog(jsonl([
      { date: '2026-09-01', habit: 'Read', done: true, at: 'x' },
      { date: '2026-09-02', system: 'Read', done: true, at: 'x' },
      { date: '2026-09-02', system: 'Read', done: false, at: 'y' },
    ]));
    expect(p.lossDays(sys, day(2026, 9, 1), log, day(2026, 9, 3)).map(ymd)).toEqual(['2026-09-02']);
  });

  it('a month entirely in the future has lost nothing', () => {
    const log = p.parseSystemsLog(jsonl([{ date: '2026-09-01', system: 'Read', done: true, at: 'x' }]));
    expect(p.lossDays(sys, day(2026, 11, 1), log, today)).toEqual([]);
  });
});

describe.skipIf(!present || typeof p.checkRecord !== 'function')('checkRecord', () => {
  it('is one JSON line for appendLine (M30): no newline in it', () => {
    const r = p.checkRecord(day(2026, 9, 26), 'Read', true, new Date(Date.UTC(2026, 8, 26, 8, 0)));
    expect(r).toEqual({ date: '2026-09-26', system: 'Read', done: true, at: '2026-09-26T08:00:00.000Z' });
    expect(JSON.stringify(r)).not.toMatch(/[\r\n]/);
  });
});
