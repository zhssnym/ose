// The monthly plan and the systems log (CONTRACT §9.4, L16, M30): where a month's plan lives,
// and which days a system has lost. Days before a system's first log record are not losses,
// today unchecked is open, and a system never checked has lost nothing.
//
// Depends on: views (src/views/shared/plans.ts, dates.js). Skipped until they exist.

import { describe, expect, it } from 'vitest';

const p = await import('../../src/views/shared/plans.ts');

const day = (y, m, dd) => new Date(y, m - 1, dd);
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const EVERY = new Set([0, 1, 2, 3, 4, 5, 6]);
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('planPath', () => {
  it('is <plannings>/<YYYY-MM>.md, flat', () => {
    expect(p.planPath(day(2026, 9, 26), 'plannings')).toBe('plannings/2026-09.md');
    expect(p.planPath(day(2027, 1, 1), '3-execution/plannings/')).toBe('3-execution/plannings/2027-01.md');
  });
});

/** A lister over a fake tree: `{ folder: [names] }`; a folder not in it throws, as the host does. */
const lister = (tree) => async (folder) => {
  if (!(folder in tree)) throw Object.assign(new Error('not found'), { code: 'not_found' });
  return tree[folder].map((name) => ({ name, kind: 'file' }));
};

describe('resolvePlanPath', () => {
  it('finds a month flat, and flat wins over the year folder', async () => {
    const list = lister({ plannings: ['2026-09.md', 'systems.jsonl'], 'plannings/2026': ['2026-09.md'] });
    expect(await p.resolvePlanPath(list, day(2026, 9, 3), 'plannings')).toEqual({ path: 'plannings/2026-09.md', dir: 'plannings', exists: true, flat: true });
  });

  it('finds a month in its year folder, any name starting with the month', async () => {
    const list = lister({ plannings: ['systems.jsonl'], 'plannings/2026': ['2026-10 Monthly Plan.md', '2026-10-02.md'] });
    const f = await p.resolvePlanPath(list, day(2026, 10, 3), 'plannings');
    expect(f).toEqual({ path: 'plannings/2026/2026-10 Monthly Plan.md', dir: 'plannings/2026', exists: true, flat: false });
  });

  it('names the canonical file when there is none: in the year folder when it exists, else flat', async () => {
    expect((await p.resolvePlanPath(lister({ plannings: [] }), day(2026, 11, 1), 'plannings')).path).toBe('plannings/2026-11.md');
    const nested = await p.resolvePlanPath(lister({ plannings: [], 'plannings/2026': [] }), day(2026, 11, 1), 'plannings');
    expect(nested).toMatchObject({ path: 'plannings/2026/2026-11.md', exists: false, flat: false });
  });

  it('finds the last month that has a file', async () => {
    const list = lister({ plannings: ['2025-11.md'], 'plannings/2026': [] });
    expect((await p.previousMonthFile(list, day(2026, 2, 1), 'plannings')).path).toBe('plannings/2025-11.md');
    expect(await p.previousMonthFile(lister({}), day(2026, 2, 1), 'plannings')).toBe(null);
  });
});

