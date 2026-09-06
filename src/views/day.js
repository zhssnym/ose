// Day view: one day, side by side. Left, the timetable for that weekday drawn 07:00 to 23:30.
// Right, the systems that apply to the date and the tasks that belong on it.
// Reads four sources, all of them configurable: the timetable, the month's plan (for
// `# Systems`), the systems log, and the todo file. Writes: one appended line per system check,
// and the exact source line of a task. The paths come from `sources-compat.js` and are listed
// under the title, so what the day is built from is never a guess.

import { esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import {
  TIMETABLE, parseTimetable, parseMonthlyPlan, parseSystemsLog, systemsFor, logKey, applies,
  ymd, ddmm, dayTitle, parseDate, addDays, sameDay, dayIdx, pad, hhmm,
} from '../lib/md.js';
import { flash, navigate, getViewState, setViewState } from './shell-compat.js';
import {
  indexTasks, allTasks, tasksForDay, taskRow, taskById, toggleTask,
  getTaskSource, taskSourceMissing,
} from './tasks-index.js';
import { getSource, onSources, sourcePlanPath } from './sources-compat.js';

const { START, END, HOUR_H } = TIMETABLE;
const BODY_H = (END - START) * HOUR_H;
const NARROW = 900;      // main-column width below which the two columns stack
const TIME_MIN = 40;     // px of block height before the times fit under the name
const SUB_MIN = 72;      // and before the room or note fits under those
const LIMIT = 8;         // rows shown per task section before "show all"

let el = null, root = null;
let cursor = new Date();
let events = [], systems = [], log = { done: new Map(), first: new Map(), names: [] };
let plan = null;
// the source paths this render was built from, and whether each one is actually there
let ttFile = '', planDir = '', planFile = '', logFile = '';
let ttMissing = false, dirMissing = false;
let expanded = new Set(), busy = false, seq = 0;
let ro = null, tickTimer = null, offSources = null;

/** A source that is not there is said out loud, with the path and where to change it. */
const srcNote = (path, what = 'file') =>
  `<div class="dy-note mono-sm">no ${what} at ${esc(path)} · set it in settings (ctrl+,)</div>`;

const $ = (sel) => el && el.querySelector(sel);
const isDone = (name, d) => log.done.get(logKey(ymd(d), name)) === true;
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

/* --------------------------------------------------------------- skeleton */

function skeleton() {
  return `
<div class="view-root" tabindex="-1" id="dyRoot">
  <div class="page-col">
    <div class="v-head">
      <h1 class="page-title" id="dyTitle">&nbsp;</h1>
      <div class="v-nav">
        <button class="btn sm" id="dyPrev" aria-label="Previous day">&lsaquo;</button>
        <button class="btn sm" id="dyToday">today</button>
        <button class="btn sm" id="dyNext" aria-label="Next day">&rsaquo;</button>
      </div>
    </div>
    <div class="page-meta" id="dyMeta">&nbsp;</div>

    <div class="dy-split">
      <div class="dy-left">
        <div class="label">timeline</div>
        <div class="dy-tl" id="dyTl" style="--dy-body:${BODY_H}px"></div>
      </div>
      <div class="dy-right">
        <div class="label">systems</div>
        <div class="dy-sys" id="dySys"></div>
        <div class="label">tasks</div>
        <div class="dy-tasks" id="dyTasks"></div>
      </div>
    </div>
  </div>
</div>`;
}

/* --------------------------------------------------------------- timeline */

function renderTimeline() {
  const box = $('#dyTl');
  const d = dayIdx(cursor);
  const list = events.filter((e) => e.d === d);
  const out = ['<div class="dy-times">'];
  for (let h = Math.ceil(START); h <= Math.floor(END); h++) {
    const y = (h - START) * HOUR_H;                                 // each label sits on its line
    out.push(`<div class="dy-t mono-sm" style="top:${Math.max(0, y - 6)}px">${pad(h)}h</div>`);
  }
  out.push('</div><div class="dy-track">');
  for (let h = Math.ceil(START) + 1; h <= Math.floor(END); h++) {   // the first hour is the top border
    out.push(`<div class="dy-line" style="top:${(h - START) * HOUR_H}px"></div>`);
  }
  for (const e of list) {
    const top = (e.sm / 60 - START) * HOUR_H;
    const h = Math.max(16, (e.em - e.sm) / 60 * HOUR_H - 2);
    // a short block prints its name only; the times and the room need a second and third line
    const time = h >= TIME_MIN ? `<span class="dy-ev-t mono-sm">${hhmm(e.sm)} to ${hhmm(e.em)}</span>` : '';
    const sub = e.sub && h >= SUB_MIN ? `<span class="dy-ev-s mono-sm">${esc(e.sub)}</span>` : '';
    out.push(`<div class="dy-ev t-${e.type}" data-s="${e.sm}" data-e="${e.em}" style="top:${top}px;height:${h}px" title="${esc(e.t)}${e.sub ? ' · ' + esc(e.sub) : ''} · ${hhmm(e.sm)} to ${hhmm(e.em)}"><span class="dy-ev-n">${esc(e.t)}</span>${time}${sub}</div>`);
  }
  out.push('<div class="dy-now" id="dyNow" hidden><span class="dy-now-dot"></span></div></div>');
  box.innerHTML = out.join('');
  if (!list.length) {
    box.insertAdjacentHTML('beforeend', `<div class="dy-tl-empty empty">${ttMissing
      ? `no file at ${esc(ttFile)} · set it in settings (ctrl+,)`
      : 'nothing in the timetable for this day'}</div>`);
  }
  tick();
}

function tick() {
  if (!el) return;
  const line = $('#dyNow');
  if (!line) return;
  if (!sameDay(cursor, new Date())) { line.hidden = true; return; }
  const y = (nowMinutes() / 60 - START) * HOUR_H;
  line.hidden = y < 0 || y > BODY_H;
  line.style.top = `${y}px`;
  const m = nowMinutes();
  for (const node of el.querySelectorAll('.dy-ev')) {
    const s = +node.dataset.s, e = +node.dataset.e;
    node.classList.toggle('past', e <= m);
    node.classList.toggle('live', s <= m && m < e);
  }
}

/* ---------------------------------------------------------------- systems */

function renderSystems() {
  const box = $('#dySys');
  const list = systems.filter((s) => applies(s, cursor));
  if (dirMissing) { box.innerHTML = srcNote(planDir, 'folder'); return; }
  if (!list.length) {
    box.innerHTML = `<div class="dy-note mono-sm">no system applies on ${esc(ddmm(cursor))}</div>`;
    return;
  }
  const k = list.filter((s) => isDone(s.name, cursor)).length;
  box.innerHTML = `
    <div class="dy-sys-head">
      <span class="mono-sm faint">${esc(ddmm(cursor))}</span>
      <span class="mono-sm${k === list.length ? ' ok' : ''}">${k} / ${list.length}</span>
    </div>
    ${list.map((s) => {
      const dn = isDone(s.name, cursor);
      return `<button class="dy-sys-row${dn ? ' done' : ''}" data-system="${esc(s.name)}">
        <span class="check${dn ? ' on' : ''}"></span>
        <span class="dy-sys-name">${esc(s.name)}</span>
      </button>`;
    }).join('')}`;
}

async function toggleSystem(name) {
  if (busy) return;
  busy = true;
  const date = ymd(cursor), k = logKey(date, name);
  const prev = log.done.get(k);
  const next = !(prev === true);
  log.done.set(k, next);                                  // optimistic
  if (!log.first.has(name) || date < log.first.get(name)) log.first.set(name, date);
  renderSystems();
  try {
    await bridge.appendText(logFile, `${JSON.stringify({ date, system: name, done: next, at: new Date().toISOString() })}\n`);
  } catch (e) {
    console.error('[views:day] system write', e);
    if (prev === undefined) log.done.delete(k); else log.done.set(k, prev);
    renderSystems();
    flash(`system write failed: ${e.message || e}`);
  } finally {
    busy = false;
  }
}

/* ------------------------------------------------------------------ tasks */

function section(key, label, list) {
  if (!list.length) return '';
  const open = expanded.has(key);
  const shown = open ? list : list.slice(0, LIMIT);
  const rest = list.length - shown.length;
  return `<div class="dy-sec">
    <div class="label">${esc(label)} <span class="dy-n">${list.length}</span></div>
    ${shown.map(taskRow).join('')}
    ${rest ? `<button class="dy-more mono-sm" data-more="${esc(key)}">show all ${list.length}</button>` : ''}
  </div>`;
}

function renderTasks() {
  const box = $('#dyTasks');
  if (taskSourceMissing()) { box.innerHTML = srcNote(getTaskSource()); return; }
  const g = tasksForDay(cursor, allTasks());
  const body = [
    section('overdue', 'overdue', g.overdue),
    section('due', `due ${ymd(cursor)}`, g.due),
    section('none', 'no date', g.undated),
  ].filter(Boolean).join('');
  box.innerHTML = body || '<div class="dy-note mono-sm">nothing due, nothing late</div>';
}

async function onToggleTask(id) {
  if (busy) return;
  busy = true;
  try {
    const t = taskById(id);
    const res = await toggleTask(t);
    if (res === 'moved') flash(`task line moved in ${t.path}, re-indexed`);
    renderTasks();
  } catch (e) {
    console.error('[views:day] task write', e);
    flash(`task write failed: ${e.message || e}`);
  } finally {
    busy = false;
  }
}

/* ----------------------------------------------------------------- render */

function render() {
  if (!el) return;
  $('#dyTitle').textContent = dayTitle(cursor);
  // the actual source paths, in the order the day is built from them
  $('#dyMeta').innerHTML = [ttFile, planFile, logFile, getTaskSource()]
    .map((p) => `<span class="v-link" data-path="${esc(p)}">${esc(p)}</span>`).join('');
  $('#dyToday').hidden = sameDay(cursor, new Date());
  renderTimeline();
  renderSystems();
  renderTasks();
}

/* ------------------------------------------------------------------- data */

async function load() {
  const my = ++seq;
  const at = cursor;
  const tt = getSource('timetable');
  const dir = getSource('plans');
  const file = sourcePlanPath(at);
  const logPath = getSource('systemsLog');
  try {
    const [hasTt, ttText, hasDir, planText, logText] = await Promise.all([
      bridge.exists(tt),
      bridge.exists(tt).then((y) => (y ? bridge.readText(tt) : '')),
      bridge.exists(dir),
      bridge.exists(file).then((y) => (y ? bridge.readText(file) : '')),
      bridge.exists(logPath).then((y) => (y ? bridge.readText(logPath) : '')),
    ]);
    if (my !== seq || !el) return;
    ttFile = tt; planDir = dir; planFile = file; logFile = logPath;
    ttMissing = !hasTt; dirMissing = !hasDir;
    events = parseTimetable(ttText);
    plan = planText ? parseMonthlyPlan(planText) : null;
    log = parseSystemsLog(logText);
    systems = systemsFor(plan, log, at);
    render();
    await indexTasks();
    if (my === seq && el) renderTasks();
  } catch (e) {
    console.error('[views:day]', e);
    flash(`day: ${e.message || e}`);
  }
}

/* ------------------------------------------------------------- interaction */

function go(delta) {
  cursor = delta === 0 ? new Date() : addDays(cursor, delta);
  expanded = new Set();
  setViewState('day', { date: ymd(cursor) });
  load();
}

function onClick(ev) {
  const sys = ev.target.closest('[data-system]');
  if (sys) { toggleSystem(sys.dataset.system); return; }
  const tg = ev.target.closest('[data-toggle]');
  if (tg) { onToggleTask(tg.dataset.toggle); return; }
  const more = ev.target.closest('[data-more]');
  if (more) { expanded.add(more.dataset.more); renderTasks(); return; }
  const src = ev.target.closest('.tk-src');
  if (src) { navigate({ type: 'page', path: src.dataset.path }); return; }
  const link = ev.target.closest('.v-link');
  if (link && link.dataset.path) navigate({ type: 'page', path: link.dataset.path });
}

function onKey(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const tag = ev.target && ev.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(-1); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); go(1); }
  else if (ev.key === 't' || ev.key === 'T') { ev.preventDefault(); go(0); }
}

