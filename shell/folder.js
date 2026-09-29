// The folder view (H15): a folder is a place. `{ type: 'folder', path }` is a route like a page
// or a view — in the history, in a tab, in the address bar — and this file draws it: the
// folder's name, a small toolbar, the list of what is in it (name, type, modified, size, the
// way Explorer lays it out) and, under the list, the folder's README rendered as a note.
//
// The kernel draws nothing (docs/KERNEL.md "Folders"). `initFolder()` registers this file as
// the folder host (`ose.setFolderHost`) before `ose.init`, and the router calls `open` with the
// page column's scroller and the folder's path, then `refresh` on a file change and `unmount`
// on the way out. The same list, compact, is what Home shows for the vault root
// (`mountFolderList`), so there is one list and it behaves one way.
//
// The order is `folder-model.js`'s: folders first, then the folder's own sort, which is kept
// per folder and per machine in `ose.local('folders')` and read by the tree as well. What is
// hidden is the host's word (a dotfile, or the OS hidden attribute); Show hidden items draws
// it greyed. Nothing is hidden by name.
//
// The keyboard is Explorer's, inside the list: arrows, Home/End, type-ahead, Enter opens,
// Ctrl+Enter opens in a new tab, Backspace goes up, F2 renames, Delete trashes, Ctrl+X/C/V cut,
// copy and paste, Ctrl+Z undoes the last file operation, Ctrl+A selects everything. Every one
// of those ends in `shell/fileops.js`, the one UI for a file operation.
//
// The mouse's way to the same places is drag and drop (shell/drag.js): a row dragged onto a
// folder row, here or in the tree, moves; a drop from Explorer or Finder on a folder row or
// on the list's background is copied in; and Alt+drag takes the rows out of the app, as a
// copy.

import { ose } from 'ose:kernel';
import { esc, icon, hasIcon, toast, contextMenu } from 'ose:ui';
import * as M from './folder-model.js';
import * as fops from './fileops.js';
import { openInNewTab } from './tabs.js';
import * as pins from './pins.js';
import { clean, baseName, dirName, titleOf, vaultName, errorOf } from './paths.js';
import { DRAG_TYPE, hasOsFiles, isInternal, takeDropped, importDropped, setDragged, dragged } from './drag.js';

const { bus, commands, route } = ose;

/**
 * One row of a folder, as the host lists it (`ose.files.list`).
 * @typedef {{name: string, path: string, kind: string, ext?: string, mtime: number, size: number,
 *   hidden?: boolean, link?: string|null, readable?: boolean|null}} Row
 */
/** @typedef {{path: string, kind: 'file'|'dir'}} Target */

/** The route of a folder, with the child to select when there is one. */
export const folderRoute = (path, select) => (select ? { type: 'folder', path: clean(path), select } : { type: 'folder', path: clean(path) });

/** A folder's name as the chrome says it: its own name, the vault's at the root. */
export const folderName = (path) => (clean(path) ? baseName(path) : vaultName());

/** A name as the chrome shows it: the full name, `.md` stripped only when hideMdExt is on (W8). */
function display(entry) {
  if (!entry || entry.kind === 'dir') return entry ? entry.name : '';
  return titleOf(entry.path) || entry.name;
}

/** An icon from the kernel's set, else the plain file or folder one: `icon()` falls back to a dot. */
const iconSvg = (name, fallback = 'file') => icon(hasIcon(name) ? name : fallback);

const showHidden = () => !!ose.settings.get().showHidden;

/* ------------------------------------------------------------------ the sort, per folder */

// `ose.local('folders')`, per machine and per vault (W5), taken on first use: the slot is the
// open vault's, and there is none before the boot has one.
let sortSlot = null;
function sorts() {
  if (!sortSlot) sortSlot = ose.local('folders');
  return sortSlot.get() || {};
}
/** The sort `path` is drawn with. */
export function sortSpec(path) { return M.sortSpecFor(sorts(), path); }
/**
 * Sort `path` by `spec`, for this folder only. The tree reads the same slot and redraws on
 * `bus 'folders:sort'`.
 */
export function setSortSpec(path, spec) {
  const next = M.withSortSpec(sorts(), path, spec);
  sortSlot.set(next);
  bus.emit('folders:sort', { path: clean(path), spec: M.sortSpecFor(next, path) });
}

const SORT_WORDS = { name: 'Name', modified: 'Modified', size: 'Size', type: 'Type' };
// The columns, left to right, as Explorer's details view has them.
const COLUMNS = ['name', 'type', 'modified', 'size'];

/* ------------------------------------------------------------------ the list */

let uidSeq = 0;

/**
 * One folder's list, drawn into `el`. The folder view uses it whole; Home uses it compact
 * (fewer columns, no header, a single click opens).
 * @param {*} el
 * @param {string} path
 * @param {{compact?: boolean, onChange?: ((me: object) => void)|null, onLoad?: ((me: object) => void)|null,
 *   select?: string|null}} [opts]
 * @returns the list's handle
 */
