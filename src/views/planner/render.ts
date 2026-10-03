// The planner's four pages as HTML: Day, Week, Month and Year. Pure but for `esc`: everything it
// draws comes from `Ctx`, which index.ts reads from the files. The look is docs/DESIGN.md's and
// views.css's `.pv` block: the big picture, not the minute. Every zoom is rows of cells across
// the page, terracotta for what was done; one figure per page says how far things are; times,
// places and counts beside lines are not shown, the rest is in tooltips.

import { esc } from '../../ui/index.ts';
import {
  addDays, allSystems, count, dateOf, dayIndex, dayShare, daysIn, hhmm, isOldMonth, linesFor, monthTally,
  nameOf, plannedSystems, stateOf, ymd, ymOf,
  type Area, type Month, type Review, type Year,
} from '../shared/plan.ts';

export type Zoom = 'year' | 'month' | 'week' | 'day';
export const ZOOMS: Array<[Zoom, string]> = [['year', 'Year'], ['month', 'Month'], ['week', 'Week'], ['day', 'Day']];

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
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const pct = (done: number, due: number) => (due ? Math.round((100 * done) / due) : 0);
const shortDate = (d: Date) => `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
const paras = (text: string) => String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/* ------------------------------------------------------------------ the frame */

const fileLink = (path: string) => `<button type="button" class="v-link" data-path="${esc(path)}">${esc(base(path))}</button>`;

function frame(ctx: Ctx, { zoom, title, unit, meta, body, here }: { zoom: Zoom; title: string; unit: string; meta: string[]; body: string; here: boolean; }): string {
  return `<div class="pn-zoom" role="group" aria-label="Zoom">${ZOOMS.map(([z, label]) =>
    `<button type="button" class="pn-zoom-b${z === zoom ? ' on' : ''}" data-act="zoom" data-zoom="${z}" aria-pressed="${z === zoom}">${label}</button>`).join('')}</div>
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

/** A section's head: its label, and at the right how far it is. `sum` is HTML. */
const head = (label: string, sum = '') => `<div class="pv-head"><span class="label">${esc(label)}</span><span class="pv-sum">${sum}</span></div>`;

/** "76% so far · September 57%": the one figure of a page, and the period before it. */
function farSum(now: { done: number; due: number; }, open: boolean, before: { done: number; due: number; } | null, beforeName: string): string {
  if (!now.due) return '';
  const a = `<b>${pct(now.done, now.due)}%</b>${open ? ' so far' : ''}`;
  return before && before.due ? `${a} · ${esc(beforeName)} ${pct(before.done, before.due)}%` : a;
}

/* ------------------------------------------------------------------ the cells */

type Col = { gap?: boolean; d?: Date; head?: string; today?: boolean; act?: string; title?: string; };
type Row = { label?: string; title?: string; cls?: string; cells: string[]; end?: string; };

/** The one component: rows of cells across the page. `names` false is a bare strip. */
function grid(cols: Col[], rows: Row[], { names = true, cls = '' } = {}): string {
  const tracks = cols.map((c) => (c.gap ? 'var(--sp-1)' : 'minmax(0, 1fr)')).join(' ');
  const tpl = names ? `var(--pv-margin) ${tracks} var(--pv-end)` : tracks;
  const line = (rowCls: string, label: string, cells: string[], end: string) => {
    let i = 0;
    const mid = cols.map((c) => (c.gap ? '<span></span>' : cells[i++] || '<span></span>')).join('');
    return `<div class="pv-gr ${rowCls}">${names ? label : ''}${mid}${names ? end : ''}</div>`;
  };
  const heads = cols.filter((c) => !c.gap);
  const headRow = heads.some((c) => c.head)
    ? line('is-heads', '<span></span>', heads.map((c) => {
      if (!c.head) return '<span></span>';
      const k = `pv-gh${c.today ? ' is-today' : ''}`;
      return c.act ? `<button type="button" class="${k}" ${c.act} title="${esc(c.title || '')}">${esc(c.head)}</button>` : `<span class="${k}">${esc(c.head)}</span>`;
    }), '<span></span>')
    : '';
  const body = rows.map((r) => line(
    r.cls || '',
    `<span class="pv-gl${r.cls === 'is-all' ? ' is-all' : ''}" title="${esc(r.title || r.label || '')}">${esc(r.label || '')}</span>`,
    r.cells,
    `<span class="pv-ge">${r.end || ''}</span>`,
  )).join('');
  return `<div class="pv-grid ${cls}" style="--pv-cols: ${tpl}">${headRow}${body}</div>`;
}

