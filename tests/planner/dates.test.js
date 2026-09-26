// The planner's date logic (CONTRACT §9.4, L10, M32, M33, H23), on date-fns: ISO week parity
// and the (Q1)/(Q2) blocks, overnight blocks, the Day title, the journal file of a day.
// Dates are built with the local constructor, as the views build them from `new Date()`.
//
// Depends on: planner (src/planner/dates.js). Skipped until that file exists.

import { describe, expect, it } from 'vitest';
import { present as exists } from '../support/present.js';

const present = exists('src/planner/dates.js');
const d = present ? await import('../../src/planner/dates.js') : {};

const day = (y, m, dd) => new Date(y, m - 1, dd);

describe.skipIf(!present)('isoWeekParity', () => {
  it('follows the ISO week number', () => {
    expect(d.isoWeekParity(day(2026, 9, 26))).toBe('odd');   // week 39, a Saturday
    expect(d.isoWeekParity(day(2026, 9, 21))).toBe('odd');   // week 39, its Monday
    expect(d.isoWeekParity(day(2026, 9, 28))).toBe('even');  // week 40
    expect(d.isoWeekParity(day(2026, 1, 1))).toBe('odd');    // week 1
  });

  it('uses ISO weeks across a year boundary, not calendar weeks', () => {
    // 3 January 2027 is a Sunday in ISO week 53 of 2026; the next day starts week 1.
    expect(d.isoWeekParity(day(2027, 1, 3))).toBe('odd');
    expect(d.isoWeekParity(day(2027, 1, 4))).toBe('odd');
    // 29 December 2025 is the Monday of ISO week 1 of 2026.
    expect(d.isoWeekParity(day(2025, 12, 29))).toBe('odd');
    expect(d.isoWeekParity(day(2025, 12, 28))).toBe('even');  // week 52 of 2025
  });
});

describe.skipIf(!present)('blockApplies', () => {
  const odd = day(2026, 9, 24);   // week 39
  const even = day(2026, 10, 1);  // week 40

  it('a block of every week always applies', () => {
    for (const q1 of ['odd', 'even', null]) {
      expect(d.blockApplies({ q: null }, odd, q1)).toBe(true);
      expect(d.blockApplies({}, even, q1)).toBe(true);
    }
  });

  it('with the parity unknown, both Q1 and Q2 apply (drawn side by side)', () => {
    expect(d.blockApplies({ q: 'Q1' }, odd, null)).toBe(true);
    expect(d.blockApplies({ q: 'Q2' }, odd, null)).toBe(true);
  });

  it('Q1 applies in the weeks of the chosen parity and Q2 in the others', () => {
    expect(d.blockApplies({ q: 'Q1' }, odd, 'odd')).toBe(true);
    expect(d.blockApplies({ q: 'Q2' }, odd, 'odd')).toBe(false);
    expect(d.blockApplies({ q: 'Q1' }, even, 'odd')).toBe(false);
    expect(d.blockApplies({ q: 'Q2' }, even, 'odd')).toBe(true);
    expect(d.blockApplies({ q: 'Q1' }, even, 'even')).toBe(true);
    expect(d.blockApplies({ q: 'Q2' }, even, 'even')).toBe(false);
  });
});

describe.skipIf(!present)('blockMinutes', () => {
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

describe.skipIf(!present)('titles and the journal file', () => {
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

describe.skipIf(!present)('isQ1Week (anchor)', () => {
  it('alternates by whole weeks from the anchor, across a 53-week year', () => {
    const anchor = '2026-09-21';                                   // a Q1 week (ISO 39)
    expect(d.isQ1Week(day(2026, 9, 27), anchor)).toBe(true);       // its Sunday
    expect(d.isQ1Week(day(2026, 9, 28), anchor)).toBe(false);
    expect(d.isQ1Week(day(2026, 12, 28), anchor)).toBe(true);      // ISO week 53 of 2026
    expect(d.isQ1Week(day(2027, 1, 4), anchor)).toBe(false);       // ISO week 1: parity would repeat
    expect(d.isQ1Week(day(2027, 1, 11), anchor)).toBe(true);
    expect(d.isQ1Week(day(2026, 9, 14), anchor)).toBe(false);      // before the anchor too
  });

  it('is null without an anchor, and reads an old parity as before', () => {
    expect(d.isQ1Week(day(2026, 9, 26), null)).toBe(null);
    expect(d.isQ1Week(day(2026, 9, 26), 'odd')).toBe(true);
    expect(d.isQ1Week(day(2026, 9, 26), 'even')).toBe(false);
  });

  it('turns an old parity into the anchor that keeps this week as it was', () => {
    const now = day(2026, 9, 26);                                  // ISO 39, odd
    expect(d.anchorFromParity('odd', now)).toBe('2026-09-21');
    expect(d.anchorFromParity('even', now)).toBe('2026-09-14');
    expect(d.anchorFromParity(null, now)).toBe(null);
    expect(d.q1AnchorFor(now, false)).toBe('2026-09-14');
  });
});