function createList(el, path, { compact = false, onChange = null, onLoad = null, select = null } = {}) {
  /**
   * @type {{path: string, compact: boolean, entries: Row[], rows: Row[], spec: {key: string, dir: 'asc'|'desc'},
   *   selected: Set<string>, anchor: string|null, focus: string|null, error: {code: string|null, message: string}|null,
   *   sig: string, alive: boolean, loaded: boolean}}
   */
  const me = {
    path: clean(path),
    compact,
    entries: [],          // what the host answered, every entry
    rows: [],             // what is drawn, in order
    spec: sortSpec(path),
    selected: new Set(),  // names
    anchor: null,         // name the Shift range starts at
    focus: select || null,
    error: null,
    sig: '',
    alive: true,
    loaded: false,
  };
  const uid = `fv${++uidSeq}`;

  el.classList.add('fv');
  if (compact) el.classList.add('fv-compact');
  el.innerHTML = `
    ${compact ? '' : `<div class="fv-cols mono-sm" role="presentation">
      ${COLUMNS.map((k) => `<button type="button" class="fv-col fv-col-${k}" data-sort="${k}" tabindex="-1"></button>`).join('')}
    </div>`}
    <div class="fv-list" role="listbox" aria-multiselectable="true" tabindex="0" aria-describedby="${uid}-sort"></div>
    <span class="fv-sr" id="${uid}-sort"></span>
    <div class="fv-note"></div>`;
  const listEl = el.querySelector('.fv-list');
  const noteEl = el.querySelector('.fv-note');
  const colsEl = el.querySelector('.fv-cols');
  const sortEl = el.querySelector('.fv-sr');
  listEl.setAttribute('aria-label', `${folderName(path)}: contents`);
  // The folder view's list is where the keyboard lands after a navigation (the router focuses
  // the column's `.view-root`); Home's compact list is one group among several and does not.
  if (!compact) listEl.classList.add('view-root');

  const byName = (name) => me.rows.find((e) => e.name === name) || null;
  const indexOf = (name) => me.rows.findIndex((e) => e.name === name);
  /** @type {(e: Row) => Target} */
  const targetOf = (e) => ({ path: e.path, kind: e.kind === 'dir' ? 'dir' : 'file' });
  /**
   * What an operation acts on: the selected rows, and only those. The row the keyboard merely
   * stands on is not a choice (Explorer's dotted focus): with nothing selected, F2, Delete, Cut
   * and Copy do nothing, and never fall back to the folder itself.
   */
  const chosen = () => me.rows.filter((e) => me.selected.has(e.name));
  /** The one row Rename acts on: the focused row when it is selected, else the first selected. */
  const renameRow = () => {
    const f = byName(me.focus);
    return f && me.selected.has(f.name) ? f : chosen()[0] || null;
  };

  /* ---- drawing */

  function drawCols() {
    // Said once for a screen reader, on the list itself: the column headers are pointer chrome.
    sortEl.textContent = `Sorted by ${SORT_WORDS[me.spec.key].toLowerCase()}, ${me.spec.dir === 'asc' ? 'ascending' : 'descending'}`;
    if (!colsEl) return;
    for (const b of colsEl.querySelectorAll('.fv-col')) {
      const k = b.dataset.sort;
      const on = me.spec.key === k;
      b.classList.toggle('on', on);
      b.innerHTML = `<span>${SORT_WORDS[k]}</span>${on ? iconSvg(me.spec.dir === 'asc' ? 'sortAsc' : 'sortDesc', 'chevron') : ''}`;
      b.title = `Sort by ${SORT_WORDS[k].toLowerCase()}`;
      b.setAttribute('aria-label', b.title + (on ? (me.spec.dir === 'asc' ? ', ascending' : ', descending') : ''));
    }
  }

  function rowHtml(e, i) {
    const cut = isCut(e.path);
    const cls = ['fv-row'];
    if (e.hidden) cls.push('hidden');
    if (cut) cls.push('cut');
    if (e.link) cls.push('link');
    if (me.selected.has(e.name)) cls.push('selected');
    if (e.name === me.focus) cls.push('focus');
    const type = M.typeLabel(e);
    const date = M.dateLabel(e.mtime);
    const size = M.sizeLabel(e.size, e.kind);
    const badge = e.link
      ? `<span class="fv-badge" role="img" title="${esc(type)}" aria-label="${esc(type)}">${iconSvg('link', 'dot')}</span>`
      : '';
    const lock = e.readable === false
      ? `<span class="fv-badge" role="img" title="No permission to open this folder" aria-label="no permission">${iconSvg('lock', 'dot')}</span>`
      : '';
    // What the greying and the dimming say, in words: the option's name carries them.
    const states = [e.hidden ? 'hidden' : '', cut ? 'cut' : ''].filter(Boolean);
    const sr = states.length ? `<span class="fv-sr">, ${states.join(', ')}</span>` : '';
    const hint = compact ? `<span class="fv-date mono-sm">${esc(date)}</span>` : `
      <span class="fv-type">${esc(type)}</span>
      <span class="fv-date">${esc(date)}</span>
      <span class="fv-size">${esc(size)}</span>`;
    return `<div class="${cls.join(' ')}" role="option" id="${uid}-${i}" data-name="${esc(e.name)}" aria-selected="${me.selected.has(e.name)}" title="${esc(e.path)}" draggable="true">
      <span class="fv-name">${iconSvg(M.iconName(e), e.kind === 'dir' ? 'folder' : 'file')}<span class="fv-text">${esc(display(e))}</span>${badge}${lock}${sr}</span>${hint}
    </div>`;
  }

  function render() {
    if (!me.alive) return;
    drawCols();
    if (me.error) {
      listEl.innerHTML = '';
      listEl.hidden = true;
      if (colsEl) colsEl.hidden = true;
      noteEl.innerHTML = missHtml(me.error, me.path);
      wireMiss(noteEl, me.path);
      onChange && onChange(me);
      return;
    }
    listEl.hidden = false;
    if (colsEl) colsEl.hidden = !me.rows.length;
    // Selection and focus outlive a redraw by name; a name that is gone takes its mark with it.
    for (const n of [...me.selected]) if (!byName(n)) me.selected.delete(n);
    if (me.focus && !byName(me.focus)) me.focus = null;
    listEl.innerHTML = me.rows.map(rowHtml).join('');
    noteEl.innerHTML = me.rows.length || !me.loaded ? '' : `<div class="fv-empty">${me.entries.length ? 'Only hidden items here. Show hidden items to see them.' : 'This folder is empty.'}</div>`;
    syncActive(false);
    onChange && onChange(me);
  }

  /** The focused row, as the list's active descendant, scrolled into view. */
  function syncActive(scroll = true) {
    const i = indexOf(me.focus);
    for (const r of listEl.querySelectorAll('.fv-row.focus')) r.classList.remove('focus');
    if (i < 0) { listEl.removeAttribute('aria-activedescendant'); return; }
    const row = listEl.children[i];
    if (!row) return;
    row.classList.add('focus');
    listEl.setAttribute('aria-activedescendant', row.id);
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  function syncSelected() {
    for (const row of listEl.children) {
      const on = me.selected.has(row.dataset.name);
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    onChange && onChange(me);
  }

  function syncCut() {
    for (const row of listEl.children) {
      const e = byName(row.dataset.name);
      if (!e) continue;
      row.classList.toggle('cut', isCut(e.path));
      const name = row.querySelector('.fv-name');
      const old = name && name.querySelector('.fv-sr');
      if (old) old.remove();
      const states = [e.hidden ? 'hidden' : '', isCut(e.path) ? 'cut' : ''].filter(Boolean);
      if (name && states.length) name.insertAdjacentHTML('beforeend', `<span class="fv-sr">, ${states.join(', ')}</span>`);
    }
  }

  function resort() {
    me.rows = M.sortEntries(M.visibleEntries(me.entries, { showHidden: showHidden() }), me.spec);
    render();
  }

  /* ---- loading */

  // Names that just arrived here by this app's own hand (a paste, an undo, a restore, a new
  // folder): selected once they are drawn, the way Explorer shows you what you pasted.
  const arriving = new Set();

  /** Select what has arrived, once it is in the rows; what is not there yet waits. */
  function selectArrivals() {
    const here = me.rows.filter((e) => arriving.has(e.name));
    const first = here[0];
    if (!first) return;
    for (const e of here) arriving.delete(e.name);
    me.selected = new Set(here.map((e) => e.name));
    me.anchor = first.name;
    me.focus = first.name;
    syncSelected();
    syncActive();
  }

  async function load() {
    // Where the keyboard stood, as a place in the list: when what it stood on goes (Delete, a
    // move out, a file removed outside), the row that takes that place takes the keyboard.
    const pickedAt = me.rows.reduce((at, e, i) => (at < 0 && me.selected.has(e.name) ? i : at), -1);
    const standAt = pickedAt >= 0 ? pickedAt : indexOf(me.focus);
    const hadSelection = me.selected.size > 0;
    let entries;
    try {
      entries = await ose.files.list(me.path, { hidden: true });
      me.error = null;
    } catch (e) {
      if (!me.alive) return;
      me.error = errorOf(e);
      me.entries = [];
      me.rows = [];
      me.loaded = true;
      me.sig = '';
      render();
      onLoad && onLoad(me);
      return;
    }
    if (!me.alive) return;
    const list = Array.isArray(entries) ? entries : [];
    // A refresh that changes nothing draws nothing: the router calls this on every file
    // change in the vault, and a list redrawn under the pointer loses its hover and its click.
    const sig = JSON.stringify(list.map((e) => [e.name, e.kind, e.mtime, e.size, e.hidden, e.link, e.readable]));
    me.loaded = true;
    if (sig === me.sig && !me.error) { selectArrivals(); return; }
    me.sig = sig;
    me.entries = list;
    me.spec = sortSpec(me.path);
    resort();
    if (select && byName(select)) { selectOnly(select); select = null; }
    else if (standAt >= 0 && me.rows.length && !me.focus && !me.selected.size) {
      // In range: the rows are not empty.
      const next = /** @type {Row} */ (me.rows[Math.min(standAt, me.rows.length - 1)]).name;
      if (hadSelection) selectOnly(next); else { me.focus = next; syncActive(false); }
    }
    selectArrivals();
    onLoad && onLoad(me);
  }

  /* ---- selection */

  function selectOnly(name) {
    me.selected = new Set(name ? [name] : []);
    me.anchor = name;
    me.focus = name;
    syncSelected();
    syncActive();
  }

  function selectRange(name) {
    const a = indexOf(me.anchor != null ? me.anchor : me.focus);
    const b = indexOf(name);
    if (a < 0 || b < 0) { selectOnly(name); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    me.selected = new Set(me.rows.slice(lo, hi + 1).map((e) => e.name));
    me.focus = name;
    syncSelected();
    syncActive();
  }

  function toggle(name) {
    if (me.selected.has(name)) me.selected.delete(name); else me.selected.add(name);
    me.anchor = name;
    me.focus = name;
    syncSelected();
    syncActive();
  }

  function move(delta, { extend = false, keep = false } = {}) {
    if (!me.rows.length) return;
    const at = indexOf(me.focus);
    // The row the keyboard stands on but nothing is selected yet (the first Tab in): the
    // first arrow selects it rather than stepping past it.
    if (at >= 0 && !me.selected.size && !extend && !keep && Math.abs(delta) === 1) { selectOnly(me.focus); return; }
    let next;
    if (delta === -Infinity) next = 0;
    else if (delta === Infinity) next = me.rows.length - 1;
    else next = at < 0 ? (delta > 0 ? 0 : me.rows.length - 1) : Math.max(0, Math.min(me.rows.length - 1, at + delta));
    // In range: clamped to the rows, which are not empty.
    const name = /** @type {Row} */ (me.rows[next]).name;
    if (extend) selectRange(name);
    else if (keep) { me.focus = name; syncActive(); }
    else selectOnly(name);
  }

  // Type-ahead: the letters typed within a moment find the next name that starts with them.
  let typed = '';
  let typedAt = 0;
  function typeAhead(ch) {
    const now = Date.now();
    typed = now - typedAt > 800 ? ch : typed + ch;
    typedAt = now;
    // A repeated single letter ("nnn") walks the names that start with it, however fast it is
    // pressed; a word jumps once, to the first name that starts with the whole of it.
    const lower = typed.toLowerCase();
    const walk = [...lower].every((c) => c === lower[0]);
    const want = walk ? lower[0] : lower;
    const n = me.rows.length;
    if (!n) return;
    const at = indexOf(me.focus);
    const from = walk ? at + 1 : Math.max(0, at);
    for (let k = 0; k < n; k++) {
      const e = me.rows[(from + k) % n];
      if (!e) continue;
      if (display(e).toLowerCase().startsWith(want)) { selectOnly(e.name); return; }
    }
  }

  /* ---- acting */

  function open(e, { aside = false } = {}) {
    if (!e) return;
    if (e.link === 'broken' || e.link === 'loop' || e.link === 'outside') {
      toast(`${e.name}: ${M.typeLabel(e).toLowerCase()}, nothing to open here`, 'info', 3000);
      return;
    }
    const r = e.kind === 'dir' ? folderRoute(e.path) : { type: 'page', path: e.path };
    if (aside) void openInNewTab(r); else void route.navigate(r);
  }

  function goUp() {
    const up = M.parentOf(me.path);
    if (up == null) return;
    void route.navigate(folderRoute(up, baseName(me.path)));
  }

  function rename() {
    const f = renameRow();
    if (f) void fops.renamePath(targetOf(f));
  }

  function trash() {
    const list = chosen();
    if (list.length) void fops.trashPaths(list.map(targetOf));
  }

  function cut() {
    const list = chosen();
    if (list.length) fops.cut(list.map(targetOf));
  }

  function copy() {
    const list = chosen();
    if (list.length) fops.copy(list.map(targetOf));
  }

  function paste() { void fops.paste(me.path); }

  function undo() { void fops.undo(); }

  // The menus are built from the registered commands, as the tree's is (sidebar.js MENU), so a
  // label, an icon or a chord is said in one place. Each row runs its command with the rows it
  // was opened on, never with whatever has the keyboard.
  function menuFor(list) {
    const one = list.length === 1 ? list[0] : null;
    const t = one ? targetOf(one) : null;
    const all = list.map(targetOf);
    const paths = all.map((x) => x.path);
    const items = [];
    if (one) {
      items.push({ label: 'Open', shortcut: ose.keys.label('enter'), run: () => open(one) });
      items.push(commandItem('tree.open-tab', t, { chord: 'mod+enter', run: () => open(one, { aside: true }) }));
      items.push({ sep: true });
    }
    if (paths.some((p) => !pins.has(p))) items.push(commandItem('tree.pin', all, { run: () => pins.add(paths) }));
    if (paths.some((p) => pins.has(p))) items.push(commandItem('tree.unpin', all, { run: () => pins.remove(paths) }));
    if (one) items.push(commandItem('file.rename', t));
    items.push(commandItem('file.move', all));
    if (one && one.kind !== 'dir') items.push(commandItem('file.duplicate', t));
    items.push({ sep: true });
    items.push(commandItem('file.cut', all, { chord: 'mod+x' }));
    items.push(commandItem('file.copy', all, { chord: 'mod+c' }));
    // On a folder, Paste goes into that folder, as Explorer's does; on a file, into this one.
    if (hasClipboard()) {
      items.push(one && one.kind === 'dir' ? commandItem('file.paste', one.path) : commandItem('file.paste', me.path, { chord: 'mod+v' }));
    }
    if (one) {
      items.push({ sep: true });
      items.push(commandItem('tree.copy-path', t), commandItem('tree.copy-link', t));
      items.push({ sep: true });
      if (one.kind === 'dir') items.push(commandItem('tree.search-here', t));
      items.push(commandItem('tree.open-external', t), commandItem('tree.reveal', t));
    }
    items.push({ sep: true });
    items.push(commandItem('file.trash', all, { chord: 'delete' }));
    return items.filter(Boolean);
  }

  function folderMenu() {
    const here = { path: me.path, kind: 'dir' };
    const items = [
      commandItem('file.new', here),
      commandItem('tree.new-folder', me.path),
    ];
    if (hasClipboard()) items.push(commandItem('file.paste', me.path, { chord: 'mod+v' }));
    if (canUndo()) items.push(commandItem('file.undo', undefined, { chord: 'mod+z' }));
    items.push({ sep: true }, { label: 'Select all', shortcut: ose.keys.label('mod+a'), run: () => selectAll() });
    items.push({ sep: true }, commandItem('tree.search-here', here), commandItem('tree.reveal', here));
    return items.filter(Boolean);
  }

  function selectAll() {
    me.selected = new Set(me.rows.map((e) => e.name));
    syncSelected();
  }

  function openMenuAt(x, y) {
    const list = chosen();
    contextMenu(x, y, list.length ? menuFor(list) : folderMenu());
  }

  /* ---- events */

  listEl.addEventListener('mousedown', (e) => {
    // The middle button would start the browser's autoscroll; it opens a tab here instead.
    if (e.button === 1) e.preventDefault();
  });

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.fv-row');
    if (!row) { if (!e.ctrlKey && !e.shiftKey && !e.metaKey) { me.selected.clear(); syncSelected(); } return; }
    const name = row.dataset.name;
    if (e.shiftKey) selectRange(name);
    else if (e.ctrlKey || e.metaKey) toggle(name);
    else {
      selectOnly(name);
      if (compact) open(byName(name));
    }
  });

  listEl.addEventListener('dblclick', (e) => {
    if (compact) return;
    const row = e.target.closest('.fv-row');
    if (row) open(byName(row.dataset.name));
  });

  listEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const row = e.target.closest('.fv-row');
    if (!row) return;
    e.preventDefault();
    open(byName(row.dataset.name), { aside: true });
  });

  listEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('.fv-row');
    if (row && !me.selected.has(row.dataset.name)) selectOnly(row.dataset.name);
    if (!row) { me.selected.clear(); me.focus = null; syncSelected(); syncActive(false); }
    openMenuAt(e.clientX, e.clientY);
  });

  listEl.addEventListener('focus', () => {
    // The first Tab into the list stands on a row, so the arrows have somewhere to start.
    if (!me.focus && me.rows.length) { me.focus = /** @type {Row} */ (me.rows[0]).name; syncActive(); }
  });

  listEl.addEventListener('keydown', (e) => {
    if (e.isComposing || e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const cur = byName(me.focus);
    let done = true;
    if (k === 'ArrowDown') move(1, { extend: e.shiftKey, keep: mod && !e.shiftKey });
    else if (k === 'ArrowUp') move(-1, { extend: e.shiftKey, keep: mod && !e.shiftKey });
    else if (k === 'PageDown') move(10, { extend: e.shiftKey });
    else if (k === 'PageUp') move(-10, { extend: e.shiftKey });
    else if (k === 'Home') move(-Infinity, { extend: e.shiftKey });
    else if (k === 'End') move(Infinity, { extend: e.shiftKey });
    else if (k === 'Enter') open(cur, { aside: mod });
    else if (k === ' ' && mod) { if (cur) toggle(cur.name); }
    else if (k === ' ' && !mod && cur && !me.selected.has(cur.name)) selectOnly(cur.name);
    else if (k === 'Backspace' && !mod) goUp();
    else if (k === 'F2') rename();
    else if (k === 'Delete') trash();
    else if (mod && !e.shiftKey && k.toLowerCase() === 'a') selectAll();
    else if (mod && !e.shiftKey && k.toLowerCase() === 'x') cut();
    else if (mod && !e.shiftKey && k.toLowerCase() === 'c') copy();
    else if (mod && !e.shiftKey && k.toLowerCase() === 'v') paste();
    else if (mod && !e.shiftKey && k.toLowerCase() === 'z') undo();
    else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      const row = listEl.children[indexOf(me.focus)];
      const r = (row || listEl).getBoundingClientRect();
      openMenuAt(Math.round(r.left + 24), Math.round(row ? r.bottom : r.top));
    } else if (k === 'Escape' && me.selected.size > 1) {
      // Esc keeps falling through (a toast, focus mode); it only drops a wide selection here.
      const f = me.focus;
      me.selected = new Set(f ? [f] : []);
      syncSelected();
      done = false;
    } else if (k.length === 1 && !mod && k !== ' ') typeAhead(k);
    else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  });

  /* ---- drag and drop (shell/drag.js) */

  let dropOn = null;
  let draggingHere = false;
  // The host element outlives this list when a caller reuses it: its drop listeners go with
  // the list (`unmount`), and the list's own go with its nodes.
  const hostEvents = new AbortController();
  const onHost = { signal: hostEvents.signal };
  function setDropOn(node) {
    if (dropOn === node) return;
    if (dropOn) dropOn.classList.remove('drop-on');
    dropOn = node;
    if (dropOn) dropOn.classList.add('drop-on');
  }
  /**
   * Where a drop at `node` lands: a folder row's folder, else this folder. The whole list is
   * this folder's background, the note under it included, so an empty folder takes a drop too.
   */
  function dropTarget(node) {
    const row = node && node.closest ? node.closest('.fv-row') : null;
    const en = row ? byName(row.dataset.name) : null;
    if (en && en.kind === 'dir' && en.readable !== false && !en.link) return { el: row, dir: en.path };
    return { el, dir: me.path };
  }

  listEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.fv-row');
    const en = row ? byName(row.dataset.name) : null;
    if (!en || !e.dataTransfer) { e.preventDefault(); return; }
    // A row inside the selection drags the selection; any other row, itself.
    const list = me.selected.has(en.name) ? chosen() : [en];
    const paths = list.map((x) => x.path);
    draggingHere = true;
    setDragged(paths);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.setData('text/plain', paths.join('\n'));
  });
  listEl.addEventListener('dragend', () => { draggingHere = false; setDragged(null); setDropOn(null); });

  el.addEventListener('dragover', (e) => {
    const moving = dragged();
    const internal = !!moving || isInternal(e.dataTransfer);
    const external = !internal && hasOsFiles(e.dataTransfer);
    if (!internal && !external) return;
    e.preventDefault();
    const t = dropTarget(e.target);
    // A move lights a folder only when every dragged item may go there (not into itself, not
    // where it already is); the list's own background is where the rows already are.
    const ok = external || (moving || []).every((p) => fops.canMoveInto(p, t.dir));
    if (!ok) { setDropOn(null); e.dataTransfer.dropEffect = 'none'; return; }
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    setDropOn(t.el);
  }, onHost);
  el.addEventListener('dragleave', (e) => {
    if (dropOn && !el.contains(e.relatedTarget)) setDropOn(null);
  }, onHost);
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = dropTarget(e.target);
    let from = dragged();
    if (!from && isInternal(e.dataTransfer)) {
      try { const v = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); if (Array.isArray(v)) from = v.map(clean).filter(Boolean); } catch { from = null; }
    }
    // The drop's items are readable only inside the event: taken before anything awaits.
    const dropped = !(from && from.length) && hasOsFiles(e.dataTransfer) ? takeDropped(e.dataTransfer) : null;
    setDropOn(null);
    if (from && from.length) {
      const movable = from.filter((p) => fops.canMoveInto(p, t.dir));
      if (movable.length) void fops.movePaths(movable.map((p) => ({ path: p, kind: 'file' })), t.dir);
    } else if (dropped) {
      void importDropped(dropped, t.dir);
    }
    if (draggingHere) { draggingHere = false; setDragged(null); }
  }, onHost);

  if (colsEl) {
    colsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.fv-col');
      if (!b) return;
      setSort(M.nextSortSpec(me.spec, b.dataset.sort));
    });
  }

  function setSort(spec) {
    me.spec = { key: spec.key, dir: spec.dir };
    setSortSpec(me.path, me.spec);
    resort();
  }

  const offs = [];
  // While the list has the keyboard it is "here" for every file command, whichever way the
  // command is reached (shell/fileops.js `addContext`). F2 and the palette's Rename act on the
  // selected row and on nothing when none is selected: never on the folder itself. Cut, Copy
  // and the trash act on the selection. New file, New folder and Paste land in this folder.
  offs.push(fops.addContext({
    active: () => me.alive && document.activeElement === listEl,
    target: () => { const f = renameRow(); return f ? targetOf(f) : null; },
    batch: () => chosen().map(targetOf),
    folder: () => me.path,
  }));
  offs.push(fops.onClipboard(() => { syncCut(); onChange && onChange(me); }));
  offs.push(bus.on('folders:sort', (d) => {
    if (!d || clean(d.path) !== me.path) return;
    if (d.spec && (d.spec.key !== me.spec.key || d.spec.dir !== me.spec.dir)) { me.spec = { ...d.spec }; resort(); }
  }));
  // The selection follows a rename or a move inside this folder, so F2 then Enter opens what
  // was renamed and not the row that now stands where it stood.
  offs.push(bus.on('paths:moved', (d) => {
    for (const m of (d && d.moves) || []) {
      if (!m || dirName(m.from) !== me.path) continue;
      const was = baseName(m.from);
      if (dirName(m.to) === me.path) {
        const now = baseName(m.to);
        if (me.selected.delete(was)) me.selected.add(now);
        if (me.focus === was) me.focus = now;
        if (me.anchor === was) me.anchor = now;
      }
    }
    // What came in from another folder (a paste of a cut, an undone move) is selected here.
    for (const m of (d && d.moves) || []) {
      if (m && dirName(m.to) === me.path && dirName(m.from) !== me.path) arriving.add(baseName(m.to));
    }
    void load();
  }));
  // The same for a copy, a restore (an undone trash) and a new folder: once drawn, selected.
  const arrive = (paths) => { for (const p of paths) if (p && dirName(p) === me.path) arriving.add(baseName(p)); };
  offs.push(bus.on('paths:created', (d) => { arrive((d && d.paths) || []); void load(); }));
  offs.push(bus.on('paths:copied', (d) => { arrive(((d && d.pairs) || []).map((x) => x && x.to)); void load(); }));
  offs.push(bus.on('paths:restored', (d) => { arrive(((d && d.items) || []).map((x) => x && x.path)); void load(); }));
  offs.push(bus.on('paths:trashed', () => void load()));
  // Only the two settings the list draws with redraw it: a zoom or a theme leaves it alone.
  const viewKey = () => { const s = ose.settings.get(); return `${!!s.showHidden}:${!!s.hideMdExt}`; };
  let lastView = viewKey();
  offs.push(bus.on('settings', () => { const k = viewKey(); if (k !== lastView) { lastView = k; resort(); } }));

  const handle = {
    get path() { return me.path; },
    get count() { return me.rows.length; },
    get error() { return me.error; },
    get spec() { return { ...me.spec }; },
    refresh: () => load(),
    focus() { listEl.focus({ preventScroll: true }); },
    selection: () => me.focus || (me.selected.size ? [...me.selected][0] : null),
    select(name) { if (byName(name)) selectOnly(name); },
    setSort,
    chosen: () => chosen().map(targetOf),
    entries: () => me.entries.slice(),
    goUp,
    openMenu: () => { const r = listEl.getBoundingClientRect(); openMenuAt(Math.round(r.left + 24), Math.round(r.top)); },
    unmount() {
      me.alive = false;
      hostEvents.abort();
      setDropOn(null);
      el.classList.remove('drop-on');
      for (const off of offs) { try { off && off(); } catch { /* gone */ } }
      el.textContent = '';
    },
    ready: load(),
  };
  return handle;
}

