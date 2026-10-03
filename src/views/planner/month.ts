// Month: one month's page, from its file in the plannings folder. The intro and the goals, the
// systems matrix with the loss each system has taken and one summary line under it, the month's
// timetable as a small week (folded by default), and the review. Read-only, but for one thing:
// a month with no file can be started, which creates the file (never over one).
//
//   <plannings>/YYYY-MM*.md     intro, goals, `# Systems`, `# Timetable`, `# Monthly Review`
//                               (or in <plannings>/YYYY/; flat wins)
//   <plannings>/systems.jsonl   the check log
//
// It opens on this month (M32), or on the month `route.arg` names (`2026-09`, from the Year
// view), and follows the date into the next one when it was on it. A day before a system's
// first record in the log is not a loss, and a system nobody has checked yet has lost nothing
// (L16): the verdict is `dayVerdict` in plans.ts, the same one the tests read.

import { esc, icon, loadingLine, toast } from '../../ui/index.ts';
import {
  addMonths, blockApplies, DAY_SHORT, ddmm, hhmm, isSameDay, monthDays, monthTitle, startOfDay, startOfMonth, ym, ymd,
} from '../shared/dates.ts';
import {
  blockRows, dayVerdict, listPlannings, resolveLogPath, newMonthText, parseMonthlyPlan, parseSystemsLog, percentages,
  pickMonth, planDir, previousMonthFile, resolvePlanPath, systemsFor,
} from '../shared/plans.ts';
import { parseTimetable, timetableSection, type TimetableEvent } from '../shared/timetable.ts';
import { bindLinks, bindNav, detectedHtml, missingHtml, navHtml } from '../shared/nav.ts';
import { proseInto } from '../shared/prose.ts';
import { q1Of } from '../shared/settings.ts';

/** `12 done · 2 lost · 16 open`. */
const tallyText = (t) => `${t.done} done · ${t.lost} lost · ${t.open} open`;

/** `2026-09` -> the 1st of that month; anything else -> null. */
function monthOfArg(arg) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(arg ?? ''));
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? new Date(Number(m[1]), month - 1, 1) : null;
}

/** The fold of the timetable, per machine and per vault. */
const TT_KEY = 'views.month.timetable';

/**
 * The Month view.
 * @param store the planner settings store
 * @returns the view definition
 */
