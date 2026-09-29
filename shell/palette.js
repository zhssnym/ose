// Command palette (Ctrl+Shift+P) and Go to file (Ctrl+P, and Ctrl+O beside it: D8). Same
// surface, two data sources.
// Matching is a subsequence score with a bonus for word starts, so "phab" finds "page.habits".
//
// Go to file lists every file in the vault (H17), under its real name with its extension, the
// same name the tree and the tab show (W8), with its folder under it. What a page's H1 says is
// not a second name for it: a file has one name, and it is the one on disk.
import { ose } from 'ose:kernel';
import { esc, icon, openOverlay, toast, fuzzy, highlight, pageItems, focusField } from 'ose:ui';
import { allFiles } from './sidebar.js';
import { newFile } from './fileops.js';
import { dirName, extOf, titleOf } from './paths.js';

const { commands, route } = ose;
const navigate = (r, opts) => route.navigate(r, opts);
const recentFiles = () => route.recent();
const shortcutFor = (id) => ose.keys.shortcutFor(id);

// `tree` is the sidebar's row commands (D3): they act on the focused row, else the open page.
// `editor` (the code block's own two) and `image` sit with the other block-level groups; a
// group nobody lists here sorts after `app`.
const GROUP_ORDER = ['navigate', 'tab', 'folder', 'file', 'page', 'format', 'block', 'table', 'editor', 'image', 'tree', 'view', 'planner', 'trash', 'app'];
const GROUP_RANK = new Map(GROUP_ORDER.map((g, i) => [g, i]));

// The matcher and the page-list builder live in fuzzy.js so `pickPage` (dialog.js) ranks pages
// exactly the way Ctrl+P does. Re-exported here because this is where they used to be.
export { fuzzy };

/* -------------------------------------------------------------- what is listed */

// One row per act (R9). `page.close` is what Ctrl+W runs, and it closes the tab: the strip's
// `tab.close` is the same act, and it is the one listed. It still runs by id.
const SHADOWED = new Set(['page.close']);

/** A group's heading, in sentence case (M27): `navigate` -> `Navigate`. */
const groupLabel = (g) => (g ? g.charAt(0).toUpperCase() + g.slice(1) : '');

