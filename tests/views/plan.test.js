// The planner's files and how a day counts (src/views/shared/plan.ts, docs/FORMATS.md "The
// planner"), on two example months: September, closed and reviewed, counted from its first
// marked day; October, open, with a holiday week from the 19th. The clock is Thursday 15
// October 2026.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const P = await import('../../src/views/shared/plan.ts');

const fixture = (name) => readFileSync(new URL(`../fixtures/planner/${name}`, import.meta.url), 'utf8');
const sep = P.parseMonth(fixture('2026-09.md'), '2026-09');
const oct = P.parseMonth(fixture('2026-10.md'), '2026-10');
const months = new Map([['2026-09', sep], ['2026-10', oct]]);
const today = new Date(2026, 9, 15);
const st = (m, day, sys) => P.stateOf(m, day, sys, today);

describe('a month file', () => {
  it('reads its title, goals, weeks, days and review', () => {
    expect(oct.title).toBe('October 2026');
    expect(oct.goals.map((a) => `${a.label} ${a.goals.length}`)).toEqual(['Educational 5', 'Financial 2', 'Personal 3']);
    expect(oct.weeks.map((w) => w.from)).toEqual([null, '2026-10-19']);
    expect(oct.days.systems).toEqual(['cours', 'maths', 'nsi', 'lecture', 'philo', 'sport', 'bilan', 'algo', 'famille', 'hg', 'off', 'bed']);
    expect(oct.days.rows.size).toBe(31);
    expect(oct.review.written).toBe(false);
    expect(P.isOldMonth(oct)).toBe(false);
  });

  it('reads a weekday label of one day, a list and a run, and nothing else', () => {
    expect([...P.weekdaysOfLabel('Mardi, Jeudi')]).toEqual([1, 3]);
    expect([...P.weekdaysOfLabel('Lundi à Vendredi')]).toEqual([0, 1, 2, 3, 4]);
    expect(P.weekdaysOfLabel('Holidays until 1 November.')).toBe(null);
  });

  it('reads a week line with or without its times, its place and its tail', () => {
    expect(P.parseWeekLine('17h20 à 19h00 Maths · BU Sciences [maths]')).toMatchObject({ name: 'Maths', where: 'BU Sciences', start: 1040, end: 1140, system: 'maths' });
    expect(P.parseWeekLine('Bed by 23h00 [bed]')).toMatchObject({ name: 'Bed by 23h00', start: null, system: 'bed' });
    expect([...P.parseWeekLine('Lecture (sam dim) [lecture]').days]).toEqual([5, 6]);
    expect(P.parseWeekLine('23h00 à 07h00 Sommeil [sleep] (Q2)')).toMatchObject({ end: 1860, q: 'Q2' });
  });

  it('reads the grades of a review', () => {
    expect(sep.review.overall).toBe(6);
    expect(sep.review.grades.map((g) => `${g.label} ${g.n}`)).toEqual(['Educational 6', 'Financial 8', 'Personal 4']);
  });

  it('knows a month kept before the planner had days', () => {
    expect(P.isOldMonth(P.parseMonth('# 2026-06 Monthly Plan\n\nEducational\n\n- Read\n\n# Monthly Review\n\nGood.\n', '2026-06'))).toBe(true);
  });
});

