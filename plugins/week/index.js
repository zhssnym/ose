// Week: the timetable grid for the current week, a "now / next" box, and per-day totals.
// The week comes from the `timetable` source and nowhere else; the path is whatever settings
// says, and the view re-reads on the `sources` event. The file no longer carries the (Q1)/(Q2)
// alternating-week markers, so there is no toggle and no stored state.

import { esc, loadingLine } from 'ose:ui';
import {
  TIMETABLE, parseTimetable, pad, dayIdx, addDays, startOfWeek,
  hhmm, dur, until, DAY_SHORT,
} from 'ose:md';

let ose = null;   // the facade, from activate()

/** A transient line in the status bar; the view always gives the slot back. */
let flashTimer = null;
function flash(text) {
  ose.status.set('doc', text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ose.status.set('doc', null), 6000);
}

const { START, END, HOUR_H, WORK_KINDS } = TIMETABLE;
const BODY_H = (END - START) * HOUR_H;
const TIME_MIN = 2 * HOUR_H;     // a block needs two hour rows before it prints its times
const SUB_MIN = 3 * HOUR_H;      // and three before the room or note fits under them

let el = null, events = [], tickTimer = null, dayTimer = null, lastDay = -1, loading = false;
let path = '', offSources = null, again = false;

const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const $ = (sel) => el && el.querySelector(sel);

/* ------------------------------------------------------------------ chrome */

function skeleton() {
  const monday = startOfWeek(new Date());
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return `
<div class="view-root" tabindex="-1" id="wkRoot">
  <div class="page-col">
    <h1 class="page-title">Week</h1>
    <div class="page-meta" id="wkMeta">
      <button type="button" class="v-link" data-path="${esc(path)}">${esc(path)}</button>
      <span>${esc(fmt(monday))} to ${esc(fmt(addDays(monday, 6)))}</span>
      <span id="wkSource"></span>
    </div>

    <div class="wk-now">
      <div class="wk-now-row"><span class="label wk-k">now</span><span class="wk-v" id="wkNow">&nbsp;</span></div>
      <div class="wk-now-row"><span class="label wk-k">next</span><span class="wk-v" id="wkNext">&nbsp;</span></div>
    </div>

    <div class="wk-scroll"><div class="wk-grid" id="wkGrid" style="--wk-body:${BODY_H}px"></div></div>
    <div class="wk-sum mono-sm" id="wkSum">&nbsp;</div>
    <div class="empty" id="wkEmpty" hidden></div>
  </div>
</div>`;
}

/* -------------------------------------------------------------------- grid */

function build() {
  const grid = $('#wkGrid');
  if (!grid) return;
  const ti = dayIdx(new Date());
  lastDay = ti;
  const monday = startOfWeek(new Date());
  const out = [];

  // header row
  out.push('<div class="wk-hd wk-corner"></div>');
  DAY_SHORT.forEach((d, i) => {
    const date = addDays(monday, i);
    out.push(`<div class="wk-hd${i === ti ? ' today' : ''}"><span class="wk-hd-d">${d}</span><span class="wk-hd-n mono-sm">${pad(date.getDate())}</span></div>`);
  });

  // hour gutter: each label sits on its own line, not under it
  let times = '<div class="wk-times">';
  for (let h = Math.ceil(START); h <= Math.floor(END); h++) {
    const y = (h - START) * HOUR_H;
    times += `<div class="wk-t mono-sm" style="top:${Math.max(0, y - 6)}px">${pad(h)}h</div>`;
  }
  out.push(times + '</div>');

  // day columns
  for (let d = 0; d < 7; d++) {
    let col = `<div class="wk-col${d === ti ? ' today' : ''}" data-d="${d}">`;
    for (let h = Math.ceil(START) + 1; h <= Math.floor(END); h++) {
      col += `<div class="wk-line" style="top:${(h - START) * HOUR_H}px"></div>`;
    }
    for (const e of events) {
      if (e.d !== d) continue;
      const top = (e.sm / 60 - START) * HOUR_H;
      const h = Math.max(15, (e.em - e.sm) / 60 * HOUR_H - 2);
      const time = h >= TIME_MIN ? `<span class="wk-ev-t mono-sm">${hhmm(e.sm)} to ${hhmm(e.em)}</span>` : '';
      const sub = e.sub && h >= SUB_MIN ? `<span class="wk-ev-s mono-sm">${esc(e.sub)}</span>` : '';
      col += `<div class="wk-ev t-${e.type}" data-s="${e.sm}" data-e="${e.em}" title="${esc(e.t)}${e.sub ? ' · ' + esc(e.sub) : ''} · ${hhmm(e.sm)} to ${hhmm(e.em)}" style="top:${top}px;height:${h}px"><span class="wk-ev-n">${esc(e.t)}</span>${time}${sub}</div>`;
    }
    if (d === ti) col += '<div class="wk-nowline" id="wkNowline"><span class="wk-nowdot"></span></div>';
    out.push(col + '</div>');
  }

  // footer: personal work per day
  const perDay = new Array(7).fill(0);
  const kinds = new Set(WORK_KINDS.map(([k]) => k));
  for (const e of events) if (kinds.has(e.kind)) perDay[e.d] += e.em - e.sm;
  out.push('<div class="wk-ft wk-ft-k mono-sm">work</div>');
  perDay.forEach((m, i) => out.push(`<div class="wk-ft mono-sm${i === ti ? ' today' : ''}${m ? '' : ' faint'}">${m ? dur(m) : '–'}</div>`));

  grid.innerHTML = out.join('');

  // totals line
  const sums = {};
  for (const e of events) sums[e.kind] = (sums[e.kind] || 0) + e.em - e.sm;
  const parts = WORK_KINDS.filter(([k]) => sums[k]).map(([k, label]) => `${label} ${dur(sums[k])}`);
  const total = WORK_KINDS.reduce((a, [k]) => a + (sums[k] || 0), 0);
  $('#wkSum').textContent = parts.length ? `personal work this week · ${parts.join(' · ')} · total ${dur(total)}` : ' ';

  tick();
}