/* ------------------------------------------------------------------ small pieces */

function isCut(path) {
  const c = fops.clipboard();
  return !!c && c.mode === 'cut' && c.paths.some((p) => clean(p) === clean(path));
}

function hasClipboard() {
  const c = fops.clipboard();
  return !!c && c.paths.length > 0;
}

const canUndo = () => ose.fileops.journal.canUndo();

function newFileHere(path) { void fops.newFile({ path: clean(path), kind: 'dir' }); }

function newFolderHere(path) { void fops.newFolder(clean(path)); }

/**
 * A menu row from a registered command: its title, its icon and its chord, as the palette and
 * the tree's menu say them, run with `arg` (the rows the menu is for, or a folder path).
 * `chord` names the list's own key for a command the keymap does not bind (Ctrl+X is the
 * list's, so the editor keeps its own); `run` replaces the command's own run for a row that
 * must act on several rows where the command takes one (Pin).
 * @param {string} id
 * @param {*} arg
 * @param {{chord?: string, run?: (() => unknown)|null}} [opts]
 * @returns {object|null} null when the command is not registered
 */
function commandItem(id, arg, { chord = '', run = null } = {}) {
  const c = commands.get(id);
  if (!c) return null;
  return {
    label: c.title,
    iconSvg: c.icon ? icon(c.icon) : '',
    shortcut: ose.keys.shortcutFor(id) || (chord ? ose.keys.label(chord) : ''),
    danger: id === 'file.trash',
    run: () => {
      const failed = (e) => { console.error('[folder] menu', id, e); toast(String((e && e.message) || e), 'err', 0); };
      try {
        const out = run ? run() : c.run(arg);
        if (out && typeof out.then === 'function') out.then(null, failed);
      } catch (e) { failed(e); }
    },
  };
}

