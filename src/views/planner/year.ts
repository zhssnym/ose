// Year: one year's page, from `YYYY.md` in the plannings folder. The intro and the goals (the
// same title section as a month), the twelve months as small boxes that open each one in the
// Month view, with its systems' completion when it has a file, and the yearly review.
// Read-only, but for one thing: a year with no file can be started, which creates the file
// (never over one).
//
//   <plannings>/YYYY.md (or `YYYY Yearly Plan.md`, or in <plannings>/YYYY/)   the year
//   <plannings>/YYYY-MM*.md                                                    its months
//   <plannings>/systems.jsonl                                                  the check log
//
// It opens on this year, or on the year `route.arg` names (`2026`, from the Month view).

import { esc, loadingLine, toast } from '../../ui/index.ts';
import { startOfDay } from '../shared/dates.ts';
import {
  listPlannings, monthTally, resolveLogPath, newYearText, parseMonthlyPlan, parseSystemsLog, parseYearlyPlan,
  percentages, pickMonth, pickYear, systemsFor, type PlanFile,
} from '../shared/plans.ts';
import { bindLinks, bindNav, detectedHtml, missingHtml, navHtml } from '../shared/nav.ts';
import { proseInto } from '../shared/prose.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');

/** `2026` -> 2026; anything else -> null. */
const yearOfArg = (arg) => (/^\d{4}$/.test(String(arg ?? '')) ? Number(arg) : null);

/**
 * The Year view.
 * @param store the planner settings store
 * @returns the view definition
 */
