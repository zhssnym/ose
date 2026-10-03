// The planner's pages as HTML. Pure but for `esc`: everything comes from `Ctx`, which index.ts
// reads from the files.
//
//   Year, Month   the file's goals, how many are ticked, its review in a paragraph
//   Execution     the month's log as a heatmap with what each item has lost, the day's list to
//                 tick, the todo list
//
// No times and no counts beside lines: life is not managed to the minute. The look is views.css's
// `.pv` block: terracotta for what was done, the paper's own greys for the rest.

import { esc } from '../../ui/index.ts';
import {
  allSystems, dateOf, dayIndex, daysIn, isOldMonth, linesFor, monthTally, nameOf, outcome, percentages, stateOf, ymd, ymOf,
  type Area, type Month, type Review, type Year,
} from '../shared/plan.ts';

export type Zoom = 'year' | 'month';
export const ZOOMS: Array<[Zoom, string]> = [['year', 'Year'], ['month', 'Month']];

/** What the pages are drawn from. */
export type Ctx = {
  today: Date;
  folder: string | null;                                  // the planner folder, null when not chosen
  months: Map<string, Month>;                             // by YYYY-MM, the months read
  files: Map<string, { path: string; exists: boolean; }>; // by YYYY-MM, where each month is or would be
  year: { path: string; exists: boolean; plan: Year | null; } | null;
  tasks: any[];                                           // the todo lines (shared/tasks.ts)
  todoPath: string | null;
  note: string;                                           // one quiet line, when something went wrong
};

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const pct = (done: number, due: number) => (due ? Math.round((100 * done) / due) : 0);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const fileLink = (path: string) => `<button type="button" class="v-link" data-path="${esc(path)}">${esc(base(path))}</button>`;

/** A section's head: its label, and at the right how far it is. `sum` is HTML. */
const head = (label: string, sum = '') => `<div class="pv-head"><span class="label">${esc(label)}</span><span class="pv-sum">${sum}</span></div>`;

/** The title row: the zoom words (Planner only), the title, ‹ Today ›, the files. */
function frame(ctx: Ctx, { zoom, title, unit, meta, body, here }: { zoom: Zoom | null; title: string; unit: string; meta: string[]; body: string; here: boolean; }): string {
  const zooms = zoom ? `<div class="pn-zoom" role="group" aria-label="Zoom">${ZOOMS.map(([z, label]) =>
    `<button type="button" class="pn-zoom-b${z === zoom ? ' on' : ''}" data-act="zoom" data-zoom="${z}" aria-pressed="${z === zoom}">${label}</button>`).join('')}</div>` : '';
  return `${zooms}
    <div class="v-head">
      <h1 class="page-title view-title">${esc(title)}</h1>
      <div class="v-nav">
        <button type="button" class="btn sm" data-nav="prev" aria-label="Previous ${unit}">&lsaquo;</button>
        <button type="button" class="btn sm" data-nav="today"${here ? ' hidden' : ''}>Today</button>
        <button type="button" class="btn sm" data-nav="next" aria-label="Next ${unit}">&rsaquo;</button>
      </div>
    </div>
    <div class="page-meta">${meta.filter(Boolean).join('')}</div>
    ${ctx.note ? `<div class="pl-quiet">${esc(ctx.note)}</div>` : ''}
    ${body}`;
}

/* ------------------------------------------------------------------ goals and review */

/** The goals with a box, and how many are ticked. */
const goalsMet = (areas: Area[]) => {
  const boxed = areas.flatMap((a) => a.goals).filter((g) => g.box);
  return { met: boxed.filter((g) => g.box === 'done').length, of: boxed.length };
};

/** The one figure of a year or a month: its goals ticked over its goals (2 of 10 is 20%). */
const goalsSum = (areas: Area[]) => {
  const g = goalsMet(areas);
  return g.of ? `<b>${pct(g.met, g.of)}%</b> · ${g.met} of ${g.of} met` : '';
};

