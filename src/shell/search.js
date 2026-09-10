// Vault search (Ctrl+Shift+F): a centred surface with the same geometry as the palette.
// Results are grouped by file, one row per matching line in mono with the terms highlighted;
// arrows move, Enter opens, Esc closes. `bridge.search` runs debounced 150ms as you type.
//
// Batch 12 (N32 to N40, S33) moved the thinking into the two bridges, which now agree on one
// answer: `{hits, files, total, capped}`. Every term must appear in the file, `"a phrase"` is
// one term, `path:` and `file:` narrow it, names match as well as content, text files are read
// as well as markdown, every hit carries a column, the cap counts files, and a newer query
// cancels the walk the older one started. What is left here is the surface: how it is shown,
// how it is steered, and what Enter does with a hit.
import { commands, debounce, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openOverlay } from './dialog.js';
import { navigate } from './router.js';
import { revealFolder } from './sidebar.js';
import { getFocus, isUnderFocus } from './focus.js';
import { icon } from './icons.js';
import { titleOf, dirName } from './paths.js';

// Files, not lines (N34). A hundred files is more than anybody reads and enough that the
// "showing N of M" line is the exception rather than the rule.
const LIMIT = 100;
// Focus mode filters the bridge's answer here, so ask for more of it: otherwise a common word
// fills the cap with files outside the focus folder and the list comes back empty.
const FOCUS_LIMIT = 1000;
// The queries this session has run, newest first, recalled with ArrowUp in an empty-ish field.
const MAX_HISTORY = 20;

let openOv = null;
let lastQuery = '';
let history = [];

/** Both answers: the `{hits}` object of batch 12 and the bare array an older host returns. */
const hitsOf = (r) => (Array.isArray(r) ? r : Array.isArray(r && r.hits) ? r.hits : []);

function remember(q) {
  const t = String(q || '').trim();
  if (!t) return;
  history = [t, ...history.filter((h) => h !== t)].slice(0, MAX_HISTORY);
}

/**
 * The words a highlight should mark: the query minus its operators, quotes removed. The same
 * split the bridges do, kept simple here because it only decides what is drawn bold.
 */
function termsOf(q) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(q || '')))) {
    const word = (m[1] !== undefined ? m[1] : m[2]) || '';
    if (/^(path|file):/i.test(word)) continue;
    const clean = word.replace(/^"|"$/g, '').trim();
    if (clean) out.push(clean.toLowerCase());
  }
  return out;
}

/** Escape, then wrap every case-insensitive occurrence of any term in <b>. */
function highlight(text, terms) {
  const t = String(text);
  if (!terms.length) return esc(t);
  const low = t.toLowerCase();
  let out = '', i = 0;
  while (i < t.length) {
    let at = -1, len = 0;
    for (const term of terms) {
      const k = low.indexOf(term, i);
      if (k >= 0 && (at < 0 || k < at || (k === at && term.length > len))) { at = k; len = term.length; }
    }
    if (at < 0) { out += esc(t.slice(i)); break; }
    out += esc(t.slice(i, at)) + '<b>' + esc(t.slice(at, at + len)) + '</b>';
    i = at + len;
  }
  return out;
}

