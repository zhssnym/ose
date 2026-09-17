// Day: one day, side by side. Left, the timetable for that weekday drawn 07:00 to 23:30.
// Right, the cards — the systems that apply to the date, the tasks that belong on it, and
// whatever any other module has registered as a tile.
//
// Reads four sources, all of them configurable: the timetable, the month's plan (for
// `# Systems`), the systems log, and the todo source. Writes: one appended line per system
// check, and the exact source line of a task, in the file that task came from. The resolved
// paths are listed under the title, so what the day is built from is never a guess.
//
// The right column is `ose.tiles.list()`: this module registers the two tiles that were the
// hard-coded halves of the old Day view, and a module that registers its own appears beside
// them in `order` (docs/KERNEL.md `ose.tiles`). Nothing else in Ose draws tiles.

import { esc, loadingLine } from 'ose:ui';
import {
  TIMETABLE, parseTimetable, parseMonthlyPlan, parseSystemsLog, systemsFor, logKey, applies,
  ymd, ddmm, dayTitle, parseDate, addDays, sameDay, dayIdx, pad, hhmm,
} from 'ose:md';
import { navHtml, bindNav } from './nav.js';
import { resolvePlanPath } from './plan.js';
import {
  initTasks, indexTasks, groupsForDay, taskRow, taskById, toggleTask,
  getTaskSource, taskSourceMissing, taskFiles,
} from './tasks.js';

const { START, END, HOUR_H } = TIMETABLE;
const BODY_H = (END - START) * HOUR_H;
const NARROW = 900;      // main-column width below which the two columns stack
const TIME_MIN = 40;     // px of block height before the times fit under the name
const SUB_MIN = 72;      // and before the room or note fits under those
const LIMIT = 8;         // rows shown per task section before "show all"

let ose = null;          // the facade, from activate()
let el = null, root = null;
let cursor = new Date();
let events = [], systems = [], log = { done: new Map(), first: new Map(), names: [] };
let plan = null;
// the source paths this render was built from, and whether each one is actually there
let ttFile = '', plansDir = '', planFile = '', logFile = '';
let ttMissing = false, dirMissing = false, planMissing = false;
let expanded = new Set(), busy = false, seq = 0;
let ro = null, tickTimer = null, offSources = null, offNav = null, offTasks = null;
let mountedTiles = [];   // the tile ids this view has on screen
let sysEl = null, tasksEl = null;   // the boxes the two own tiles drew into

/** Every empty, missing and loading message is the one `.empty` line of DESIGN.md. */
const note = (text) => `<div class="empty">${text}</div>`;
/** A source that is not there is said out loud, with the path and where to change it. */
const srcNote = (path, what = 'file') => note(`no ${what} at ${esc(path)} · set it in settings (ctrl+,)`);

const $ = (sel) => el && el.querySelector(sel);
const isDone = (name, d) => log.done.get(logKey(ymd(d), name)) === true;
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

/** A transient line in the status bar; the view always gives the slot back. */
let flashTimer = null;
function flash(text) {
  ose.status.set('doc', text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ose.status.set('doc', null), 6000);
}

/* --------------------------------------------------------------- skeleton */

function skeleton() {
  return `
<div class="view-root" tabindex="-1" id="dyRoot">
  <div class="page-col">
    <div class="v-head">
      <h1 class="page-title" id="dyTitle">&nbsp;</h1>
      ${navHtml('day')}
    </div>
    <div class="page-meta" id="dyMeta">&nbsp;</div>

    <div class="dy-split">
      <div class="dy-left">
        <div class="label">timeline</div>
        <div class="dy-tl" id="dyTl" style="--dy-body:${BODY_H}px"></div>
      </div>
      <div class="dy-right" id="dyTiles"></div>
    </div>
  </div>
</div>`;
}

/* --------------------------------------------------------------- timeline */

