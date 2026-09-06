// Vault search (Ctrl+F): a centred surface with the same geometry as the palette. Results are
// grouped by file, one row per matching line in mono with the match highlighted. Arrows move,
// Enter opens the page, Esc closes. `bridge.search` runs debounced 150ms as you type.
import { commands, debounce, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openOverlay } from './dialog.js';
import { navigate } from './router.js';
import { getFocus, isUnderFocus } from './focus.js';
import { icon } from './icons.js';
import { titleOf, dirName } from './paths.js';

const LIMIT = 200;
// Focus mode filters the bridge's answer here, so ask for more of it: otherwise a common word
// fills the cap with hits from outside the focus folder and the list comes back empty.
const FOCUS_LIMIT = 2000;

let openOv = null;
let lastQuery = '';

/** Escape, then wrap every case-insensitive occurrence of q in <b>. */
function highlight(text, q) {
  if (!q) return esc(text);
  const t = String(text);
  const low = t.toLowerCase(), needle = q.toLowerCase();
  let out = '', i = 0;
  for (;;) {
    const at = low.indexOf(needle, i);
    if (at < 0) { out += esc(t.slice(i)); break; }
    out += esc(t.slice(i, at)) + '<b>' + esc(t.slice(at, at + needle.length)) + '</b>';
    i = at + needle.length;
  }
  return out;
}

export function openSearch() {
  if (openOv) { openOv.focus(); return; }

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
  let shown = '';

  function paint(note) {
    list.textContent = '';
    if (note) { list.innerHTML = `<div class="empty">${esc(note)}</div>`; return; }
    const frag = document.createDocumentFragment();
    let file = null;
    hits.forEach((h, i) => {
      if (h.path !== file) {
        file = h.path;
        const head = document.createElement('div');
        head.className = 'sr-file';
        head.innerHTML = `<span class="g-name">${esc(titleOf(h.path))}</span><span class="g-dir">${esc(dirName(h.path))}</span>`;
        frag.appendChild(head);
      }
      const row = document.createElement('div');
      row.className = 'row sr-row' + (i === sel ? ' active' : '');
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      row.innerHTML = `<span class="grow">${highlight(String(h.text || '').trim() || ' ', shown)}</span>`
        + `<span class="hint">L${esc(h.line)}</span>`;
      frag.appendChild(row);
    });
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
    ov.close();
    Promise.resolve().then(() => navigate({ type: 'page', path: h.path }));
  }

  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) { hits = []; shown = ''; modeEl.textContent = 'search'; paint('type to search'); return; }
    const my = ++seq;
    try {
      const r = await bridge.search(q, { limit: getFocus() ? FOCUS_LIMIT : LIMIT });
      if (my !== seq || !openOv) return;
      // The bridge searches the whole vault; focus mode narrows the result list here.
      hits = (Array.isArray(r) ? r : []).filter((h) => isUnderFocus(h.path)).slice(0, LIMIT);
      shown = q;
      sel = 0;
      const files = new Set(hits.map((h) => h.path)).size;
      const scope = getFocus() ? ' · in focus' : '';
      modeEl.textContent = hits.length
        ? `${hits.length} hit${hits.length === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}${scope}`
        : 'search' + scope;
      paint(hits.length ? '' : (getFocus() ? 'no matches under ' + getFocus() : 'no matches'));
    } catch (e) {
      if (my !== seq) return;
      hits = [];
      paint('search failed: ' + (e.message || e));
    }
  }, 150);

  input.addEventListener('input', () => { lastQuery = input.value; run(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
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

  openOv = { ...ov, focus: () => { input.focus(); input.select(); } };
  input.value = lastQuery;
  paint(lastQuery ? '' : 'type to search');
  if (lastQuery) run();
  input.focus(); input.select();
  requestAnimationFrame(() => { if (document.activeElement !== input) { input.focus(); input.select(); } });
}

export function initSearch() {
  commands.register({ id: 'app.search', title: 'Search in vault', group: 'navigate', run: () => openSearch() });
}