/** `openSearch({ prefill })` — the folder menu's "Search in folder" arrives with `path:…`. */
export function openSearch(opts = {}) {
  if (openOv) {
    if (opts.prefill) openOv.setQuery(opts.prefill);
    openOv.focus();
    return;
  }

  const ov = openOverlay({ width: 620, top: '13vh', className: 'pal search', onClose: () => { openOv = null; } });
  ov.box.innerHTML = `
    <div class="pal-head">
      <span class="pal-icon">${icon('search')}</span>
      <input class="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="Search the vault…" aria-label="Search the vault">
    </div>
    <div class="pal-list sr-list" role="listbox"></div>
    <div class="pal-foot mono-sm">
      <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
      <span><span class="kbd">Enter</span> open</span>
      <span><span class="kbd">Esc</span> close</span>
      <span class="grow"></span>
      <span class="pal-mode">search</span>
    </div>`;

  const input = ov.box.querySelector('.pal-input');
  const list = ov.box.querySelector('.sr-list');
  const modeEl = ov.box.querySelector('.pal-mode');

  let hits = [];
  let sel = 0;
  let seq = 0;
  let terms = [];
  let note = '';
  // Where ArrowUp is in the history, and what was typed before it started walking (N40).
  let histAt = -1;
  let typed = '';

  function paint(message) {
    list.textContent = '';
    if (message) { list.innerHTML = `<div class="empty">${esc(message)}</div>`; return; }
    const frag = document.createDocumentFragment();
    let file = null;
    hits.forEach((h, i) => {
      if (h.path !== file) {
        file = h.path;
        const head = document.createElement('div');
        head.className = 'sr-file';
        head.innerHTML = `<span class="g-name">${esc(h.kind === 'dir' ? h.path : titleOf(h.path))}</span>`
          + `<span class="g-dir">${esc(h.kind === 'dir' ? 'folder' : dirName(h.path))}</span>`;
        frag.appendChild(head);
      }
      const row = document.createElement('div');
      row.className = 'row sr-row' + (i === sel ? ' active' : '');
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      // A hit with no line is a name match (N35): the row says so rather than showing the
      // path twice, and its hint slot stays empty because there is no line to name.
      const isName = !(Number.isInteger(h.line) && h.line > 0);
      row.innerHTML = `<span class="grow">${isName
        ? `<span class="sr-name">${h.kind === 'dir' ? 'folder name' : 'file name'}</span>`
        : highlight(String(h.text || '').trim() || ' ', terms)}</span>`
        + (isName ? '' : `<span class="hint">L${esc(h.line)}</span>`);
      frag.appendChild(row);
    });
    // "showing 100 of 412 files" (N34): a cut list must say it is cut, or the answer lies.
    if (note) {
      const foot = document.createElement('div');
      foot.className = 'empty sr-note';
      foot.textContent = note;
      frag.appendChild(foot);
    }
    list.appendChild(frag);
    list.querySelector('.sr-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function move(d) {
    if (!hits.length) return;
    sel = (sel + d + hits.length) % hits.length;
    list.querySelectorAll('.sr-row').forEach((n, i) => n.classList.toggle('active', i === sel));
    list.querySelector('.sr-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function accept() {
    const h = hits[sel];
    if (!h) return;
    remember(input.value);
    ov.close();
    // A folder is not a page: it is shown where it lives instead (N35).
    if (h.kind === 'dir') { revealFolder(h.path); return; }
    // Both bridges number lines from 1; a 0 means the file's *name* matched, and the page
    // opens at the top. `col` and the query ride along so the editor can land the caret on
    // the match and open find with it highlighted (N36).
    const route = { type: 'page', path: h.path };
    if (Number.isInteger(h.line) && h.line > 0) {
      route.line = h.line;
      if (Number.isInteger(h.col) && h.col > 0) route.col = h.col;
      const first = terms[0];
      if (first) route.query = first;
    }
    Promise.resolve().then(() => navigate(route));
  }

  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) { hits = []; terms = []; note = ''; modeEl.textContent = 'search'; paint('type to search'); return; }
    const my = ++seq;
    try {
      // `chan` is what lets the host abandon the walk this keystroke replaces (S33); the
      // sequence number here is the second line of defence, for an answer already in flight.
      const r = await bridge.search(q, { limit: getFocus() ? FOCUS_LIMIT : LIMIT, chan: 'overlay' });
      if (my !== seq || !openOv) return;
      // The bridge searches the whole vault; focus mode narrows the result list here.
      hits = hitsOf(r).filter((h) => isUnderFocus(h.path));
      terms = termsOf(q);
      sel = 0;
      const files = new Set(hits.map((h) => h.path)).size;
      const scope = getFocus() ? ' · in focus' : '';
      note = r && r.capped ? `showing ${r.files} of ${r.total} files · narrow the search with path: or file:` : '';
      modeEl.textContent = hits.length
        ? `${hits.length} hit${hits.length === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}${scope}`
        : 'search' + scope;
      paint(hits.length ? '' : (getFocus() ? 'no matches under ' + getFocus() : 'no matches'));
    } catch (e) {
      if (my !== seq) return;
      hits = [];
      note = '';
      paint('search failed: ' + (e.message || e));
    }
  }, 150);

  const setQuery = (text) => {
    input.value = text;
    lastQuery = text;
    histAt = -1;
    run();
  };

  input.addEventListener('input', () => { lastQuery = input.value; histAt = -1; run(); });
  input.addEventListener('keydown', (e) => {
    // ArrowUp walks the session's queries (N40), the way a shell's history does: from an empty
    // field, and from a query that came out of the history itself, so pressing it twice reaches
    // the one before. Anything else — a typed query — and ArrowUp belongs to the list.
    // ArrowDown always belongs to the list, which is how you leave the history and pick a hit.
    if (e.key === 'ArrowUp' && history.length && (histAt >= 0 || !input.value.trim())) {
      e.preventDefault();
      if (histAt < 0) typed = input.value;
      const next = Math.min(histAt + 1, history.length - 1);
      if (next === histAt) return;          // the oldest: stay there rather than wrap
      histAt = next;
      input.value = history[histAt];
      input.select();
      run();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); histAt = -1; move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); accept(); }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.sr-row');
    if (!row) return;
    sel = +row.dataset.i;
    accept();
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.sr-row');
    if (!row || +row.dataset.i === sel) return;
    sel = +row.dataset.i;
    list.querySelectorAll('.sr-row').forEach((n, i) => n.classList.toggle('active', i === sel));
  });

  openOv = { ...ov, setQuery, focus: () => { input.focus(); input.select(); } };
  input.value = opts.prefill || lastQuery;
  paint(input.value ? '' : 'type to search');
  if (input.value) run();
  input.focus();
  // A prefilled `path:folder/ ` is a starting point, not a selection: the caret goes after it
  // so the next thing typed is the query. A recalled query is selected, so typing replaces it.
  if (opts.prefill) input.setSelectionRange(input.value.length, input.value.length);
  else input.select();
  requestAnimationFrame(() => { if (document.activeElement !== input) { input.focus(); if (!opts.prefill) input.select(); } });
}

export function initSearch() {
  commands.register({ id: 'app.search', title: 'Search in vault', group: 'navigate', run: () => openSearch() });
}
