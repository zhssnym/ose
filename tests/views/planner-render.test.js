// @vitest-environment happy-dom
// The planner's four pages (src/views/planner/render.ts), drawn from the example months: each
// page draws, shows the one figure it promises, and none shows a clock time.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const P = await import('../../src/views/shared/plan.ts');
const R = await import('../../src/views/planner/render.ts');

const fixture = (name) => readFileSync(`${process.cwd()}/tests/fixtures/planner/${name}`, 'utf8');   // happy-dom changes import.meta.url
const months = new Map([['2026-09', P.parseMonth(fixture('2026-09.md'), '2026-09')], ['2026-10', P.parseMonth(fixture('2026-10.md'), '2026-10')]]);
const files = new Map([['2026-09', { path: 'plannings/2026-09.md', exists: true }], ['2026-10', { path: 'plannings/2026-10.md', exists: true }], ['2026-11', { path: 'plannings/2026-11.md', exists: false }]]);
const ctx = {
  today: new Date(2026, 9, 15), folder: 'plannings', months, files, note: '',
  year: { path: 'plannings/2026.md', exists: true, plan: P.parseYear(fixture('2026.md'), 2026) },
  tasks: [{ id: 't:3', path: 'plannings/todo.md', line: 3, text: 'Renew the library card', due: '2026-10-12', done: false, depth: 0 }],
  todoPath: 'plannings/todo.md',
};
const page = (html) => { const el = document.createElement('div'); el.innerHTML = html; return el; };
// a time the user wrote into a name ("Bed by 23h00") is their words; the page adds none of its own
const noClock = (el) => expect(el.textContent.replace(/Bed by 23h00/g, '')).not.toMatch(/\b\d{2}h\d{2}\b/);

describe('the planner pages', () => {
  it('Day: the month across the top, the day, the tasks', () => {
    const el = page(R.dayPage(ctx, ctx.today));
    expect(el.querySelector('.page-title').textContent).toBe('Thursday 15 October');
    expect(el.querySelectorAll('.pv-strip .pv-c')).toHaveLength(31);
    expect(el.querySelector('.pv-sum').textContent).toBe('76% so far · September 57%');
    expect([...el.querySelectorAll('.pv-item[data-act="tick"] .pv-what')].map((x) => x.textContent)).toEqual(['School', 'Maths', 'NSI', 'Lecture', 'OFF block taken, not worked through', 'Bed by 23h00']);
    expect(el.querySelector('.pv-late').textContent).toBe('late');
    noClock([...el.querySelectorAll('.pv-day section')][0]);
  });

  it('Week: a row per system and the week before', () => {
    const el = page(R.weekPage(ctx, ctx.today));
    expect(el.querySelector('.page-title').textContent).toBe('Week of 12 October');
    expect(el.querySelector('.pv-sum').textContent).toBe('76% so far · last week 67%');
    expect(el.querySelectorAll('.pv-gr:not(.is-heads)').length).toBeGreaterThan(5);
    noClock(el);
  });

  it('Month: goals, the days by system, the review', () => {
    const el = page(R.monthPage(ctx, new Date(2026, 8, 1)));
    expect(el.querySelector('.page-title').textContent).toBe('September 2026');
    expect([...el.querySelectorAll('.pv-sum')].map((x) => x.textContent)).toContain('57%');
    expect(el.querySelectorAll('.pv-goal').length).toBe(11);
    expect(el.querySelectorAll('.pv-review').length).toBe(4);
    noClock(el.querySelector('.pv-grid'));
  });

  it('Month: a month with no file can be started', () => {
    const el = page(R.monthPage(ctx, new Date(2026, 10, 1)));
    expect(el.querySelector('[data-act="start-month"]')).not.toBe(null);
  });

  it('Year: the months, their rates and the grade', () => {
    const el = page(R.yearPage(ctx, 2026));
    expect(el.querySelector('.page-title').textContent).toBe('2026');
    expect(el.textContent).toContain('57%');
    expect(el.textContent).toContain('6/10');
    expect(el.querySelectorAll('.pv-goal').length).toBe(11);
  });
});