const SAID = { done: 'done', missed: 'not done', open: 'open', planned: 'to come', skipped: 'dropped that day', idle: 'before the month was started' };

/** A cell of one system on one day. A past day's or today's is a button that ticks it. */
function markCell(ctx: Ctx, month: Month | null, d: Date, sys: string, name: string): string {
  const st = month ? stateOf(month, d.getDate(), sys, ctx.today) : null;
  if (!st) return '<span class="pv-c"></span>';
  const tip = `${name} · ${DAY_SHORT[dayIndex(d)]} ${d.getDate()} · ${SAID[st]}`;
  if (d > ctx.today) return `<span class="pv-c is-${st}" title="${esc(tip)}"></span>`;
  const key = ymd(d);
  return `<button type="button" class="pv-c is-${st}" data-act="tick" data-day="${key}" data-sys="${esc(sys)}" data-key="tick:${key}:${esc(sys)}" aria-pressed="${st === 'done'}" aria-label="${esc(tip)}" title="${esc(tip)}"></button>`;
}

/** A cell of everything on one day, deeper with the share done. It opens the day. */
function dayCell(ctx: Ctx, d: Date, { here = false } = {}): string {
  const month = ctx.months.get(ymOf(d));
  const key = ymd(d);
  const open = `data-act="open-day" data-day="${key}" data-key="day:${key}"`;
  const label = `${DAY_SHORT[dayIndex(d)]} ${d.getDate()}`;
  const ring = here ? ' is-here' : '';
  if (!month || !month.days) return `<span class="pv-c${ring}"></span>`;
  const s = dayShare(month, d.getDate(), ctx.today);
  if (s.share === null) {
    const planned = plannedSystems(month, d).length > 0;
    return `<button type="button" class="pv-c${planned ? ' is-planned' : ''}${ring}" ${open} aria-label="${esc(label)}" title="${esc(label)}${s.when === 'idle' ? ' · before the month was started' : ''}"></button>`;
  }
  const row = month.days.rows.get(d.getDate());
  const tip = `${label} · ${s.done} of ${s.due}${row && row.note ? ` · ${row.note}` : ''}`;
  return `<button type="button" class="pv-c is-tint${ring}" style="--p:${Math.round(s.share * 100)}" ${open} aria-label="${esc(tip)}" title="${esc(tip)}"></button>`;
}

/** The days of a month as columns, with a small space before each Monday. */
function dayCols(ctx: Ctx, month: Month, heads: boolean): Col[] {
  const cols: Col[] = [];
  for (let day = 1; day <= daysIn(month.year, month.month); day++) {
    const d = dateOf(month, day), wd = dayIndex(d);
    if (wd === 0 && day > 1) cols.push({ gap: true });
    const isToday = +d === +ctx.today;
    cols.push({ d, head: heads && (day === 1 || wd === 0 || isToday) ? String(day) : '', today: isToday });
  }
  return cols;
}

const prevYm = (m: Month) => ymOf(new Date(m.year, m.month - 2, 1));

/** How far a month is, and the month before it when it kept its days. */
function monthSum(ctx: Ctx, month: Month): string {
  const prev = ctx.months.get(prevYm(month));
  const before = prev && prev.days ? monthTally(prev, ctx.today) : null;
  return farSum(monthTally(month, ctx.today), month.ym === ymOf(ctx.today), before, prev ? (MONTH[prev.month - 1] ?? '') : '');
}

/** Done over due across any run of dates, whatever months they fall in. */
function countDates(ctx: Ctx, dates: Date[]) {
  const t = { done: 0, due: 0 };
  for (const d of dates) {
    const m = ctx.months.get(ymOf(d));
    if (!m || !m.days) continue;
    const c = count(m, ctx.today, { days: [d.getDate()] });
    t.done += c.done; t.due += c.due;
  }
  return t;
}