export function createYearView(ose: any, store: any): any {
  let live: { unmount(): void; refresh(): void; } | null = null;

  function mount(host, route) {
    let alive = true, seq = 0, busy = false;
    let year = yearOfArg(route && route.arg) || new Date().getFullYear();
    let file: PlanFile | null = null, plan: ReturnType<typeof parseYearlyPlan> | null = null;
    let months: Array<{ file: PlanFile; done: number | null; }> = [];
    const offs: any[] = [];
    const settings = () => store.get();

    host.innerHTML = `
<div class="view-root" tabindex="-1">
  <div class="page-col">
    <div class="v-head">
      <h1 class="page-title view-title" data-el="title">${year}</h1>
      ${navHtml('year')}
    </div>
    <div class="page-meta" data-el="meta">&nbsp;</div>
    <div data-el="detected"></div>
    <div class="label">Goals</div>
    <div class="mo-goals" data-el="goals"></div>
    <div class="label">Months</div>
    <div class="yr-months" data-el="months"></div>
    <div class="label">Review</div>
    <div class="mo-review view-prose" data-el="review"></div>
  </div>
</div>`;
    const root = host.querySelector('.view-root');
    const $ = (name) => host.querySelector(`[data-el="${name}"]`);

    function renderGoals() {
      const box = $('goals');
      if (!settings().reports) { box.innerHTML = missingHtml('reports'); return; }
      if (!file) { box.innerHTML = ''; return; }
      if (!plan) {
        box.innerHTML = `<div class="mo-start"><div class="empty">No file for ${year} at ${esc(file.path)}</div>
          <button type="button" class="btn sm" data-act="start">Start ${year}</button></div>`;
        return;
      }
      const cards = plan.sections.filter((s) => s.items.length);
      box.innerHTML = (plan.intro ? '<div class="mo-intro view-prose" data-el="intro"></div>' : '')
        + (cards.length ? cards.map((s) => `
        <div class="mo-card">
          <div class="label">${esc(s.label)}</div>
          <ul class="view-prose">${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        </div>`).join('') : (plan.intro ? '' : '<div class="empty">This plan has no goals</div>'));
      const intro = box.querySelector('[data-el="intro"]');
      if (intro) proseInto(intro, plan.intro, file.path);
    }

    function renderMonths() {
      const box = $('months');
      if (!settings().reports) { box.innerHTML = ''; return; }
      const now = new Date();
      box.innerHTML = MONTHS.map((name, i) => {
        const m = months[i];
        const has = !!m && m.file.exists;
        const isNow = now.getFullYear() === year && now.getMonth() === i;
        const pct = m && m.done !== null ? `${m.done}%` : '';
        const tip = has ? `${m.file.path}${pct ? ` · ${pct} of the systems done` : ''}` : 'No file yet';
        return `<button type="button" class="yr-m${has ? ' has' : ''}${isNow ? ' now' : ''}" data-month="${year}-${two(i + 1)}" title="${esc(tip)}">
          <span>${name}</span><span class="yr-m-p">${pct}</span></button>`;
      }).join('');
    }

    function renderReview() {
      const box = $('review');
      if (!settings().reports) { box.innerHTML = ''; return; }
      const text = plan && plan.review;
      if (text && file) proseInto(box, text, file.path);
      else box.innerHTML = plan ? '<div class="empty">Not written yet</div>' : '';
    }

    function render() {
      if (!alive) return;
      const s = settings();
      $('title').textContent = String(year);
      $('meta').innerHTML = [
        file && file.exists ? `<button type="button" class="v-link" data-path="${esc(file.path)}">${esc(file.path)}</button>` : '',
        s.reports ? `<span>${months.filter((m) => m.file.exists).length} of 12 months planned</span>` : '',
      ].filter(Boolean).join('') || '&nbsp;';
      $('detected').innerHTML = s.confirmed ? '' : detectedHtml();
      host.querySelector('[data-nav="today"]').hidden = year === new Date().getFullYear();
      renderGoals();
      renderMonths();
      renderReview();
    }

    async function load() {
      await store.ready;
      const my = ++seq;
      const at = year;
      const s = settings();
      if (!s.reports) { file = null; plan = null; months = []; render(); return; }
      const stops = ['goals', 'months', 'review'].map((n) => loadingLine($(n)));
      const stop = () => stops.forEach((f) => f());
      try {
        const listing = await listPlannings((f) => ose.files.list(f), s.reports, at);
        const yf = pickYear(listing);
        const mf = MONTHS.map((_, i) => pickMonth(listing, new Date(at, i, 1)));
        const log = await resolveLogPath((p) => ose.files.exists(p), s.reports);
        const [yearText, logText] = await Promise.all([
          yf.exists ? ose.files.read(yf.path) : '',
          (await ose.files.exists(log)) ? ose.files.read(log) : '',
        ]);
        // each planned month that has begun: its systems over its due days so far
        const parsedLog = parseSystemsLog(logText);
        const today = startOfDay(new Date());
        const done = await Promise.all(mf.map(async (f, i) => {
          const first = new Date(at, i, 1);
          if (!f.exists || first > today) return null;
          try {
            const sys = systemsFor(parseMonthlyPlan(await ose.files.read(f.path)), parsedLog, first);
            const t = monthTally(sys, first, parsedLog, today);
            return t.done + t.lost + t.open ? percentages(t).done : null;
          } catch { return null; }
        }));
        if (my !== seq || !alive) return;
        file = yf;
        plan = yf.exists ? parseYearlyPlan(yearText) : null;
        months = mf.map((f, i) => ({ file: f, done: done[i] ?? null }));
        stop();
        render();
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[planner] year', e);
        toast(`Year: ${(e && e.message) || e}`, 'err');
      } finally {
        stop();
      }
    }

    /**
     * Create the year's file (`newYearText`): the previous year's goal labels, then the review's
     * gap line. In the same layout as the previous year's file; flat when there is none.
     */
    async function start() {
      const dir = settings().reports;
      if (busy || !dir) return;
      busy = true;
      const at = year;
      try {
        const prev = pickYear(await listPlannings((f) => ose.files.list(f), dir, at - 1));
        const prevText = prev.exists ? await ose.files.read(prev.path) : null;
        const folder = prev.exists && !prev.flat ? `${dir}/${at}` : dir;
        await ose.fileops.create(folder, `${at}.md`, { text: newYearText(at, prevText) });
        toast(`Started ${at}`, 'info', 3000);
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        if (!(e && e.code === 'exists')) toast(`The year could not be started: ${(e && e.message) || e}`, 'err');
      } finally {
        busy = false;
        if (alive) load();
      }
    }

    function go(delta) {
      year = delta === 0 ? new Date().getFullYear() : year + delta;
      load();
    }

    function onClick(ev) {
      const t = ev.target.closest ? ev.target.closest('[data-act], [data-month]') : null;
      if (!t || !root.contains(t)) return;
      if (t.dataset.month) {
        const r = { type: 'view', name: 'planner', arg: `month:${t.dataset.month}` };
        if ((ev.ctrlKey || ev.metaKey) && ose.tabs && ose.tabs.open) ose.tabs.open(r, { reuse: false });
        else ose.route.navigate(r);
        return;
      }
      if (t.dataset.act === 'start') void start();
    }

    root.addEventListener('click', onClick);
    offs.push(() => root.removeEventListener('click', onClick));
    offs.push(bindNav(root, { prev: () => go(-1), next: () => go(1), today: () => go(0) }));
    offs.push(bindLinks(root, ose));
    offs.push(store.on(() => load()));
    offs.push(ose.watch((d) => {
      const r = settings().reports;
      const mine = (p) => !!p && !!r && (p === r || p.startsWith(`${r}/`));
      if (!d || d.lost || d.rescan || (d.changes || []).some((c) => c && (mine(c.path) || mine(c.to)))) load();
    }));
    root.focus({ preventScroll: true });
    load();

    const handle = {
      unmount() {
        alive = false;
        for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
        if (live === handle) live = null;
      },
      refresh() { if (alive) render(); },
    };
    live = handle;
    return handle;
  }

  return {
    title: 'Year',
    order: 35,
    icon: 'year',
    section: 'planner',
    mount: (el, route) => mount(el, route),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}