/** The box a folder that cannot be listed gets, in the router's own miss shape. */
function missHtml(err, path) {
  const denied = err.code === 'permission' || err.code === 'denied' || /denied|permission/i.test(err.message);
  const title = err.code === 'not_found' ? 'This folder is not there'
    : err.code === 'escapes_vault' ? 'This folder is outside the vault'
      : denied ? 'No permission to open this folder'
        : 'This folder could not be read';
  const up = M.parentOf(path);
  return `<div class="miss fv-miss">
    <div class="miss-title">${esc(title)}</div>
    <div class="miss-path mono">${esc(clean(path) || vaultName())}</div>
    ${err.message && err.code !== 'not_found' ? `<div class="miss-why">${esc(err.message)}</div>` : ''}
    ${up != null ? '<button type="button" class="btn fv-up">Go to parent folder</button>' : ''}
  </div>`;
}

function wireMiss(box, path) {
  const b = box.querySelector('.fv-up');
  if (b) b.addEventListener('click', () => void route.navigate(folderRoute(M.parentOf(path), baseName(path))));
}

/* ------------------------------------------------------------------ the view */

// The one folder view on screen, if any: what the toolbar commands and `folder.sort` act on.
let current = null;

function toolButton(cls, iconName, fallback, label, title) {
  return `<button type="button" class="btn sm ghost fv-tool ${cls}" title="${esc(title || label)}">${iconSvg(iconName, fallback)}<span>${esc(label)}</span></button>`;
}

