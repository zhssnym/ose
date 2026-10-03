// The planner's files and how a day counts (src/views/shared/plan.ts, docs/FORMATS.md "The
// planner"), on two example months: September, closed and reviewed, counted from its first
// marked day; October, open. A month is # Goals, # Execution (a list per weekday, in doing
// order), # Log (a row per day) and # Review. The clock is Thursday 15 October 2026.

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
  it('reads its title, goals, execution, log and review', () => {
    expect(oct.title).toBe('October 2026');
    expect(oct.goals.map((a) => `${a.label} ${a.goals.length}`)).toEqual(['Educational 5', 'Financial 2', 'Personal 3']);
    expect(oct.weeks).toHaveLength(1);
    expect(oct.days.systems).toEqual(['school', 'maths', 'nsi', 'lecture', 'off', 'sleep', 'philo', 'cardio', 'bilan', 'algo', 'famille', 'hg']);
    expect(oct.days.rows.size).toBe(31);
    expect(oct.review.written).toBe(false);
    expect(sep.review.written).toBe(true);
    expect(P.isOldMonth(oct)).toBe(false);
  });

  it('lists a day in the order the file writes it', () => {
    expect(P.linesFor(oct, new Date(2026, 9, 18)).map((l) => l.name)).toEqual(['Maths', 'Philo', 'Famille', 'HG', 'Bilan', 'Cardio', 'Lecture', 'Off', 'Sleep']);
  });

  it('keys an item by its own words, unless brackets name it', () => {
    expect(P.parseWeekLine('Sleep')).toMatchObject({ name: 'Sleep', system: 'sleep', start: null });
    expect(P.parseWeekLine('Histoire-géo [hg]')).toMatchObject({ name: 'Histoire-géo', system: 'hg' });
    expect(P.parseWeekLine('17h20 à 19h00 Maths · BU Sciences')).toMatchObject({ name: 'Maths', where: 'BU Sciences', system: 'maths' });
    expect([...P.parseWeekLine('Lecture (sam dim)').days]).toEqual([5, 6]);
  });

  it('reads a weekday label of one day, a list and a run, and nothing else', () => {
    expect([...P.weekdaysOfLabel('Mardi, Jeudi')]).toEqual([1, 3]);
    expect([...P.weekdaysOfLabel('Lundi à Vendredi')]).toEqual([0, 1, 2, 3, 4]);
    expect(P.weekdaysOfLabel('Holidays until 1 November.')).toBe(null);
  });

  it('runs the first execution from the 1st, and each dated one until the next or the end of the month', () => {
    const m = P.parseMonth([
      '# x', '', '# Execution', '', 'Lundi', '', '- School', '- Maths', '',
      '# Execution from 2026-10-26', '', 'Lundi', '', '- Lecture', '',
      '# Log', '', '| Day | School | Maths | Lecture |', '|---|---|---|---|',
    ].join('\n'), '2026-10');
    const mon = (d) => P.plannedSystems(m, new Date(2026, 9, d));
    expect(mon(5)).toEqual(['school', 'maths']);
    expect(mon(19)).toEqual(['school', 'maths']);
    expect(mon(26)).toEqual(['lecture']);
    // written in any order, the dated executions still follow their dates
    const three = P.parseMonth('# x\n\n# Execution from 2026-11-16\n\nLundi\n\n- C\n\n# Execution\n\nLundi\n\n- A\n\n# Execution from 2026-11-09\n\nLundi\n\n- B\n', '2026-11');
    expect([2, 9, 16, 23].map((d) => P.plannedSystems(three, new Date(2026, 10, d)))).toEqual([['a'], ['b'], ['c'], ['c']]);
  });

  it('starts a new month with no Note column, and reads an older one without making it an item', () => {
    expect(P.emptyDays(2026, 11, ['Maths'])[0]).toBe('| Day    | Maths |');
    const m = P.parseMonth('# x\n\n# Log\n\n| Day | Maths | Note |\n|---|---|---|\n| 05 lun | x | ill |\n', '2026-10');
    expect(m.days.systems).toEqual(['maths']);
    expect(P.writeMark(m, 5, 'maths', '').next).toBe('| 05 lun |       | ill  |');
  });

  it('still reads the older names, # Week and # Days', () => {
    const m = P.parseMonth('# x\n\n# Week\n\nLundi\n\n- Maths\n\n# Days\n\n| Day | Maths | Note |\n|---|---|---|\n| 05 lun | x | |\n', '2026-10');
    expect(P.stateOf(m, 5, 'maths', today)).toBe('done');
  });

  it('knows a month kept before the planner had a log', () => {
    expect(P.isOldMonth(P.parseMonth('# 2026-06 Monthly Plan\n\nEducational\n\n- Read\n\n# Monthly Review\n\nGood.\n', '2026-06'))).toBe(true);
  });

  it('reads the grades a review may hold', () => {
    const r = P.parseMonth('# x\n\n# Review\n\nEducational\n\nIt went fine.\n\nGrade: 7/10\n\nOverall: 60/100\n', '2026-10').review;
    expect(r.overall).toBe(6);
    expect(r.grades).toEqual([{ label: 'Educational', n: 7 }]);
  });
});

