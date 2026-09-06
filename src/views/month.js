// Month view: the month's goals, the systems activity matrix, the numbers it computes, and
// Hassan's monthly review. Everything comes from two sources and nothing is written here:
//   plans      <plans>/<year>/<YYYY-MM> Monthly Plan.md   goals, `# Systems`, `# Monthly Review`
//   systemsLog the append-only check log
// Both paths come from `sources-compat.js`, so they follow the settings; the file schema is
// `Personal/3. Action/CLAUDE.md` and the parsers in `lib/md.js` match it exactly.
// The cells are read-only on purpose; checking a system is a Day-view action.

import { esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import {
  parseMonthlyPlan, parseSystemsLog, systemsFor, logKey, applies, isGapLine,
  ymd, ym, ddmm, parseDate, addDays, sameDay, monthDays, monthName,
  startOfMonth, endOfMonth, addMonths, pad,
} from '../lib/md.js';
import { flash, navigate, getViewState, setViewState } from './shell-compat.js';
import { getSource, onSources, sourcePlanPath } from './sources-compat.js';

let el = null;
let cursor = startOfMonth(new Date());
let plan = null, path = '', systems = [], log = { done: new Map(), first: new Map(), names: [] };
let planDir = '', logPath = '';          // the source paths this render was built from
let dirMissing = false, logMissing = false;
let offSources = null;
let seq = 0;   // a navigation while a read is in flight must not be overwritten by it

/** A source that is not there is said out loud, with the path and where to change it. */
const srcEmpty = (path, what = 'file') =>
  `<div class="empty">no ${what} at ${esc(path)} · set it in settings (ctrl+,)</div>`;

const $ = (sel) => el && el.querySelector(sel);
const isDone = (s, d) => log.done.get(logKey(ymd(d), s.name)) === true;

/** The first day that counts: the first day the system appears in the log, or the 1st. */
function floorOf(s) {
  const first = log.first.get(s.name);
  const start = startOfMonth(cursor);
  const f = first ? parseDate(first) : null;
  return f && f > start ? f : start;
}

/** The last day with a verdict: today, or the end of the month once it is behind us. */
function lastDay() {
  const today = new Date(), end = endOfMonth(cursor);
  return end < today ? end : today;
}

/* ------------------------------------------------------------------ stats */

/** done / applicable to date. Today still pending is not counted as a miss. */
function score(s) {
  const today = new Date(), end = lastDay(), floor = floorOf(s);
  let all = 0, ok = 0;
  for (let d = floor; d <= end; d = addDays(d, 1)) {
    if (!applies(s, d)) continue;
    const done = isDone(s, d);
    if (sameDay(d, today) && !done) continue;
    all++;
    if (done) ok++;
  }
  return { all, ok };
}

/** Applicable days done in a row, counting back. Today still pending is not a break. */
function streak(s) {
  const today = new Date(), floor = floorOf(s);
  let d = lastDay(), n = 0;
  if (sameDay(d, today) && applies(s, d) && !isDone(s, d)) d = addDays(d, -1);
  for (let i = 0; i < 400 && d >= floor; i++, d = addDays(d, -1)) {
    if (!applies(s, d)) continue;
    if (!isDone(s, d)) break;
    n++;
  }
  return n;
}

/* --------------------------------------------------------------- skeleton */

function skeleton() {
  return `
<div class="view-root">
  <div class="page-col">
    <div class="v-head">
      <h1 class="page-title" id="moTitle">&nbsp;</h1>
      <div class="v-nav">
        <button class="btn sm" id="moPrev" aria-label="Previous month">&lsaquo;</button>
        <button class="btn sm" id="moToday">today</button>
        <button class="btn sm" id="moNext" aria-label="Next month">&rsaquo;</button>
      </div>
    </div>
    <div class="page-meta" id="moMeta">&nbsp;</div>

    <div class="label">goals</div>
    <div class="mo-goals" id="moGoals"></div>

    <div class="label">systems</div>
    <div class="mo-matrix-wrap"><div class="mo-matrix" id="moMatrix"></div></div>
    <div class="mo-nums" id="moNums"></div>

    <div class="label">monthly review</div>
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
  if (dirMissing) { box.innerHTML = srcEmpty(planDir, 'folder'); return; }
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
  if (!systems.length) {
    // No systems and no log: the source itself is missing, which is a different problem from
    // a month nobody checked anything in.
    box.innerHTML = logMissing && !plan
      ? srcEmpty(logPath)
      : `<div class="empty">no systems for ${esc(monthName(cursor))}</div>`;
    box.classList.add('is-empty');
    return;
  }
  box.classList.remove('is-empty');
  const today = new Date(), days = monthDays(cursor);
  box.style.setProperty('--mo-days', String(days.length));

  const out = ['<div class="mo-corner"></div>'];
  for (const d of days) {
    out.push(`<div class="mo-dh mono-sm${sameDay(d, today) ? ' today' : ''}"><span>${pad(d.getDate())}</span></div>`);
  }
  for (const s of systems) {
    out.push(`<div class="mo-lab" title="${esc(s.name)}"><span>${esc(s.name)}</span></div>`);
    const floor = floorOf(s);
    for (const d of days) {
      const future = d > today && !sameDay(d, today);
      const done = isDone(s, d);
      // a day checked ahead of time still counts as filled; everything else in the future is dim
      const off = !applies(s, d) || d < floor || (future && !done);
      const state = done ? 'done'
        : future ? 'upcoming'
        : !applies(s, d) ? 'not applicable'
        : d < floor ? 'before it started'
        : 'not done';
      const cls = off ? 'off' : done ? 'on' : 'skip';
      out.push(`<div class="mo-c ${cls}${sameDay(d, today) ? ' today' : ''}" data-tip="${esc(s.name)} · ${ddmm(d)} · ${state}"></div>`);
    }
  }
  box.innerHTML = out.join('');
}

function renderNums() {
  const box = $('#moNums');
  if (!systems.length) { box.innerHTML = ''; return; }
  let all = 0, ok = 0;
  const rows = systems.map((s) => {
    const { all: a, ok: k } = score(s);
    all += a; ok += k;
    const st = streak(s);
    return `<div class="mo-num">
      <span class="mo-num-k">${esc(s.name)}</span>
      <span class="mo-num-v">${k} / ${a}${st ? ` <span class="faint">·</span> streak ${st}` : ''}</span>
    </div>`;
  }).join('');
  const pct = all ? Math.round((100 * ok) / all) : null;
  box.innerHTML = `${rows}<div class="mo-num mo-total">
    <span class="mo-num-k">overall</span>
    <span class="mo-num-v">${pct === null ? '–' : `${pct} %`} to date</span>
  </div>`;
}

function renderReview() {
  const box = $('#moReview');
  const text = plan && plan.review;
  if (!text) { box.innerHTML = '<div class="empty">not written yet</div>'; return; }
  box.innerHTML = prose(text);
}

function render() {
  if (!el) return;
  $('#moTitle').textContent = monthName(cursor);
  $('#moMeta').innerHTML = [
    `<span class="v-link" data-path="${esc(path)}">${esc(path)}</span>`,
    `<span class="v-link" data-path="${esc(logPath)}">${esc(logPath)}</span>`,
    `<span>${systems.length} system${systems.length === 1 ? '' : 's'}</span>`,
  ].join('');
  $('#moToday').hidden = sameDay(startOfMonth(new Date()), cursor);
  renderGoals();
  renderMatrix();
  renderNums();
  renderReview();
}

/* ------------------------------------------------------------------- data */

async function load() {
  const my = ++seq;
  const at = cursor;
  try {
    const dir = getSource('plans');
    const file = sourcePlanPath(at);
    const logFile = getSource('systemsLog');
    const [hasDir, planText, hasLog, logText] = await Promise.all([
      bridge.exists(dir),
      bridge.exists(file).then((y) => (y ? bridge.readText(file) : '')),
      bridge.exists(logFile),
      bridge.exists(logFile).then((y) => (y ? bridge.readText(logFile) : '')),
    ]);
    if (my !== seq || !el) return;
    planDir = dir; path = file; logPath = logFile;
    dirMissing = !hasDir; logMissing = !hasLog;
    plan = planText ? parseMonthlyPlan(planText) : null;
    log = parseSystemsLog(logText);
    systems = systemsFor(plan, log, at);
    render();
  } catch (e) {
    console.error('[views:month]', e);
    flash(`month: ${e.message || e}`);
  }
}

function onClick(ev) {
  const link = ev.target.closest('.v-link');
  if (link && link.dataset.path) navigate({ type: 'page', path: link.dataset.path });
}

function go(delta) {
  cursor = delta === 0 ? startOfMonth(new Date()) : addMonths(cursor, delta);
  setViewState('month', { month: ym(cursor) });
  load();
}

/* ------------------------------------------------------------------- view */

export const month = {
  name: 'month',
  title: 'Month',
  icon: 'month',

  async mount(host) {
    el = host;
    el.innerHTML = skeleton();
    el.addEventListener('click', onClick);
    $('#moPrev').addEventListener('click', () => go(-1));
    $('#moNext').addEventListener('click', () => go(1));
    $('#moToday').addEventListener('click', () => go(0));
    offSources = onSources(() => load());
    const saved = await getViewState('month');
    cursor = (saved.month && parseDate(`${saved.month}-01`)) || startOfMonth(new Date());
    await load();
  },

  unmount() {
    if (offSources) { offSources(); offSources = null; }
    if (el) el.removeEventListener('click', onClick);
    el = null;
  },

  refresh() { if (el) load(); },
};