/** A month with no file, or one kept before the planner had days: one quiet line. */
function noMonth(ctx: Ctx, d: Date): string {
  const ym = ymOf(d), name = `${MONTH[d.getMonth()]} ${d.getFullYear()}`;
  const m = ctx.months.get(ym), f = ctx.files.get(ym);
  if (m && isOldMonth(m) && f) return `<div class="pl-quiet">${esc(name)} was kept before the planner had days: its goals and its review are in <button type="button" class="v-link" data-path="${esc(f.path)}">${esc(base(f.path))}</button>.</div>`;
  if (m && !m.days && f) return `<div class="pl-quiet">${esc(name)} has no <span class="mono-sm"># Days</span> table yet in <button type="button" class="v-link" data-path="${esc(f.path)}">${esc(base(f.path))}</button>.</div>`;
  return `<div class="pl-quiet">${esc(name)} has no file yet. <button type="button" class="v-link" data-act="start-month" data-ym="${ym}" data-key="start:${ym}">Start it</button> from the last month.</div>`;
}

/* ------------------------------------------------------------------ day */

/** The things of a day: one per system, in the order of the day; times and places go to the tooltip. */
function thingsOf(month: Month, d: Date) {
  const out: Array<{ system: string | null; name: string; tip: string[]; }> = [];
  for (const l of linesFor(month, d)) {
    const at = l.start !== null && l.end !== null ? `${hhmm(l.start)} to ${hhmm(l.end)}${l.where ? ` · ${l.where}` : ''}` : (l.where || '');
    const seen = l.system ? out.find((x) => x.system === l.system) : null;
    if (seen) { if (at) seen.tip.push(at); continue; }
    out.push({ system: l.system, name: l.name, tip: at ? [at] : [] });
  }
  const row = month.days ? month.days.rows.get(d.getDate()) : null;
  for (const s of row ? Object.keys(row.marks) : []) {
    if (row && row.marks[s] === 'x' && !out.some((x) => x.system === s)) out.push({ system: s, name: nameOf(month, s), tip: [] });
  }
  return out;
}

function dayColumn(ctx: Ctx, month: Month, d: Date): string {
  const future = d > ctx.today, key = ymd(d);
  let done = 0, due = 0;
  const rows = thingsOf(month, d).map((t) => {
    const tip = esc(t.tip.join(', '));
    if (!t.system) return `<div class="pv-item is-plain" title="${tip}"><span></span><span class="pv-what">${esc(t.name)}</span></div>`;
    const st = stateOf(month, d.getDate(), t.system, ctx.today);
    if (st === 'done') { done++; due++; } else if (st !== 'skipped') due++;
    const box = st === 'done' ? ' on' : st === 'skipped' ? ' skip' : '';
    const inner = `<span class="check${box}"></span><span class="pv-what">${esc(t.name)}</span>`;
    return future
      ? `<div class="pv-item" title="${tip}">${inner}</div>`
      : `<button type="button" class="pv-item is-${st}" data-act="tick" data-day="${key}" data-sys="${esc(t.system)}" data-key="tick:${key}:${esc(t.system)}" aria-pressed="${st === 'done'}" title="${tip}">${inner}</button>`;
  }).join('');
  const sum = !due ? '' : future ? `${due} planned` : `${done} of ${due}`;
  return `<section>${head(+d === +ctx.today ? 'Today' : (DAY_LONG[dayIndex(d)] ?? ''), sum)}
    ${rows || '<div class="pv-empty">Nothing planned on this day</div>'}</section>`;
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
    return `<div class="pv-item${t.done ? ' is-struck' : ''}" style="padding-left: calc(${depth} * var(--sp-5))" title="${esc(`${base(t.path)}:${t.line + 1}`)}">
      <button type="button" class="pv-box" data-act="task" data-id="${esc(t.id)}" data-key="task:${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}"><span class="check${t.done ? ' on' : ''}"></span></button>
      <span class="pv-what">${esc(t.text)}</span>${late ? `<span class="pv-late" title="Due ${esc(when(t))}">late</span>` : ''}</div>`;
  };
  return `<section>${head('Tasks')}
    ${[...open, ...closed].map(rowOf).join('') || '<div class="pv-empty">Nothing due, nothing late</div>'}
    <input type="text" class="pv-field" data-act="add" data-key="add" autocomplete="off" spellcheck="false" aria-label="New task" placeholder="New task">
  </section>`;
}