function tick() {
  if (!el) return;
  const m = nowMinutes(), ti = dayIdx(new Date());
  const line = $('#wkNowline');
  if (line) {
    const y = (m / 60 - START) * HOUR_H;
    line.hidden = y < 0 || y > BODY_H;
    line.style.top = `${y}px`;
  }
  const today = events.filter((e) => e.d === ti);
  const cur = today.find((e) => e.sm <= m && m < e.em);
  const nxt = today.find((e) => e.sm > m);
  const now = $('#wkNow'), next = $('#wkNext');
  if (!events.length) { now.innerHTML = '&nbsp;'; next.innerHTML = '&nbsp;'; return; }
  now.innerHTML = cur
    ? `<span class="wk-dot t-${cur.type}"></span>${esc(cur.t)}${cur.sub && cur.type !== 'class' ? ` <span class="faint">· ${esc(cur.sub)}</span>` : ''} <span class="faint mono-sm">until ${hhmm(cur.em)}</span>`
    : '<span class="wk-dot t-rest"></span><span class="faint">nothing scheduled</span>';
  next.innerHTML = nxt
    ? `${esc(nxt.t)} <span class="faint mono-sm">${hhmm(nxt.sm)} · ${until(nxt.sm - m)}</span>`
    : '<span class="faint">nothing else today</span>';

  for (const node of el.querySelectorAll(`.wk-col[data-d="${ti}"] .wk-ev`)) {
    const s = +node.dataset.s, e = +node.dataset.e;
    node.classList.toggle('past', e <= m);
    node.classList.toggle('live', s <= m && m < e);
  }
}

/* -------------------------------------------------------------------- data */

async function load() {
  // a source change during a read must not be swallowed by the coalescing guard
  if (loading) { again = true; return; }
  loading = true;
  // the grid says "loading…" only when the read outlasts a blink; a fast re-read keeps the
  // grid that is already there until build() replaces it
  const stop = loadingLine($('#wkGrid'));
  try {
    path = ose.sources.get('timetable');
    const link = $('#wkMeta .v-link');
    if (link) { link.dataset.path = path; link.textContent = path; }
    const has = await ose.files.exists(path);
    events = has ? parseTimetable(await ose.files.read(path)) : [];
    stop();
    const empty = $('#wkEmpty');
    if (empty) {
      empty.hidden = events.length > 0;
      // a missing source is never a silent fallback: say the path and where to change it
      empty.textContent = has
        ? `no blocks parsed from ${path}`
        : `no file at ${path} · set it in settings (ctrl+,)`;
    }
    if ($('#wkSource')) $('#wkSource').textContent = `${events.length} blocks`;
    build();
  } catch (e) {
    console.error('[week]', e);
    flash(`week: ${e.message || e}`);
    // a failed read leaves the grid frame empty (a loading line must not stay behind) and says
    // what went wrong in the same slot a missing file uses
    if (stop()) { const g = $('#wkGrid'); if (g) g.innerHTML = ''; }
    const empty = $('#wkEmpty');
    if (empty) { empty.hidden = false; empty.textContent = `could not read ${path}: ${e.message || e}`; }
  } finally {
    stop();
    loading = false;
    if (again) { again = false; load(); }
  }
}

function onClick(ev) {
  const link = ev.target.closest('.v-link');
  if (link && link.dataset.path) ose.route.navigate({ type: 'page', path: link.dataset.path });
}

/* ------------------------------------------------------------------- view */

const view = {
  name: 'week',
  title: 'Week',
  order: 20,
  icon: 'week',

  async mount(host) {
    el = host;
    path = ose.sources.get('timetable');
    el.innerHTML = skeleton();
    el.addEventListener('click', onClick);
    offSources = ose.bus.on('sources', () => load());
    // focus lands on the view, not nowhere, so Tab reaches the path link and the shell's keys
    // have a target from the first frame
    const root = $('#wkRoot');
    if (root) root.focus({ preventScroll: true });
    await load();
    tickTimer = setInterval(tick, 30000);
    dayTimer = setInterval(() => { if (dayIdx(new Date()) !== lastDay) build(); }, 60000);
  },

  unmount() {
    if (offSources) { offSources(); offSources = null; }
    clearTimeout(flashTimer); flashTimer = null;
    clearInterval(tickTimer); tickTimer = null;
    clearInterval(dayTimer); dayTimer = null;
    if (el) el.removeEventListener('click', onClick);
    el = null;
  },

  refresh() { if (el) load(); },
};

/* --------------------------------------------------------------- the module */

export async function activate(app) {
  ose = app;
  ose.views.register('week', view);
  ose.commands.register({
    id: 'view.week', title: 'Week', group: 'view',
    run: () => ose.route.navigate({ type: 'view', name: 'week' }),
  });
  // The timetable changing on disk is the only thing this view reads.
  ose.watch(() => { if (el) load(); });
  addStyles();
}

export function deactivate() { removeStyles(); }

/* ------------------------------------------------------------------ styles */

// docs/MODULES.md rule 3: a <link> the entry adds and `deactivate` takes away, resolved
// against the module's own folder so nothing here names an origin.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = new URL('./week.css', import.meta.url).href;
  document.head.appendChild(sheet);
}
function removeStyles() { if (sheet) { sheet.remove(); sheet = null; } }
