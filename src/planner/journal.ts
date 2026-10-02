// Journal: the whole record, newest first, and one way to write: "Write today" opens today's
// file in the editor (H23). The composer and its localStorage draft are gone; the editor has
// drafts, versions and the leave gate, and a journal entry is a page like any other. Text the
// old composer kept unsaved in localStorage (`os.journal.draft`) is offered once per start until
// it is added to today's entry or discarded on purpose (`recoverOldDraft`); never dropped quietly.
//
// The folder is `journal` in Settings › Planner. An entry is any `YYYY-MM-DD*.md` in it; the date
// comes from the file name, never from the heading. Today's file is `YYYY-MM-DD.md`, created with
// `# YYYY-MM-DD - Journal` by an exclusive create when it is not there yet; when a file dated
// today exists under another name, that one is opened instead. A journal folder that is not
// there is never made quietly (it may have been renamed while the app was closed): Write today
// says so and makes it only on "Create it". This view writes nothing else.
//
// The record has two modes (`journalMode`): full prints every entry, compact one line per day
// that expands in place. Newest 30 days first, the rest on scroll or "Show earlier". An entry is
// drawn with `ose:editor`'s `render` when it is there, so maths and links read as on the page,
// and a link in an entry opens what it points at, with the mouse or with Enter.

import { confirm, esc, loadingLine, toast } from 'ose:ui';
import {
  clock, dateFromName, daysBetween, journalFileName, journalHeading, shortDate, weekdayName, ymd,
} from './dates.ts';
import { naturalCompare } from './plans.ts';
import { bindLinks, detectedHtml, missingHtml, openPlannerSettings } from './nav.ts';

const CHUNK = 30;            // days rendered per pass
const MODES = ['full', 'compact'];

/* ------------------------------------------------------------------ the entry */

/** The H1 an entry opens with, which the record drops: the date comes from the file name. */
function isEntryHeading(line) {
  const m = /^#\s+(.+?)\s*$/.exec(String(line ?? ''));
  if (!m) return false;
  const title = m[1] ?? '';
  return /journal\s*$/i.test(title) || /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(title);
}