/**
 * The folder view, drawn into the page column's scroller: the header, the toolbar, the list
 * and the README under it. Answers the handle the router keeps (docs/KERNEL.md "Folders").
 * @param {HTMLElement} el
 * @param {string} path
 * @param {{select?: string, scrollTop?: number}} [opts]
 * @returns {Promise<{unmount: Function, refresh: Function, selection: Function}>}
 */
async function openFolder(el, path, opts = {}) {
  const p = clean(path);
  const root = document.createElement('div');
  root.className = 'page-col folder-view';
  root.innerHTML = `
    <div class="fv-head">
      <h1 class="page-title fv-title"></h1>
      <span class="fv-count mono-sm"></span>
    </div>
    <div class="fv-tools" role="toolbar" aria-label="Folder">
      ${toolButton('fv-new', 'plus', 'plus', 'New file', 'New file…')}
      ${toolButton('fv-mkdir', 'folderPlus', 'folder', 'New folder')}
      ${toolButton('fv-paste', 'clipboard', 'copy', 'Paste')}
      ${toolButton('fv-undo', 'undo', 'back', 'Undo')}
      <span class="fv-tools-gap"></span>
      ${toolButton('fv-sort', 'sortAsc', 'chevron', 'Name', 'Sort by…')}
      ${toolButton('fv-hidden', 'eye', 'view', 'Show hidden items')}
    </div>
    <div class="fv-body"></div>
    <div class="fv-readme" hidden>
      <div class="fv-readme-head"><span class="fv-readme-name mono-sm"></span><button type="button" class="btn sm ghost fv-edit">Edit</button></div>
      <div class="fv-readme-body"></div>
    </div>`;
  el.appendChild(root);

  // Drawn just above, as is everything this function looks up in `root`.
  const titleEl = /** @type {HTMLElement} */ (root.querySelector('.fv-title'));
  const countEl = /** @type {HTMLElement} */ (root.querySelector('.fv-count'));
  titleEl.textContent = folderName(p);
  titleEl.title = p || vaultName();

  const btn = (c) => /** @type {HTMLElement} */ (root.querySelector('.' + c));
  const tools = {
    paste: btn('fv-paste'), undo: btn('fv-undo'), sort: btn('fv-sort'), hidden: btn('fv-hidden'),
  };
  // The chords are said in the tooltips, never on the buttons: the bar is chrome.
  const chordTitle = (b, label, id) => {
    const chord = ose.keys.shortcutFor(id);
    b.title = chord ? `${label} (${chord})` : label;
  };
  chordTitle(btn('fv-new'), 'New file…', 'file.new');
  chordTitle(btn('fv-mkdir'), 'New folder', 'tree.new-folder');
  btn('fv-new').addEventListener('click', () => newFileHere(p));
  btn('fv-mkdir').addEventListener('click', () => newFolderHere(p));
  tools.paste.addEventListener('click', () => void fops.paste(p));
  tools.undo.addEventListener('click', () => void fops.undo());
  tools.sort.addEventListener('click', () => sortMenu(tools.sort));
  tools.hidden.addEventListener('click', () => toggleHidden());

  let readmeFor = null;
  let readmeSeq = 0;

  function syncTools(list) {
    const n = list ? list.count : 0;
    countEl.textContent = list && !list.error ? `${n} item${n === 1 ? '' : 's'}` : '';
    tools.paste.hidden = !hasClipboard();
    tools.undo.hidden = !canUndo();
    const spec = list ? list.spec : M.DEFAULT_SORT;
    tools.sort.innerHTML = `${iconSvg(spec.dir === 'asc' ? 'sortAsc' : 'sortDesc', 'chevron')}<span>${esc(SORT_WORDS[spec.key])}</span>`;
    tools.sort.title = `Sort by ${SORT_WORDS[spec.key].toLowerCase()}, ${spec.dir === 'asc' ? 'ascending' : 'descending'}. Choose another…`;
    const on = showHidden();
    tools.hidden.setAttribute('aria-pressed', on ? 'true' : 'false');
    tools.hidden.classList.toggle('on', on);
    tools.hidden.innerHTML = `${iconSvg(on ? 'eye' : 'eyeOff', 'view')}<span>Show hidden items</span>`;
  }

  const body = root.querySelector('.fv-body');
  let dead = false;
  const list = createList(body, p, {
    select: opts.select || null,
    onChange: () => syncTools(list),
    onLoad: () => { syncTools(list); void drawReadme(); },
  });

  /** The README under the list: the first of README.md, readme.md, index.md, read-only. */
  async function drawReadme() {
    const box = /** @type {HTMLElement} */ (root.querySelector('.fv-readme'));
    const part = (c) => /** @type {HTMLElement} */ (box.querySelector(c));
    // Every entry, hidden ones too: a folder's README is its own page whatever its attributes.
    const hit = M.readmeOf(list.error ? [] : list.entries());
    const key = hit ? `${hit.path}:${hit.mtime}:${hit.size}` : null;
    if (key === readmeFor) return;
    readmeFor = key;
    const my = ++readmeSeq;
    if (!hit) { box.hidden = true; part('.fv-readme-body').textContent = ''; return; }
    let text = '';
    let render = null;
    try {
      const [t, ed] = await Promise.all([ose.files.read(hit.path), import('ose:editor')]);
      text = t;
      render = ed.render;
    } catch (e) {
      console.warn('[folder] readme', e);
      if (my === readmeSeq) box.hidden = true;
      return;
    }
    if (my !== readmeSeq || dead) return;
    part('.fv-readme-name').textContent = hit.name;
    const edit = part('.fv-edit');
    edit.onclick = () => void route.navigate({ type: 'page', path: hit.path });
    edit.title = `Edit ${hit.name}`;
    const out = part('.fv-readme-body');
    out.textContent = '';
    try {
      out.appendChild(render(text, {
        basePath: hit.path,
        onLink: (target, heading) => void followLink(target, heading),
      }));
    } catch (e) {
      console.warn('[folder] readme render', e);
      out.textContent = text;
    }
    box.hidden = false;
  }

  const me = {
    path: p,
    list,
    sortMenu: () => sortMenu(tools.sort),
    toggleHidden,
  };
  current = me;

  const offs = [
    bus.on('fileops:journal', () => syncTools(list)),
    bus.on('settings', () => syncTools(list)),
  ];

  await list.ready;
  syncTools(list);
  // The router keeps the scroll per route; the host puts it back once the rows exist.
  if (typeof opts.scrollTop === 'number' && opts.scrollTop > 0) {
    const top = opts.scrollTop;
    const scroller = el.closest('.main-scroll') || el;
    requestAnimationFrame(() => { if (scroller.isConnected) scroller.scrollTop = top; });
  }

  return {
    unmount() {
      dead = true;
      readmeSeq++;
      for (const off of offs) { try { off && off(); } catch { /* gone */ } }
      list.unmount();
      if (current === me) current = null;
      root.remove();
    },
    refresh() { void list.refresh(); syncTools(list); },
    selection: () => list.selection(),
  };
}

