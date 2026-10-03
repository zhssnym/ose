// @vitest-environment happy-dom
// The planner's pages (src/views/planner/render.ts), drawn from the example months. Year and
// Month are goals and a review, with one figure from the checkboxes; Execution is the month's log
// as a heatmap, the day's execution and the tasks. No page shows a time of its own.

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

describe('the planner pages', () => {
  it('Execution: the heatmap with what each item lost, the day in its order, the tasks', () => {
    const el = page(R.executionPage(ctx, ctx.today));
    expect(el.querySelector('.page-title').textContent).toBe('Thursday 15 October');
    expect(el.querySelector('.pn-zoom')).toBe(null);
    expect(el.querySelector('.pv-sum').textContent).toBe('76% so far · September 57%');
    expect(el.querySelectorAll('.pv-heat .pv-gl')).toHaveLength(12);
    expect([...el.querySelectorAll('.pv-loss')].map((x) => x.textContent).slice(0, 3)).toEqual(['−5%', '−3%', '−15%']);
    expect(el.querySelector('.pv-hsum').textContent).toBe('34% done · 11% lost · 55% open');
    expect([...el.querySelectorAll('.pv-item[data-act="tick"] .pv-what')].map((x) => x.textContent)).toEqual(['School', 'Maths', 'NSI', 'Lecture', 'Off', 'Sleep']);
    expect(el.querySelector('.pv-late').textContent).toBe('late');
    expect(el.textContent).not.toMatch(/\b\d{2}h\d{2}\b/);
  });

  it('Month: the goals with their figure, then the review, and nothing else', () => {
    const el = page(R.monthPage(ctx, new Date(2026, 8, 1)));
    expect(el.querySelector('.page-title').textContent).toBe('September 2026');
    expect([...el.querySelectorAll('.pn-zoom-b')].map((b) => b.textContent)).toEqual(['Year', 'Month']);
    expect([...el.querySelectorAll('.label')].map((x) => x.textContent)).toEqual(['Goals', 'Review']);
    expect(el.querySelector('.pv-sum').textContent).toBe('36% · 4 of 11 met');
    expect(el.querySelectorAll('.pv-goal')).toHaveLength(11);
    expect(el.querySelector('.pv-review').dataset.prose).toMatch(/^The week itself held/);
    expect(el.querySelector('.pv-grid')).toBe(null);
  });

  it('Month: a month with no file can be started', () => {
    expect(page(R.monthPage(ctx, new Date(2026, 10, 1))).querySelector('[data-act="start-month"]')).not.toBe(null);
  });

  it('Year: the year file alone, its checklist and how much of it is met', () => {
    const el = page(R.yearPage(ctx, 2026));
    expect(el.querySelector('.page-title').textContent).toBe('2026');
    expect(el.querySelector('.pv-sum').textContent).toBe('27% · 3 of 11 met');
    expect(el.querySelectorAll('.pv-goal')).toHaveLength(11);
    expect(el.querySelector('.pv-grid')).toBe(null);
  });
});