function goalsHtml(areas: Area[], path: string): string {
  if (!areas.length) return '<div class="pv-empty">No goals written</div>';
  return areas.map((a) => `<div class="pv-area">
    <div class="pv-area-name pv-what">${esc(a.label)}</div>
    <div>${a.goals.map((g) => {
      const inner = `${g.box ? `<span class="check${g.box === 'done' ? ' on' : ''}"></span>` : '<span class="pv-bullet"></span>'}<span class="pv-what">${esc(g.text)}</span>`;
      return g.box
        ? `<button type="button" class="pv-goal${g.box === 'done' ? ' is-done' : ''}" data-act="goal" data-path="${esc(path)}" data-line="${g.line}" data-key="goal:${esc(path)}:${g.line}" aria-pressed="${g.box === 'done'}">${inner}</button>`
        : `<div class="pv-goal">${inner}</div>`;
    }).join('')}</div>
  </div>`).join('');
}

/** The review: the file's words as one document, drawn by index.ts with the editor's renderer. */
const reviewHtml = (review: Review) => (review.written
  ? `<div class="pv-prose pv-review" data-prose="${esc(review.text)}"></div>`
  : '<div class="pv-empty">Not written yet</div>');

/** The intro of a month or a year. */
const intro = (text: string) => (text ? `<div class="pv-prose pv-intro" data-prose="${esc(text)}"></div>` : '');

/** Goals, then the review: a year's page and a month's are this and nothing else. */
const goalsAndReview = (areas: Area[], review: Review, path: string, introText: string) => `${intro(introText)}
  <div class="pv-sec">${head('Goals', goalsSum(areas))}${goalsHtml(areas, path)}</div>
  <div class="pv-sec">${head('Review')}${reviewHtml(review)}</div>`;

/* ------------------------------------------------------------------ year, month */

export function yearPage(ctx: Ctx, y: number): string {
  const yf = ctx.year;
  const plan = yf ? yf.plan : null;
  const body = !yf ? '' : plan
    ? goalsAndReview(plan.goals, plan.review, yf.path, plan.intro)
    : `<div class="pl-quiet">${y} has no file yet. <button type="button" class="v-link" data-act="start-year" data-key="start-year">Start it</button>.</div>`;
  return frame(ctx, { zoom: 'year', title: String(y), unit: 'year', meta: [yf && yf.exists ? fileLink(yf.path) : ''], body, here: y === ctx.today.getFullYear() });
}

/** A month with no file, or one kept before the planner had a log: one quiet line. */
function noMonth(ctx: Ctx, d: Date): string {
  const ym = ymOf(d), name = `${MONTH[d.getMonth()]} ${d.getFullYear()}`;
  const m = ctx.months.get(ym), f = ctx.files.get(ym);
  if (m && isOldMonth(m) && f) return `<div class="pl-quiet">${esc(name)} was kept before the planner had a log: it is in <button type="button" class="v-link" data-path="${esc(f.path)}">${esc(base(f.path))}</button>.</div>`;
  if (m && f) return `<div class="pl-quiet">${esc(name)} has no <span class="mono-sm"># Log</span> table yet in <button type="button" class="v-link" data-path="${esc(f.path)}">${esc(base(f.path))}</button>.</div>`;
  return `<div class="pl-quiet">${esc(name)} has no file yet. <button type="button" class="v-link" data-act="start-month" data-ym="${ym}" data-key="start:${ym}">Start it</button> from the last month.</div>`;
}

export function monthPage(ctx: Ctx, date: Date): string {
  const ym = ymOf(date), month = ctx.months.get(ym) || null, f = ctx.files.get(ym);
  const meta = [f && f.exists ? fileLink(f.path) : '', `<button type="button" class="v-link" data-act="zoom" data-zoom="year" data-key="to-year">${date.getFullYear()}</button>`];
  const body = month && f && !isOldMonth(month) ? goalsAndReview(month.goals, month.review, f.path, month.intro) : noMonth(ctx, date);
  return frame(ctx, { zoom: 'month', title: `${MONTH[date.getMonth()]} ${date.getFullYear()}`, unit: 'month', meta, body, here: ym === ymOf(ctx.today) });
}

/* ------------------------------------------------------------------ today */