/** Follow a link out of a README: a folder opens as a folder, anything else as a page. */
async function followLink(target, heading) {
  let kind = 'file';
  try { const s = await ose.files.stat(target); if (s && s.kind === 'dir') kind = 'dir'; } catch { /* a page route decides */ }
  if (kind === 'dir') void route.navigate(folderRoute(target));
  else void route.navigate(heading ? { type: 'page', path: target, heading } : { type: 'page', path: target });
}

/** The sort control's menu: the four columns, then the two directions. */
function sortMenu(anchor) {
  const v = current;
  if (!v) return;
  const spec = v.list.spec;
  const r = anchor ? anchor.getBoundingClientRect() : { left: 80, bottom: 80 };
  // The current choice wears the dot, the one mark the app has for "this one".
  const mark = (on) => (on ? icon('dot') : '');
  /** @type {{label?: string, iconSvg?: string, run?: () => void, sep?: boolean}[]} */
  const items = M.SORT_KEYS.map((k) => ({
    label: SORT_WORDS[k], iconSvg: mark(spec.key === k),
    run: () => v.list.setSort({ key: k, dir: spec.key === k ? spec.dir : M.nextSortSpec(spec, k).dir }),
  }));
  items.push({ sep: true });
  items.push({ label: 'Ascending', iconSvg: mark(spec.dir === 'asc'), run: () => v.list.setSort({ key: spec.key, dir: 'asc' }) });
  items.push({ label: 'Descending', iconSvg: mark(spec.dir === 'desc'), run: () => v.list.setSort({ key: spec.key, dir: 'desc' }) });
  contextMenu(Math.round(r.left), Math.round(r.bottom), items);
}