describe('how a day counts', () => {
  it('uses the week in force on the day', () => {
    expect(P.weekFor(oct, new Date(2026, 9, 18)).from).toBe(null);
    expect(P.weekFor(oct, new Date(2026, 9, 19)).from).toBe('2026-10-19');
    expect(P.plannedSystems(oct, new Date(2026, 9, 16))).toContain('cours');
    expect(P.plannedSystems(oct, new Date(2026, 9, 19))).not.toContain('cours');
    expect(P.plannedSystems(oct, new Date(2026, 9, 24))).toEqual(['algo', 'sport', 'lecture', 'off', 'bed']);
  });

  it('marks a system done, missed, dropped, open or to come', () => {
    expect(st(oct, 1, 'cours')).toBe('done');
    expect(st(oct, 1, 'nsi')).toBe('missed');
    expect(st(oct, 8, 'cours')).toBe('skipped');
    expect(st(oct, 4, 'nsi')).toBe(null);
    expect(st(oct, 15, 'maths')).toBe('open');
    expect(st(oct, 16, 'cours')).toBe('planned');
  });

  it('counts a month from its first marked day, and a blank day after it as missed', () => {
    expect(P.firstMarked(sep)).toBe(7);
    expect(st(sep, 3, 'cours')).toBe('idle');
    expect(st(sep, 12, 'maths')).toBe('missed');
    expect(P.monthTally(sep, today)).toEqual({ done: 94, due: 164, skipped: 0, from: 7, blank: 3 });
    expect(P.monthTally(oct, today)).toEqual({ done: 73, due: 96, skipped: 3, from: 1, blank: 0 });
  });

  it('does not count what is still open today', () => {
    expect(P.count(oct, today, { days: [15] })).toEqual({ done: 1, due: 1, skipped: 0 });
    expect(P.dayShare(oct, 15, today).when).toBe('today');
  });

  it('says how one day went', () => {
    expect(P.dayShare(oct, 1, today)).toEqual({ done: 5, due: 6, share: 5 / 6, when: 'past' });
    expect(P.dayShare(oct, 16, today).share).toBe(null);
    expect(P.dayShare(sep, 3, today).when).toBe('idle');
  });

  it('runs across a dropped day and months, and stops on a missed one', () => {
    expect(P.streak(months, 'maths', today)).toBe(11);
    expect(P.streak(months, 'nsi', today)).toBe(0);
    expect(P.streak(months, 'lecture', today)).toBe(4);
  });

  it('shows a system under the words of its first line', () => {
    expect(P.nameOf(oct, 'maths')).toBe('Maths');
    expect(P.nameOf(oct, 'off')).toBe('OFF block taken');
    expect(P.nameOf(oct, 'nothing')).toBe('nothing');
  });
});

describe('what the app writes', () => {
  it('writes the first mark of a day with a dot under everything planned', () => {
    const w = P.writeMark(oct, 16, 'maths', 'x');
    expect(w.expected).toBe(oct.days.rows.get(16).raw);
    expect(w.next).toBe('| 16 ven | .     | x     | .   | .       |       |       | .     |      |         |    | .   | .   |      |');
  });

  it('changes one cell of a marked day, and keeps its note', () => {
    expect(P.writeMark(oct, 14, 'sport', 'x').next).toBe(oct.days.rows.get(14).raw.replace('| .     |       |      |', '| x     |       |      |'));
    expect(P.writeMark(oct, 2, 'maths', 'x').next.endsWith('| DS de maths le matin |')).toBe(true);
  });

  it('writes nothing it cannot place', () => {
    expect(P.writeMark(oct, 32, 'maths', 'x')).toBe(null);
    expect(P.writeMark(oct, 2, 'chess', 'x')).toBe(null);
  });

  it('flips a goal and nothing else on its line', () => {
    expect(P.writeGoal(oct.goals[0].goals[0]).next).toBe('- [x] Maths: 17 or more at the DS');
    expect(P.writeGoal({ line: 0, raw: '- a', text: 'a', box: null })).toBe(null);
  });

  it('starts a month from the one before: goals unticked, the last week, an empty table', () => {
    const text = P.newMonthText(2026, 11, { text: fixture('2026-10.md'), ym: '2026-10' });
    const nov = P.parseMonth(text, '2026-11');
    expect(nov.title).toBe('November 2026');
    expect(nov.goals.flatMap((a) => a.goals).every((g) => g.box === 'open')).toBe(true);
    expect(nov.weeks).toHaveLength(1);
    expect(nov.weeks[0].from).toBe(null);
    expect(P.plannedSystems(nov, new Date(2026, 10, 2))).not.toContain('cours');     // the holiday week went on
    expect(nov.days.rows.size).toBe(30);
    expect(nov.days.rows.get(1).raw.startsWith('| 01 dim |')).toBe(true);
    expect(P.firstMarked(nov)).toBe(null);
    expect(text.trimEnd().endsWith(P.MONTH_GAP)).toBe(true);
  });

  it('starts a first month and a year with the three areas', () => {
    expect(P.parseMonth(P.newMonthText(2026, 9, null), '2026-09').goals.map((a) => a.label)).toEqual(['Educational', 'Financial', 'Personal']);
    const y = P.parseYear(P.newYearText(2027, fixture('2026.md')), 2027);
    expect(y.title).toBe('2027');
    expect(y.goals.map((a) => a.label)).toEqual(['Educational', 'Financial', 'Personal']);
    expect(y.review.gap).toBe(true);
  });
});
