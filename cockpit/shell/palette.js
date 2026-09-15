// Command palette (Ctrl+K) and quick open (Ctrl+P). Same surface, two data sources.
// Matching is a subsequence score with a bonus for word starts, so "phab" finds "page.habits".
import { ose } from 'ose:kernel';
import { esc, icon, openOverlay, toast, fuzzy, highlight, pageItems } from 'ose:ui';
// One reader for "the first H1 of a markdown text", the same one the editor's title strip and
// the task index use: it skips frontmatter and fenced code.
import { firstH1 } from 'ose:md';
import { allPages, newPageIn, scratchFolder } from './sidebar.js';
import { dirName } from './paths.js';

const { bus, commands, store, files, route } = ose;
const navigate = (r, opts) => route.navigate(r, opts);
const recentFiles = () => route.recent();
const shortcutFor = (id) => ose.keys.shortcutFor(id);
const defaultNewFolder = () => ose.focus.defaultNewFolder();

// `tree` is the sidebar's row commands (D3): they act on the focused row, else the open page.
// `editor` (the code block's own two) and `image` sit with the other block-level groups; both
// used to fall past the end of this list and sort under a heading nothing declared (QA F8).
const GROUP_ORDER = ['navigate', 'page', 'format', 'block', 'table', 'editor', 'image', 'tree', 'view', 'app'];
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
  // A group nobody declared sorts last, after `app`, rather than tying with it.
  const rank = (g) => GROUP_RANK.get(g) ?? GROUP_ORDER.length;
  out.sort((a, b) => (b.score - a.score) || rank(a.group) - rank(b.group) || a.title.localeCompare(b.title));
  if (!q) out.sort((a, b) => (rank(a.group) - rank(b.group)) || a.title.localeCompare(b.title));
  return out;
}

/**
 * What each page calls itself (L26): `path -> first H1`, read once and kept until the vault
 * changes. Quick open matched file names only, so a page whose H1 is `Living systems` in a
 * file called `zz.md` could not be found by its name — the one name the user knows it by.
 *
 * The read is one `readText` per page, started the first time quick open is used and never
 * awaited: the list is drawn from file names immediately and re-drawn when the titles land.
 * A vault of a few hundred pages is milliseconds; nothing here is on the boot path.
 */
const titles = new Map();
let titleScan = null;
let onTitles = null;

function scanTitles() {
  if (titleScan) return titleScan;
  const paths = allPages();
  titleScan = (async () => {
    for (const p of paths) {
      if (titles.has(p)) continue;
      try { titles.set(p, firstH1(await files.read(p))); } catch { titles.set(p, ''); }
    }
    if (onTitles) onTitles();
  })();
  return titleScan;
}

/** The map `pageItems` wants: only the pages whose H1 is worth showing. */
function titleMap() {
  const m = new Map();
  for (const [p, t] of titles) if (t) m.set(p, t);
  return m;
}

function fileItems(q) {
  return pageItems(allPages(), q, { recent: recentFiles(), titles: titleMap() }).map((it) => ({
    kind: 'file', id: it.path, group: 'pages',
    title: it.title, hint: it.hint, sub: it.path, shortcut: '',
    score: it.score, hits: it.hits, recent: it.recent,
    run: () => navigate({ type: 'page', path: it.path }),
  }));
}

/**
 * Shift+Enter in quick open (N41): a page with the typed name, where a new page goes — the
 * focused folder, else whatever the "new page in" setting says, else beside the open page and
 * finally the scratch folder. That last pair is `page.new`'s rule, and the two chords are the
 * same sentence ("make me a page, now"): asking only `defaultNewFolder()` answered '' in the
 * default setting and dropped the page at the vault root (QA defect 7).
 */
async function createTyped(text) {
  const name = String(text || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\.md$/i, '').trim();
  if (!name) return;
  const open = store.get('route');
  const beside = open && open.type === 'page' && open.path ? dirName(open.path) : '';
  const path = await newPageIn(defaultNewFolder() || beside || scratchFolder(), name);
  if (path) titles.set(path, name);
}

/* ------------------------------------------------------------------ ui */

let openOv = null;

export function openPalette(mode = 'commands') {
  if (openOv) {
    // Already open: switch mode in place rather than stacking a second surface.
    if (openOv.mode !== mode) openOv.setMode(mode);
    return;
  }

  const ov = openOverlay({ width: 560, top: '15vh', className: 'pal', onClose: () => { openOv = null; onTitles = null; } });
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
      <span class="pal-create" hidden><span class="kbd">Shift</span><span class="kbd">Enter</span> new page</span>
      <span class="grow"></span>
      <span class="pal-mode"></span>
    </div>`;

  const input = ov.box.querySelector('.pal-input');
  const list = ov.box.querySelector('.pal-list');
  const modeEl = ov.box.querySelector('.pal-mode');
  const iconEl = ov.box.querySelector('.pal-icon');
  const createEl = ov.box.querySelector('.pal-create');

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
      // A page row is two lines: what the page calls itself, and where the file is (L26).
      // A command row is one, as it always was.
      if (it.sub) {
        row.classList.add('pal-row-2');
        row.innerHTML = `<span class="grow"><span class="pal-title">${highlight(it.title, it.hits)}</span>`
          + `<span class="pal-sub mono-sm">${esc(it.sub)}</span></span>`;
      } else {
        row.innerHTML =
          `<span class="grow">${highlight(it.title, it.hits)}</span>` +
          (it.hint ? `<span class="pal-hint">${esc(it.hint)}</span>` : '') +
          (it.shortcut ? `<span class="kbd">${esc(it.shortcut)}</span>` : '');
      }
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
    // A command that throws says so on screen, not only in a console nobody has open (B6).
    // Async failures are the command's own to toast; this catches the synchronous ones.
    Promise.resolve().then(() => {
      try { it.run(); } catch (e) { console.error('[shell] palette run', e); toast(String(e.message || e), 'err'); }
    });
  }

  function setMode(m) {
    current = m;
    openOv.mode = m;
    input.placeholder = m === 'files' ? 'Go to page…' : 'Type a command…';
    modeEl.textContent = m === 'files' ? 'quick open' : 'commands';
    iconEl.innerHTML = icon(m === 'files' ? 'page' : 'command');
    // The titles are read in the background the first time quick open is used; the list is
    // drawn from file names at once and rebuilt, in place, when they land (L26).
    if (m === 'files') { onTitles = () => { if (openOv && current === 'files') build(); }; void scanTitles(); }
    createEl.hidden = m !== 'files';
    build();
  }

  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    // Shift+Enter in quick open makes the page you were looking for and did not find (N41).
    else if (e.key === 'Enter' && e.shiftKey && current === 'files') {
      e.preventDefault();
      const typed = input.value.trim();
      if (!typed) return;
      ov.close();
      void createTyped(typed);
    }
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

/** A changed vault means changed titles: the index is dropped and read again when next used. */
bus.on('fs', () => { titles.clear(); titleScan = null; });

export function initPalette() {
  commands.register({ id: 'app.palette', title: 'Command palette', group: 'app', run: () => openPalette('commands') });
  commands.register({ id: 'app.quickopen', title: 'Go to page', group: 'navigate', hint: 'by title or path', run: () => openPalette('files') });
}