const SAID = { done: 'done', missed: 'not done', open: 'open', planned: 'to come', skipped: 'dropped that day', idle: 'before the month began' };

/**
 * The month's log as a heatmap: a row per item, a cell per day, and at the end of the row what
 * that item has lost (its due days gone by and not done). Under it, the month in three words.
 * A cell of a day gone by or of today ticks it.
 */
function heatmap(ctx: Ctx, month: Month, on: Date): string {
  const tracks: string[] = [];
  const cols: Array<Date | null> = [];
  for (let day = 1; day <= daysIn(month.year, month.month); day++) {
    const d = dateOf(month, day);
    if (dayIndex(d) === 0 && day > 1) { tracks.push('var(--sp-1)'); cols.push(null); }
    tracks.push('minmax(0, 1fr)');
    cols.push(d);
  }
  const row = (label: string, cells: string[], cls = '', end = '<span></span>') => {
    let i = 0;
    return `<div class="pv-gr ${cls}">${label}${cols.map((c) => (c ? cells[i++] ?? '<span></span>' : '<span></span>')).join('')}${end}</div>`;
  };
  const days = cols.filter((c): c is Date => !!c);
  const heads = row('<span></span>', days.map((d) => {
    const isOn = +d === +on;
    if (!(d.getDate() === 1 || dayIndex(d) === 0 || isOn)) return '<span></span>';
    return `<button type="button" class="pv-gh${+d === +ctx.today ? ' is-today' : ''}" data-act="open-day" data-day="${ymd(d)}" data-key="h:${ymd(d)}" title="Open this day">${d.getDate()}</button>`;
  }), 'is-heads');
  const body = allSystems(month).map((s) => {
    const name = nameOf(month, s);
    const o = outcome(month, ctx.today, [s]);
    const all = o.done + o.lost + o.open;
    const loss = all && o.lost ? `<span class="pv-loss" title="${esc(name)} · ${o.done} done · ${o.lost} lost · ${o.open} open">−${Math.round((100 * o.lost) / all)}%</span>` : '<span></span>';
    return row(`<span class="pv-gl" title="${esc(name)}">${esc(name)}</span>`, days.map((d) => {
      const st = stateOf(month, d.getDate(), s, ctx.today);
      if (!st) return '<span class="pv-c"></span>';
      const tip = `${name} · ${DAY_SHORT[dayIndex(d)]} ${d.getDate()} · ${SAID[st]}`;
      const cls = `pv-c is-${st}${+d === +on ? ' is-here' : ''}`;
      return d > ctx.today
        ? `<span class="${cls}" title="${esc(tip)}"></span>`
        : `<button type="button" class="${cls}" data-act="tick" data-day="${ymd(d)}" data-sys="${esc(s)}" data-key="c:${ymd(d)}:${esc(s)}" aria-pressed="${st === 'done'}" aria-label="${esc(tip)}" title="${esc(tip)}"></button>`;
    }), '', loss);
  }).join('');
  const p = percentages(outcome(month, ctx.today));
  const sum = `<div class="pv-hsum">${p.done}% done · ${p.lost}% lost · ${p.open}% open</div>`;
  return `<div class="pv-grid pv-heat" style="--pv-cols: var(--pv-margin) ${tracks.join(' ')} var(--pv-end)">${heads}${body}</div>${sum}`;
}

/** The day's execution, in the order it is done, to tick. */
function dayList(ctx: Ctx, month: Month, d: Date): string {
  const future = d > ctx.today, key = ymd(d);
  const seen = new Set<string>();
  let done = 0, due = 0;
  const rows = linesFor(month, d).map((l) => {
    if (!l.system || seen.has(l.system)) return '';
    seen.add(l.system);
    const st = stateOf(month, d.getDate(), l.system, ctx.today);
    if (st === 'done') { done++; due++; } else if (st !== 'skipped') due++;
    const box = st === 'done' ? ' on' : st === 'skipped' ? ' skip' : '';
    const inner = `<span class="check${box}"></span><span class="pv-what">${esc(l.name)}</span>`;
    return future
      ? `<div class="pv-item">${inner}</div>`
      : `<button type="button" class="pv-item is-${st}" data-act="tick" data-day="${key}" data-sys="${esc(l.system)}" data-key="tick:${key}:${esc(l.system)}" aria-pressed="${st === 'done'}">${inner}</button>`;
  }).join('');
  const sum = !due ? '' : future ? `${due} planned` : `${done} of ${due}`;
  return `<section>${head(+d === +ctx.today ? 'Today' : (DAY_LONG[dayIndex(d)] ?? ''), sum)}
    ${rows || '<div class="pv-empty">Nothing listed for this day</div>'}</section>`;
}