describe('how a day counts', () => {
  it('plans what the execution lists for the weekday', () => {
    expect(P.plannedSystems(oct, new Date(2026, 9, 17))).toEqual(['maths', 'nsi', 'algo', 'cardio', 'lecture', 'off', 'sleep']);
    expect(P.plannedSystems(oct, new Date(2026, 9, 17))).not.toContain('school');
  });

  it('marks an item done, missed, dropped, open or to come', () => {
    expect(st(oct, 1, 'school')).toBe('done');
    expect(st(oct, 1, 'nsi')).toBe('missed');
    expect(st(oct, 8, 'school')).toBe('skipped');
    expect(st(oct, 4, 'nsi')).toBe(null);
    expect(st(oct, 15, 'maths')).toBe('open');
    expect(st(oct, 16, 'school')).toBe('planned');
  });

  it('counts a month from its first marked day, and a blank day after it as missed', () => {
    expect(P.firstMarked(sep)).toBe(7);
    expect(st(sep, 3, 'school')).toBe('idle');
    expect(st(sep, 12, 'maths')).toBe('missed');
    expect(P.monthTally(sep, today)).toEqual({ done: 95, due: 167, skipped: 0, from: 7, blank: 3 });
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

  it('shows an item under its own words', () => {
    expect(P.nameOf(oct, 'famille')).toBe('Famille');
    expect(P.nameOf(oct, 'hg')).toBe('HG');
    expect(P.nameOf(oct, 'nothing')).toBe('nothing');
  });
});

describe('what the app writes', () => {
  it('writes the first mark of a day with a dot under everything planned', () => {
    const w = P.writeMark(oct, 16, 'maths', 'x');
    expect(w.expected).toBe(oct.days.rows.get(16).raw);
    expect(w.next).toBe('| 16 ven | .      | x     | .   | .       | .   | .     |       |        | .     |      |         |    |');
  });

  it('changes one cell of a marked day', () => {
    const before = oct.days.rows.get(14);
    const after = P.parseDays({ body: [oct.days.header, { n: 99, text: P.writeMark(oct, 14, 'cardio', 'x').next }].map((x) => ({ n: x.n ?? x.line, text: x.text ?? x.raw })) }).rows.get(14);
    expect(after.marks).toEqual({ ...before.marks, cardio: 'x' });
  });

  it('writes nothing it cannot place', () => {
    expect(P.writeMark(oct, 32, 'maths', 'x')).toBe(null);
    expect(P.writeMark(oct, 2, 'chess', 'x')).toBe(null);
  });

  it('flips a goal and nothing else on its line', () => {
    expect(P.writeGoal(oct.goals[0].goals[0]).next).toBe('- [x] Maths: 17 or more at the DS');
    expect(P.writeGoal({ line: 0, raw: '- a', text: 'a', box: null })).toBe(null);
  });

  it('starts a month from the one before: goals unticked, the same execution, an empty log', () => {
    const text = P.newMonthText(2026, 11, { text: fixture('2026-10.md'), ym: '2026-10' });
    const nov = P.parseMonth(text, '2026-11');
    expect(nov.title).toBe('November 2026');
    expect(text).toContain('# Execution');
    expect(text).toContain('# Log');
    expect(nov.goals.flatMap((a) => a.goals).every((g) => g.box === 'open')).toBe(true);
    expect(nov.days.systems).toEqual(oct.days.systems);
    expect(nov.days.heads.slice(1, 4)).toEqual(['School', 'Maths', 'NSI']);
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