/* ------------------------------------------------------------------- view */

export const day = {
  name: 'day',
  title: 'Day',
  icon: 'day',

  async mount(host) {
    el = host;
    el.innerHTML = skeleton();
    root = $('#dyRoot');
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    $('#dyPrev').addEventListener('click', () => go(-1));
    $('#dyNext').addEventListener('click', () => go(1));
    $('#dyToday').addEventListener('click', () => go(0));

    // the layout follows the main column, not the window: the sidebar and the Claude pane
    // both change how much room there is.
    const fit = (w) => { if (root) root.classList.toggle('narrow', w < NARROW); };
    fit(el.clientWidth);              // right on the first paint, before the observer fires
    ro = new ResizeObserver((entries) => fit(entries[0].contentRect.width));
    ro.observe(el);

    offSources = onSources(() => load());
    const saved = await getViewState('day');
    cursor = (saved.date && parseDate(saved.date)) || new Date();
    await load();
    root.focus({ preventScroll: true });
    tickTimer = setInterval(tick, 30000);
  },

  unmount() {
    if (offSources) { offSources(); offSources = null; }
    if (ro) { ro.disconnect(); ro = null; }
    clearInterval(tickTimer); tickTimer = null;
    if (el) { el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey); }
    el = null; root = null;
  },

  refresh() { if (el) load(); },
};