function renderTimeline() {
  const box = $('#dyTl');
  if (!box) return;
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
    // the same .empty line as everywhere else; .dy-tl-empty only spans it across both columns
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

/* ------------------------------------------------------------------ tiles */

/**
 * The right column. Every registered tile is one card: its title as the section label, then
 * whatever the tile draws. The handle goes back to the kernel so `ose.tiles.refresh(id)`
 * reaches it, and `forget` takes it away again on unmount — that is the whole contract.
 */
function mountTiles() {
  const host = $('#dyTiles');
  if (!host) return;
  unmountTiles();
  host.textContent = '';
  for (const tile of ose.tiles.list()) {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = tile.title || tile.id;
    host.appendChild(label);
    const box = document.createElement('div');
    box.className = 'dy-tile';
    box.dataset.tile = tile.id;
    host.appendChild(box);
    try {
      const handle = tile.render(box) || {};
      ose.tiles.mounted(tile.id, handle);
      mountedTiles.push(tile.id);
    } catch (e) {
      console.error('[day] tile', tile.id, e);
      box.innerHTML = note(`${esc(tile.id)} failed: ${esc(String(e.message || e))}`);
    }
  }
}

function unmountTiles() {
  for (const id of mountedTiles) ose.tiles.forget(id);
  mountedTiles = [];
  sysEl = null;
  tasksEl = null;
}

/* ---------------------------------------------------------------- systems */

function renderSystems() {
  const box = sysEl;
  if (!box) return;
  const list = systems.filter((s) => applies(s, cursor));
  if (dirMissing) { box.innerHTML = srcNote(plansDir, 'folder'); return; }
  if (!list.length) {
    // no systems at all and no plan for the month is a different thing from a rest day
    box.innerHTML = (!systems.length && planMissing)
      ? note(`no plan for this month at ${esc(planFile)}`)
      : note(`no system applies on ${esc(ddmm(cursor))}`);
    return;
  }
  const k = list.filter((s) => isDone(s.name, cursor)).length;
  box.innerHTML = `
    <div class="dy-box">
      <div class="dy-box-head">
        <span class="mono-sm faint">${esc(ddmm(cursor))}</span>
        <span class="mono-sm${k === list.length ? ' ok' : ''}">${k} / ${list.length}</span>
      </div>
      ${list.map((s) => {
        const dn = isDone(s.name, cursor);
        return `<button class="dy-sys-row${dn ? ' done' : ''}" data-system="${esc(s.name)}">
          <span class="check${dn ? ' on' : ''}"></span>
          <span class="dy-sys-name">${esc(s.name)}</span>
        </button>`;
      }).join('')}
    </div>`;
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
    await ose.files.append(logFile, `${JSON.stringify({ date, system: name, done: next, at: new Date().toISOString() })}\n`);
  } catch (e) {
    console.error('[day] system write', e);
    if (prev === undefined) log.done.delete(k); else log.done.set(k, prev);
    renderSystems();
    flash(`system write failed: ${e.message || e}`);
  } finally {
    busy = false;
  }
}

/* ------------------------------------------------------------------ tasks */

/**
 * One todo list as one box, built exactly like the systems box: a head row with the list's
 * name and its count, then the rows. There are no `overdue / due / no date` sub-headings — the
 * rows are ordered late first, then due, then undated, and the date chip on a row already says
 * which it is (red when late, accent when due today). One box, no rules.
 */
function group(g) {
  const list = [...g.overdue, ...g.due, ...g.undated];
  if (!list.length) return '';
  const open = expanded.has(g.path);
  const shown = open ? list : list.slice(0, LIMIT);
  const rest = list.length - shown.length;
  const head = g.label
    ? `<div class="dy-box-head">
         <button class="dy-grp-head" data-path="${esc(g.path)}" title="${esc(g.path)}">${esc(g.label)}</button>
         <span class="mono-sm faint">${list.length}</span>
       </div>`
    : '';
  return `<div class="dy-box">${head}
    ${shown.map((t) => taskRow(t, { short: !!g.label })).join('')}
    ${rest ? `<button class="dy-more mono-sm" data-more="${esc(g.path)}">show all ${list.length}</button>` : ''}
  </div>`;
}