/** One file -> the thoughts written that day, split on standalone `---` lines. */
function parseEntry(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (isEntryHeading(lines[0])) lines.shift();
  const out: any[] = [];
  let cur: any[] = [];
  for (const ln of lines) {
    if (/^\s*---+\s*$/.test(ln)) { out.push(cur.join('\n')); cur = []; } else cur.push(ln);
  }
  out.push(cur.join('\n'));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Without `ose:editor`: paragraphs, and an inner heading kept as a bold line. */
function plainThought(text) {
  const out: any[] = [];
  for (const b of String(text).split(/\n\s*\n/)) {
    const t = b.trim();
    if (!t) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h && !t.includes('\n')) { out.push(`<p class="jr-h">${esc((h[1] ?? '').trim())}</p>`); continue; }
    out.push(`<p>${esc(t).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}

/** The first line of an entry, for the compact row. */
function firstLine(day) {
  for (const ln of String((day.thoughts && day.thoughts[0]) || '').split('\n')) {
    const t = ln.trim().replace(/^#{1,6}\s+/, '').trim();
    if (t) return t;
  }
  return day.text === undefined ? '' : 'Empty entry';
}

/** Journal files in a listing, newest first. */
function entriesOf(items) {
  return (items || [])
    .filter((i) => i.kind === 'file' && /\.md$/i.test(i.name) && dateFromName(i.name))
    .sort((a, b) => naturalCompare(b.name, a.name));
}

/* ------------------------------------------------------------------ Write today */

/**
 * Today's journal file: the one dated today in the folder, else `<journal>/YYYY-MM-DD.md` made
 * with its heading (`[exists]` = it appeared meanwhile: that one). A folder that is not there is
 * made only with `createFolder`; otherwise a toast says so and offers "Create it".
 * @param store the planner settings store
 * @param opts `then` runs after
 *   "Create it" made the folder and the file
 * @returns the path, or '' when there is none (the toast has said why)
 */
async function ensureToday(ose: any, store: any, { createFolder = false, then = null }: { createFolder?: boolean; then?: ((path: string) => unknown) | null; } = {}): Promise<string> {
  await store.ready;
  const folder = store.get().journal;
  if (!folder) {
    toast('No journal folder chosen. Choose one in Settings › Planner.', 'warn');
    openPlannerSettings(ose);
    return '';
  }
  const now = new Date();
  const name = journalFileName(now);
  let items: any[] = [];
  if (!createFolder) {
    let st: any = null;
    try { st = await ose.files.stat(folder); } catch (err) {
      const e = (err as { code?: string, message?: string });
      toast(`Could not read ${folder}: ${(e && e.message) || e}`, 'err');
      return '';
    }
    if (!st || !st.exists || st.kind !== 'dir') {
      // renamed or moved while the app was closed, most likely: a new empty folder under the
      // old name would split the journal, so it is made only when asked
      const make = async () => {
        const path = await ensureToday(ose, store, { createFolder: true });
        if (path && then) await then(path);
      };
      toast(`Nothing at ${folder}. Choose the journal folder in Settings › Planner, or create it.`, 'warn', 0, {
        actions: [{ label: 'Choose…', run: () => openPlannerSettings(ose) }, { label: 'Create it', run: make }],
      });
      return '';
    }
    try { items = await ose.files.list(folder); } catch (err) {
      const e = (err as { code?: string, message?: string });
      toast(`Could not read ${folder}: ${(e && e.message) || e}`, 'err');
      return '';
    }
  }
  const today = entriesOf(items).filter((i) => i.name.startsWith(ymd(now)));
  const hit = today.find((i) => i.name === name) || today[today.length - 1];
  if (hit) return `${folder}/${hit.name}`;
  try {
    return (await ose.fileops.create(folder, name, { text: `${journalHeading(now)}\n\n` })).path;
  } catch (err) {
    const e = (err as { code?: string, message?: string });
    if (e && e.code === 'exists') return `${folder}/${name}`;
    toast(`Today's journal could not be created: ${(e && e.message) || e}`, 'err');
    return '';
  }
}

/** Open `path` with the caret on its last line. */
async function openAtEnd(ose, path) {
  let line = 1;
  try {
    const lines = String(await ose.files.read(path)).split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    line = Math.max(1, lines.length);
  } catch { /* the top of the file, then */ }
  return ose.route.navigate({ type: 'page', path, line });
}

/**
 * `journal.today`: open today's journal file in the editor, creating `<journal>/YYYY-MM-DD.md`
 * with its heading when there is none. The caret goes to the last line.
 * @param store the planner settings store
 * @returns false when there is no journal folder or the file could not be made
 */
export async function openToday(ose: any, store: any): Promise<boolean> {
  const path = await ensureToday(ose, store, { then: (p) => openAtEnd(ose, p) });
  if (!path) return false;
  return openAtEnd(ose, path);
}

/* ------------------------------------------------------------------ the old composer's draft */

const OLD_DRAFT = 'os.journal.draft';
const oldDraft = () => { try { return localStorage.getItem(OLD_DRAFT) || ''; } catch { return ''; } };
const dropOldDraft = () => { try { localStorage.removeItem(OLD_DRAFT); } catch { /* nothing to drop */ } };

/**
 * Add `text` to today's entry as the composer did: after a `---` line when the day already has
 * something written, one line at a time with `appendLine`, so nothing above it is touched. The
 * old key goes only once every line is on disk.
 * @returns the path written, or '' when there was no file to write to
 */
async function addToToday(ose, store, text): Promise<string> {
  const write = async (path) => {
    const cur = String(await ose.files.read(path)).replace(/\r\n?/g, '\n');
    const lines = cur.split('\n');
    if (isEntryHeading(lines[0])) lines.shift();
    const hasBody = lines.join('\n').trim() !== '';
    const out: any[] = [];
    if (cur !== '' && !cur.endsWith('\n\n')) out.push('');
    if (hasBody) out.push('---', '');
    out.push(...String(text).replace(/\r\n?/g, '\n').trim().split('\n'));
    for (const line of out) await ose.files.appendLine(path, line);
    dropOldDraft();
    toast("Added to today's journal.", 'ok', 4500, { actions: [{ label: 'Open', run: () => openAtEnd(ose, path) }] });
    return path;
  };
  const path = await ensureToday(ose, store, { then: write });
  return path ? write(path) : '';
}

/**
 * Once per start: when the old Journal left unsaved text in this machine's localStorage, offer
 * it (a sticky toast, and a palette command while it is there). The key goes only after the
 * text is written to today's entry, or on a confirmed "Discard".
 * @param store the planner settings store
 * @returns removes the command
 */
export function recoverOldDraft(ose: any, store: any): () => void {
  if (!oldDraft().trim()) return () => {};
  const add = async () => {
    const text = oldDraft();
    if (!text.trim()) return;
    try { await addToToday(ose, store, text); } catch (err) {
      const e = (err as { code?: string, message?: string });
      console.error('[planner] journal draft', e);
      toast(`The text was not added: ${(e && e.message) || e}. It is kept for next time.`, 'err', 0);
    }
  };
  const offer = () => {
    if (!oldDraft().trim()) return;
    toast('The old Journal kept text that was never saved.', 'warn', 0, {
      actions: [{ label: "Add to today's journal", run: add }, { label: 'Discard…', run: discard }],
    });
  };
  const discard = async () => {
    const ok = await confirm({ title: 'Discard the unsaved journal text?', body: oldDraft(), ok: 'Discard', danger: true });
    if (ok) dropOldDraft(); else offer();
  };
  const off = ose.commands.register({
    id: 'journal.recoverDraft', title: 'Recover unsaved journal text', group: 'planner',
    when: () => !!oldDraft().trim(),
    run: offer,
  });
  offer();
  return off;
}

/* ------------------------------------------------------------------ the view */

/**
 * The Journal view.
 * @param store the planner settings store
 * @returns the view definition
 */
export function createJournalView(ose: any, store: any): any {
  let live: { unmount(): void; refresh(): void; } | null = null;
  let renderMd: ((markdown: string, opts?: any) => HTMLElement | null) | null = null;       // `ose:editor` render, once loaded
  const editorReady = import('ose:editor').then((m) => { renderMd = m.render; }).catch(() => { /* the plain renderer */ });

  function mount(host) {
    let alive = true, days: any[] = [], sig = '', shown = 0, dirError = '', loading = false, again = false;
    let opened = new Set<any>(), filling = false, folder = '';
    const offs: any[] = [];
    const settings = () => store.get();
    const mode = () => (MODES.includes(settings().journalMode) ? settings().journalMode : 'full');

    host.innerHTML = `
<div class="view-root jr-root" tabindex="-1">
  <div class="page-col">
    <h1 class="page-title view-title" data-el="title">${esc(ymd(new Date()))}</h1>
    <div class="page-meta jr-meta">
      <span data-el="when">&nbsp;</span>
      <span class="jr-gap" data-el="gap">&nbsp;</span>
    </div>
    <div data-el="detected"></div>
    <div class="jr-bar">
      <div class="jr-write">
        <button type="button" class="btn primary" data-act="today">Write today</button>
      </div>
      <div class="jr-mode seg" role="group" aria-label="Record" data-el="mode">
        <button type="button" class="seg-b" data-mode="full">Full</button>
        <button type="button" class="seg-b" data-mode="compact">Compact</button>
      </div>
    </div>
    <div class="jr-record" data-el="record"></div>
    <div class="jr-more" data-el="more" hidden>
      <button type="button" class="jr-more-btn" data-act="more">Show earlier</button>
    </div>
  </div>
</div>`;
    const root = host.querySelector('.view-root');
    const $ = (name) => host.querySelector(`[data-el="${name}"]`);

    function gapLine() {
      if (!days.length) return 'No entry yet';
      const n = daysBetween(days[0].date, new Date());
      if (n <= 0) return 'Written today';
      if (n === 1) return 'Last written yesterday';
      return `Last written ${n} days ago`;
    }

    function drawHeader() {
      if (!alive) return;
      const now = new Date();
      $('title').textContent = ymd(now);
      $('when').textContent = `${weekdayName(now)} ${clock(now)}`;
      $('gap').textContent = gapLine();
      $('detected').innerHTML = settings().confirmed ? '' : detectedHtml();
      for (const b of $('mode').querySelectorAll('[data-mode]')) {
        const on = b.dataset.mode === mode();
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
    }

    /** Fill an entry's body: the editor's renderer when loaded, else plain paragraphs. */
    function fillBody(el, day) {
      if (!day.thoughts || !day.thoughts.length) { el.innerHTML = '<p class="faint">Empty entry</p>'; return; }
      const md = renderMd;
      if (!md) { el.innerHTML = day.thoughts.map(plainThought).join('<hr class="jr-sep">'); return; }
      if (!day.nodes) {
        day.nodes = day.thoughts.map((t) => {
          try { return md(t, { basePath: day.path }); } catch { const d = document.createElement('div'); d.innerHTML = plainThought(t); return d; }
        });
      }
      el.textContent = '';
      // the rendered nodes themselves, moved and never cloned: a day is drawn in one place at a
      // time, and the code colouring `render` paints later lands on the node that is shown
      day.nodes.forEach((n, i) => {
        if (i) { const hr = document.createElement('hr'); hr.className = 'jr-sep'; el.appendChild(hr); }
        el.appendChild(n);
      });
    }

    const openBtn = (day, extra = '') => `<button type="button" class="jr-open${extra}" data-open="${esc(day.name)}">Open as page</button>`;

    function dayHtml(day) {
      return `
<div class="jr-day" data-name="${esc(day.name)}">
  <div class="jr-date">
    <span class="jr-d1">${esc(shortDate(day.date))}</span>
    <span class="jr-d2">${esc(weekdayName(day.date).slice(0, 3))}</span>
    ${openBtn(day)}
  </div>
  <div class="jr-body view-prose text-select" data-fill="${esc(day.name)}"></div>
</div>`;
    }

    function compactHtml(day) {
      const open = opened.has(day.name);
      return `
<div class="jr-c${open ? ' open' : ''}" data-name="${esc(day.name)}">
  <button type="button" class="jr-c-row" data-expand="${esc(day.name)}" aria-expanded="${open}">
    <span class="jr-c-d">${esc(shortDate(day.date))}</span>
    <span class="jr-c-w">${esc(weekdayName(day.date).slice(0, 3))}</span>
    <span class="jr-c-t">${esc(firstLine(day))}</span>
  </button>
  ${openBtn(day, ' jr-c-open')}
  ${open ? `<div class="jr-c-body jr-body view-prose text-select" data-fill="${esc(day.name)}"></div>` : ''}
</div>`;
    }

    function drawRecord() {
      const box = $('record');
      if (!box || !alive) return;
      const s = settings();
      if (!s.journal) { box.innerHTML = missingHtml('journal'); $('more').hidden = true; return; }
      box.classList.toggle('is-compact', mode() === 'compact');
      if (!days.length) {
        box.innerHTML = `<div class="empty">${dirError ? `Could not read ${esc(folder)}: ${esc(dirError)}` : 'No entries yet'}</div>`;
        $('more').hidden = true;
        return;
      }
      const one = mode() === 'compact' ? compactHtml : dayHtml;
      const list = days.slice(0, shown);
      const parts: any[] = [];
      for (let i = 0; i < list.length; i++) {
        if (i > 0 && list[i].year !== list[i - 1].year) parts.push(`<div class="jr-year">${list[i].year}</div>`);
        parts.push(one(list[i]));
      }
      box.innerHTML = parts.join('');
      const byName = new Map(days.map((d) => [d.name, d]));
      for (const el of box.querySelectorAll('[data-fill]')) fillBody(el, byName.get(el.dataset.fill));
      const rest = days.length - shown;
      $('more').hidden = rest <= 0;
      if (rest > 0) host.querySelector('[data-act="more"]').textContent = `Show earlier (${rest})`;
    }

    async function renderTo(target: number, before: (() => unknown) | null = null) {
      const next = Math.min(days.length, Math.max(0, target));
      if (next <= shown) { if (before) before(); return; }
      const need = days.slice(shown, next).filter((d) => d.text === undefined);
      await Promise.all(need.map(async (d) => {
        try { d.text = await ose.files.read(d.path); } catch (e) { console.warn('[planner] journal read', d.path, e); d.text = ''; }
        d.thoughts = parseEntry(d.text);
        d.nodes = null;
      }));
      if (!alive) return;
      shown = next;
      if (before) before();
      drawRecord();
    }

    async function renderMore() {
      if (filling) return;
      filling = true;
      try { await renderTo(shown + CHUNK); } finally { filling = false; }
    }

    async function load() {
      if (loading) { again = true; return; }
      loading = true;
      let stop = () => false;
      try {
        await store.ready;
        await editorReady;
        if (!alive) return;
        const next = settings().journal || '';
        if (next !== folder) { folder = next; days = []; sig = ''; shown = 0; opened = new Set<any>(); }
        if (!folder) { drawHeader(); drawRecord(); return; }
        stop = loadingLine($('record'));
        let items: any = null;
        dirError = '';
        try { items = await ose.files.list(folder); } catch (err) { const e = (err as { code?: string, message?: string }); dirError = String((e && e.message) || e); }
        if (!alive) return;
        const files = entriesOf(items);
        const nextSig = `${folder}::${files.map((f) => `${f.name}:${f.mtime || ''}:${f.size || ''}`).join('|')}`;
        if (nextSig === sig && days.length) { drawHeader(); if (stop()) drawRecord(); return; }
        sig = nextSig;
        const keep = new Map(days.map((d) => [d.name, d]));
        days = files.map((f) => {
          const old = keep.get(f.name);
          // a file that changed since it was read is read again
          if (old && old.mtime === f.mtime && old.size === f.size) return old;
          // entriesOf kept only the names that carry a date
          const date = (dateFromName(f.name) as Date);
          return { name: f.name, path: `${folder}/${f.name}`, date, year: date.getFullYear(), mtime: f.mtime, size: f.size };
        });
        const was = shown;
        shown = 0;
        drawHeader();
        if (!days.length) { stop(); drawRecord(); } else await renderTo(Math.max(CHUNK, was), stop);
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[planner] journal', e);
        toast(`Journal: ${(e && e.message) || e}`, 'err');
      } finally {
        stop();
        loading = false;
        if (again && alive) { again = false; load(); }
      }
    }

    function maybeMore() {
      const more = $('more');
      if (!more || more.hidden) return;
      const h = window.innerHeight || document.documentElement.clientHeight || 0;
      if (more.getBoundingClientRect().top < h + 400) renderMore();
    }

    /**
     * A link inside an entry (`render` leaves vault links as `.md-link[data-path]` and `#heading`
     * links as `.md-anchor`): open it, in a new tab with Ctrl or the middle button. A folder
     * opens as a folder.
     */
    function followEntryLink(ev, newTab) {
      const a = ev.target.closest ? ev.target.closest('.jr-body .md-link, .jr-body .md-anchor') : null;
      if (!a || !root.contains(a)) return false;
      ev.preventDefault();
      const fill = a.closest('[data-fill]');
      const day = fill && days.find((d) => d.name === fill.dataset.fill);
      const heading = a.dataset.heading || '';
      const path = a.classList.contains('md-anchor') ? (day && day.path) : a.dataset.path;
      if (!path) return true;
      void (async () => {
        let route = heading ? { type: 'page', path, heading } : { type: 'page', path };
        try { const st = await ose.files.stat(path); if (st && st.kind === 'dir') route = { type: 'folder', path }; } catch { /* a page route decides */ }
        if (newTab && ose.tabs && typeof ose.tabs.open === 'function') ose.tabs.open(route, { reuse: false });
        else ose.route.navigate(route);
      })();
      return true;
    }

    function onKeydown(ev) {
      if (ev.key === 'Enter' && !ev.altKey && !ev.shiftKey) followEntryLink(ev, ev.ctrlKey || ev.metaKey);
    }

    function onAux(ev) { if (ev.button === 1) followEntryLink(ev, true); }

    function onClick(ev) {
      if (followEntryLink(ev, ev.ctrlKey || ev.metaKey)) return;
      const open = ev.target.closest('[data-open]');
      if (open) {
        const d = days.find((x) => x.name === open.dataset.open);
        if (d) {
          const route = { type: 'page', path: d.path };
          if ((ev.ctrlKey || ev.metaKey) && ose.tabs && ose.tabs.open) ose.tabs.open(route, { reuse: false });
          else ose.route.navigate(route);
        }
        return;
      }
      const act = ev.target.closest('[data-act]');
      if (act && act.dataset.act === 'today') { openToday(ose, store); return; }
      if (act && act.dataset.act === 'more') { renderMore(); return; }
      const m = ev.target.closest('[data-mode]');
      if (m) { store.set({ journalMode: m.dataset.mode === 'compact' ? 'compact' : 'full' }); return; }
      const ex = ev.target.closest('[data-expand]');
      if (ex) {
        const name = ex.dataset.expand;
        if (opened.has(name)) opened.delete(name); else opened.add(name);
        drawRecord();
        const again = host.querySelector(`[data-expand="${CSS.escape(name)}"]`);
        if (again) again.focus({ preventScroll: true });
      }
    }

    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKeydown);
    host.addEventListener('auxclick', onAux);
    offs.push(() => host.removeEventListener('click', onClick));
    offs.push(() => host.removeEventListener('keydown', onKeydown));
    offs.push(() => host.removeEventListener('auxclick', onAux));
    offs.push(bindLinks(root, ose));
    offs.push(store.on(() => { drawHeader(); load(); drawRecord(); }));
    offs.push(ose.watch((d) => {
      const mine = (p) => !!p && !!folder && (p === folder || p.startsWith(`${folder}/`));
      if (!d || d.lost || d.rescan || (d.changes || []).some((c) => c && (mine(c.path) || mine(c.to)))) load();
    }));
    const clockTimer = setInterval(drawHeader, 30000);
    offs.push(() => clearInterval(clockTimer));
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) renderMore(); });
      io.observe($('more'));
      offs.push(() => io.disconnect());
    }
    let scroller: any = null;
    for (let p = host; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') { scroller = p; break; }
    }
    const target = scroller || window;
    target.addEventListener('scroll', maybeMore, { passive: true });
    offs.push(() => target.removeEventListener('scroll', maybeMore));

    drawHeader();
    root.focus({ preventScroll: true });
    load();

    const handle = {
      unmount() {
        alive = false;
        for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
        if (live === handle) live = null;
      },
      refresh() { if (alive) drawHeader(); },
    };
    live = handle;
    return handle;
  }

  return {
    title: 'Journal',
    order: 40,
    icon: 'journal',
    section: 'planner',
    mount: (el) => mount(el),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}
