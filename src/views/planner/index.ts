// Execution and Planner over the planner folder. Planner is Year · Month: a file's goals, how many
// are ticked, its review. Execution is the month as it is lived: its log as a heatmap with what
// each item has lost, the day's list to tick, the todo list. The pages are drawn by render.ts from the files read here; the format is
// plan.ts and docs/FORMATS.md "The planner".
//
// `route.arg` says where to land: Planner takes `year:2026` or `month:2026-10`, Execution a
// day, `2026-10-15`. With none, Planner opens the zoom last used, and Execution today.
//
// Writes, one line each, never a whole file:
//   - a mark of a day replaces that day's row of the month's `# Days` (`replaceLine`, only if the
//     row still reads what was on screen; a refused write reads the file again and tries once);
//   - a goal ticked replaces its line;
//   - a task ticked or added goes through shared/todo.ts, as before;
//   - "Start it" on a month or a year with no file creates it, never over one.

import { loadingLine, toast } from '../../ui/index.ts';
import {
  addDays, isOldMonth, newMonthText, newYearText, parseMonth, parseYear, plannedSystems, startOfDay,
  stateOf, two, writeGoal, writeMark, ymOf, type Mark, type Month, type Write,
} from '../shared/plan.ts';
import { listPlannings, pickMonth, pickYear, planDir, previousMonthFile } from '../shared/plans.ts';
import { parseYmd } from '../shared/dates.ts';
import { taskDepth } from '../shared/tasks.ts';
import { createTodoIndex } from '../shared/todo.ts';
import { bindLinks, bindNav, detectedHtml, missingHtml } from '../shared/nav.ts';
import { proseInto } from '../shared/prose.ts';
import { executionPage, monthPage, yearPage, type Ctx, type Zoom } from './render.ts';

/** What a mounted planner shows: a zoom of Planner, or Today. */
type Mode = Zoom | 'today';
const isZoom = (z: unknown): z is Zoom => z === 'year' || z === 'month';

/** `month:2026-10` -> ['month', date]; a bare `2026-10-15` -> ['today', date]. */
function parseArg(arg: unknown): [Mode | null, Date | null] {
  const s = String(arg ?? '');
  const bare = parseYmd(s);
  if (bare && /^\d{4}-\d{2}-\d{2}$/.test(s)) return ['today', bare];
  const m = /^(year|month|week|day):(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) return [null, null];
  // an older link to a week or a day opens its month
  return [m[1] === 'year' ? 'year' : 'month', new Date(Number(m[2]), Number(m[3] || 1) - 1, Number(m[4] || 1))];
}

