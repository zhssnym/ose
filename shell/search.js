// Vault search (Ctrl+Shift+F), in the side panel to the right of the page (M25).
//
// It stays open while its hits are opened: Enter opens the selected hit at its line with the
// query in the page's find bar, and the caret stays in the search field, so the next hit is
// one ArrowDown and one Enter away; Ctrl+Enter opens it in a new tab. Esc hands the keyboard
// to the page; the panel stays until it is closed (its close button, or `search.close`).
//
// The bridges do the walking and agree on one answer: `{hits, files, total, capped}` (every
// term in the file, `"a phrase"` is one term, `path:` and `file:` narrow it, names match as
// well as content, a newer query on the same channel cancels the older walk). What is left
// here is the order and the surface. The order is this file's, all in JS, one class per file:
//
//   1. the file's name matches;
//   2. a heading matches;
//   3. a whole word matches in the body;
//   4. only part of a word matches;
//
// and, inside a class, the file changed most recently first.
import { ose } from 'ose:kernel';
import { esc, icon } from 'ose:ui';
import { panel, focusPage } from './layout.js';
import { dirName, titleOf } from './paths.js';

const { bus, commands, debounce } = ose;

const PANEL = 'search';
// Files, not lines (N34). A hundred files is more than anybody reads and enough that the
// "Showing N of M" line is the exception rather than the rule.
const LIMIT = 100;
// Focus mode filters the bridge's answer here, so ask for more of it: otherwise a common word
// fills the cap with files outside the focus folder and the list comes back empty.
const FOCUS_LIMIT = 1000;
// The queries this session has run, newest first, recalled with ArrowUp in an empty field.
const MAX_HISTORY = 20;

// What survives the panel being closed and opened again: the query and the history.
let lastQuery = '';
let history = [];
// The live panel, while it is open: `{ setQuery, focus, rerun }`.
let live = null;
// path -> mtime, for the tie-break. Filled lazily by one `stat` per file in a result, and
// dropped on every `fs` batch: a stale mtime would only mis-order two files, but the cost of
// re-asking is a handful of stats.
const mtimes = new Map();

/** The name the chrome shows for a path (W8): `ose.names.display`, through paths.js. */
const display = (p) => titleOf(p);

/** Both answers: the `{hits}` object of batch 12 and the bare array an older host returns. */
const hitsOf = (r) => (Array.isArray(r) ? r : Array.isArray(r && r.hits) ? r.hits : []);

function remember(q) {
  const t = String(q || '').trim();
  if (!t) return;
  history = [t, ...history.filter((h) => h !== t)].slice(0, MAX_HISTORY);
}

/**
 * The words a highlight should mark: the query minus its operators, quotes removed. The same
 * split the bridges do, kept simple here because it only decides what is drawn bold and how a
 * hit is ranked.
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

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex per term that matches it only as a whole word, letters of any script counted. */
function wordMatchers(terms) {
  return terms.map((t) => {
    try { return new RegExp(`(?<![\\p{L}\\p{N}_])${reEscape(t)}(?![\\p{L}\\p{N}_])`, 'iu'); } catch { return null; }
  }).filter(Boolean);
}

const isNameHit = (h) => !(Number.isInteger(h.line) && h.line > 0);
const isHeading = (text) => /^#{1,6}\s/.test(String(text || '').trim());

/**
 * The hits grouped by file and put in the order at the top of this file. Pure apart from the
 * mtime map it reads. Answers `[{ path, kind, rank, hits: [...] }]`.
 */
export function rankFiles(hits, terms, mtimeOf = (p) => mtimes.get(p) || 0) {
  const words = wordMatchers(terms);
  const byPath = new Map();
  for (const h of hits) {
    let f = byPath.get(h.path);
    if (!f) { f = { path: h.path, kind: h.kind === 'dir' ? 'dir' : 'file', rank: 4, hits: [] }; byPath.set(h.path, f); }
    f.hits.push(h);
    let r = 4;
    if (isNameHit(h)) r = 1;
    else if (isHeading(h.text)) r = 2;
    else if (words.some((w) => w.test(String(h.text || '')))) r = 3;
    f.rank = Math.min(f.rank, r);
  }
  const files = [...byPath.values()];
  // A name hit is drawn first in its file, then the lines in the order they come in the file.
  for (const f of files) f.hits.sort((a, b) => (Number(isNameHit(b)) - Number(isNameHit(a))) || ((a.line || 0) - (b.line || 0)));
  files.sort((a, b) => (a.rank - b.rank) || (mtimeOf(b.path) - mtimeOf(a.path)) || a.path.localeCompare(b.path));
  return files;
}