export function dayPage(ctx: Ctx, d: Date): string {
  const month = ctx.months.get(ymOf(d)) || null;
  const f = ctx.files.get(ymOf(d));
  const title = `${DAY_LONG[dayIndex(d)]} ${d.getDate()} ${MONTH[d.getMonth()]}${d.getFullYear() !== ctx.today.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  const meta = [f && f.exists ? fileLink(f.path) : '', ctx.todoPath ? fileLink(ctx.todoPath) : ''];
  let body: string;
  if (!month || !month.days) body = `${noMonth(ctx, d)}<div class="pv-day pv-sec"><section></section>${tasksColumn(ctx, d)}</div>`;
  else {
    // the month so far, one cell a day: where this day sits in it, and how the others went
    const cols = dayCols(ctx, month, false);
    const strip = grid(cols, [{ cells: cols.filter((c) => !c.gap).map((c) => dayCell(ctx, c.d as Date, { here: +(c.d as Date) === +d })) }], { names: false, cls: 'pv-strip' });
    const row = month.days.rows.get(d.getDate());
    body = `${row && row.note ? `<p class="pv-what pv-daynote">${esc(row.note)}</p>` : ''}
      <div class="pv-sec"><div class="pv-head">
        <button type="button" class="label" data-act="zoom" data-zoom="month" data-key="to-month" title="Open the month">${MONTH[d.getMonth()]}</button>
        <span class="pv-sum">${monthSum(ctx, month)}</span></div>${strip}</div>
      <div class="pv-day pv-sec">${dayColumn(ctx, month, d)}${tasksColumn(ctx, d)}</div>`;
  }
  return frame(ctx, { zoom: 'day', title, unit: 'day', meta, body, here: +d === +ctx.today });
}

/* ------------------------------------------------------------------ week */

export function weekPage(ctx: Ctx, date: Date): string {
  const monday = addDays(date, -dayIndex(date));
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
  const files = [...new Set(days.map((d) => ymOf(d)))].map((ym) => ctx.files.get(ym)).filter((f) => f && f.exists) as Array<{ path: string; }>;
  const cols: Col[] = days.map((d) => ({
    d, head: `${DAY_SHORT[dayIndex(d)]} ${d.getDate()}`, today: +d === +ctx.today,
    act: `data-act="open-day" data-day="${ymd(d)}" data-key="wday:${ymd(d)}"`, title: 'Open this day',
  }));
  // the systems the week has anything for, in the order their months keep them
  const systems: string[] = [];
  for (const m of new Set(days.map((d) => ctx.months.get(ymOf(d))).filter(Boolean) as Month[])) {
    for (const s of allSystems(m)) {
      if (!systems.includes(s) && days.some((d) => ctx.months.get(ymOf(d)) === m && stateOf(m, d.getDate(), s, ctx.today))) systems.push(s);
    }
  }
  const last = ctx.months.get(ymOf(days[6] as Date)) || ctx.months.get(ymOf(days[0] as Date)) || null;
  const rows: Row[] = [
    { cls: 'is-all', label: 'All', cells: days.map((d) => dayCell(ctx, d)) },
    ...systems.map((s) => {
      const name = nameOf(last, s);
      return { label: name, cells: days.map((d) => markCell(ctx, ctx.months.get(ymOf(d)) || null, d, s, name)) };
    }),
  ];
  const here = +monday === +addDays(ctx.today, -dayIndex(ctx.today));
  const sum = farSum(countDates(ctx, days), here, countDates(ctx, days.map((d) => addDays(d, -7))), 'last week');
  const body = systems.length
    ? `<div class="pv-sec">${head('Days', sum)}${grid(cols, rows)}</div>`
    : (ctx.months.get(ymOf(monday)) ? '<div class="pv-empty">Nothing planned this week</div>' : noMonth(ctx, monday));
  const meta = [...files.map((f) => fileLink(f.path)), `<span>${esc(shortDate(monday))} to ${esc(shortDate(days[6] as Date))}</span>`];
  return frame(ctx, { zoom: 'week', title: `Week of ${monday.getDate()} ${MONTH[monday.getMonth()]}`, unit: 'week', meta, body, here });
}

/* ------------------------------------------------------------------ goals and review */

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

/** The goals with a box, and how many are ticked. */
const goalsMet = (areas: Area[]) => {
  const boxed = areas.flatMap((a) => a.goals).filter((g) => g.box);
  return { met: boxed.filter((g) => g.box === 'done').length, of: boxed.length };
};
const goalsSum = (areas: Area[]) => {
  const g = goalsMet(areas);
  return g.of ? `<b>${pct(g.met, g.of)}%</b> · ${g.met} of ${g.of} met` : '';
};

/** The review, set like the goals: each area in the margin with its grade, its words beside it. */
function reviewHtml(review: Review): string {
  if (!review.written) return '<div class="pv-empty">Not written yet</div>';
  const blocks: Array<{ label: string; grade: string; text: string[]; }> = [];
  let cur = { label: '', grade: '', text: [] as string[] };
  for (const p of paras(review.text)) {
    const line = p.replace(/^\*\*|\*\*$/g, '');
    if (!/\s/.test(line) && /^[\p{L}]/u.test(line)) { cur = { label: line, grade: '', text: [] }; blocks.push(cur); continue; }
    const g = /^(?:grade|overall)\s*:\s*(.+)$/i.exec(line);
    if (g) { cur.grade = (g[1] ?? '').trim(); continue; }
    if (!blocks.includes(cur)) blocks.push(cur);
    cur.text.push(p);
  }
  return blocks.map((b) => `<div class="pv-area pv-review">
    <div class="pv-area-name pv-what">${esc(b.label)}${b.grade ? `<span class="pv-area-grade">${esc(b.grade)}</span>` : ''}</div>
    <div class="pv-prose" data-prose="${esc(b.text.join('\n\n'))}"></div>
  </div>`).join('');
}

/** The intro of a month or a year: filled with the document renderer by index.ts. */
const intro = (text: string) => (text ? `<div class="pv-prose pv-intro" data-prose="${esc(text)}"></div>` : '');

/* ------------------------------------------------------------------ month */

export function monthPage(ctx: Ctx, date: Date): string {
  const ym = ymOf(date), month = ctx.months.get(ym) || null, f = ctx.files.get(ym);
  const title = `${MONTH[date.getMonth()]} ${date.getFullYear()}`;
  const here = ym === ymOf(ctx.today);
  const meta = [f && f.exists ? fileLink(f.path) : '', `<button type="button" class="v-link" data-act="zoom" data-zoom="year" data-key="to-year">${date.getFullYear()}</button>`];
  if (!month || isOldMonth(month)) return frame(ctx, { zoom: 'month', title, unit: 'month', meta, body: noMonth(ctx, date), here });
  let days = '<div class="pv-empty">No days table in this file</div>';
  if (month.days) {
    const cols = dayCols(ctx, month, true);
    const real = cols.filter((c) => !c.gap);
    const rows: Row[] = [
      { cls: 'is-all', label: 'All', cells: real.map((c) => dayCell(ctx, c.d as Date)) },
      ...allSystems(month).map((s) => {
        const name = nameOf(month, s);
        const c = count(month, ctx.today, { systems: [s] });
        return { label: name, cells: real.map((col) => markCell(ctx, month, col.d as Date, s, name)), end: c.due ? `${pct(c.done, c.due)}%` : '' };
      }),
    ];
    days = grid(cols, rows);
  }
  const path = f ? f.path : '';
  const body = `${intro(month.intro)}
    <div class="pv-sec">${head('Goals', goalsSum(month.goals))}${goalsHtml(month.goals, path)}</div>
    <div class="pv-sec">${head('Days', month.days ? monthSum(ctx, month) : '')}${days}</div>
    <div class="pv-sec">${head('Review', month.review.overall !== null ? `${month.review.overall}/10` : '')}${reviewHtml(month.review)}</div>`;
  return frame(ctx, { zoom: 'month', title, unit: 'month', meta, body, here });
}

/* ------------------------------------------------------------------ year */

export function yearPage(ctx: Ctx, y: number): string {
  // the year is its own file: what it is for, its checklist and how much of it is met, its
  // review. Nothing here is computed from the months.
  const here = y === ctx.today.getFullYear();
  const yf = ctx.year;
  const plan = yf ? yf.plan : null;
  const body = !yf ? '' : plan
    ? `${intro(plan.intro)}
      <div class="pv-sec">${head('Goals', goalsSum(plan.goals))}${goalsHtml(plan.goals, yf.path)}</div>
      <div class="pv-sec">${head('Review', plan.review.overall !== null ? `${plan.review.overall}/10` : '')}${reviewHtml(plan.review)}</div>`
    : `<div class="pl-quiet">${y} has no file yet. <button type="button" class="v-link" data-act="start-year" data-key="start-year">Start it</button>.</div>`;
  return frame(ctx, { zoom: 'year', title: String(y), unit: 'year', meta: [yf && yf.exists ? fileLink(yf.path) : ''], body, here });
}