function renderTasks() {
  const box = tasksEl;
  if (!box) return;
  if (taskSourceMissing()) { box.innerHTML = srcNote(getTaskSource(), 'todo source'); return; }
  const out = groupsForDay(cursor).map(group).join('');
  box.innerHTML = out || note('nothing due, nothing late');
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
    console.error('[day] task write', e);
    flash(`task write failed: ${e.message || e}`);
  } finally {
    busy = false;
  }
}

/* ----------------------------------------------------------------- render */

/**
 * The files this day was actually built from, in the order it reads them: the resolved plan
 * file rather than the folder it sits in, and one entry per task list rather than the todo
 * folder. Redrawn again once the task index resolves, since that is what names the lists.
 */
function renderMeta() {
  const box = $('#dyMeta');
  if (!box) return;
  const files = taskFiles();
  box.innerHTML = [ttFile, planFile, logFile, ...(files.length ? files : [getTaskSource()])]
    .filter(Boolean)
    .map((p) => `<button type="button" class="v-link" data-path="${esc(p)}">${esc(p)}</button>`).join('');
}

/**
 * Everything the five reads feed. The tasks box is left out on the first pass of a load, since
 * the index resolves after it: drawing it from the previous index and again a moment later
 * would be a flash of the wrong list.
 */
function render({ tasks = true } = {}) {
  if (!el) return;
  $('#dyTitle').textContent = dayTitle(cursor);
  renderMeta();
  $('[data-nav="today"]').hidden = sameDay(cursor, new Date());
  renderTimeline();
  renderSystems();
  if (tasks) renderTasks();
}

/* ------------------------------------------------------------------- data */

async function load() {
  const my = ++seq;
  const at = cursor;
  const tt = ose.sources.get('timetable');
  const dir = ose.sources.get('plans');
  const logPath = ose.sources.get('systemsLog');
  // each region says "loading…" only if its reads take longer than a blink; a fast reload keeps
  // the previous day on screen until the new one replaces it
  const stopTl = loadingLine($('#dyTl')), stopSys = loadingLine(sysEl), stopTasks = loadingLine(tasksEl);
  try {
    // the month's file is found by listing `<plans>/<year>/`: names after the date are free
    const [hasTt, ttText, hasDir, found, logText] = await Promise.all([
      ose.files.exists(tt),
      ose.files.exists(tt).then((y) => (y ? ose.files.read(tt) : '')),
      ose.files.exists(dir),
      resolvePlanPath(ose.files, at, dir),
      ose.files.exists(logPath).then((y) => (y ? ose.files.read(logPath) : '')),
    ]);
    const planText = found.exists ? await ose.files.read(found.path) : '';
    if (my !== seq || !el) return;
    ttFile = tt; plansDir = dir; planFile = found.path; logFile = logPath;
    ttMissing = !hasTt; dirMissing = !hasDir; planMissing = !found.exists;
    events = parseTimetable(ttText);
    plan = planText ? parseMonthlyPlan(planText) : null;
    log = parseSystemsLog(logText);
    systems = systemsFor(plan, log, at);
    stopTl(); stopSys();
    render({ tasks: false });
    await indexTasks();
    if (my !== seq || !el) return;
    stopTasks();
    renderMeta(); renderTasks();
  } catch (e) {
    console.error('[day]', e);
    flash(`day: ${e.message || e}`);
  } finally {
    // a superseded or failed load must not leave a timer that would print "loading…" later
    stopTl(); stopSys(); stopTasks();
  }
}

/* ------------------------------------------------------------- interaction */

function go(delta) {
  cursor = delta === 0 ? new Date() : addDays(cursor, delta);
  expanded = new Set();
  ose.state('date').set(ymd(cursor));
  load();
}

