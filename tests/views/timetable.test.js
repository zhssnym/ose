// The calendar format (CONTRACT §9.4, docs/FORMATS.md "Calendar", M33): one weekday H1 per
// day, one line per block. Overnight blocks wrap, (Q1)/(Q2) blocks feed `blockApplies`, and a
// line under a weekday that tries to be a block and does not parse is reported, with its line
// number, instead of vanishing.
//
// Depends on: views (src/views/shared/timetable.ts, dates.js). Skipped until they exist.

import { describe, expect, it } from 'vitest';

const { chooseTimetable, parseTimetable, timetableSection } = await import('../../src/views/shared/timetable.ts');
const { blockApplies, blockMinutes } = await import('../../src/views/shared/dates.ts');

// Synthetic: the shape of a school timetable, none of anyone's real one.
const CAL = [
  '# Lundi',                                       // 1
  '',                                              // 2
  '- 08h00 à 10h00 Cours · salle 1 [cours]',       // 3
  '- 17h30 à 19h30 Maths [maths]',                 // 4
  '',                                              // 5
  '# Jeudi',                                       // 6
  '',                                              // 7
  '- 14h00 à 16h00 NSI (Q1) [nsi]',                // 8
  '- 14h00 à 16h00 Philo [philo] (Q2)',            // 9
  '- 25h00 à 26h00 Nothing real [off]',            // 10: hours out of range
  '- sometime Maths [maths]',                      // 11: a bullet that is no block
  'Prose under a day is ignored.',                 // 12
  '',                                              // 13
  '# Dimanche',                                    // 14
  '- 22h00 à 06h00 Sommeil [sommeil]',             // 15: overnight
  '',                                              // 16
  '# Hours per week',                              // 17
  '- 9h à 10h this closes the day, so it is prose [x]', // 18
  '',
].join('\n');

describe('parseTimetable', () => {
  const { events, unknown } = parseTimetable(CAL);

  it('reads one event per block, sorted by day then start', () => {
    expect(events.map((e) => [e.d, e.sm])).toEqual([[0, 480], [0, 1050], [3, 840], [3, 840], [6, 1320]]);
    const first = events[0];
    expect(first).toMatchObject({ d: 0, s: '08:00', e: '10:00', sm: 480, em: 600, t: 'Cours', sub: 'salle 1', kind: 'cours' });
  });

  it('reports the lines it did not understand, 1-based, and ignores prose and other H1s', () => {
    expect(unknown.map((u) => u.line)).toEqual([10, 11]);
    expect(unknown[1].text).toContain('sometime');
    expect(events.some((e) => e.t.includes('closes the day'))).toBe(false);
  });

  it('an overnight block wraps: never negative, the night is its length', () => {
    const night = events.find((e) => e.d === 6);
    expect(night.sm).toBe(22 * 60);
    expect(night.em - night.sm).toBe(8 * 60);
    expect(blockMinutes(night.sm, night.em % 1440)).toBe(8 * 60);
  });

  it('the (Q1) and (Q2) markers, before or after the type, feed blockApplies', () => {
    const [nsi, philo] = events.filter((e) => e.d === 3);
    const odd = new Date(2026, 8, 24);   // ISO week 39
    const even = new Date(2026, 9, 1);   // ISO week 40
    expect(blockApplies(nsi, odd, 'odd')).toBe(true);
    expect(blockApplies(philo, odd, 'odd')).toBe(false);
    expect(blockApplies(nsi, even, 'odd')).toBe(false);
    expect(blockApplies(philo, even, 'odd')).toBe(true);
    expect(blockApplies(nsi, odd, null) && blockApplies(philo, odd, null)).toBe(true);
    expect(blockApplies(events[0], even, 'odd')).toBe(true);
  });

  it('reads CRLF and a BOM the same', () => {
    const r = parseTimetable(`﻿${CAL.replace(/\n/g, '\r\n')}`);
    expect(r.events.map((e) => [e.d, e.sm, e.em])).toEqual(events.map((e) => [e.d, e.sm, e.em]));
    expect(r.unknown.map((u) => u.line)).toEqual([10, 11]);
  });

  it('an empty or missing file is an empty week', () => {
    expect(parseTimetable('')).toEqual({ events: [], unknown: [] });
    expect(parseTimetable(undefined)).toEqual({ events: [], unknown: [] });
  });
});

describe('the # Timetable section of a month file', () => {
  const month = [
    '# 2026-09 Monthly Plan',              // 1
    '',
    '- 08h00 à 09h00 Not a block [maths]', // 3: the title section, never read
    '# Timetable',                          // 4
    '',
    '# Lundi',                              // 6
    '- 08h20 à 09h15 Maths [maths]',        // 7
    '- 25h00 nonsense',                     // 8
    '# Mardi',                              // 9
    '- 10h20 à 12h10 NSI [cours] (Q1)',     // 10
    '# Monthly Review',                     // 11
    '- 13h00 à 14h00 After the end [maths]',
  ].join('\n');

  it("holds the weekdays under it and stops at the review, with the file's line numbers", () => {
    const sec = timetableSection(month);
    expect(sec.found).toBe(true);
    const { events, unknown } = parseTimetable(sec.text);
    expect(events.map((e) => [e.d, e.t, e.line, e.q])).toEqual([[0, 'Maths', 7, null], [1, 'NSI', 10, 'Q1']]);
    expect(unknown.map((u) => u.line)).toEqual([8]);
  });

  it("is the month's when it has one, else the calendar's", () => {
    const cal = { path: 'calendar.md', exists: true, text: '# Lundi\n- 07h00 à 08h00 Run [off]\n' };
    expect(chooseTimetable({ path: 'p/2026-09.md', text: month }, cal)).toMatchObject({ from: 'month', path: 'p/2026-09.md' });
    const none = chooseTimetable({ path: 'p/2026-01.md', text: '# 2026-01 Monthly Plan\n' }, cal);
    expect(none.from).toBe('calendar');
    expect(none.events.map((e) => e.t)).toEqual(['Run']);
    expect(timetableSection('# Lundi\n- 08h00 à 09h00 X [maths]\n').found).toBe(false);
  });
});
