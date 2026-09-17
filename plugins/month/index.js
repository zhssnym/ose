// Month: three sections and nothing else. The month's goals, the systems matrix with the
// loss each system has taken and one summary line under it, and Hassan's review. Everything
// comes from one folder and nothing is written here:
//   <reports>/<year>/<YYYY-MM>*.md   goals, `# Systems`, `# Monthly Review`
//   <reports>/systems.jsonl          the append-only check log, derived from the same folder
// The folder is the `reports` path and nothing here spells it; the file schema is the reports
// folder's own README and the parsers in `../_lib/plans.js` match it exactly. Plan names are
// tolerant: the year folder is listed and any file starting with the month is that month's plan,
// the exact `2026-09.md` winning when several match. The app never creates a file there.
// The cells are read-only on purpose; checking a system is a Day-view action.

import { esc, loadingLine } from 'ose:ui';
import {
  ymd, ym, ddmm, parseDate, sameDay, monthDays, monthName, startOfMonth, addMonths, pad,
} from 'ose:md';
import {
  parseMonthlyPlan, parseSystemsLog, systemsFor, logKey, applies, isGapLine, resolvePlanPath,
} from '../_lib/plans.js';
import { navHtml, bindNav } from '../_lib/nav.js';
import { pathInto } from '../_lib/view.js';

export const name = 'Month';
export const description = "The month's goals, the systems matrix with the loss each has taken, and the review. Read-only: checking a system is a Day action.";

export const paths = {
  reports: {
    folder: 'reports',
    hint: 'One folder per year holding one file per month named YYYY-MM.md, with the sections Goals, # Systems and # Monthly Review.',
  },
};

const LOG_FILE = 'systems.jsonl';   // the check log, derived from the reports folder

let ose = null;   // the plugin's own `ose`, from activate()

/** A transient line in the status bar; the view always gives the slot back. */
let flashTimer = null;
function flash(text) {
  ose.status.set('doc', text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ose.status.set('doc', null), 6000);
}

let el = null, root = null;
let cursor = startOfMonth(new Date());
let plan = null, path = '', systems = [], log = { done: new Map(), first: new Map(), names: [] };
// the paths this render was built from; '' means `ose.paths` could not resolve the folder and
// the goals box is holding the kernel's box instead
let reportsDir = '', logPath = '';
let logMissing = false;
let offPaths = null, offNav = null;
let seq = 0;   // a navigation while a read is in flight must not be overwritten by it

const $ = (sel) => el && el.querySelector(sel);
const isDone = (s, d) => log.done.get(logKey(ymd(d), s.name)) === true;

/** The first day that counts: the first day the system appears in the log, or the 1st. */
function floorOf(s) {
  const first = log.first.get(s.name);
  const start = startOfMonth(cursor);
  const f = first ? parseDate(first) : null;
  return f && f > start ? f : start;
}

/* ------------------------------------------------------------------ stats */

/**
 * One day of one system, as the cell draws it and as the numbers count it, from the same
 * verdict so the two can never disagree:
 *   on    due and checked, whenever it was checked        -> done
 *   skip  due and not checked, today or before            -> lost, except today, which is open
 *   off   not due, before the system started, or to come -> nothing, or open when it is due
 * A day before the floor (the system's first logged day) is off and counts as neither done,
 * lost nor open: a system added on the 10th has a 21-day month, not a 30-day one with nine
 * losses it never had the chance to avoid. Today still unchecked is open, not lost, so the
 * loss column does not accuse before the day is over.
 */
function verdict(s, d, floor, today) {
  const done = isDone(s, d);
  const isToday = sameDay(d, today), future = d > today && !isToday;
  const due = applies(s, d) && d >= floor;
  const cls = done ? 'on' : (!due || future) ? 'off' : 'skip';
  const tally = !due ? null : done ? 'done' : (future || isToday) ? 'open' : 'lost';
  const state = done ? 'done'
    : future ? 'upcoming'
    : !applies(s, d) ? 'not applicable'
    : d < floor ? 'before it started'
    : 'not done';
  return { cls, tally, state };
}

/** `12 done · 2 lost · 16 open` — the hover of a row's loss and the shape of the summary. */
const tallyText = (t) => `${t.done} done · ${t.lost} lost · ${t.open} open`;

/**
 * Three integers that always sum to 100. `done` and `lost` round on their own and `open`
 * takes the drift, so a line never reads 33 · 33 · 33. Once nothing is open (a month behind
 * us) the drift goes to `lost` instead: two halves rounding up (1 lost of 8, 7 done) would
 * otherwise print "−1% open" on a month that has nothing open at all.
 */
function percentages(t) {
  const all = t.done + t.lost + t.open;
  const done = Math.round((100 * t.done) / all);
  if (!t.open) return { done, lost: 100 - done, open: 0 };
  const lost = Math.round((100 * t.lost) / all);
  return { done, lost, open: 100 - done - lost };
}

