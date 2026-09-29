// Month: the month's goals, the systems matrix with the loss each system has taken and one
// summary line under it, and the review. Read-only: checking a system is a Day action.
//
//   <reports>/<year>/<YYYY-MM>*.md   goals, `# Systems`, `# Monthly Review`
//   <reports>/systems.jsonl          the check log
//
// It always opens on this month (M32), and follows the date into the next one when it was on it. A day before a system's first record in the log is not a
// loss, and a system nobody has checked yet has lost nothing (L16): the verdict is `dayVerdict`
// in plans.js, the same one the tests read.

import { esc, loadingLine, toast } from 'ose:ui';
import { addMonths, ddmm, isSameDay, monthDays, monthTitle, startOfDay, startOfMonth } from './dates.js';
import {
  dayVerdict, isGapLine, logPath, parseMonthlyPlan, parseSystemsLog, percentages, resolvePlanPath, systemsFor,
} from './plans.js';
import { bindLinks, bindNav, detectedHtml, missingHtml, navHtml } from './nav.js';

/** `12 done · 2 lost · 16 open`. */
const tallyText = (t) => `${t.done} done · ${t.lost} lost · ${t.open} open`;

/** Prose, as the file has it: paragraphs, `_..._` as emphasis, gap lines flagged. */
function prose(text) {
  return text.split(/\n{2,}/).map((p) => {
    const line = p.trim().replace(/\s*\n\s*/g, ' ');
    const body = esc(line).replace(/_([^_]+)_/g, '<em>$1</em>');
    return `<p${isGapLine(line) ? ' class="mo-gap"' : ''}>${body}</p>`;
  }).join('');
}

/**
 * The Month view.
 * @param {object} ose
 * @param {object} store the planner settings store
 * @returns {object} the view definition
 */
export function createMonthView(ose, store) {
  let live = null;

  function mount(host) {
    let alive = true, seq = 0;
    let cursor = startOfMonth(new Date());
    let plan = null, path = '', planExists = false, systems = [];
    let log = parseSystemsLog(''), logMissing = false, logFile = '';
    const offs = [];
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
    <div class="label">Review</div>
    <div class="mo-review view-prose" data-el="review"></div>
  </div>
</div>`;
    const root = host.querySelector('.view-root');
    const $ = (name) => host.querySelector(`[data-el="${name}"]`);

    function renderGoals() {
      const box = $('goals');
      if (!settings().reports) { box.innerHTML = missingHtml('reports'); return; }
      if (!plan) { box.innerHTML = `<div class="empty">No plan file for ${esc(monthTitle(cursor))} at ${esc(path)}</div>`; return; }
      const intro = plan.intro ? `<div class="mo-intro view-prose">${prose(plan.intro)}</div>` : '';
      const cards = plan.sections.filter((s) => s.items.length);
      if (!cards.length) { box.innerHTML = intro || '<div class="empty">This plan has no goals</div>'; return; }
      box.innerHTML = intro + cards.map((s) => `
        <div class="mo-card">
          <div class="label">${esc(s.label)}</div>
          <ul class="view-prose">${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        </div>`).join('');
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
        out.push(`<div class="mo-dh mono-sm${isSameDay(d, today) ? ' today' : ''}"><span>${String(d.getDate()).padStart(2, '0')}</span></div>`);
      }
      out.push('<div class="mo-corner"></div>');
      const month = { done: 0, lost: 0, open: 0 };
      for (const s of systems) {
        out.push(`<div class="mo-lab" title="${esc(s.name)}"><span>${esc(s.name)}</span></div>`);
        const t = { done: 0, lost: 0, open: 0 };
        for (const d of days) {
          const v = dayVerdict(s, d, log, today);
          if (v.tally) { t[v.tally]++; month[v.tally]++; }
          out.push(`<div class="mo-c ${v.cls}${isSameDay(d, today) ? ' today' : ''}" data-tip="${esc(s.name)} · ${ddmm(d)} · ${v.state}"></div>`);
        }
        const due = t.done + t.lost + t.open;
        const loss = due && t.lost ? `−${Math.round((100 * t.lost) / due)}%` : '';
        out.push(`<div class="mo-loss" data-tip="${tallyText(t)}">${loss}</div>`);
      }
      if (month.done + month.lost + month.open) {
        const p = percentages(month);
        out.push(`<div class="mo-sum">${p.done}% done · ${p.lost}% lost · ${p.open}% open</div>`);
      }
      box.innerHTML = out.join('');
    }

    function renderReview() {
      const box = $('review');
      if (!settings().reports) { box.innerHTML = ''; return; }
      const text = plan && plan.review;
      box.innerHTML = text ? prose(text) : '<div class="empty">Not written yet</div>';
    }

    function render() {
      if (!alive) return;
      const s = settings();
      $('title').textContent = monthTitle(cursor);
      $('meta').innerHTML = [
        planExists ? `<button type="button" class="v-link" data-path="${esc(path)}">${esc(path)}</button>` : '',
        logFile && !logMissing ? `<button type="button" class="v-link" data-path="${esc(logFile)}">${esc(logFile)}</button>` : '',
        s.reports ? `<span>${systems.length} system${systems.length === 1 ? '' : 's'}</span>` : '',
      ].filter(Boolean).join('') || '&nbsp;';
      $('detected').innerHTML = s.confirmed ? '' : detectedHtml();
      host.querySelector('[data-nav="today"]').hidden = isSameDay(startOfMonth(new Date()), cursor);
      renderGoals();
      renderMatrix();
      renderReview();
    }

    async function load() {
      await store.ready;
      const my = ++seq;
      const at = cursor;
      const s = settings();
      logFile = s.reports ? logPath(s.reports) : '';
      if (!s.reports) {
        plan = null; path = ''; planExists = false; systems = []; log = parseSystemsLog('');
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
        plan = planText ? parseMonthlyPlan(planText) : null;
        log = parseSystemsLog(logText);
        systems = systemsFor(plan, log, at);
        stop();
        render();
      } catch (err) {
        const e = /** @type {{ code?: string, message?: string }} */ (err);
        console.error('[planner] month', e);
        toast(`Month: ${(e && e.message) || e}`, 'err');
      } finally {
        stop();
      }
    }

    function go(delta) {
      cursor = delta === 0 ? startOfMonth(new Date()) : startOfMonth(addMonths(cursor, delta));
      load();
    }

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
    mount: (el) => mount(el),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}
