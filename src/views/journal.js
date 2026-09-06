// Journal view: write once at the top, read the whole record underneath.
//
// The file format is Hassan's and does not change: a new day gets "# YYYY-MM-DD - Journal"
// then the text; a second thought the same day is appended after a "---" separator. Existing
// text is never edited by this view; there are no edit controls at all. Older files carry a
// "# DD-MM-YYYY - Journal" heading instead, so the date always comes from the file name.
//
// Layout: the date as the page title, weekday / time / gap line in mono under it, the writing
// box, then every entry latest first in one continuous column with the date in a 96px left
// margin. Newest 30 days render first, the rest on scroll or a "show earlier" row.
//
// The record has two modes, remembered under `views.journal.mode`: `full` prints every entry,
// `compact` prints one 28px line per day (date, weekday, first line) that expands in place when
// clicked. The writing box grows with its content without a maximum; the page scrolls, it does not.

import { esc, status } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { flash, navigate, getViewState, setViewState } from './shell-compat.js';
import './journal.css';

/* --------------------------------------------------------------- constants */

const DEFAULT_DIR = 'Personal/4. Journal';
const DRAFT = 'os.journal.draft';
const CHUNK = 30;                 // days rendered per pass
const MIN_ROWS = 6;               // the empty box is six lines tall; there is no maximum
const MODES = ['full', 'compact'];

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The journal folder. Configurable so a harness can point at a scratch copy. */
let DIR = DEFAULT_DIR;
export function setJournalDir(dir) { DIR = String(dir || DEFAULT_DIR).replace(/\/+$/, ''); }
export function getJournalDir() { return DIR; }

/* ----------------------------------------------------------------- helpers */

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fileFor = (d) => `${ymd(d)} - Journal.md`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

/** `2026-09-06 - Journal.md` -> a local Date, or null when the name is not dated. */
function dateFromName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

const lsGet = () => { try { return localStorage.getItem(DRAFT) || ''; } catch { return ''; } };
const lsSet = (v) => { try { v ? localStorage.setItem(DRAFT, v) : localStorage.removeItem(DRAFT); } catch { /* private mode */ } };

/* ------------------------------------------------------------ file parsing */

/**
 * One file -> the thoughts written that day. The leading "# ... - Journal" heading is dropped
 * (the date comes from the file name) and standalone `---` lines separate thoughts.
 */