/* --------------------------------------------------------------- skeleton */

function skeleton() {
  return `
<div class="view-root" tabindex="-1" id="moRoot">
  <div class="page-col">
    <div class="v-head">
      <h1 class="page-title" id="moTitle">&nbsp;</h1>
      ${navHtml('month')}
    </div>
    <div class="page-meta" id="moMeta">&nbsp;</div>

    <div class="label">goals</div>
    <div class="mo-goals" id="moGoals"></div>

    <div class="label">systems</div>
    <div class="mo-matrix-wrap"><div class="mo-matrix" id="moMatrix"></div></div>

    <div class="label">review</div>
    <div class="mo-review" id="moReview"></div>
  </div>
</div>`;
}

/* ----------------------------------------------------------------- render */

/** Prose, exactly as the file has it: paragraphs, `_..._` as emphasis, gap lines flagged. */
function prose(text) {
  return text.split(/\n{2,}/).map((p) => {
    const line = p.trim().replace(/\s*\n\s*/g, ' ');
    const body = esc(line).replace(/_([^_]+)_/g, '<em>$1</em>');
    return `<p${isGapLine(line) ? ' class="mo-gap"' : ''}>${body}</p>`;
  }).join('');
}

function renderGoals() {
  const box = $('#moGoals');
  // no reports folder: the box is holding the kernel's missing panel for the whole view
  if (!box || !reportsDir) return;
  if (!plan) { box.innerHTML = `<div class="empty">no plan file for ${esc(monthName(cursor))}</div>`; return; }
  // A month written outside the schema has its goals as plain paragraphs; they are the intro,
  // never invented into goal bullets. Show them rather than dropping them on the floor.
  const intro = plan.intro ? `<div class="mo-intro">${prose(plan.intro)}</div>` : '';
  // a goal section is a label plus its bullets; a label with none carries no goals, and
  // whatever prose sat under it is already in the intro
  const cards = plan.sections.filter((s) => s.items.length);
  if (!cards.length) {
    box.innerHTML = intro || '<div class="empty">this plan has no goals</div>';
    return;
  }
  box.innerHTML = intro + cards.map((s) => `
    <div class="mo-card">
      <div class="label">${esc(s.label)}</div>
      <ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
    </div>`).join('');
}

function renderMatrix() {
  const box = $('#moMatrix');
  if (!box) return;
  // the goals box carries the one missing panel; this section stays quiet rather than repeating it
  if (!reportsDir) { box.innerHTML = ''; box.classList.add('is-empty'); return; }
  if (!systems.length) {
    // No systems and no log: the log itself is missing, which is a different problem from a
    // month nobody checked anything in.
    box.innerHTML = logMissing && !plan
      ? `<div class="empty">no check log at ${esc(logPath)}</div>`
      : `<div class="empty">no systems for ${esc(monthName(cursor))}</div>`;
    box.classList.add('is-empty');
    return;
  }
  box.classList.remove('is-empty');
  const today = new Date(), days = monthDays(cursor);
  box.style.setProperty('--mo-days', String(days.length));

  // the header row and every system row end in the loss column, so both carry one more cell
  const out = ['<div class="mo-corner"></div>'];
  for (const d of days) {
    out.push(`<div class="mo-dh mono-sm${sameDay(d, today) ? ' today' : ''}"><span>${pad(d.getDate())}</span></div>`);
  }
  out.push('<div class="mo-corner"></div>');

  const month = { done: 0, lost: 0, open: 0 };
  for (const s of systems) {
    out.push(`<div class="mo-lab" title="${esc(s.name)}"><span>${esc(s.name)}</span></div>`);
    const floor = floorOf(s), t = { done: 0, lost: 0, open: 0 };
    for (const d of days) {
      const v = verdict(s, d, floor, today);
      if (v.tally) { t[v.tally]++; month[v.tally]++; }
      out.push(`<div class="mo-c ${v.cls}${sameDay(d, today) ? ' today' : ''}" data-tip="${esc(s.name)} · ${ddmm(d)} · ${v.state}"></div>`);
    }
    // the loss a system has taken so far, over every day it is due this month; a system that
    // has lost nothing says nothing, so the column is empty on a clean sheet
    const due = t.done + t.lost + t.open;
    const loss = due && t.lost ? `−${Math.round((100 * t.lost) / due)}%` : '';
    out.push(`<div class="mo-loss" data-tip="${tallyText(t)}">${loss}</div>`);
  }

  // one line for the month, pooled over every system, the month as the only denominator; a
  // month where nothing is due yet (every system starts after it) has nothing to say
  if (month.done + month.lost + month.open) {
    const p = percentages(month);
    out.push(`<div class="mo-sum">${p.done}% done · ${p.lost}% lost · ${p.open}% open</div>`);
  }
  box.innerHTML = out.join('');
}