export function createMonthView(ose: any, store: any): any {
  let live: { unmount(): void; refresh(): void; } | null = null;

  const ttStore = () => { try { return ose.local(TT_KEY); } catch { return null; } };
  const ttRead = () => { try { return ttStore()?.get() === true; } catch { return false; } };
  const ttWrite = (open) => { try { ttStore()?.set(open); } catch { /* not kept */ } };

  function mount(host, route) {
    let alive = true, seq = 0, busy = false;
    let cursor = monthOfArg(route && route.arg) || startOfMonth(new Date());
    let plan: ReturnType<typeof parseMonthlyPlan> | null = null, path = '', planExists = false, systems: any[] = [];
    let tt: { found: boolean; events: TimetableEvent[]; unknown: Array<{ line: number; text: string; }>; } = { found: false, events: [], unknown: [] };
    let ttOpen = ttRead();
    let log = parseSystemsLog(''), logMissing = false, logFile = '';
    const offs: any[] = [];
    const settings = () => store.get();

    host.innerHTML = `
<div class="view-root" tabindex="-1">
  <div class="page-col">
    <div class="v-head">
      <h1 class="page-title view-title" data-el="title">${esc(monthTitle(cursor))}</h1>
      ${navHtml('month')}
    </div>
    <div class="page-meta" data-el="meta">&nbsp;</div>
    <div data-el="detected"></div>
    <div class="label">Goals</div>
    <div class="mo-goals" data-el="goals"></div>
    <div class="label">Systems</div>
    <div class="mo-matrix-wrap"><div class="mo-matrix" data-el="matrix"></div></div>
    <div data-el="tt-part" hidden>
      <button type="button" class="label mo-fold" data-act="fold" aria-expanded="false" aria-controls="mo-tt">${icon('chevron')}<span>Timetable</span></button>
      <div class="mo-tt-wrap" id="mo-tt" data-el="tt" hidden></div>
    </div>
    <div class="label">Review</div>
    <div class="mo-review view-prose" data-el="review"></div>
  </div>
</div>`;
    const root = host.querySelector('.view-root');
    const $ = (name) => host.querySelector(`[data-el="${name}"]`);

    function renderGoals() {
      const box = $('goals');
      if (!settings().reports) { box.innerHTML = missingHtml('reports'); return; }
      if (!plan) {
        const title = monthTitle(cursor);
        box.innerHTML = `<div class="mo-start"><div class="empty">No file for ${esc(title)} at ${esc(path)}</div>
          <button type="button" class="btn sm" data-act="start">Start ${esc(title)}</button></div>`;
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
      if (intro) proseInto(intro, plan.intro, path);
    }

    function renderMatrix() {
      const box = $('matrix');
      if (!settings().reports) { box.innerHTML = ''; box.classList.add('is-empty'); return; }
      if (!systems.length) {
        box.innerHTML = logMissing && !plan
          ? `<div class="empty">No check log at ${esc(logFile)}</div>`
          : `<div class="empty">No systems for ${esc(monthTitle(cursor))}</div>`;
        box.classList.add('is-empty');
        return;
      }
      box.classList.remove('is-empty');
      const today = new Date(), days = monthDays(cursor);
      box.style.setProperty('--mo-days', String(days.length));
      const out = ['<div class="mo-corner"></div>'];
      for (const d of days) {
        out.push(`<button type="button" class="mo-dh mono-sm${isSameDay(d, today) ? ' today' : ''}" data-day="${ymd(d)}" title="Open this day"><span>${String(d.getDate()).padStart(2, '0')}</span></button>`);
      }
      out.push('<div class="mo-corner"></div>');
      const month = { done: 0, lost: 0, open: 0 };
      for (const s of systems) {
        out.push(`<div class="mo-lab" title="${esc(s.name)}"><span>${esc(s.name)}</span></div>`);
        const t = { done: 0, lost: 0, open: 0 };
        for (const d of days) {
          const v = dayVerdict(s, d, log, today);
          if (v.tally) { t[v.tally]++; month[v.tally]++; }
          out.push(`<div class="mo-c ${v.cls}${isSameDay(d, today) ? ' today' : ''}" title="${esc(s.name)} · ${ddmm(d)} · ${v.state}"></div>`);
        }
        const due = t.done + t.lost + t.open;
        const loss = due && t.lost ? `−${Math.round((100 * t.lost) / due)}%` : '';
        out.push(`<div class="mo-loss" title="${tallyText(t)}">${loss}</div>`);
      }
      if (month.done + month.lost + month.open) {
        const p = percentages(month);
        out.push(`<div class="mo-sum">${p.done}% done · ${p.lost}% lost · ${p.open}% open</div>`);
      }
      box.innerHTML = out.join('');
    }

    /** The month's own timetable as a small week: seven columns of `08h20 Maths` rows. */
    function renderTimetable() {
      const part = $('tt-part'), box = $('tt');
      part.hidden = !plan || !tt.found;
      const fold = host.querySelector('[data-act="fold"]');
      fold.setAttribute('aria-expanded', String(ttOpen));
      fold.classList.toggle('open', ttOpen);
      box.hidden = !ttOpen;
      if (part.hidden || !ttOpen) { box.innerHTML = ''; return; }
      if (!tt.events.length) { box.innerHTML = '<div class="empty">No blocks under # Timetable</div>'; return; }
      const cols = DAY_SHORT.map((name, d) => {
        const rows = tt.events.filter((e) => e.d === d).map((e) => {
          const title = `${e.q ? `${e.q} · ` : ''}${e.t}${e.sub ? ` · ${e.sub}` : ''} · ${hhmm(e.sm)} to ${hhmm(e.em)}`;
          return `<div class="mo-tt-row" title="${esc(title)}"><span class="wk-dot t-${e.type}"></span><span class="mo-tt-t mono-sm">${hhmm(e.sm)}</span><span class="mo-tt-n">${esc(e.t)}</span>${e.q ? `<span class="mo-tt-q mono-sm">${e.q}</span>` : ''}</div>`;
        }).join('');
        return `<div class="mo-tt-col"><div class="mo-tt-d label">${name}</div>${rows || '<div class="mo-tt-row faint">–</div>'}</div>`;
      }).join('');
      const n = tt.unknown.length;
      const bad = n
        ? `<button type="button" class="v-link pl-unknown mono-sm" data-path="${esc(path)}" data-line="${tt.unknown[0]?.line}" title="Lines ${esc(tt.unknown.map((u) => u.line).join(', '))}">${n} line${n === 1 ? '' : 's'} not understood</button>`
        : '';
      box.innerHTML = `<div class="mo-tt">${cols}</div>${bad}`;
    }

    function renderReview() {
      const box = $('review');
      if (!settings().reports) { box.innerHTML = ''; return; }
      const text = plan && plan.review;
      if (text) proseInto(box, text, path);
      else box.innerHTML = plan ? '<div class="empty">Not written yet</div>' : '';
    }

    function render() {
      if (!alive) return;
      const s = settings();
      $('title').textContent = monthTitle(cursor);
      const year = String(cursor.getFullYear());
      $('meta').innerHTML = [
        planExists ? `<button type="button" class="v-link" data-path="${esc(path)}">${esc(path)}</button>` : '',
        logFile && !logMissing ? `<button type="button" class="v-link" data-path="${esc(logFile)}">${esc(logFile)}</button>` : '',
        s.reports ? `<span>${systems.length} system${systems.length === 1 ? '' : 's'}</span>` : '',
        s.reports ? `<button type="button" class="v-link" data-year="${year}" title="The year ${year}">${year}</button>` : '',
      ].filter(Boolean).join('') || '&nbsp;';
      $('detected').innerHTML = s.confirmed ? '' : detectedHtml();
      host.querySelector('[data-nav="today"]').hidden = isSameDay(startOfMonth(new Date()), cursor);
      renderGoals();
      renderMatrix();
      renderTimetable();
      renderReview();
    }

    async function load() {
      await store.ready;
      const my = ++seq;
      const at = cursor;
      const s = settings();
      logFile = s.reports ? await resolveLogPath((p) => ose.files.exists(p), s.reports) : '';
      if (!s.reports) {
        plan = null; path = ''; planExists = false; systems = []; log = parseSystemsLog('');
        tt = { found: false, events: [], unknown: [] };
        render();
        return;
      }
      const stops = ['goals', 'matrix', 'review'].map((n) => loadingLine($(n)));
      const stop = () => stops.forEach((f) => f());
      try {
        const [found, hasLog] = await Promise.all([
          resolvePlanPath((f) => ose.files.list(f), at, s.reports),
          ose.files.exists(logFile),
        ]);
        const [planText, logText] = await Promise.all([
          found.exists ? ose.files.read(found.path) : '',
          hasLog ? ose.files.read(logFile) : '',
        ]);
        if (my !== seq || !alive) return;
        path = found.path;
        planExists = found.exists;
        logMissing = !hasLog;
        plan = found.exists ? parseMonthlyPlan(planText) : null;
        const sec = timetableSection(planText);
        tt = sec.found ? { found: true, ...parseTimetable(sec.text) } : { found: false, events: [], unknown: [] };
        log = parseSystemsLog(logText);
        // The habits of # Systems, then one row per kind of block of the month's timetable.
        systems = [...systemsFor(plan, log, at), ...blockRows(tt.events, (e, date) => blockApplies(e, date, q1Of(settings())))];
        stop();
        render();
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[planner] month', e);
        toast(`Month: ${(e && e.message) || e}`, 'err');
      } finally {
        stop();
      }
    }

    /**
     * Create the month's file from the last month that has one (`newMonthText`), in the same
     * layout: flat when that month is flat, else in this year's folder. Exclusive: an existing
     * file is never touched.
     */
    async function start() {
      const dir = settings().reports;
      if (busy || !dir) return;
      busy = true;
      const at = cursor;
      const list = (f) => ose.files.list(f);
      try {
        const prev = await previousMonthFile(list, at, dir);
        const prevText = prev ? await ose.files.read(prev.path) : null;
        const flat = prev ? prev.flat : pickMonth(await listPlannings(list, dir, at.getFullYear()), at).flat;
        const folder = flat ? dir : planDir(at, dir);
        await ose.fileops.create(folder, `${ym(at)}.md`, { text: newMonthText(at, prevText) });
        toast(prev ? `Started ${monthTitle(at)} from ${prev.path}` : `Started ${monthTitle(at)}`, 'info', 3000);
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        if (!(e && e.code === 'exists')) toast(`The month could not be started: ${(e && e.message) || e}`, 'err');
      } finally {
        busy = false;
        if (alive) load();
      }
    }

    function go(delta) {
      cursor = delta === 0 ? startOfMonth(new Date()) : startOfMonth(addMonths(cursor, delta));
      load();
    }

    function onClick(ev) {
      const t = ev.target.closest ? ev.target.closest('[data-act], [data-year]') : null;
      if (!t || !root.contains(t)) return;
      if (t.dataset.year) { ose.route.navigate({ type: 'view', name: 'planner', arg: `year:${t.dataset.year}` }); return; }
      if (t.dataset.act === 'start') { void start(); return; }
      if (t.dataset.act === 'fold') { ttOpen = !ttOpen; ttWrite(ttOpen); renderTimetable(); }
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
    // Left open past midnight: a view that was on this month follows the date into the next one;
    // one that was elsewhere stays, and redraws so today's marks and the Today button are right.
    let lastDay = startOfDay(new Date());
    const dayTimer = setInterval(() => {
      const today = startOfDay(new Date());
      if (isSameDay(today, lastDay)) return;
      const wasHere = isSameDay(startOfMonth(lastDay), cursor);
      lastDay = today;
      if (wasHere && !isSameDay(startOfMonth(today), cursor)) go(0); else render();
    }, 60000);
    offs.push(() => clearInterval(dayTimer));
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
    title: 'Month',
    order: 30,
    icon: 'month',
    section: 'planner',
    mount: (el, route) => mount(el, route),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}

