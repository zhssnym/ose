// Command palette (Ctrl+K) and quick open (Ctrl+P). Same surface, two data sources.
// Matching is a subsequence score with a bonus for word starts, so "phab" finds "page.habits".
import { commands, esc } from '../registry.js';
import { openOverlay } from './dialog.js';
import { shortcutFor } from './keys.js';
import { navigate, recentFiles } from './router.js';
import { allPages } from './sidebar.js';
import { icon } from './icons.js';
import { fuzzy, highlight, pageItems } from './fuzzy.js';

const GROUP_ORDER = ['navigate', 'page', 'view', 'claude', 'app'];
const GROUP_RANK = new Map(GROUP_ORDER.map((g, i) => [g, i]));

// The matcher and the page-list builder live in fuzzy.js so `pickPage` (dialog.js) ranks pages
// exactly the way Ctrl+P does. Re-exported here because this is where they used to be.
export { fuzzy };

/* ------------------------------------------------------------------ sources */

function commandItems(q) {
  const out = [];
  for (const c of commands.list()) {
    const hay = `${c.title} ${c.group || ''} ${c.id}`;
    const m = fuzzy(hay.toLowerCase(), q.toLowerCase());
    if (!m) continue;
    const titleMatch = fuzzy(c.title.toLowerCase(), q.toLowerCase());
    out.push({
      kind: 'cmd', id: c.id, group: c.group || 'app',
      title: c.title, hint: c.hint || '',
      shortcut: shortcutFor(c.id) || c.shortcut || '',
      score: m.score + (titleMatch ? titleMatch.score * 1.5 : 0),
      hits: titleMatch ? titleMatch.hits : null,
      run: () => commands.run(c.id),
    });
  }
  out.sort((a, b) => (b.score - a.score) || (GROUP_RANK.get(a.group) ?? 9) - (GROUP_RANK.get(b.group) ?? 9) || a.title.localeCompare(b.title));
  if (!q) out.sort((a, b) => ((GROUP_RANK.get(a.group) ?? 9) - (GROUP_RANK.get(b.group) ?? 9)) || a.title.localeCompare(b.title));
  return out;
}

function fileItems(q) {
  return pageItems(allPages(), q, { recent: recentFiles() }).map((it) => ({
    kind: 'file', id: it.path, group: 'pages',
    title: it.title, hint: it.hint, shortcut: '',
    score: it.score, hits: it.hits, recent: it.recent,
    run: () => navigate({ type: 'page', path: it.path }),
  }));
}

/* ------------------------------------------------------------------ ui */

let openOv = null;

export function openPalette(mode = 'commands') {
  if (openOv) {
    // Already open: switch mode in place rather than stacking a second surface.
    if (openOv.mode !== mode) openOv.setMode(mode);
    return;
  }

  const ov = openOverlay({ width: 560, top: '15vh', className: 'pal', onClose: () => { openOv = null; } });
  ov.box.innerHTML = `
    <div class="pal-head">
      <span class="pal-icon"></span>
      <input class="pal-input" type="text" spellcheck="false" autocomplete="off" aria-label="Command">
    </div>
    <div class="pal-list" role="listbox"></div>
    <div class="pal-foot mono-sm">
      <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
      <span><span class="kbd">Enter</span> run</span>
      <span><span class="kbd">Esc</span> close</span>
      <span class="grow"></span>
      <span class="pal-mode"></span>
    </div>`;

  const input = ov.box.querySelector('.pal-input');
  const list = ov.box.querySelector('.pal-list');
  const modeEl = ov.box.querySelector('.pal-mode');
  const iconEl = ov.box.querySelector('.pal-icon');

  let items = [];
  let sel = 0;
  let current = mode;

  function build() {
    const q = input.value.trim();
    items = current === 'files' ? fileItems(q) : commandItems(q);
    sel = 0;
    paint();
  }

  function paint() {
    list.textContent = '';
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'no matches';
      list.appendChild(d);
      return;
    }
    const frag = document.createDocumentFragment();
    let group = null;
    items.forEach((it, i) => {
      const g = current === 'files' ? (it.recent && !input.value.trim() ? 'recent' : 'pages') : it.group;
      if (g !== group) {
        group = g;
        const l = document.createElement('div');
        l.className = 'section-label';
        l.textContent = g;
        frag.appendChild(l);
      }
      const row = document.createElement('div');
      row.className = 'row pal-row' + (i === sel ? ' active' : '');
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      row.innerHTML =
        `<span class="grow">${highlight(it.title, it.hits)}</span>` +
        (it.hint ? `<span class="pal-hint">${esc(it.hint)}</span>` : '') +
        (it.shortcut ? `<span class="kbd">${esc(it.shortcut)}</span>` : '');
      frag.appendChild(row);
    });
    list.appendChild(frag);
    scrollSel();
  }

  function scrollSel() {
    const node = list.querySelector('.pal-row.active');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
    scrollSel();
  }

  function accept() {
    const it = items[sel];
    if (!it) return;
    ov.close();
    Promise.resolve().then(() => { try { it.run(); } catch (e) { console.error('[shell] palette run', e); } });
  }

  function setMode(m) {
    current = m;
    openOv.mode = m;
    input.placeholder = m === 'files' ? 'Go to page…' : 'Type a command…';
    modeEl.textContent = m === 'files' ? 'quick open' : 'commands';
    iconEl.innerHTML = icon(m === 'files' ? 'page' : 'command');
    build();
  }

  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); accept(); }
    else if (e.key === 'Home' && !input.value) { e.preventDefault(); sel = 0; paint(); }
  });
  list.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.pal-row');
    if (!row || +row.dataset.i === sel) return;
    sel = +row.dataset.i;
    list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.pal-row');
    if (!row) return;
    sel = +row.dataset.i;
    accept();
  });

  openOv = { ...ov, mode, setMode };
  setMode(mode);
  requestAnimationFrame(() => input.focus());
}

export function initPalette() {
  commands.register({ id: 'app.palette', title: 'Command palette', group: 'app', run: () => openPalette('commands') });
  commands.register({ id: 'app.quickopen', title: 'Go to page', group: 'navigate', run: () => openPalette('files') });
}