/** Ask the host for the mtime of every file of a result that is not known yet. */
async function fillMtimes(paths) {
  const want = paths.filter((p) => !mtimes.has(p));
  if (!want.length) return false;
  await Promise.all(want.map(async (p) => {
    try { const st = await ose.files.stat(p); mtimes.set(p, (st && st.mtime) || 0); } catch { mtimes.set(p, 0); }
  }));
  return true;
}

/** The route a hit opens: a folder is a folder route (H15); a line carries the caret and the query. */
function routeOf(h, terms) {
  if (h.kind === 'dir') return { type: 'folder', path: h.path };
  const route = { type: 'page', path: h.path };
  if (!isNameHit(h)) {
    route.line = h.line;
    if (Number.isInteger(h.col) && h.col > 0) route.col = h.col;
    if (terms[0]) route.query = terms[0];
  }
  return route;
}

/**
 * Draw the search into `el` (the side panel's body) and answer the panel's handle.
 * @param {HTMLElement} el
 * @param {{ query?: string, caretAtEnd?: boolean }} [start]
 */
function mountSearch(el, start = {}) {
  el.innerHTML = `
    <div class="sp">
      <div class="sp-field">
        <span class="sp-icon" aria-hidden="true">${icon('search')}</span>
        <input class="sp-input" type="text" spellcheck="false" autocomplete="off"
          placeholder="Search the vault" aria-label="Search the vault" role="combobox"
          aria-expanded="true" aria-controls="sp-list" aria-autocomplete="list">
      </div>
      <div class="sp-meta" aria-live="polite"></div>
      <div class="sp-list" id="sp-list" role="listbox" aria-label="Results"></div>
    </div>`;

  // All three drawn just above.
  const input = /** @type {HTMLInputElement} */ (el.querySelector('.sp-input'));
  const list = /** @type {HTMLElement} */ (el.querySelector('.sp-list'));
  const meta = /** @type {HTMLElement} */ (el.querySelector('.sp-meta'));

  let rows = [];          // the hits in drawn order: what ArrowUp/Down walk
  let files = [];
  let sel = 0;
  let seq = 0;
  let terms = [];
  let note = '';
  let summary = '';
  let histAt = -1;        // where ArrowUp is in the history (N40)
  let unmounted = false;

  function paint(message) {
    list.textContent = '';
    meta.textContent = summary;
    input.removeAttribute('aria-activedescendant');
    if (message) { list.innerHTML = `<div class="empty">${esc(message)}</div>`; return; }
    const frag = document.createDocumentFragment();
    rows = [];
    for (const f of files) {
      const head = document.createElement('div');
      head.className = 'sp-file';
      head.innerHTML = `<span class="sp-name">${esc(f.kind === 'dir' ? display(f.path) || f.path : display(f.path))}</span>`
        + `<span class="sp-dir">${esc(dirName(f.path))}</span>`;
      head.title = f.path;
      frag.appendChild(head);
      for (const h of f.hits) {
        const i = rows.length;
        rows.push(h);
        const row = document.createElement('div');
        row.className = 'row sp-row' + (i === sel ? ' active' : '');
        row.id = `sp-row-${i}`;
        row.dataset.i = String(i);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === sel));
        // A hit with no line is a name match (N35): the row says so rather than showing the
        // path twice, and its line slot stays empty because there is no line to name.
        const name = isNameHit(h);
        row.innerHTML = `<span class="grow">${name
          ? `<span class="sp-what">${h.kind === 'dir' ? 'Folder name' : 'File name'}</span>`
          : highlight(String(h.text || '').trim() || ' ', terms)}</span>`
          + (name ? '' : `<span class="hint">${esc(h.line)}</span>`);
        frag.appendChild(row);
      }
    }
    // "Showing 100 of 412 files" (N34): a cut list must say it is cut, or the answer lies.
    if (note) {
      const foot = document.createElement('div');
      foot.className = 'empty sp-note';
      foot.textContent = note;
      frag.appendChild(foot);
    }
    list.appendChild(frag);
    markActive();
  }

  function markActive() {
    list.querySelectorAll('.sp-row').forEach((n, i) => {
      n.classList.toggle('active', i === sel);
      n.setAttribute('aria-selected', String(i === sel));
    });
    const node = list.querySelector('.sp-row.active');
    if (node) { node.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', node.id); }
  }

  function move(d) {
    if (!rows.length) return;
    sel = (sel + d + rows.length) % rows.length;
    markActive();
  }

  /** Open the selected hit. The panel stays, and so does the caret, unless `aside` asked for a tab. */
  function accept({ aside = false } = {}) {
    const h = rows[sel];
    if (!h) return;
    remember(input.value);
    const route = routeOf(h, terms);
    const opened = aside
      ? ose.tabs.open(route, { reuse: false })
      : ose.route.navigate(route, { focus: false });
    // The page may take the caret as it mounts (its find bar opens with the query): the field
    // takes it back once the page has drawn, so the next ArrowDown is still the list's.
    Promise.resolve(opened).catch((e) => console.error('[shell] search open', e)).then(() => {
      if (unmounted) return;
      const back = () => { if (!unmounted && !el.contains(document.activeElement)) input.focus({ preventScroll: true }); };
      back();
      requestAnimationFrame(back);
      setTimeout(back, 120);
    });
  }

  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) { rows = []; files = []; terms = []; note = ''; summary = ''; paint('Type to search'); return; }
    const my = ++seq;
    const focus = ose.focus.get();
    try {
      // `chan` is what lets the host abandon the walk this keystroke replaces (S33); the
      // sequence number here is the second line of defence, for an answer already in flight.
      const r = await ose.search(q, {
        limit: focus ? FOCUS_LIMIT : LIMIT, chan: 'panel', hidden: !!ose.settings.get().showHidden,
      });
      if (my !== seq || unmounted) return;
      // The bridge searches the whole vault; focus mode narrows the result list here.
      const hits = hitsOf(r).filter((h) => ose.focus.isUnder(h.path));
      terms = termsOf(q);
      const selected = rows[sel];
      const draw = () => {
        files = rankFiles(hits, terms);
        // Keep the selection on the same hit across a re-run (an edit, a file change).
        const flat = files.flatMap((f) => f.hits);
        const again = selected ? flat.findIndex((h) => h.path === selected.path && h.line === selected.line) : -1;
        sel = again >= 0 ? again : 0;
        const scope = focus ? ` in ${display(focus)}` : '';
        note = r && r.capped ? `Showing ${r.files} of ${r.total} files. Narrow the search with path: or file:` : '';
        summary = hits.length
          ? `${hits.length} ${hits.length === 1 ? 'result' : 'results'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}${scope}`
          : '';
        paint(hits.length ? '' : (focus ? `No matches in ${display(focus)}` : 'No matches'));
      };
      draw();
      // The tie-break needs each file's mtime: drawn at once in the bridge's order within a
      // class, then once more when the stats land, only if any were missing.
      if (await fillMtimes([...new Set(hits.map((h) => h.path))]) && my === seq && !unmounted) draw();
    } catch (e) {
      if (my !== seq || unmounted) return;
      rows = []; files = []; note = ''; summary = '';
      paint('Search failed: ' + (e && typeof e === 'object' && 'message' in e && e.message ? e.message : e));
    }
  }, 150);

  const setQuery = (text, { caretAtEnd = false } = {}) => {
    input.value = text;
    lastQuery = text;
    histAt = -1;
    run();
    input.focus();
    if (caretAtEnd) input.setSelectionRange(input.value.length, input.value.length);
    else input.select();
  };

  input.addEventListener('input', () => { lastQuery = input.value; histAt = -1; run(); });
  input.addEventListener('keydown', (e) => {
    // ArrowUp walks the session's queries (N40), the way a shell's history does: from an empty
    // field, and from a query that came out of the history itself. Anything else — a typed
    // query — and ArrowUp belongs to the list. ArrowDown always belongs to the list.
    if (e.key === 'ArrowUp' && history.length && (histAt >= 0 || !input.value.trim())) {
      e.preventDefault();
      const next = Math.min(histAt + 1, history.length - 1);
      if (next === histAt) return;          // the oldest: stay there rather than wrap
      histAt = next;
      input.value = history[histAt];
      lastQuery = input.value;
      input.select();
      run();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); histAt = -1; move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); accept({ aside: e.ctrlKey || e.metaKey }); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); focusPage(); }
  });
  list.addEventListener('click', (e) => {
    const row = e.target instanceof Element ? /** @type {HTMLElement|null} */ (e.target.closest('.sp-row')) : null;
    if (!row) return;
    sel = Number(row.dataset.i);
    markActive();
    accept({ aside: e.ctrlKey || e.metaKey });
  });
  list.addEventListener('auxclick', (e) => {
    const row = e.target instanceof Element ? /** @type {HTMLElement|null} */ (e.target.closest('.sp-row')) : null;
    if (!row || e.button !== 1) return;
    e.preventDefault();
    sel = Number(row.dataset.i);
    markActive();
    accept({ aside: true });
  });

  live = {
    setQuery,
    focus: () => { input.focus(); input.select(); },
    rerun: () => { if (input.value.trim()) run(); },
  };

  input.value = start.query !== undefined ? start.query : lastQuery;
  paint(input.value.trim() ? '' : 'Type to search');
  if (input.value.trim()) run();

  return {
    focus() {
      input.focus();
      if (start.caretAtEnd) input.setSelectionRange(input.value.length, input.value.length);
      else input.select();
    },
    unmount() {
      unmounted = true;
      seq++;
      live = null;
    },
  };
}