function parseEntry(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (/^#\s+.*journal\s*$/i.test(lines[0] || '')) lines.shift();
  const out = [];
  let cur = [];
  for (const ln of lines) {
    if (/^\s*---+\s*$/.test(ln)) { out.push(cur.join('\n')); cur = []; }
    else cur.push(ln);
  }
  out.push(cur.join('\n'));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Read-only, minimal: paragraphs, and an inner heading kept as a bold line. */
function renderThought(text) {
  const blocks = String(text).split(/\n\s*\n/);
  const out = [];
  for (const b of blocks) {
    const t = b.trim();
    if (!t) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h && !t.includes('\n')) { out.push(`<p class="jr-h">${esc(h[1].trim())}</p>`); continue; }
    out.push(`<p>${esc(t).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}

/* ------------------------------------------------------------------- state */

let el = null;                    // the element the shell handed us
let days = [];                    // [{name, path, date, year, text?, thoughts?}] newest first
let sig = '';                     // signature of the listing, so refresh() is cheap
let shown = 0;                    // how many days are in the DOM
let wantFocus = false;
let loading = false;
let clock = null;                 // 30s tick
let io = null;                    // sentinel observer for lazy rendering
let scroller = null;              // the element that scrolls this view, watched as a fallback
let titleYmd = '';                // the date the header is drawn for
let mode = 'full';                // 'full' | 'compact', persisted in views.journal.mode
let opened = new Set();           // day names expanded while in compact mode

const $ = (s) => el && el.querySelector(s);

/* ------------------------------------------------------------------ header */

function gapLine() {
  if (!days.length) return 'no entry yet';
  const n = daysBetween(days[0].date, new Date());
  if (n <= 0) return 'written today';
  if (n === 1) return 'last written yesterday';
  return `last written ${n} days ago`;
}

function drawHeader() {
  if (!el) return;
  const now = new Date();
  if (ymd(now) !== titleYmd) { titleYmd = ymd(now); $('#jrTitle').textContent = titleYmd; }
  $('#jrWhen').textContent = `${DAY_LONG[now.getDay()]} ${hhmm(now)}`;
  $('#jrGap').textContent = gapLine();
}

/* ------------------------------------------------------------------ record */

const bodyHtml = (day) => ((day.thoughts && day.thoughts.length)
  ? day.thoughts.map(renderThought).join('<hr class="jr-sep">')
  : '<p class="faint">empty entry</p>');

/** The first line of an entry, for the compact row. Headings lose their hashes. */
function firstLine(day) {
  const src = (day.thoughts && day.thoughts[0]) || '';
  for (const ln of String(src).split('\n')) {
    const t = ln.trim().replace(/^#{1,6}\s+/, '').trim();
    if (t) return t;
  }
  return day.text === undefined ? '' : 'empty entry';
}

function dayHtml(day) {
  const d = day.date;
  return `
<div class="jr-day" data-name="${esc(day.name)}">
  <div class="jr-date">
    <span class="jr-d1">${pad2(d.getDate())} ${MONTH_SHORT[d.getMonth()]}</span>
    <span class="jr-d2">${DAY_SHORT[d.getDay()]}</span>
    <button type="button" class="jr-open" data-open="${esc(day.name)}">open as page</button>
  </div>
  <div class="jr-body text-select">${bodyHtml(day)}</div>
</div>`;
}

/** One 28px line per day. Clicking it expands that entry in place, clicking again folds it. */
function compactHtml(day) {
  const d = day.date;
  const open = opened.has(day.name);
  const line = firstLine(day);
  return `
<div class="jr-c${open ? ' open' : ''}" data-name="${esc(day.name)}">
  <button type="button" class="jr-c-row" data-expand="${esc(day.name)}" aria-expanded="${open}">
    <span class="jr-c-d">${pad2(d.getDate())} ${MONTH_SHORT[d.getMonth()]}</span>
    <span class="jr-c-w">${DAY_SHORT[d.getDay()]}</span>
    <span class="jr-c-t">${esc(line)}</span>
  </button>
  <button type="button" class="jr-open jr-c-open" data-open="${esc(day.name)}">open as page</button>
  ${open ? `<div class="jr-c-body jr-body text-select">${bodyHtml(day)}</div>` : ''}
</div>`;
}

/** Rebuild the rendered part of the record from memory. No reads, so no flicker. */
function drawRecord() {
  const box = $('#jrRecord');
  if (!box) return;
  box.classList.toggle('is-compact', mode === 'compact');
  if (!days.length) {
    box.innerHTML = '<div class="jr-empty">no entries yet</div>';
    $('#jrMore').hidden = true;
    return;
  }
  const one = mode === 'compact' ? compactHtml : dayHtml;
  const list = days.slice(0, shown);
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && list[i].year !== list[i - 1].year) parts.push(`<div class="jr-year">${list[i].year}</div>`);
    parts.push(one(list[i]));
  }
  box.innerHTML = parts.join('');
  const rest = days.length - shown;
  const more = $('#jrMore');
  more.hidden = rest <= 0;
  if (rest > 0) $('#jrMoreBtn').textContent = `show earlier (${rest})`;
}

/** Read the text of every day up to `target`, then draw once. */
async function renderTo(target) {
  if (!el) return;
  const next = Math.min(days.length, Math.max(0, target));
  if (next <= shown) return;
  const need = days.slice(shown, next).filter((d) => d.text === undefined);
  await Promise.all(need.map(async (d) => {
    try { d.text = await bridge.readText(d.path); }
    catch (e) { console.warn('[views:journal] read', d.path, e); d.text = ''; }
    d.thoughts = parseEntry(d.text);
  }));
  if (!el) return;
  shown = next;
  drawRecord();
}

let filling = false;
async function renderMore() {
  if (filling) return;
  filling = true;
  try { await renderTo(shown + CHUNK); } finally { filling = false; }
}

/** The scroller the view sits in (the shell's main column, or the harness's). */
function scrollParent(node) {
  for (let p = node; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

/**
 * Draw the next chunk once the tail comes close. An IntersectionObserver does the same job,
 * but it is silent in some embedded WebViews, so the scroll position is checked as well.
 */
function maybeMore() {
  const more = $('#jrMore');
  if (!more || more.hidden) return;
  const h = window.innerHeight || document.documentElement.clientHeight || 0;
  if (more.getBoundingClientRect().top < h + 400) renderMore();
}

/* -------------------------------------------------------------------- data */

async function load() {
  if (loading || !el) return;
  loading = true;
  try {
    let items = [];
    try { items = await bridge.list(DIR); } catch { items = []; }
    const files = items
      .filter((i) => i.kind === 'file' && /\.md$/i.test(i.name) && dateFromName(i.name))
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

    const newest = files[0];
    const next = `${files.map((f) => f.name).join('|')}::${newest ? `${newest.mtime || ''}:${newest.size || ''}` : ''}`;
    if (next === sig && days.length) { drawHeader(); return; }
    sig = next;

    // reuse the parsed text of every day that is still there; the newest file may have grown
    const keep = new Map(days.map((d) => [d.name, d]));
    days = files.map((f) => {
      const old = keep.get(f.name);
      if (old) return old;
      const date = dateFromName(f.name);
      return { name: f.name, path: `${DIR}/${f.name}`, date, year: date.getFullYear() };
    });
    if (days[0]) { days[0].text = undefined; days[0].thoughts = undefined; }

    const was = shown;
    shown = 0;
    drawHeader();
    if (!days.length) drawRecord();
    else await renderTo(Math.max(CHUNK, was));
  } catch (e) {
    console.error('[views:journal]', e);
    flash(`journal: ${e.message || e}`);
  } finally {
    loading = false;
  }
}

/* -------------------------------------------------------------------- save */

async function save() {
  const ta = $('#jrText'), btn = $('#jrSave');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  btn.disabled = true;
  try {
    const now = new Date(), name = fileFor(now), path = `${DIR}/${name}`;
    if (await bridge.exists(path)) {
      const cur = await bridge.readText(path);
      const gap = cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
      await bridge.appendText(path, `${gap}---\n\n${text}\n`);
    } else {
      await bridge.writeText(path, `# ${ymd(now)} - Journal\n\n${text}\n`);
    }
    ta.value = '';
    persistNow('');
    grow(ta);
    syncSave();
    status.set('save', `saved ${hhmm(new Date())}`);

    // splice today into the record in place: one small read, no rebuild from scratch
    const fresh = await bridge.readText(path);
    let day = days.find((d) => d.name === name);
    if (!day) {
      day = { name, path, date: startOfDay(now), year: now.getFullYear() };
      days.unshift(day);            // today is always the newest
      shown++;
    }
    day.text = fresh;
    day.thoughts = parseEntry(fresh);
    sig = '';                     // the next refresh() re-lists and re-signs
    drawHeader();
    drawRecord();
  } catch (e) {
    console.error('[views:journal] save', e);
    flash(`journal write failed: ${e.message || e}`);
    status.set('save', 'save failed');
  }
  syncSave();
}

/* ---------------------------------------------------------------- composer */

/**
 * The box is as tall as its text: six lines when empty, and after that whatever the content
 * needs, with no ceiling and no inner scrollbar. Long entries make the page scroll instead.
 */
function grow(ta) {
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 26;
  const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const min = Math.round(lh * MIN_ROWS + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + borders);
  ta.style.overflowY = 'hidden';
  if (!ta.value) { ta.style.height = `${min}px`; return; }
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(min, ta.scrollHeight + borders)}px`;
}

function syncSave() {
  const ta = $('#jrText'), btn = $('#jrSave');
  if (ta && btn) btn.disabled = !ta.value.trim();
}

// own debounce, because saving must be able to cancel a pending draft write
let persistT = null;
const persist = (v) => { clearTimeout(persistT); persistT = setTimeout(() => lsSet(v), 250); };
const persistNow = (v) => { clearTimeout(persistT); lsSet(v); };

function onInput(e) { grow(e.target); syncSave(); persist(e.target.value || ''); }

function onKeydown(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
}

function onClick(ev) {
  const open = ev.target.closest('[data-open]');
  if (open) { navigate({ type: 'page', path: `${DIR}/${open.dataset.open}` }); return; }
  const m = ev.target.closest('[data-mode]');
  if (m) { setMode(m.dataset.mode); return; }
  const ex = ev.target.closest('[data-expand]');
  if (ex) {
    const name = ex.dataset.expand;
    if (opened.has(name)) opened.delete(name); else opened.add(name);
    drawRecord();
    return;
  }
  if (ev.target.closest('#jrMoreBtn')) renderMore();
}

/* -------------------------------------------------------------------- mode */

function drawMode() {
  const box = $('#jrMode');
  if (!box) return;
  for (const b of box.querySelectorAll('[data-mode]')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function setMode(next) {
  if (!MODES.includes(next) || next === mode) return;
  mode = next;
  drawMode();
  drawRecord();
  setViewState('journal', { mode });
}

/* -------------------------------------------------------------------- view */

function skeleton() {
  return `
<div class="view-root jr-root">
  <div class="page-col">
    <h1 class="page-title" id="jrTitle">${esc(ymd(new Date()))}</h1>
    <div class="page-meta jr-meta">
      <span id="jrWhen">&nbsp;</span>
      <span class="jr-gap" id="jrGap">&nbsp;</span>
    </div>

    <div class="jr-compose">
      <textarea class="input jr-input text-select" id="jrText" rows="6"
        placeholder="Today. Write it as it comes; the file keeps your wording."></textarea>
      <div class="jr-foot">
        <span class="jr-hint">ctrl+enter</span>
        <button class="btn primary" id="jrSave" disabled>Save</button>
      </div>
    </div>

    <div class="jr-bar">
      <div class="jr-mode" id="jrMode">
        <button type="button" data-mode="full" class="on" aria-pressed="true">full</button>
        <span class="jr-mode-sep" aria-hidden="true">|</span>
        <button type="button" data-mode="compact" aria-pressed="false">compact</button>
      </div>
    </div>
    <div class="jr-record" id="jrRecord"></div>
    <div class="jr-more" id="jrMore" hidden>
      <button type="button" class="jr-more-btn" id="jrMoreBtn">show earlier</button>
    </div>
  </div>
</div>`;
}

export const journal = {
  name: 'journal',
  title: 'Journal',
  icon: 'journal',

  async mount(host) {
    el = host;
    days = []; sig = ''; shown = 0; titleYmd = ''; opened = new Set();
    el.innerHTML = skeleton();

    const ta = $('#jrText');
    ta.value = lsGet();
    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', onKeydown);
    $('#jrSave').addEventListener('click', save);
    el.addEventListener('click', onClick);
    grow(ta);
    syncSave();
    // fonts and the injected stylesheet can land a frame late; measure again once
    requestAnimationFrame(() => { if (el) grow($('#jrText')); });

    drawHeader();
    clock = setInterval(drawHeader, 30000);

    const saved = await getViewState('journal');
    if (!el) return;
    mode = MODES.includes(saved.mode) ? saved.mode : 'full';
    drawMode();

    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) renderMore(); });
      io.observe($('#jrMore'));
    }
    scroller = scrollParent(el) || window;
    scroller.addEventListener('scroll', maybeMore, { passive: true });

    await load();
    if (wantFocus) { wantFocus = false; ta.focus(); }
  },

  unmount() {
    clearInterval(clock); clock = null;
    if (io) { io.disconnect(); io = null; }
    if (scroller) { scroller.removeEventListener('scroll', maybeMore); scroller = null; }
    if (el) el.removeEventListener('click', onClick);
    status.set('save', null);
    el = null;
  },

  refresh() { if (el) load(); },

  /** Used by the `journal.new` command once the shell has mounted the view. */
  focusComposer() {
    wantFocus = true;
    const ta = $('#jrText');
    if (ta) { wantFocus = false; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  },
};
