// The calendar format (CONTRACT §9.4, docs/FORMATS.md "Calendar", M33): one weekday H1 per
// day, one line per block. Overnight blocks wrap, (Q1)/(Q2) blocks feed `blockApplies`, and a
// line under a weekday that tries to be a block and does not parse is reported, with its line
// number, instead of vanishing.
//
// Depends on: planner (src/planner/timetable.ts, dates.js). Skipped until they exist.

import { describe, expect, it } from 'vitest';

const { parseTimetable } = await import('../../src/planner/timetable.ts');
const { blockApplies, blockMinutes } = await import('../../src/planner/dates.ts');

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