/**
 * Open the search panel, or bring the caret back to it when it is already open.
 *
 * `openSearch({ folder })` is Search in folder (the tree's `tree.search-here`): the field
 * starts as `path:<folder>/ ` with the caret after it, so the next thing typed is the query.
 * `{ query }` puts a query in; `{ prefill }` is the older name for the same thing.
 *
 * @param {{ query?: string, folder?: string, prefill?: string }} [opts]
 */
export function openSearch(opts = {}) {
  let query;
  let caretAtEnd = false;
  if (opts.folder !== undefined && opts.folder !== null) {
    const f = String(opts.folder).replace(/\/+$/, '');
    query = (f ? `path:${f}/ ` : '') + (opts.query || '');
    caretAtEnd = true;
  } else if (opts.query !== undefined) query = String(opts.query);
  else if (opts.prefill !== undefined) { query = String(opts.prefill); caretAtEnd = true; }

  if (live && panel.isOpen(PANEL)) {
    if (query !== undefined) live.setQuery(query, { caretAtEnd });
    else live.focus();
    return;
  }
  panel.open(PANEL, (el) => mountSearch(el, { query, caretAtEnd }), { title: 'Search' });
}

/** Close the panel if search is what it holds. */
export function closeSearch() { panel.close(PANEL); }

/** Register the search commands and keep an open result list current. Called once by `boot.js`. */
export function initSearch() {
  commands.register({
    id: 'app.search', title: 'Search in vault', group: 'navigate', hint: 'in the side panel',
    run: () => openSearch(),
  });
  commands.register({
    id: 'search.close', title: 'Close search', group: 'navigate',
    when: () => panel.isOpen(PANEL),
    run: () => closeSearch(),
  });
  // A file that changed may have gained or lost a hit; the list follows, once things settle.
  const rerun = debounce(() => { if (live) live.rerun(); }, 800);
  bus.on('fs', () => { mtimes.clear(); rerun(); });
  bus.on('settings', rerun);
}