describe('the year file', () => {
  it('is YYYY.md, or the year and a space, never a month, goals or review', () => {
    expect(p.pickYearFile(['2026-goals.md', '2026-09.md', '2026.md', '2026-review.md'], 2026)).toBe('2026.md');
    expect(p.pickYearFile(['2026-goals.md', '2026 Yearly Plan.md'], 2026)).toBe('2026 Yearly Plan.md');
    expect(p.pickYearFile(['2026-goals.md', '2026-review.md', '2026-01.md', '20261.md'], 2026)).toBe(null);
  });

  it('is found flat first, then in the year folder', async () => {
    const both = lister({ plannings: ['2026.md'], 'plannings/2026': ['2026.md'] });
    expect((await p.resolveYearPath(both, 2026, 'plannings')).path).toBe('plannings/2026.md');
    const nested = lister({ plannings: ['2026-goals.md'], 'plannings/2026': ['2026.md'] });
    expect(await p.resolveYearPath(nested, 2026, 'plannings')).toMatchObject({ path: 'plannings/2026/2026.md', exists: true, flat: false });
    expect(await p.resolveYearPath(lister({ plannings: ['2026-goals.md'] }), 2026, 'plannings')).toMatchObject({ path: 'plannings/2026.md', exists: false });
  });

  it('reads like a month: intro, labels with bullets, the yearly review', () => {
    const y = p.parseYearlyPlan('# 2026 Yearly Plan\n\nWhy this year.\n\nEducational\n\n- Pass\n\nPersonal\n\n- Sleep\n\n# Yearly Review\n\n_gap: later_\n');
    expect(y.intro).toBe('Why this year.');
    expect(y.sections).toEqual([{ label: 'Educational', items: ['Pass'] }, { label: 'Personal', items: ['Sleep'] }]);
    expect(y.review).toBe('_gap: later_');
  });
});

describe('a new month', () => {
  const prev = [
    '# 2026-09 Monthly Plan', '', 'Why September matters.', '', '# Goals', '', 'Educational', '', '- Maths: 17+', '',
    '# Systems', '', '- Maths session (lun-ven)', '', '', '# Timetable', '', '# Lundi', '', '- 08h20 à 09h15 Maths [maths]', '',
    '# Monthly Review', '', 'It went well.', '',
  ].join('\n');

  it('keeps goals, systems and timetable, drops the intro, and leaves the review a gap', () => {
    expect(p.newMonthText(day(2026, 10, 1), prev)).toBe([
      '# 2026-10 Monthly Plan', '', '# Goals', '', 'Educational', '', '- Maths: 17+', '',
      '# Systems', '', '- Maths session (lun-ven)', '', '', '# Timetable', '', '# Lundi', '', '- 08h20 à 09h15 Maths [maths]', '',
      '# Monthly Review', '', p.MONTH_GAP, '',
    ].join('\n'));
  });

  it('keeps the labels and bullets of a title section, and adds a review when there was none', () => {
    const old = '# 2024-01 Monthly Plan\n\nEducational\n\n- Read\n\nFinancial\n\n- Earn\n';
    expect(p.newMonthText(day(2024, 2, 1), old)).toBe(`# 2024-02 Monthly Plan\n\nEducational\n\n- Read\n\nFinancial\n\n- Earn\n\n# Monthly Review\n\n${p.MONTH_GAP}\n`);
  });

  it('with no previous month, is the four headings', () => {
    expect(p.newMonthText(day(2026, 10, 1), null)).toBe(`# 2026-10 Monthly Plan\n\n# Systems\n\n# Timetable\n\n# Monthly Review\n\n${p.MONTH_GAP}\n`);
  });
});

describe('a new year', () => {
  it("carries the previous year's labels only, then the review gap", () => {
    const prev = '# 2026 Yearly Plan\n\nThe year in a line.\n\nEducational\n\n- Pass\n\nFinancial\n\n- Save\n\n# Yearly Review\n\nDone.\n';
    expect(p.newYearText(2027, prev)).toBe(`# 2027 Yearly Plan\n\nEducational\n\nFinancial\n\n# Yearly Review\n\n${p.YEAR_GAP}\n`);
    expect(p.newYearText(2027, null)).toBe(`# 2027 Yearly Plan\n\n# Yearly Review\n\n${p.YEAR_GAP}\n`);
  });
});

describe('lossDays', () => {
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

describe('checkRecord', () => {
  it('is one JSON line for appendLine (M30): no newline in it', () => {
    const r = p.checkRecord(day(2026, 9, 26), 'Read', true, new Date(Date.UTC(2026, 8, 26, 8, 0)));
    expect(r).toEqual({ date: '2026-09-26', system: 'Read', done: true, at: '2026-09-26T08:00:00.000Z' });
    expect(JSON.stringify(r)).not.toMatch(/[\r\n]/);
  });
});