function renderReview() {
  const box = $('#moReview');
  if (!box) return;
  if (!reportsDir) { box.innerHTML = ''; return; }
  const text = plan && plan.review;
  if (!text) { box.innerHTML = '<div class="empty">not written yet</div>'; return; }
  box.innerHTML = prose(text);
}

function render() {
  if (!el) return;
  $('#moTitle').textContent = monthName(cursor);
  $('#moMeta').innerHTML = [
    path ? `<button type="button" class="v-link" data-path="${esc(path)}">${esc(path)}</button>` : '',
    logPath ? `<button type="button" class="v-link" data-path="${esc(logPath)}">${esc(logPath)}</button>` : '',
    `<span>${systems.length} system${systems.length === 1 ? '' : 's'}</span>`,
  ].filter(Boolean).join('');
  $('[data-nav="today"]').hidden = sameDay(startOfMonth(new Date()), cursor);
  renderGoals();
  renderMatrix();
  renderReview();
}

/* ------------------------------------------------------------------- data */

async function load() {
  const my = ++seq;
  const at = cursor;
  // The folder first, into the goals box: everything on this page comes from it, so one box
  // there says it once. Asking before the loading lines are armed keeps a timer from painting
  // "loading…" over a box the kernel has just drawn.
  const found = await pathInto(ose, 'reports', $('#moGoals'));
  if (my !== seq || !el) return;
  reportsDir = found;
  logPath = reportsDir ? `${reportsDir}/${LOG_FILE}` : '';
  if (!reportsDir) {
    plan = null; path = ''; systems = []; log = { done: new Map(), first: new Map(), names: [] };
    render();
    return;
  }

  // the three regions the reads feed say "loading…" only past a blink
  const stops = ['#moGoals', '#moMatrix', '#moReview'].map((s) => loadingLine($(s)));
  const stop = () => stops.forEach((f) => f());
  try {
    const [plans, hasLog, logText] = await Promise.all([
      resolvePlanPath(ose.files, at, reportsDir),
      ose.files.exists(logPath),
      ose.files.exists(logPath).then((y) => (y ? ose.files.read(logPath) : '')),
    ]);
    const planText = plans.exists ? await ose.files.read(plans.path) : '';
    if (my !== seq || !el) return;
    path = plans.path;
    logMissing = !hasLog;
    plan = planText ? parseMonthlyPlan(planText) : null;
    log = parseSystemsLog(logText);
    systems = systemsFor(plan, log, at);
    stop();
    render();
  } catch (e) {
    console.error('[month]', e);
    flash(`month: ${e.message || e}`);
  } finally {
    stop();   // a superseded or failed load must not print "loading…" later
  }
}

function onClick(ev) {
  const link = ev.target.closest('.v-link');
  if (link && link.dataset.path) ose.route.navigate({ type: 'page', path: link.dataset.path });
}

function go(delta) {
  cursor = delta === 0 ? startOfMonth(new Date()) : addMonths(cursor, delta);
  ose.state('month').set(ym(cursor));
  load();
}

/* ------------------------------------------------------------------- view */

const view = {
  name: 'month',
  title: 'Month',
  order: 30,
  icon: 'month',

  async mount(host) {
    el = host;
    el.innerHTML = skeleton();
    root = $('#moRoot');
    el.addEventListener('click', onClick);
    offNav = bindNav(root, { prev: () => go(-1), next: () => go(1), today: () => go(0) });
    // a folder chosen or reset elsewhere is a different month to build: resolve again and re-read
    offPaths = ose.paths.on(() => load());
    const saved = ose.state('month').get();
    cursor = (saved && parseDate(`${saved}-01`)) || startOfMonth(new Date());
    // the title needs no read: it is on screen before the data, and the keys work from the
    // first frame because focus goes to the root before the reads, not after
    $('#moTitle').textContent = monthName(cursor);
    root.focus({ preventScroll: true });
    await load();
  },

  unmount() {
    if (offPaths) { offPaths(); offPaths = null; }
    if (offNav) { offNav(); offNav = null; }
    clearTimeout(flashTimer); flashTimer = null;
    if (el) el.removeEventListener('click', onClick);
    el = null; root = null;
  },

  refresh() { if (el) load(); },
};

/* --------------------------------------------------------------- the plugin */

export async function activate(app) {
  ose = app;
  ose.views.register('month', view);
  ose.commands.register({
    id: 'view.month', title: 'Month', group: 'view',
    run: () => ose.route.navigate({ type: 'view', name: 'month' }),
  });
  // A check written by the Day view lands in the log this view draws. `watch(fn)` is the whole
  // vault, so the change list is filtered against the folder that was actually resolved.
  ose.watch((d) => {
    if (!el) return;
    const mine = (p) => !!p && !!reportsDir && (p === reportsDir || p.startsWith(`${reportsDir}/`));
    if (!d || d.lost || (d.changes || []).some((c) => c && (mine(c.path) || mine(c.to)))) load();
  });
}
