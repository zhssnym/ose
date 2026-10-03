// The planner's date logic (CONTRACT §9.4, L10, M32, H23), on date-fns: overnight blocks, the Day title, the journal file of a day.
// Dates are built with the local constructor, as the views build them from `new Date()`.
//
// Depends on: views (src/views/shared/dates.ts). Skipped until that file exists.

import { describe, expect, it } from 'vitest';

const d = await import('../../src/views/shared/dates.ts');

const day = (y, m, dd) => new Date(y, m - 1, dd);

describe('blockMinutes', () => {
  it('is the length of a block', () => {
    expect(d.blockMinutes(9 * 60, 10 * 60 + 30)).toBe(90);
    expect(d.blockMinutes(17 * 60 + 30, 19 * 60 + 30)).toBe(120);
  });

  it('wraps overnight and is never negative', () => {
    expect(d.blockMinutes(22 * 60, 1 * 60)).toBe(180);
    expect(d.blockMinutes(23 * 60 + 30, 7 * 60)).toBe(450);
    for (let s = 0; s < 1440; s += 97) for (let e = 0; e < 1440; e += 89) {
      const m = d.blockMinutes(s, e);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(1440);
    }
  });
});

describe('titles and the journal file', () => {
  it('the Day title names the weekday, the date and the year (L16)', () => {
    expect(d.dayTitle(day(2026, 9, 26))).toBe('Saturday 26 September 2026');
    expect(d.dayTitle(day(2027, 1, 4))).toBe('Monday 4 January 2027');
  });

  it('the journal file of a day is YYYY-MM-DD.md, with its heading (H23)', () => {
    expect(d.journalFileName(day(2026, 9, 26))).toBe('2026-09-26.md');
    expect(d.journalFileName(day(2026, 1, 5))).toBe('2026-01-05.md');
    expect(d.journalHeading(day(2026, 9, 26))).toBe('# 2026-09-26 - Journal');
  });

  it('a late-evening date is still that day, not the next one in UTC', () => {
    const late = new Date(2026, 8, 26, 23, 59);
    expect(d.journalFileName(late)).toBe('2026-09-26.md');
    expect(d.dayTitle(late)).toBe('Saturday 26 September 2026');
  });
});

