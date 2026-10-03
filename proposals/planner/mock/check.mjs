// The five counting rules and the writes, checked on the example months.
//
//   node proposals/planner/mock/check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const here = new URL('../', import.meta.url);
new Function(readFileSync(new URL('mock/planner.js', here), 'utf8'))();
const P = globalThis.Planner;
const load = (ym) => P.parseMonth(readFileSync(new URL(`examples/plannings/${ym}.md`, here), 'utf8'), ym);
const sep = load('2026-09'), oct = load('2026-10');
const months = new Map([['2026-09', sep], ['2026-10', oct]]);
const today = new Date(2026, 9, 15);
const st = (m, day, sys) => P.stateOf(m, day, sys, today);

// rule 1: the week in force
assert.equal(P.weekFor(oct, new Date(2026, 9, 18)).from, null);
assert.equal(P.weekFor(oct, new Date(2026, 9, 19)).from, '2026-10-19');
assert.ok(P.plannedSystems(oct, new Date(2026, 9, 16)).includes('cours'));
assert.ok(!P.plannedSystems(oct, new Date(2026, 9, 19)).includes('cours'));
assert.deepEqual(P.plannedSystems(oct, new Date(2026, 9, 24)), ['algo', 'sport', 'lecture', 'off', 'bed']);

// rules 2 and 3: due, done, skipped
assert.equal(st(oct, 1, 'cours'), 'done');
assert.equal(st(oct, 1, 'nsi'), 'missed');
assert.equal(st(oct, 8, 'cours'), 'skipped');
assert.equal(st(oct, 4, 'nsi'), null);                  // a Sunday has no NSI
assert.equal(st(oct, 15, 'maths'), 'open');             // today
assert.equal(st(oct, 16, 'cours'), 'planned');          // a day to come

// rule 4: a month counts from its first marked day; a blank day after it is missed
assert.equal(P.firstMarked(sep), 7);
assert.equal(st(sep, 3, 'cours'), 'idle');
assert.equal(st(sep, 12, 'maths'), 'missed');
assert.deepEqual(P.monthTally(sep, today), { done: 94, due: 164, skipped: 0, from: 7, blank: 3 });
assert.deepEqual(P.monthTally(oct, today), { done: 73, due: 96, skipped: 3, from: 1, blank: 0 });
// today's open lines are not due yet: one done line today adds one to both
assert.deepEqual(P.count(oct, today, { days: [15] }), { done: 1, due: 1, skipped: 0 });

// rule 5: a run crosses a skipped day and stops on a missed one; it crosses months
assert.equal(P.streak(months, 'maths', today), 11);
assert.equal(P.streak(months, 'nsi', today), 0);
const lecture = P.streak(months, 'lecture', today);
assert.equal(lecture, 4);

// the write: the first mark of a day says what was due
const w = P.writeMark(oct, 16, 'maths', 'x');
assert.equal(w.expected, oct.days.rows.get(16).raw);
assert.equal(w.next, '| 16 ven | .     | x     | .   | .       |       |       | .     |      |         |    | .   | .   |      |');
// a second mark changes one cell and keeps the rest
const w2 = P.writeMark(oct, 14, 'sport', 'x');
assert.equal(w2.next, oct.days.rows.get(14).raw.replace('| .     |       |      |', '| x     |       |      |'));
// a mark keeps the day's note where it is
assert.ok(P.writeMark(oct, 2, 'maths', 'x').next.endsWith('| DS de maths le matin |'));
// what a day says in one figure, and the words a system is shown under
assert.deepEqual(P.dayShare(oct, 1, today), { done: 5, due: 6, share: 5 / 6, when: 'past' });
assert.equal(P.dayShare(oct, 15, today).when, 'today');
assert.equal(P.dayShare(oct, 16, today).share, null);
assert.equal(P.dayShare(sep, 3, today).when, 'idle');
assert.equal(P.nameOf(oct, 'maths'), 'Maths');
assert.equal(P.nameOf(oct, 'off'), 'OFF block taken');
// a goal's box flips and nothing else on the line moves
const g = oct.goals[0].goals[0];
assert.equal(P.writeGoal(g).next, '- [x] Maths: 17 or more at the DS');
// labels: one day, a list, a run
assert.deepEqual([...P.weekdaysOfLabel('Mardi, Jeudi')], [1, 3]);
assert.deepEqual([...P.weekdaysOfLabel('Lundi à Vendredi')], [0, 1, 2, 3, 4]);
assert.equal(P.weekdaysOfLabel('Holidays until 1 November.'), null);
// the review's grades
assert.equal(sep.review.overall, 6);
assert.deepEqual(sep.review.grades.map((x) => `${x.label} ${x.n}`), ['Educational 6', 'Financial 8', 'Personal 4']);
console.log('all the rules hold on the examples');
