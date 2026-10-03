// Where the planner's files are (src/views/shared/plans.ts): a month and a year, flat or in a
// year folder, flat winning; the last month that has a file. What they hold is plan.test.js.

import { describe, expect, it } from 'vitest';

const p = await import('../../src/views/shared/plans.ts');

const day = (y, m, dd) => new Date(y, m - 1, dd);

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

});