function tasksColumn(ctx: Ctx, d: Date): string {
  if (!ctx.todoPath) return `<section>${head('Tasks')}</section>`;
  const key = ymd(d);
  const when = (t) => t.due || t.scheduled || null;
  const open = ctx.tasks.filter((t) => !t.done && (!when(t) || when(t) <= key));
  const closed = ctx.tasks.filter((t) => t.done && t.doneDate === key);
  const rank = (t) => (when(t) && when(t) < key ? 0 : when(t) === key ? 1 : 2);
  open.sort((a, b) => rank(a) - rank(b) || String(when(a) || '').localeCompare(String(when(b) || '')) || a.line - b.line);
  const rowOf = (t) => {
    const late = !t.done && when(t) && when(t) < key;
    const depth = Math.min(4, t.depth || 0);
    return `<div class="pv-item${t.done ? ' is-struck' : ''}" style="padding-left: calc(${depth} * var(--sp-5))">
      <button type="button" class="pv-box" data-act="task" data-id="${esc(t.id)}" data-key="task:${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}"><span class="check${t.done ? ' on' : ''}"></span></button>
      <span class="pv-what">${esc(t.text)}</span>${late ? `<span class="pv-late" title="Due ${esc(when(t))}">late</span>` : ''}</div>`;
  };
  return `<section>${head('Tasks')}
    ${[...open, ...closed].map(rowOf).join('') || '<div class="pv-empty">Nothing due, nothing late</div>'}
    <input type="text" class="pv-field" data-act="add" data-key="add" autocomplete="off" spellcheck="false" aria-label="New task" placeholder="New task">
  </section>`;
}

/** How far the month's log is, and the month before it when it has one. */
function logSum(ctx: Ctx, month: Month): string {
  const t = monthTally(month, ctx.today);
  if (!t.due) return '';
  const prev = ctx.months.get(ymOf(new Date(month.year, month.month - 2, 1)));
  const p = prev && prev.days ? monthTally(prev, ctx.today) : null;
  const now = `<b>${pct(t.done, t.due)}%</b>${month.ym === ymOf(ctx.today) ? ' so far' : ''}`;
  return p && p.due && prev ? `${now} · ${MONTH[prev.month - 1]} ${pct(p.done, p.due)}%` : now;
}

export function executionPage(ctx: Ctx, d: Date): string {
  const month = ctx.months.get(ymOf(d)) || null;
  const f = ctx.files.get(ymOf(d));
  const title = `${DAY_LONG[dayIndex(d)]} ${d.getDate()} ${MONTH[d.getMonth()]}${d.getFullYear() !== ctx.today.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  const meta = [f && f.exists ? fileLink(f.path) : '', ctx.todoPath ? fileLink(ctx.todoPath) : ''];
  const body = month && month.days
    ? `<div class="pv-sec"><div class="pv-head">
        <button type="button" class="label" data-act="open-month" data-ym="${month.ym}" data-key="to-month" title="Open the month">${MONTH[d.getMonth()]}</button>
        <span class="pv-sum">${logSum(ctx, month)}</span></div>${heatmap(ctx, month, d)}</div>
      <div class="pv-day pv-sec">${dayList(ctx, month, d)}${tasksColumn(ctx, d)}</div>`
    : `${noMonth(ctx, d)}<div class="pv-day pv-sec"><section></section>${tasksColumn(ctx, d)}</div>`;
  return frame(ctx, { zoom: null, title, unit: 'day', meta, body, here: +d === +ctx.today });
}