function commandItems(q) {
  const out = [];
  for (const c of commands.list()) {
    if (SHADOWED.has(c.id)) continue;
    const hay = `${c.title} ${c.group || ''} ${c.id}`;
    const m = fuzzy(hay.toLowerCase(), q.toLowerCase());
    if (!m) continue;
    const titleMatch = fuzzy(c.title.toLowerCase(), q.toLowerCase());
    out.push({
      kind: 'cmd', id: c.id, group: c.group || 'app',
      title: c.title, hint: c.hint || '',
      // `shortcutFor` is the whole truth: a command registered with a `shortcut` that the
      // shell's keys.json has since taken answers null here, and the row prints nothing rather
      // than a chord that runs the other command (QA-K defect 4).
      shortcut: shortcutFor(c.id) || '',
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

/** The name the chrome shows for a path (W8): `ose.names.display`, through paths.js. */
const display = (p) => titleOf(p);

/** Markdown first when two files tie (H17): `notes.md` before `notes.txt` for the same query. */
const isMd = (p) => ['md', 'markdown', 'mdown', 'mkd'].includes(extOf(p));

function fileItems(q) {
  // Every file the tree holds, not only the pages (H17). The title of a row is the file's own
  // name, extension and all; the line under it is its folder.
  const paths = allFiles();
  const names = new Map(paths.map((p) => [p, display(p)]));
  const items = pageItems(paths, q, { recent: recentFiles(), titles: names });
  items.sort((a, b) => (b.score - a.score) || (Number(isMd(b.path)) - Number(isMd(a.path))) || a.title.localeCompare(b.title));
  return items.map((it) => ({
    kind: 'file', id: it.path, group: 'files',
    title: it.title, hint: '', sub: dirName(it.path), shortcut: '',
    score: it.score, hits: it.hits, recent: it.recent,
    run: () => navigate({ type: 'page', path: it.path }),
  }));
}

/**
 * Shift+Enter in Go to file (N41): the file you were looking for and did not find, made with
 * the name you typed. It is New file… (shell/fileops.js) with the prompt already answered, so
 * there is one way a file is created and one rule for where it goes. The name is taken as
 * typed; a name that carries no extension is a page and gets `.md`, and one that does
 * (`notes.txt`, `data.json`) is exactly that file. A name that cannot be used brings the New
 * file prompt up with the reason.
 */
async function createTyped(text) {
  const typed = String(text || '').trim();
  if (!typed) return;
  const { ext } = ose.names.split(typed);
  const name = /^[A-Za-z0-9]{1,10}$/.test(ext) ? typed : `${typed}.md`;
  await newFile(undefined, { name });
}

/* ------------------------------------------------------------------ ui */

let openOv = null;

/**
 * Open the palette in `commands` or `files` mode; switch mode in place when it is already open.
 * @param {'commands'|'files'} [mode]
 */
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
      <span><span class="kbd">↑</span><span class="kbd">↓</span> Move</span>
      <span><span class="kbd">Enter</span> <span class="pal-enter">Run</span></span>
      <span><span class="kbd">Esc</span> Close</span>
      <span class="pal-create" hidden><span class="kbd">Shift</span><span class="kbd">Enter</span> New file</span>
      <span class="grow"></span>
      <span class="pal-mode"></span>
    </div>`;

  // All written just above, so none of them is null.
  const input = /** @type {HTMLInputElement} */ (ov.box.querySelector('.pal-input'));
  const list = /** @type {HTMLElement} */ (ov.box.querySelector('.pal-list'));
  const modeEl = /** @type {HTMLElement} */ (ov.box.querySelector('.pal-mode'));
  const iconEl = /** @type {HTMLElement} */ (ov.box.querySelector('.pal-icon'));
  const createEl = /** @type {HTMLElement} */ (ov.box.querySelector('.pal-create'));
  const enterEl = /** @type {HTMLElement} */ (ov.box.querySelector('.pal-enter'));

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
      d.textContent = 'No matches';
      list.appendChild(d);
      return;
    }
    const frag = document.createDocumentFragment();
    let group = null;
    items.forEach((it, i) => {
      const g = current === 'files' ? (it.recent && !input.value.trim() ? 'recent' : 'files') : it.group;
      if (g !== group) {
        group = g;
        const l = document.createElement('div');
        l.className = 'section-label';
        l.textContent = groupLabel(g);
        frag.appendChild(l);
      }
      const row = document.createElement('div');
      row.className = 'row pal-row' + (i === sel ? ' active' : '');
      row.dataset.i = String(i);
      row.setAttribute('role', 'option');
      // A file row is two lines: its name, and the folder it is in. A file at the vault root
      // has no folder line; a command row is one line, as it always was.
      if (it.kind === 'file' && it.sub) {
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

  /**
   * The row an event landed in, if any.
   * @param {EventTarget|null} t
   * @returns {HTMLElement|null}
   */
  const rowAt = (t) => (t instanceof Element ? t.closest('.pal-row') : null);

  function accept() {
    const it = items[sel];
    if (!it) return;
    ov.close();
    // A command that throws says so on screen, not only in a console nobody has open (B6).
    // Async failures are the command's own to toast; this catches the synchronous ones.
    Promise.resolve().then(() => {
      try { it.run(); } catch (e) { console.error('[shell] palette run', e); toast(String((e && typeof e === 'object' && 'message' in e && e.message) || e), 'err'); }
    });
  }

  function setMode(m) {
    current = m;
    openOv.mode = m;
    input.placeholder = m === 'files' ? 'Go to file…' : 'Type a command…';
    modeEl.textContent = m === 'files' ? 'Go to file' : 'Commands';
    // The foot names the act, and Go to file opens a file rather than running one (R17).
    enterEl.textContent = m === 'files' ? 'Open' : 'Run';
    iconEl.innerHTML = icon(m === 'files' ? 'file' : 'command');
    createEl.hidden = m !== 'files';
    build();
  }

  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    // Shift+Enter in Go to file makes the file you were looking for and did not find (N41).
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
    const row = rowAt(e.target);
    if (!row || Number(row.dataset.i) === sel) return;
    sel = Number(row.dataset.i);
    list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
  });
  list.addEventListener('click', (e) => {
    const row = rowAt(e.target);
    if (!row) return;
    sel = Number(row.dataset.i);
    accept();
  });

  openOv = { ...ov, mode, setMode };
  setMode(mode);
  // In the same task as the chord, so the keys typed right after it land in the input and
  // never in the page behind (focusField tries once more after a task, only if focus moved).
  focusField(ov.box, input);
}

/** Register the palette's two commands. Called once by `boot.js`. */
export function initPalette() {
  commands.register({ id: 'app.palette', title: 'Command palette', group: 'app', run: () => openPalette('commands') });
  commands.register({ id: 'app.quickopen', title: 'Go to file', group: 'navigate', hint: 'by name or path', run: () => openPalette('files') });
}