function onClick(ev) {
  const sys = ev.target.closest('[data-system]');
  if (sys) { toggleSystem(sys.dataset.system); return; }
  const tg = ev.target.closest('[data-toggle]');
  if (tg) { onToggleTask(tg.dataset.toggle); return; }
  const more = ev.target.closest('[data-more]');
  if (more) { expanded.add(more.dataset.more); renderTasks(); return; }
  const src = ev.target.closest('.tk-src, .dy-grp-head');
  if (src && src.dataset.path) {
    // a task row knows the 1-based line it came from; the route carries it so the editor lands
    // the caret on that line
    const route = { type: 'page', path: src.dataset.path };
    if (src.dataset.line) route.line = Number(src.dataset.line);
    ose.route.navigate(route);
    return;
  }
  const link = ev.target.closest('.v-link');
  if (link && link.dataset.path) ose.route.navigate({ type: 'page', path: link.dataset.path });
}

/* ------------------------------------------------------------------- view */

const view = {
  name: 'day',
  title: 'Day',
  order: 10,
  icon: 'day',

  async mount(host) {
    el = host;
    el.innerHTML = skeleton();
    root = $('#dyRoot');
    el.addEventListener('click', onClick);
    offNav = bindNav(root, { prev: () => go(-1), next: () => go(1), today: () => go(0) });
    mountTiles();

    // the layout follows the main column, not the window: the sidebar changes how much room
    // there is.
    const fit = (w) => { if (root) root.classList.toggle('narrow', w < NARROW); };
    fit(el.clientWidth);              // right on the first paint, before the observer fires
    ro = new ResizeObserver((entries) => fit(entries[0].contentRect.width));
    ro.observe(el);

    offSources = ose.bus.on('sources', () => load());
    const saved = ose.state('date').get();
    if (!el) return;
    cursor = (saved && parseDate(saved)) || new Date();
    // the title needs no read: it is on screen before the data, and the keys work from the
    // first frame because focus goes to the root before the reads, not after
    $('#dyTitle').textContent = dayTitle(cursor);
    root.focus({ preventScroll: true });
    await load();
    tickTimer = setInterval(tick, 30000);
    return { unmount: view.unmount, refresh: view.refresh };
  },

  unmount() {
    if (offSources) { offSources(); offSources = null; }
    if (offNav) { offNav(); offNav = null; }
    if (ro) { ro.disconnect(); ro = null; }
    clearInterval(tickTimer); tickTimer = null;
    clearTimeout(flashTimer); flashTimer = null;
    unmountTiles();
    if (el) el.removeEventListener('click', onClick);
    el = null; root = null;
  },

  refresh() { if (el) load(); },
};

/* --------------------------------------------------------------- the module */

export async function activate(app) {
  ose = app;
  offTasks = initTasks(app);

  ose.views.register('day', view);
  ose.commands.register({
    id: 'view.day', title: 'Day', group: 'view',
    run: () => ose.route.navigate({ type: 'view', name: 'day' }),
  });

  // The two halves of the old Day view, now tiles like any other module's — same markup, same
  // look, and a module's tile takes its place beside them by registering one.
  ose.tiles.register({
    id: 'day.systems', title: 'systems', order: 10,
    render: (box) => { sysEl = box; renderSystems(); return { refresh: renderSystems, unmount: () => { if (sysEl === box) sysEl = null; } }; },
  });
  ose.tiles.register({
    id: 'day.tasks', title: 'tasks', order: 20,
    render: (box) => { tasksEl = box; box.classList.add('dy-tasks'); renderTasks(); return { refresh: renderTasks, unmount: () => { if (tasksEl === box) tasksEl = null; } }; },
  });

  // The vault changing under the view is the same thing as the day changing: re-read.
  ose.watch(() => { if (el) load(); });

  addStyles();
}

export function deactivate() {
  if (offTasks) { offTasks(); offTasks = null; }
  removeStyles();
}

/* ------------------------------------------------------------------ styles */

// docs/MODULES.md rule 3: a stylesheet is a <link> the entry adds and `deactivate` takes away.
// `import.meta.url` is this file, so the href resolves against the module folder in the host
// and in the browser dev server alike, and nothing here names an origin.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = new URL('./day.css', import.meta.url).href;
  document.head.appendChild(sheet);
}
function removeStyles() { if (sheet) { sheet.remove(); sheet = null; } }