/** The months a page needs: Today its month and the one before (to compare), Month its own, Year none. */
function monthsFor(mode: Mode, d: Date): string[] {
  if (mode === 'year') return [];
  if (mode === 'month') return [ymOf(d)];
  return [ymOf(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymOf(d)];
}

/**
 * Mount the planner into `host`.
 * @param opts.today true for the Today view: it stays on the Day zoom, and another zoom opens Planner
 */
function mountPlanner(ose: any, store: any, host: HTMLElement, route: any, opts: { today: boolean; memory: any; }) {
  const todo = createTodoIndex(ose);
  const [askedZoom, askedDate] = parseArg(route && route.arg);
  let remembered: unknown = null;
  try { remembered = opts.memory?.get(); } catch { remembered = null; }
  const st = {
    zoom: (opts.today ? 'today' : (isZoom(askedZoom) ? askedZoom : (isZoom(remembered) ? remembered : 'month'))) as Mode,
    date: startOfDay(askedDate || new Date()),
    seq: 0, busy: false,
  };
  const ctx: Ctx = { today: startOfDay(new Date()), folder: null, months: new Map(), files: new Map(), year: null, tasks: [], todoPath: null, note: '' };
  const texts = new Map<string, string>();      // by path: the text each page was drawn from
  let alive = true, loaded = false;
  const offs: Array<() => void> = [];

  host.innerHTML = '<div class="view-root" tabindex="-1"><div class="page-col pv" data-el="page"></div></div>';
  const root = host.querySelector('.view-root') as HTMLElement;
  const pageEl = host.querySelector('[data-el="page"]') as HTMLElement;
  const settings = () => store.get();

  /* -------------------------------------------------------------- reading */

  async function load() {
    await store.ready;
    const my = ++st.seq;
    const s = settings();
    const folder = s.reports || null;
    ctx.today = startOfDay(new Date());
    ctx.folder = folder;
    ctx.todoPath = s.todo[0] || null;
    if (!folder) { draw(); return; }
    const stop = loaded ? () => false : loadingLine(pageEl);
    try {
      const list = (f: string) => ose.files.list(f);
      const wanted = monthsFor(st.zoom, st.date);
      const years = [...new Set(wanted.map((ym) => Number(ym.slice(0, 4))))];
      if (st.zoom === 'year') years.push(st.date.getFullYear());
      const listings = new Map<number, any>();
      await Promise.all([...new Set(years)].map(async (y) => listings.set(y, await listPlannings(list, folder, y))));
      const files = new Map<string, { path: string; exists: boolean; }>();
      for (const ym of wanted) {
        const f = pickMonth(listings.get(Number(ym.slice(0, 4))), new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1));
        files.set(ym, { path: f.path, exists: f.exists });
      }
      const yf = st.zoom === 'year' ? pickYear(listings.get(st.date.getFullYear())) : null;
      const read = async (p: string) => { const t = await ose.files.read(p); texts.set(p, t); return t; };
      const months = new Map<string, Month>();
      await Promise.all([...files].map(async ([ym, f]) => { if (f.exists) months.set(ym, parseMonth(await read(f.path), ym)); }));
      const yearText = yf && yf.exists ? await read(yf.path) : null;
      todo.setPaths(s.todo);
      const todoFiles = await todo.load();
      if (my !== st.seq || !alive) return;
      ctx.months = months;
      ctx.files = files;
      ctx.year = yf ? { path: yf.path, exists: yf.exists, plan: yearText !== null ? parseYear(yearText, st.date.getFullYear()) : null } : null;
      ctx.tasks = todoFiles.flatMap((f) => f.tasks.map((t) => ({ ...t, depth: taskDepth(t) })));
      loaded = true;
      stop();
      draw();
    } catch (err) {
      const e = err as { message?: string };
      console.error('[planner] load', e);
      stop();
      if (alive) toast(`Planner: ${(e && e.message) || e}`, 'err');
    }
  }

  /* -------------------------------------------------------------- drawing */

  function draw() {
    if (!alive) return;
    // a redraw keeps the focused control focused, and the place on the page
    const act = document.activeElement as HTMLElement | null;
    const key = act && pageEl.contains(act) ? act.dataset.key : null;
    const draft = (pageEl.querySelector('[data-act="add"]') as HTMLInputElement | null)?.value || '';
    const s = settings();
    if (!ctx.folder) {
      pageEl.innerHTML = `<h1 class="page-title view-title">${opts.today ? 'Today' : 'Planner'}</h1>${missingHtml('reports')}`;
      return;
    }
    const html = st.zoom === 'today' ? executionPage(ctx, st.date)
      : st.zoom === 'month' ? monthPage(ctx, st.date)
      : yearPage(ctx, st.date.getFullYear());
    pageEl.innerHTML = (s.confirmed ? '' : detectedHtml()) + html;
    const add = pageEl.querySelector('[data-act="add"]') as HTMLInputElement | null;
    if (add && draft) add.value = draft;
    // the user's own prose: the intro and the review, drawn as documents
    const base = st.zoom === 'year' ? (ctx.year?.path || '') : (ctx.files.get(ymOf(st.date))?.path || '');
    for (const el of pageEl.querySelectorAll<HTMLElement>('[data-prose]')) proseInto(el, el.dataset.prose || '', base);
    const again = key ? pageEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
    if (again) again.focus({ preventScroll: true });
  }

  function go(zoom: Mode, date: Date | null) {
    const d = date || st.date;
    // Today is a day, the zooms are Planner's: crossing over is a navigation
    if (opts.today && zoom !== 'today') { ose.route.navigate({ type: 'view', name: 'planner', arg: zoom === 'year' ? `year:${d.getFullYear()}` : `month:${ymOf(d)}` }); return; }
    if (!opts.today && zoom === 'today') { ose.route.navigate({ type: 'view', name: 'execution', arg: `${ymOf(d)}-${two(d.getDate())}` }); return; }
    st.zoom = zoom;
    if (date) st.date = startOfDay(date);
    if (!opts.today) { try { opts.memory?.set(zoom); } catch { /* remembered or not, the page shows */ } }
    root.scrollIntoView?.({ block: 'start' });
    load();
  }

  function nav(dir: 'prev' | 'next' | 'today') {
    const d = st.date;
    if (dir === 'today') st.date = startOfDay(new Date());
    else {
      const k = dir === 'next' ? 1 : -1;
      if (st.zoom === 'today') st.date = addDays(d, k);
      else if (st.zoom === 'month') st.date = new Date(d.getFullYear(), d.getMonth() + k, 1);
      else st.date = new Date(d.getFullYear() + k, 0, 1);
    }
    load();
  }

  /* -------------------------------------------------------------- writing */

  /** One line of one file, only if it still reads what was on screen. -> true when written. */
  async function replace(path: string, w: Write | null): Promise<boolean> {
    if (!w) return false;
    const r = await ose.files.replaceLine(path, w.line, w.expected, w.next);
    return !!r && r.status === 'replaced';
  }

  /** A mark on a day: done and back, or (with `skip`) dropped for the day and back. */
  async function tick(dayYmd: string, sys: string, skip: boolean) {
    const d = parseYmd(dayYmd);
    if (!d || d > ctx.today || st.busy) return;
    const ym = ymOf(d), f = ctx.files.get(ym);
    if (!f || !f.exists) return;
    st.busy = true;
    try {
      const attempt = (m: Month) => {
        const s = stateOf(m, d.getDate(), sys, ctx.today);
        const back: Mark = plannedSystems(m, d).includes(sys) ? '.' : '';
        const mark: Mark = skip ? (s === 'skipped' ? back : '-') : (s === 'done' ? back : 'x');
        return writeMark(m, d.getDate(), sys, mark);
      };
      const month = ctx.months.get(ym);
      if (!month) return;
      const first = attempt(month);
      if (!first) { ctx.note = `No row for the ${d.getDate()}th, or no column for ${sys}, in ${f.path}.`; draw(); return; }
      let ok = await replace(f.path, first);
      if (!ok) {
        // the file changed under the page: read it again, find the day's row by its number, try once more
        const fresh = parseMonth(await ose.files.read(f.path), ym);
        ok = await replace(f.path, attempt(fresh));
        if (!ok) toast(`${f.path} changed; the mark was not written. Read again.`, 'warn');
      }
      ctx.note = '';
    } catch (err) {
      const e = err as { message?: string };
      console.error('[planner] mark', e);
      toast(`The mark was not written: ${(e && e.message) || e}`, 'err');
    } finally {
      st.busy = false;
      await load();
    }
  }

  async function goal(path: string, line: number) {
    if (st.busy) return;
    const areas = path === ctx.year?.path ? (ctx.year.plan?.goals || []) : ([...ctx.months.values()].find((m) => ctx.files.get(m.ym)?.path === path)?.goals || []);
    const g = areas.flatMap((a) => a.goals).find((x) => x.line === line);
    if (!g) return;
    st.busy = true;
    try {
      if (!(await replace(path, writeGoal(g)))) toast(`${path} changed; read again.`, 'warn');
    } catch (err) {
      const e = err as { message?: string };
      toast(`The goal was not written: ${(e && e.message) || e}`, 'err');
    } finally {
      st.busy = false;
      await load();
    }
  }

  async function toggleTask(id: string) {
    if (st.busy) return;
    st.busy = true;
    try {
      const t = ctx.tasks.find((x) => x.id === id) || null;
      const r = await todo.toggle(t);
      if (r === 'changed') toast('The todo file changed; reloaded.', 'info', 3000);
    } catch (err) {
      const e = err as { message?: string };
      toast(`The task was not written: ${(e && e.message) || e}`, 'err');
    } finally {
      st.busy = false;
      await load();
    }
  }

  async function addTask(input: HTMLInputElement) {
    const text = input.value.trim();
    const target = ctx.todoPath;
    if (!text || !target || st.busy) return;
    st.busy = true;
    input.value = '';
    try {
      let r = await todo.add(target, text);
      if (r === 'missing') {
        // the planner folder has no todo.md yet: the first task makes it, never over a file
        const cut = target.lastIndexOf('/');
        try { await ose.fileops.create(cut < 0 ? '' : target.slice(0, cut), target.slice(cut + 1), { text: '# Todo\n\n' }); } catch { /* there after all */ }
        r = await todo.add(target, text);
      }
      if (r === 'missing') { input.value = text; toast(`Nothing to add to at ${target}`, 'warn'); }
    } catch (err) {
      const e = err as { message?: string };
      input.value = text;
      toast(`The task was not written: ${(e && e.message) || e}`, 'err');
    } finally {
      st.busy = false;
      await load();
      (pageEl.querySelector('[data-act="add"]') as HTMLElement | null)?.focus({ preventScroll: true });
    }
  }

  /** Create a month from the last one that has a file, in the same layout. Never over a file. */
  async function startMonth(ym: string) {
    const folder = ctx.folder;
    if (!folder || st.busy) return;
    st.busy = true;
    const at = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1);
    const list = (f: string) => ose.files.list(f);
    try {
      const prev = await previousMonthFile(list, at, folder);
      const prevText = prev ? await ose.files.read(prev.path) : null;
      const prevYm = prev ? (/(\d{4}-\d{2})/.exec(prev.path.slice(prev.path.lastIndexOf('/') + 1)) || [])[1] || '' : '';
      const usable = prev && prevText !== null && !isOldMonth(parseMonth(prevText, prevYm)) ? { text: prevText, ym: prevYm } : null;
      const flat = prev ? prev.flat : pickMonth(await listPlannings(list, folder, at.getFullYear()), at).flat;
      await ose.fileops.create(flat ? folder : planDir(at, folder), `${ym}.md`, { text: newMonthText(at.getFullYear(), at.getMonth() + 1, usable) });
      toast(usable ? `Started ${ym} from ${prevYm}` : `Started ${ym}`, 'info', 3000);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (!(e && e.code === 'exists')) toast(`The month could not be started: ${(e && e.message) || e}`, 'err');
    } finally {
      st.busy = false;
      await load();
    }
  }

  async function startYear() {
    const folder = ctx.folder;
    if (!folder || st.busy) return;
    st.busy = true;
    const y = st.date.getFullYear();
    try {
      const prev = pickYear(await listPlannings((f: string) => ose.files.list(f), folder, y - 1));
      const prevText = prev.exists ? await ose.files.read(prev.path) : null;
      await ose.fileops.create(prev.exists && !prev.flat ? `${folder}/${y}` : folder, `${y}.md`, { text: newYearText(y, prevText) });
      toast(`Started ${y}`, 'info', 3000);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (!(e && e.code === 'exists')) toast(`The year could not be started: ${(e && e.message) || e}`, 'err');
    } finally {
      st.busy = false;
      await load();
    }
  }

  /* -------------------------------------------------------------- events */

  function onClick(ev: MouseEvent) {
    const el = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-act]') : null;
    if (!el || !root.contains(el)) return;
    const a = el.dataset.act;
    if (a === 'zoom' && isZoom(el.dataset.zoom)) go(el.dataset.zoom, null);
    else if (a === 'tick') void tick(el.dataset.day || '', el.dataset.sys || '', ev.shiftKey);
    else if (a === 'task') void toggleTask(el.dataset.id || '');
    else if (a === 'goal') void goal(el.dataset.path || '', Number(el.dataset.line));
    else if (a === 'open-day') go('today', parseYmd(el.dataset.day));
    else if (a === 'open-month') go('month', parseYmd(`${el.dataset.ym}-01`));
    else if (a === 'start-month') void startMonth(el.dataset.ym || '');
    else if (a === 'start-year') void startYear();
  }

  function onKey(ev: KeyboardEvent) {
    const t = ev.target as HTMLElement;
    if (t instanceof HTMLInputElement) {
      if (ev.key === 'Enter' && t.dataset.act === 'add') { ev.preventDefault(); void addTask(t); }
      else if (ev.key === 'Escape' && t.value) { ev.preventDefault(); ev.stopPropagation(); t.value = ''; }
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key;
    const zoomKeys: Record<string, Mode> = { y: 'year', m: 'month', d: 'today' };
    if (zoomKeys[k]) { ev.preventDefault(); go(zoomKeys[k] as Mode, null); }
    else if (k === 's' && t.dataset && t.dataset.act === 'tick') { ev.preventDefault(); void tick(t.dataset.day || '', t.dataset.sys || '', true); }
    else if (k === 'ArrowDown' || k === 'ArrowUp') {
      // the rows of the page are one list to the arrows
      const stops = [...pageEl.querySelectorAll<HTMLElement>('[data-key]')];
      if (!stops.length) return;
      const i = stops.indexOf(document.activeElement as HTMLElement);
      const next = stops[k === 'ArrowDown' ? Math.min(stops.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)];
      if (next) { ev.preventDefault(); next.focus(); }
    }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  offs.push(() => root.removeEventListener('click', onClick));
  offs.push(() => root.removeEventListener('keydown', onKey));
  offs.push(bindNav(root, { prev: () => nav('prev'), next: () => nav('next'), today: () => nav('today') }));
  offs.push(bindLinks(root, ose));
  offs.push(store.on(() => load()));
  // a file under the planner folder changed on disk, by the editor, an agent or a sync: read again
  offs.push(ose.watch((d: any) => {
    const s = settings();
    const mine = (p: string) => !!p && ((!!s.reports && (p === s.reports || p.startsWith(`${s.reports}/`))) || todo.touches(p));
    if (!d || d.lost || d.rescan || (d.changes || []).some((c: any) => c && (mine(c.path) || mine(c.to)))) { todo.markStale(); load(); }
  }));
  // left open past midnight: a page on today moves to the new today
  let lastDay = startOfDay(new Date());
  const timer = setInterval(() => {
    const now = startOfDay(new Date());
    if (+now === +lastDay) return;
    if (+st.date === +lastDay || (st.zoom !== 'today' && ymOf(st.date) === ymOf(lastDay))) st.date = now;
    lastDay = now;
    load();
  }, 60000);
  offs.push(() => clearInterval(timer));
  root.focus({ preventScroll: true });
  load();

  return {
    unmount() {
      alive = false;
      for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
    },
    // the router calls this on any change in the vault; the files read here are the watch's business
    refresh() { if (alive) draw(); },
  };
}

/** A view of the planner: Execution, or Planner. */
function planView(ose: any, store: any, which: 'today' | 'planner') {
  let live: { unmount(): void; refresh(): void; } | null = null;
  const memory = () => { try { return ose.local('views.planner'); } catch { return null; } };
  return {
    title: which === 'today' ? 'Execution' : 'Planner',
    order: which === 'today' ? 10 : 20,
    icon: which === 'today' ? 'day' : 'month',
    section: 'planner',
    mount(el: HTMLElement, route: any) {
      live?.unmount();
      const h = mountPlanner(ose, store, el, route, { today: which === 'today', memory: memory() });
      live = { unmount() { h.unmount(); if (live === this) live = null; }, refresh: h.refresh };
      return live;
    },
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}

export const createPlannerView = (ose: any, store: any): any => planView(ose, store, 'planner');
export const createExecutionView = (ose: any, store: any): any => planView(ose, store, 'today');