/** Show hidden items: the tree's command, so there is one toggle and it says one thing. */
const toggleHidden = () => commands.run('view.toggle-hidden');

/**
 * The folder list alone, for a surface that shows a folder without being its view: Home's
 * vault root (H19). `compact` draws the name and the date only, and a click opens.
 * @param {HTMLElement} el
 * @param {string} path
 * @param {{compact?: boolean}} [opts]
 * @returns {{refresh: Function, unmount: Function, focus: Function, selection: Function, ready: Promise}}
 */
export function mountFolderList(el, path, { compact = true } = {}) {
  return createList(el, path, { compact });
}

/* ------------------------------------------------------------------ where "up" is */

/** The route one step up from `r`: a folder's parent, a page's folder; null otherwise. */
export function upFrom(r) {
  if (!r) return null;
  if (r.type === 'folder') {
    const up = M.parentOf(r.path);
    return up == null ? null : folderRoute(up, baseName(r.path));
  }
  if (r.type === 'page' && r.path) return folderRoute(dirName(r.path), baseName(r.path));
  return null;
}

/* ------------------------------------------------------------------ registration */

/**
 * Register the folder host and the folder commands. `boot.js` calls it before `ose.init`, so
 * the router can draw a folder route from its first navigation.
 */
export function initFolder() {
  ose.setFolderHost({ open: (el, path, opts) => openFolder(el, path, opts || {}) });

  commands.register({
    id: 'folder.up', title: 'Go to parent folder', group: 'navigate',
    hint: 'the folder this page or folder is in',
    when: () => !!upFrom(route.current()),
    run: () => { const r = upFrom(route.current()); if (r) return route.navigate(r); return undefined; },
  });
  commands.register({
    id: 'folder.show-current', title: 'Show in folder', group: 'navigate',
    hint: 'the page on screen, selected in its folder',
    when: () => { const r = route.current(); return !!r && r.type === 'page'; },
    run: () => { const r = upFrom(route.current()); if (r) return route.navigate(r); return undefined; },
  });
  commands.register({
    id: 'folder.sort', title: 'Sort folder by…', group: 'navigate',
    hint: 'name, modified, size or type, for this folder',
    when: () => !!current,
    run: () => { if (current) current.sortMenu(); },
  });
  commands.register({
    id: 'folder.open-root', title: 'Open vault folder', group: 'navigate',
    hint: 'the vault root as a folder',
    run: () => route.navigate(folderRoute('')),
  });
}
