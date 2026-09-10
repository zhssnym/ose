// Sidebar: pinned, views, pages, scratch. One scrolling column, no search box (search
// is the Ctrl+F overlay now). Expansion and pins are persisted; the current page is revealed.
// Rows drag onto folder rows to move files; files dragged in from Explorer are imported.
// In focus mode the pages section is rooted at one folder and the other sections go away.
// Several rows can be selected at once (C17) and moved, trashed, pinned or dragged together;
// every move, however it was made, rewrites the links that pointed at what moved (C13).
import { bus, store, commands, views, debounce, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { icon, hasIcon } from './icons.js';
import { patchState, stateCache } from './state.js';
import { navigate, currentRoute, clearRoute, focusMain } from './router.js';
import { prompt, confirm, contextMenu, pickFolder, toast, copyText, focusOrigin, retargetFocusOrigin, overlayCount } from './dialog.js';
import { shortcutFor } from './keys.js';
import { getFocus, setFocus, exitFocus, isUnderFocus, defaultNewFolder } from './focus.js';
import { getSource } from '../lib/sources.js';
import { vaultLost } from './vault.js';
import { rewriteInboundMany, findInbound } from '../lib/links.js';
import { clean, join, baseName, dirName, extOf, titleOf, isMd, isHiddenName, segments } from './paths.js';
import { relativeHref, isTextFile } from '../editor/paths.js';
import { openSearch } from './search.js';
import './nav.css';

let el = null, scrollEl = null;
let tree = null;
let expanded = new Set();
let pins = [];
// The one row that is a tab stop (D2). A key, not an element: rows are rebuilt on every render.
let roving = null;
// Set by a rename or move so the next render puts focus on the row's new name (B4).
let focusAfterRender = null;
// The multi-selection (C17): tree paths, never pins or views. Empty means the focused row is
// the only target, as before; two or more and the tree commands act on all of them. `anchor`
// is the row a Shift-range grows from, set by every plain click or arrow.
let selected = new Set();
let anchor = null;

const ARCHIVE = '_Archive';

// The scratch folder is a source, not a name in the code: `7-scratchpad` today, whatever the
// user points it at tomorrow (CONTRACT.md batch 5). Everything that used to say 'Scratchpad'
// asks here, and the sidebar re-renders on the `sources` event.
export function scratchFolder() { return getSource('scratch'); }

/* ------------------------------------------------------------------ tree data */

// Files and folders sort together, in natural numeric order, case- and accent-insensitive,
// so `0. Index/` and `00-index.md` land next to each other and before any letter. The bridge
// and the host both hand us folders first; this is where that is undone.
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent', caseFirst: 'false' });
export const compareNames = (a, b) => COLLATOR.compare(a, b);

function sortChildren(list, atRoot) {
  const out = list.filter((c) => !isHiddenName(c.name));
  out.sort((a, b) => {
    if (atRoot) {
      const aa = a.name === ARCHIVE, bb = b.name === ARCHIVE;
      if (aa !== bb) return aa ? 1 : -1;
    }
    return COLLATOR.compare(a.name, b.name);
  });
  return out;
}

function findNode(path) {
  const segs = segments(path);
  let node = tree;
  for (const s of segs) {
    if (!node || !node.children) return null;
    node = node.children.find((c) => c.name === s);
  }
  return node || null;
}

function mdFilesOf(node) {
  return node && node.children ? node.children.filter((c) => c.kind === 'file' && isMd(c.name)) : [];
}

/** Every .md path in the vault, for the quick-open palette. Focus mode narrows it. */
export function allPages() {
  const out = [];
  const walk = (n, atRoot) => {
    if (!n.children) return;
    for (const c of sortChildren(n.children, atRoot)) {
      if (c.kind === 'dir') walk(c, false);
      else if (isMd(c.name)) out.push(c.path);
    }
  };
  if (tree) walk(tree, true);
  return getFocus() ? out.filter((p) => isUnderFocus(p)) : out;
}

export function treeRoot() { return tree; }

/* ------------------------------------------------------------------ expansion */

function persistExpanded() {
  const s = stateCache().sidebar || {};
  patchState({ sidebar: { ...s, expanded: [...expanded] } });
}

function expandAncestors(path) {
  const segs = segments(dirName(path));
  let acc = '';
  for (const s of segs) { acc = acc ? acc + '/' + s : s; expanded.add(acc); }
}

/* ------------------------------------------------------------------ pins */

function persistPins() { patchState({ pins: [...pins] }); }

export function isPinned(path) { return pins.includes(clean(path)); }

function pin(path) {
  const p = clean(path);
  if (!p || pins.includes(p)) return;
  pins.push(p);
  persistPins();
  render();
}

function unpin(path) {
  const p = clean(path);
  const i = pins.indexOf(p);
  if (i < 0) return;
  pins.splice(i, 1);
  persistPins();
  render();
}

/** A selection pinned or unpinned in one go (C17): one persist, one render. */
function pinMany(paths) {
  const add = paths.map(clean).filter((p) => p && !pins.includes(p));
  if (!add.length) return;
  pins.push(...add);
  persistPins();
  render();
}

function unpinMany(paths) {
  const drop = new Set(paths.map(clean));
  const before = pins.length;
  pins = pins.filter((p) => !drop.has(p));
  if (pins.length === before) return;
  persistPins();
  render();
}

/** Follow a rename or a move: a pinned path, and anything under it, keeps its pin. */
function repinMoved(from, to) {
  let changed = false;
  pins = pins.map((p) => {
    if (p === from) { changed = true; return to; }
    if (p.startsWith(from + '/')) { changed = true; return to + p.slice(from.length); }
    return p;
  });
  if (changed) persistPins();
}

function dropPinsUnder(path) {
  const before = pins.length;
  pins = pins.filter((p) => p !== path && !p.startsWith(path + '/'));
  if (pins.length !== before) persistPins();
}

/** Drop pins whose file is gone (deleted outside the app). Only when the tree is loaded. */
function prunePins() {
  if (!tree) return;
  const before = pins.length;
  pins = pins.filter((p) => !!findNode(p));
  if (pins.length !== before) persistPins();
}

/* ------------------------------------------------------------------ rendering */

// Every row is the same three-column grid: 16px chevron slot, 14px glyph, name (plus an
// optional mono tail). Folders and pages at the same depth put their text at the same x.
function rowEl({ cls = '', depth = 0, glyphHtml = '', chevron = null, text, tail = '', hint = '', data = {} }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row sb-row ' + cls;
  const inTree = !!data.path && data.pin !== '1';
  if (inTree && selected.has(data.path)) b.classList.add('selected');
  b.style.setProperty('--d', depth);
  for (const k of Object.keys(data)) b.dataset[k] = data[k];
  if (data.path) b.draggable = true; // moves within the vault; see the drag and drop section
  // A tree to a screen reader, not a list of unrelated buttons (S39, P8's request): the level
  // is 1-based, `aria-selected` is on every selectable row so the reader can say "not
  // selected" too, and only a folder claims to expand.
  b.setAttribute('role', 'treeitem');
  b.setAttribute('aria-level', String(depth + 1));
  if (inTree) b.setAttribute('aria-selected', String(selected.has(data.path)));
  if (chevron !== null) b.setAttribute('aria-expanded', String(!!chevron));
  b.innerHTML =
    `<span class="tw${chevron ? ' open' : ''}">${chevron === null ? '' : icon('chevron')}</span>` +
    `<span class="gl">${glyphHtml}</span>` +
    `<span class="grow">${esc(text)}</span>` +
    (tail ? `<span class="par">${esc(tail)}</span>` : '') +
    (hint ? `<span class="hint">${esc(hint)}</span>` : '');
  return b;
}

// A section label doubles as a drop target when `dropPath` is given: '' is the vault root,
// 'Scratchpad' the scratch section. Pass nothing for a label that takes no drops.
function label(text, dropPath) {
  const d = document.createElement('div');
  d.className = 'section-label';
  d.textContent = text;
  if (dropPath !== undefined && dropPath !== null) d.dataset.drop = dropPath;
  return d;
}

// Views may hand us a raw <svg> string, a name from our icon set, or nothing.
function viewIcon(v) {
  const i = v.icon;
  if (typeof i === 'string' && i.trim().startsWith('<')) return i;
  if (typeof i === 'string' && hasIcon(i)) return icon(i);
  return icon(hasIcon(v.name) ? v.name : 'view');
}

/**
 * A `role="tree"` box for one section, so every `treeitem` has a tree to belong to (S39).
 * One tree per section rather than one for the whole sidebar: the sections are separate lists
 * with separate names, and claiming otherwise would make a reader announce wrong positions.
 */
function treeBox(frag, label) {
  const box = document.createElement('div');
  box.className = 'sb-group';
  box.setAttribute('role', 'tree');
  box.setAttribute('aria-label', label);
  frag.appendChild(box);
  return box;
}

/** Pinned pages and folders, in pin order. Hidden entirely while nothing is pinned. */
function renderPinned(frag) {
  if (!pins.length) return;
  const r = currentRoute();
  const curPath = r && r.type === 'page' ? r.path : null;
  const names = new Map();
  for (const p of pins) names.set(baseName(p), (names.get(baseName(p)) || 0) + 1);

  frag.appendChild(label('pinned'));
  const box = treeBox(frag, 'Pinned');
  for (const p of pins) {
    const node = findNode(p);
    const dir = node ? node.kind === 'dir' : !baseName(p).includes('.');
    const name = dir ? baseName(p) : titleOf(p);
    const ambiguous = (names.get(baseName(p)) || 0) > 1;
    const parent = dirName(p);
    box.appendChild(rowEl({
      cls: 'sb-pin ' + (dir ? 'dir' : 'file') + (curPath === p ? ' current' : ''),
      depth: 0,
      glyphHtml: icon(dir ? 'folder' : 'page'),
      text: name,
      tail: ambiguous ? (parent ? baseName(parent) : '/') : '',
      data: { path: p, kind: dir ? 'dir' : 'file', md: isMd(p) ? '1' : '0', pin: '1' },
    }));
  }
}

/** The agent row is its own section above the views, and is never listed among them. */
function renderViews(frag) {
  const list = views.list();
  if (!list.length) return;
  frag.appendChild(label('views'));
  const box = treeBox(frag, 'Views');
  const r = currentRoute();
  for (const v of list) {
    box.appendChild(rowEl({
      cls: 'sb-view' + (r && r.type === 'view' && r.name === v.name ? ' current' : ''),
      depth: 0,
      glyphHtml: viewIcon(v),
      text: v.title || v.name,
      data: { view: v.name },
    }));
  }
}

function renderNode(node, depth, frag, curPath) {
  if (isHiddenName(node.name)) return;
  // The scratch folder has its own section; it is never drawn twice, wherever it sits.
  if (node.kind === 'dir' && !getFocus() && node.path === scratchFolder()) return;
  if (node.kind === 'dir') {
    const open = expanded.has(node.path);
    frag.appendChild(rowEl({
      cls: 'dir' + (node.name === ARCHIVE ? ' archive' : ''),
      depth, chevron: open, glyphHtml: icon('folder'), text: node.name,
      data: { path: node.path, kind: 'dir' },
    }));
    if (open && node.children) {
      for (const c of sortChildren(node.children, false)) renderNode(c, depth + 1, frag, curPath);
    }
  } else {
    const md = isMd(node.name);
    // A non-markdown row says what it is, in the chrome voice, rather than wearing the page
    // glyph and hoping the extension in the name is noticed (N28). A file with no extension
    // gets no badge: there is nothing to say.
    const ext = md ? '' : extOf(node.name);
    frag.appendChild(rowEl({
      cls: 'file' + (md ? '' : ' other') + (curPath === node.path ? ' current' : ''),
      depth, glyphHtml: icon('page'), text: md ? titleOf(node.name) : node.name,
      hint: ext,
      data: { path: node.path, kind: 'file', md: md ? '1' : '0' },
    }));
  }
}

/**
 * The scratch folder, flat: its files as rows, its folders expandable in place. When the source
 * points at nothing (a renamed vault, a typo in settings) the listing goes away and the section
 * carries one mono line saying where to fix it, rather than an empty state that lies.
 */
function renderScratch(frag, curPath) {
  const dir = scratchFolder();
  const node = dir ? findNode(dir) : null;
  if (!node || node.kind !== 'dir') {
    frag.appendChild(label('scratch'));
    const miss = document.createElement('button');
    miss.type = 'button';
    // One font size for every empty line in the tree (E9): `.empty` already sets the mono face.
    miss.className = 'empty sb-empty sb-missing';
    miss.textContent = 'scratch folder missing · set it in settings';
    miss.title = dir ? `${dir} is not in the vault` : 'no scratch folder is set';
    miss.addEventListener('click', () => commands.run('app.settings'));
    frag.appendChild(miss);
    return;
  }
  const kids = sortChildren(node.children || [], false);
  frag.appendChild(label('scratch', dir));
  if (!kids.length) {
    const d = document.createElement('div');
    d.className = 'empty sb-empty';
    d.textContent = 'nothing here';
    frag.appendChild(d);
    return;
  }
  const box = document.createElement('div');
  box.className = 'sb-scratch';
  box.setAttribute('role', 'tree');
  box.setAttribute('aria-label', 'Scratch');
  box.setAttribute('aria-multiselectable', 'true');
  for (const c of kids) renderNode(c, 0, box, curPath);
  frag.appendChild(box);
}

/**
 * In focus mode the `pages` section label *is* the indicator: same row, same baseline, same
 * padding as every other label, reading `focus · <folder>` with the way out on the right.
 * It replaces the label rather than sitting under it, so focus mode costs no extra line.
 */
function focusLabel(focus) {
  const d = document.createElement('div');
  d.className = 'section-label sb-focus-label';
  d.dataset.drop = focus;
  d.innerHTML = `<span class="sb-focus-key">focus</span>`
    + `<span class="sb-focus-path" title="${esc(focus)}">${esc(baseName(focus))}</span>`;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sb-focus-exit';
  b.innerHTML = icon('close');
  b.title = 'Leave focus mode';
  b.setAttribute('aria-label', 'Leave focus mode');
  b.addEventListener('click', (e) => { e.stopPropagation(); exitFocus(); });
  d.appendChild(b);
  return d;
}

function renderTree() {
  const frag = document.createDocumentFragment();
  const r = currentRoute();
  const curPath = r && r.type === 'page' ? r.path : null;
  const focus = getFocus();

  // Focused, the sidebar is one folder and the app's own rows: pins and scratch are noise.
  if (!focus) renderPinned(frag);
  renderViews(frag);

  frag.appendChild(focus ? focusLabel(focus) : label('pages', ''));
  if (!tree) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'reading vault…';
    frag.appendChild(d);
  } else {
    const root = focus ? findNode(focus) : tree;
    const pages = document.createElement('div');
    pages.className = 'sb-pages';
    pages.setAttribute('role', 'tree');
    pages.setAttribute('aria-label', 'Pages');
    pages.setAttribute('aria-multiselectable', 'true');
    if (focus && (!root || root.kind !== 'dir')) {
      const d = document.createElement('div');
      d.className = 'empty sb-empty';
      d.textContent = 'focus folder is gone';
      pages.appendChild(d);
    } else {
      for (const c of sortChildren((root && root.children) || [], !focus)) renderNode(c, 0, pages, curPath);
    }
    frag.appendChild(pages);
  }

  if (tree && !focus) renderScratch(frag, curPath);

  // The rebuild would drop keyboard focus on the floor, and render runs 350ms after every
  // autosave (B4): note which row had it, rebuild, put it back. A row that is gone (trashed)
  // hands focus to whatever now sits at its index, so Delete on a run of pages keeps working.
  // `focusOrigin` rather than activeElement: while a confirm or rename dialog is up, the row
  // is where focus will return to, and the dialog must be told the row's replacement or it
  // would hand focus back to a detached node, i.e. to nothing.
  const origin = focusOrigin();
  const had = origin && origin !== scrollEl && scrollEl.contains(origin) ? origin : null;
  const hadKey = had ? rowKey(had) : null;
  const hadIndex = had ? treeRows().indexOf(had) : -1;

  const keep = scrollEl.scrollTop;
  scrollEl.textContent = '';
  scrollEl.appendChild(frag);
  scrollEl.scrollTop = keep;
  // A selected row that is no longer drawn (its folder collapsed, the file gone) is no longer
  // selected: a batch must never act on something the user cannot see.
  pruneSelection();

  const renamed = rowByKey(focusAfterRender);
  focusAfterRender = null;
  if (renamed) roving = rowKey(renamed);
  applyRoving();
  if (had) {
    const list = treeRows();
    // ...or, for a control that was not a row (the focus-mode exit), the tab-stop row.
    const back = renamed || rowByKey(hadKey) || (hadIndex >= 0 ? list[Math.min(hadIndex, list.length - 1)] : null) || rovingRow();
    if (back) {
      setRoving(back);
      if (overlayCount()) retargetFocusOrigin(back); else back.focus({ preventScroll: true });
    }
  }
}

function render() {
  if (!scrollEl) return;
  renderTree();
}

function rowFor(path) {
  return scrollEl.querySelector(`.sb-row[data-path="${CSS.escape(path)}"]:not(.sb-pin)`);
}

/* ------------------------------------------------------------ keyboard tree */

// Everything a key can land on, top to bottom: pins, views, pages, scratch, the missing-scratch
// line. Collapsed folders render no children, so this list is exactly the visible rows.
function treeRows() {
  return scrollEl ? [...scrollEl.querySelectorAll('.sb-row, .sb-missing')] : [];
}

/** A stable identity for a row across renders: the path (pins apart from tree rows), the view, or the one missing line. */
function rowKey(row) {
  if (!row || !row.dataset) return null;
  if (row.classList.contains('sb-missing')) return 'miss';
  if (row.dataset.view) return 'view:' + row.dataset.view;
  if (row.dataset.path !== undefined) return (row.dataset.pin === '1' ? 'pin:' : 'path:') + row.dataset.path;
  return null;
}

function rowByKey(key) {
  if (!key) return null;
  return treeRows().find((r) => rowKey(r) === key) || null;
}

/** The row Tab lands on: the remembered one if it still exists, else the current page, else the first. */
function rovingRow() {
  const list = treeRows();
  if (!list.length) return null;
  const r = currentRoute();
  return rowByKey(roving)
    || (r && r.type === 'page' && rowFor(r.path))
    || (r && r.type === 'view' && rowByKey('view:' + r.name))
    || list[0];
}

function setRoving(row) {
  roving = rowKey(row);
  for (const r of treeRows()) r.tabIndex = r === row ? 0 : -1;
}

function applyRoving() { setRoving(rovingRow()); }

function focusRow(row) {
  if (!row) return;
  setRoving(row);
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
}

/** Ctrl+Shift+E and `app.focus-sidebar`: the sidebar, open, with its one tab stop focused. */
export function focusTree() {
  if (!store.get('sidebar.open')) store.set('sidebar.open', true);
  focusRow(rovingRow());
}

/* -------------------------------------------------------------- selection (C17) */

/** The rows that can be part of a selection: tree rows with a path, so no pins and no views. */
function selectableRows() {
  return treeRows().filter((r) => r.dataset.path !== undefined && r.dataset.pin !== '1');
}
const isSelectable = (row) => !!row && row.dataset.path !== undefined && row.dataset.pin !== '1';

function paintSelection() {
  for (const r of selectableRows()) {
    const on = selected.has(r.dataset.path);
    r.classList.toggle('selected', on);
    r.setAttribute('aria-selected', String(on));
  }
}

function pruneSelection() {
  if (!selected.size) return;
  const visible = new Set(selectableRows().map((r) => r.dataset.path));
  for (const p of [...selected]) if (!visible.has(p)) selected.delete(p);
}

function clearSelection() {
  if (!selected.size) return;
  selected.clear();
  paintSelection();
}

function toggleSelected(row) {
  const p = row.dataset.path;
  if (selected.has(p)) selected.delete(p); else selected.add(p);
  paintSelection();
}

/** Select exactly the visible rows between the anchor and `row`, both included. */
function selectRange(row) {
  const rows = selectableRows();
  const b = rows.indexOf(row);
  if (b < 0) return;
  const a0 = rows.indexOf(rowByKey(anchor));
  const a = a0 < 0 ? b : a0;
  selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.dataset.path));
  paintSelection();
}

/**
 * What a tree command acts on when its target is one of several selected rows: every
 * selected row, in tree order, as `{ path, kind }`. Null when the target is not part of a
 * selection of two or more, in which case the command keeps its single-target behaviour.
 */
function batchFor(t) {
  if (!t || !t.path || selected.size < 2 || !selected.has(t.path)) return null;
  return selectableRows().filter((r) => selected.has(r.dataset.path)).map((r) => ({ path: r.dataset.path, kind: r.dataset.kind }));
}

/** The one thing every batch command needs to know before it starts: how many, and of what. */
const countOf = (items) => `${items.length} item${items.length === 1 ? '' : 's'}`;

/** Expand or collapse a tree folder row. Pinned folders reveal instead (they are shortcuts, not tree nodes). */
function toggleDir(row) {
  const path = row.dataset.path;
  if (row.dataset.pin === '1') { revealFolder(path); return; }
  if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
  persistExpanded();
  render();
}

/** Enter: what a click does. Pages open (and take focus, B3), folders toggle, views open, the missing line opens settings. */
function activateRow(row) {
  if (row.classList.contains('sb-missing')) { commands.run('app.settings'); return; }
  if (row.dataset.view) { navigate({ type: 'view', name: row.dataset.view }); return; }
  const path = row.dataset.path;
  if (row.dataset.kind === 'dir') { toggleDir(row); return; }
  if (row.dataset.md === '1') { navigate({ type: 'page', path }); return; }
  // A text file the editor can show opens in it (source mode, P5's); everything else — a PDF,
  // an image, a spreadsheet — goes to the application the platform uses for it (N24, N25).
  // Revealing it in Explorer, which is what this used to do, is a folder away from useful.
  if (isTextFile(path)) { navigate({ type: 'page', path }); return; }
  openWith(path);
}

/** `bridge.openPath`, with the refusal said out loud rather than left in a console (N10). */
function openWith(path) {
  bridge.openPath(path).catch((err) => toast(err.message || err, 'err'));
}

// Type-ahead: letters typed within 700ms of each other form one prefix, searched from the row
// after the focused one, wrapping. A single letter pressed again therefore walks the matches.
let typeBuf = '';
let typeAt = 0;
const TYPE_MS = 700;

function typeAhead(list, at, ch) {
  const now = Date.now();
  typeBuf = now - typeAt < TYPE_MS ? typeBuf + ch : ch;
  typeAt = now;
  const q = typeBuf.toLowerCase();
  const text = (r) => ((r.querySelector('.grow') || r).textContent || '').trim().toLowerCase();
  const from = typeBuf.length > 1 ? at : at + 1;
  for (let i = 0; i < list.length; i++) {
    const n = (from + i) % list.length;
    if (text(list[n]).startsWith(q)) return list[n];
  }
  return null;
}

/**
 * The tree's keys (D1), bound on `.sb-scroll` so they only run while a row has focus. Chords
 * with a modifier are the shell's (keys.js has already stopped the mapped ones) and never
 * type-ahead. Up/Down move focus only: nothing opens until Enter, so browsing the tree never
 * churns the editor (B3). Shift+Up/Down grow the selection from the anchor (C17); a plain
 * move drops it and moves the anchor, so the selection never trails a user who has moved on.
 */
function onTreeKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const list = treeRows();
  if (!list.length) return;
  const row = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.sb-row, .sb-missing') : null;
  // A click on the blank space under the tree focuses the scroller itself: the first arrow
  // key steps onto the tab-stop row instead of doing nothing.
  if (!row) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); focusRow(rovingRow()); }
    return;
  }
  const at = list.indexOf(row);
  const isDir = row.dataset.kind === 'dir';
  const inTree = isSelectable(row);
  const target = row.dataset.path !== undefined ? { path: row.dataset.path, kind: row.dataset.kind } : null;
  const k = e.key;
  let next = null;

  if (k === 'ArrowDown') next = list[Math.min(list.length - 1, at + 1)];
  else if (k === 'ArrowUp') next = list[Math.max(0, at - 1)];
  else if (k === 'Home') next = list[0];
  else if (k === 'End') next = list[list.length - 1];
  else if (k === 'ArrowRight') {
    if (!isDir) return;
    if (row.dataset.pin === '1') { e.preventDefault(); revealFolder(row.dataset.path); return; }
    if (!expanded.has(row.dataset.path)) { e.preventDefault(); toggleDir(row); return; }
    // Open already: the first child is the very next row, when there is one.
    const kid = list[at + 1];
    if (kid && kid.dataset.path && dirName(kid.dataset.path) === row.dataset.path) next = kid; else return;
  } else if (k === 'ArrowLeft') {
    if (isDir && inTree && expanded.has(row.dataset.path)) { e.preventDefault(); toggleDir(row); return; }
    if (!inTree) return;
    const parent = dirName(row.dataset.path);
    next = parent ? rowFor(parent) : null;
    if (!next) return;
  } else if (k === 'Enter') { e.preventDefault(); activateRow(row); return; }
  else if (k === ' ') { e.preventDefault(); if (isDir) toggleDir(row); return; }
  else if (k === 'F2') { if (!target) return; e.preventDefault(); void renameAt(target.path, target.kind); return; }
  // Delete is the Windows key, Backspace the macOS one; both do the same thing everywhere,
  // because a keyboard that has one is not always the machine the vault is on (S21).
  else if (k === 'Delete' || k === 'Backspace') { if (!target) return; e.preventDefault(); void trashAt(batchFor(target) || [target]); return; }
  // Shift+F10 and the Menu key are the Windows convention for "the context menu of the thing
  // that has focus", and the tree is the one place in the app with a context menu (S12).
  else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
    e.preventDefault();
    openMenuAt(row);
    return;
  }
  else if (k === 'Escape') {
    // A selection goes first; the page gets focus on the next Esc, so neither is lost.
    e.preventDefault();
    if (selected.size) { clearSelection(); return; }
    focusMain();
    return;
  }
  else if (k.length === 1 && k !== ' ') { next = typeAhead(list, at, k); if (!next) return; }
  else return;

  e.preventDefault();
  if (!next) return;
  // Shift + a vertical move extends the range from the anchor to where focus lands; a move
  // without it is a single row again. Only tree rows can be selected, so a range that runs
  // into the views or the pins simply skips them.
  if (e.shiftKey && (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') && (inTree || isSelectable(next))) {
    if (!anchor || !rowByKey(anchor)) anchor = rowKey(row);
    if (isSelectable(next)) selectRange(next);
    if (next !== row) focusRow(next);
    return;
  }
  clearSelection();
  anchor = rowKey(next);
  if (next !== row) focusRow(next);
}

function scrollToCurrent() {
  const r = currentRoute();
  if (!r || r.type !== 'page') return;
  const node = rowFor(r.path);
  if (node) node.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ data load */

export async function refreshTree() {
  try {
    tree = await bridge.tree();
  } catch (e) {
    console.error('[shell] tree', e);
    // A read that fails because the folder itself is gone is not a tree bug, and a toast per
    // failed call is noise on top of a vault that has been unplugged (S29, P8): the shell has
    // one dialog for it, and `vaultLost` is idempotent while that dialog is up.
    if (/os error 2|no such file|cannot find the path|not a directory/i.test(String(e.message || e))) {
      vaultLost();
      return;
    }
    toast('tree failed: ' + (e.message || e), 'err');
    return;
  }
  prunePins();
  render();
  scrollToCurrent();
}

/* ------------------------------------------------------------------ mutations */

/**
 * A new page in `folder`. With no `name` it is `Untitled.md` and the title is selected so the
 * first thing typed names it (C12); with one — quick open's Shift+Enter (N41) — the file and
 * the H1 carry that name and the caret goes to the body instead, because the name is settled.
 */
export async function newPageIn(folder, name) {
  const dir = clean(folder || '');
  const base = safeName(String(name || '').trim(), '') || 'Untitled';
  try {
    let path = join(dir, `${base}.md`);
    for (let n = 2; n < 500 && await bridge.exists(path); n++) path = join(dir, `${base} ${n}.md`);
    await bridge.writeText(path, `# ${base}\n`);
    if (dir) { expanded.add(dir); expandAncestors(path); persistExpanded(); }
    await refreshTree();
    await navigate({ type: 'page', path });
    // A new page wants its name first: the title, selected, the way the editor's own page.new
    // leaves it. DOM level only, since the title element belongs to the editor. A page created
    // with a name has one already, so the caret is left where the editor put it.
    const title = name ? null : document.querySelector('.main .page-title[contenteditable]');
    if (title) {
      title.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(title);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return path;
  } catch (e) {
    toast('could not create page: ' + (e.message || e), 'err');
    return null;
  }
}

async function newFolderIn(folder) {
  const name = await prompt({ title: 'New Folder', placeholder: 'folder name', ok: 'Create' });
  if (!name) return;
  const dir = clean(folder || '');
  try {
    await bridge.mkdir(join(dir, name));
    if (dir) expanded.add(dir);
    expanded.add(join(dir, name));
    persistExpanded();
    await refreshTree();
  } catch (e) { toast('could not create folder: ' + (e.message || e), 'err'); }
}

/**
 * The from/to pairs a move produces for the link rewrite (C13): the path itself, and for a
 * folder every file under it as well, since a link into a moved folder names one of its
 * files. Read from the tree before `bridge.rename` runs, because the fs event that follows
 * replaces the tree and the old folder is not in the new one.
 */
function filePairs(from, to) {
  const out = [{ from, to }];
  const node = findNode(from);
  if (!node || node.kind !== 'dir') return out;
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.kind === 'dir') walk(c); else out.push({ from: c.path, to: to + c.path.slice(from.length) });
    }
  };
  walk(node);
  return out;
}

const followMove = (p, from, to) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null);

/**
 * Shared tail of rename, move-to and drag, for one move or many: keep expansion, pins, the
 * selection and the open page pointing at the new paths, then rewrite every link into what
 * moved (C13) and say what happened in one toast: "moved to X · 3 links in 2 pages updated",
 * or just the verb when nothing linked there. A file whose links could not be written is
 * named in its own toast; the move itself has already happened and is not undone for it.
 * `moves` is [{ from, to, pairs }], `pairs` from filePairs taken before the rename.
 */
async function afterMoves(moves, verb) {
  for (const m of moves) {
    // The watcher will report this rename in a moment; N19 must not offer to fix what we
    // are about to fix ourselves.
    for (const p of m.pairs || [{ from: m.from, to: m.to }]) noteSelfMove(p.from, p.to);
    for (const p of [...expanded]) { const n = followMove(p, m.from, m.to); if (n) { expanded.delete(p); expanded.add(n); } }
    repinMoved(m.from, m.to);
    // The row the user was on has a new name; the next render focuses it there (B4, D1).
    if (roving === 'path:' + m.from) focusAfterRender = 'path:' + m.to;
    else if (roving === 'pin:' + m.from) focusAfterRender = 'pin:' + m.to;
  }
  persistExpanded();
  if (selected.size) {
    const next = new Set();
    for (const p of selected) {
      let moved = null;
      for (const m of moves) { moved = followMove(p, m.from, m.to); if (moved) break; }
      next.add(moved || p);
    }
    selected = next;
  }

  const r = currentRoute();
  let reopen = null;
  if (r && r.type === 'page') for (const m of moves) { reopen = followMove(r.path, m.from, m.to); if (reopen) break; }
  await refreshTree();
  if (reopen) await navigate({ type: 'page', path: reopen }, { replace: true, force: true });

  let res = { files: 0, links: 0, failed: [] };
  try {
    res = await rewriteInboundMany(moves.flatMap((m) => m.pairs || [{ from: m.from, to: m.to }]));
  } catch (e) {
    console.error('[shell] links', e);
    toast('links not updated: ' + (e.message || e), 'err');
  }
  const n = res.links, f = res.files;
  toast(verb + (n ? ` · ${n} link${n === 1 ? '' : 's'} in ${f} page${f === 1 ? '' : 's'} updated` : ''), 'info', 2600);
  for (const p of res.failed) toast('could not update links in ' + p, 'err');
}

/* ------------------------------------------------- renames made outside the app (N19) */

// A move the app made itself: the watcher reports it a moment later, and the links have
// already been rewritten by `afterMoves`. Keyed `from>to`, forgotten after a few seconds.
const selfMoves = new Map();
const SELF_MOVE_MS = 8000;

function noteSelfMove(from, to) {
  const now = Date.now();
  selfMoves.set(from + '>' + to, now);
  for (const [k, at] of selfMoves) if (now - at > SELF_MOVE_MS) selfMoves.delete(k);
}

const wasSelfMove = (from, to) => {
  const at = selfMoves.get(from + '>' + to);
  return !!at && Date.now() - at <= SELF_MOVE_MS;
};

// Renames the watcher has reported and we have not asked about yet. They are collected rather
// than handled one by one, because moving a folder in Explorer arrives as one event per file.
let pendingRenames = [];
let askingRenames = false;

/**
 * A file renamed or moved from outside — Explorer, an agent, a terminal — leaves every link
 * into it pointing at a name that is gone (N19). The app cannot silently rewrite files the
 * user did not ask it to touch, so it asks, once, and only when there is something to fix:
 * the question names the count, and answering no leaves every file exactly as it is.
 *
 * The watcher has to have paired the two halves of the rename (`fs` `{kind:'rename', to}`),
 * which the host does and the dev bridge cannot; in a browser an external rename still shows
 * up as a delete and nothing is offered.
 */
async function askAboutRenames() {
  if (askingRenames || !pendingRenames.length) return;
  askingRenames = true;
  const moves = pendingRenames;
  pendingRenames = [];
  try {
    // Which of them anything actually links to. One search per moved name; a rename nobody
    // linked to is never mentioned at all.
    const real = [];
    let links = 0;
    let files = new Set();
    for (const m of moves) {
      let inbound = [];
      try { inbound = await findInbound(m.from); } catch (e) { console.error('[shell] links', e); continue; }
      if (!inbound.length) continue;
      real.push(m);
      for (const p of inbound) { links += p.count; files.add(p.path); }
    }
    if (!real.length) return;
    const one = real.length === 1 ? real[0] : null;
    const ok = await confirm({
      title: 'Update links?',
      body: one
        ? `${baseName(one.from)} was moved to ${one.to} outside the app. `
          + `${links} link${links === 1 ? '' : 's'} in ${files.size} page${files.size === 1 ? '' : 's'} still point at the old name.`
        : `${real.length} files were moved outside the app. `
          + `${links} link${links === 1 ? '' : 's'} in ${files.size} page${files.size === 1 ? '' : 's'} still point at their old names.`,
      ok: `Update ${links} link${links === 1 ? '' : 's'}`,
    });
    if (!ok) return;
    const res = await rewriteInboundMany(real);
    toast(res.links
      ? `${res.links} link${res.links === 1 ? '' : 's'} in ${res.files} page${res.files === 1 ? '' : 's'} updated`
      : 'nothing to update', 'info', 2600);
    for (const p of res.failed) toast('could not update links in ' + p, 'err');
  } finally {
    askingRenames = false;
    if (pendingRenames.length) void askAboutRenames();
  }
}

/** The `fs` half: collect the paired renames that were not ours. */
function onFsRenames(payload) {
  const changes = payload && Array.isArray(payload.changes) ? payload.changes : [];
  for (const c of changes) {
    if (!c || c.kind !== 'rename' || !c.to || !c.path) continue;
    const from = clean(c.path), to = clean(c.to);
    if (!from || !to || from === to || wasSelfMove(from, to)) continue;
    // Only markdown carries links worth chasing; an attachment that moved is a link into a
    // file, and `findInbound` finds those too, so both kinds are collected.
    pendingRenames.push({ from, to });
  }
}

/**
 * A name the filesystem accepts, keeping the extension the file already had when the user
 * did not type one. A folder is passed '' and keeps no extension. Mirrors the editor's own
 * rename (editor/index.js), which is the path this one used to disagree with.
 */
function safeName(name, ext) {
  const base = String(name).replace(/[\\/:*?"<>|]/g, '-').trim().replace(/\.+$/, '');
  if (!base || base === '.' || base === '..') return '';
  if (!ext) return base;
  return base.toLowerCase().endsWith('.' + ext) ? base : base + '.' + ext;
}

async function renameAt(path, kind) {
  const old = baseName(path);
  const name = await prompt({ title: kind === 'dir' ? 'Rename Folder' : 'Rename Page', value: old, ok: 'Rename' });
  if (!name || name === old) return;
  const safe = safeName(name, kind === 'dir' ? '' : extOf(old));
  if (!safe) { toast('that is not a usable name', 'err'); return; }
  const to = join(dirName(path), safe);
  if (to === path) return;
  try {
    // `Notes.md` -> `notes.md` is the same file on Windows, so `exists` says yes and the
    // rename used to be refused; the host performs a case-only rename through a temporary
    // name, and this guard has to let it through (N17).
    if (to.toLowerCase() !== path.toLowerCase() && await bridge.exists(to)) { toast(safe + ' already exists here', 'err'); return; }
    const pairs = filePairs(path, to);
    await bridge.rename(path, to);
    await afterMoves([{ from: path, to, pairs }], 'renamed');
  } catch (e) { toast('rename failed: ' + (e.message || e), 'err'); }
}

/**
 * Move `items` ([{ path }]) into the folder `dest`, one bridge.rename each, then one shared
 * tail: one tree refresh, one link pass, one toast. An item that cannot go there (into itself,
 * or where it already is) is skipped; one that would overwrite a file is skipped and said.
 */
async function moveMany(items, dest) {
  const target = clean(dest);
  const moves = [];
  for (const it of items) {
    const src = clean(it.path);
    if (!canDropInto(src, target)) continue;
    const to = join(target, baseName(src));
    try {
      if (await bridge.exists(to)) { toast(baseName(src) + ' already exists in ' + (target || 'the vault root'), 'err'); continue; }
      const pairs = filePairs(src, to);
      await bridge.rename(src, to);
      moves.push({ from: src, to, pairs });
    } catch (e) { toast('move failed: ' + (e.message || e), 'err'); }
  }
  if (!moves.length) return;
  if (target) { expanded.add(target); for (const m of moves) expandAncestors(m.to); }
  await afterMoves(moves, 'moved to ' + (target || 'vault root'));
}

/** Move to…: pick a destination for one item or a selection, then moveMany. */
async function moveTo(items) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  const first = clean(list[0].path);
  const title = list.length === 1 ? 'Move ' + baseName(first) + ' to…' : `Move ${countOf(list)} to…`;
  // A single folder cannot be offered its own subtree; several items are checked one by one.
  const dest = await pickFolder({ title, current: dirName(first), hide: list.length === 1 && list[0].kind === 'dir' ? first : null });
  if (dest === null) return;
  await moveMany(list, dest);
}

/** Trash one item or a selection: one confirm naming what goes, then one refresh. */
async function trashAt(items) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  const one = list.length === 1 ? list[0] : null;
  const ok = await confirm({
    title: one ? (one.kind === 'dir' ? 'Move Folder to Trash' : 'Move Page to Trash') : `Move ${countOf(list)} to Trash`,
    body: one
      ? `${one.path} goes to the Recycle Bin. Nothing is deleted permanently.`
      : `${countOf(list)} go to the Recycle Bin: ${list.map((it) => baseName(it.path)).join(', ')}. Nothing is deleted permanently.`,
    ok: 'Move to Trash', danger: true,
  });
  if (!ok) return;
  // Trashed from the tree (Delete, or the menu on a row): focus stays in the tree, on the row
  // that takes the gap (B4 does that in render). Trashed from the page: the empty surface
  // takes it, the way any other open does.
  const fromTree = !!(scrollEl && scrollEl.contains(focusOrigin()));
  let hit = false;
  const r = currentRoute();
  for (const it of list) {
    const path = clean(it.path);
    try {
      await bridge.trash(path);
      expanded.delete(path);
      dropPinsUnder(path);
      selected.delete(path);
      if (r && r.type === 'page' && followMove(r.path, path, path)) hit = true;
    } catch (e) { toast('trash failed: ' + (e.message || e), 'err'); }
  }
  await refreshTree();
  if (hit) await clearRoute({ focus: !fromTree });
}

/** Expand the tree down to a folder and bring it into view. No navigation. */
export function revealFolder(path) {
  const dir = clean(path);
  if (!dir) return;
  store.set('sidebar.open', true);
  expandAncestors(dir + '/x');
  expanded.add(dir);
  persistExpanded();
  render();
  requestAnimationFrame(() => {
    const n = rowFor(dir);
    if (n) n.scrollIntoView({ block: 'center' });
  });
}

/**
 * Breadcrumb click (N31): the folder is revealed in the tree and its row takes focus. It used
 * to open the folder's first `.md` as well, which is an arbitrary page the user did not ask
 * for; a crumb says where you are, and clicking it should show you that place, not move you.
 */
export function focusFolder(path) {
  const dir = clean(path);
  revealFolder(dir);
  requestAnimationFrame(() => {
    const row = rowFor(dir);
    if (row) focusRow(row);
  });
}

/** Kept for callers that really do want a page: reveal, then the folder's first `.md`. */
export async function openFolder(path) {
  const dir = clean(path);
  revealFolder(dir);
  const first = mdFilesOf(findNode(dir))[0];
  if (first) await navigate({ type: 'page', path: first.path });
}

/* ------------------------------------------------------------- drag and drop */

// Internal drags carry the vault paths (a JSON list: a selection drags together, C17) in a
// private type; `dragPaths` mirrors it because dataTransfer.getData is unreadable during
// dragover, and the self/descendant guard has to run there, for every item, to decide
// whether the row may light up at all.
const DRAG_TYPE = 'application/x-os-path';
const TEXT_IMPORT = new Set(['md', 'txt']);

let dragPaths = null;
let dropEl = null;

/** The list an internal payload holds. A bare path (an older build's payload) is a list of one. */
function parseDrag(data) {
  if (!data) return null;
  try { const v = JSON.parse(data); if (Array.isArray(v)) return v.map(clean).filter(Boolean); } catch { /* not JSON: a bare path */ }
  return [clean(data)].filter(Boolean);
}

/** A folder row (tree or pin) or a section label that stands for a folder. */
function dropTargetOf(node) {
  if (!node || !node.closest) return null;
  const lab = node.closest('.section-label[data-drop]');
  if (lab) return { el: lab, dir: lab.dataset.drop };
  const row = node.closest('.sb-row.dir');
  if (row && row.dataset.path) return { el: row, dir: row.dataset.path };
  return null;
}

function canDropInto(from, dir) {
  const src = clean(from), target = clean(dir);
  if (!src) return false;
  if (src === target || target.startsWith(src + '/')) return false; // into itself or its subtree
  return dirName(src) !== target;                                   // already there
}

function setDropEl(node) {
  if (dropEl === node) return;
  if (dropEl) dropEl.classList.remove('drop-on');
  dropEl = node;
  if (dropEl) dropEl.classList.add('drop-on');
}

function endDrag() { dragPaths = null; setDropEl(null); }

/** `<dir>/name.ext`, numbered when taken, so an import never overwrites a vault file. */
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let p = join(dir, name);
  for (let n = 2; n < 500 && await bridge.exists(p); n++) p = join(dir, `${base} ${n}${ext}`);
  return p;
}

function base64Of(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  const CHUNK = 0x8000; // apply() has an argument limit; 32k at a time stays under it
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(out);
}

/** Files dragged in from Explorer. Text goes through writeText, everything else as base64. */
async function importFiles(files, dir) {
  const list = [...files];
  if (!list.length) return;
  let done = 0;
  for (const f of list) {
    try {
      const path = await freeName(clean(dir), f.name || 'file');
      if (TEXT_IMPORT.has(extOf(path))) await bridge.writeText(path, await f.text());
      else await bridge.writeBinary(path, base64Of(await f.arrayBuffer()));
      done++;
    } catch (e) {
      toast('could not import ' + (f.name || 'a file') + ': ' + (e.message || e), 'err');
    }
  }
  if (!done) return;
  if (dir) { expanded.add(clean(dir)); persistExpanded(); }
  await refreshTree();
  toast(`imported ${done} file${done === 1 ? '' : 's'}`, 'info', 2600);
}

function bindDnd(host) {
  host.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.sb-row[data-path]');
    if (!row) { e.preventDefault(); return; }
    // A row inside a selection of several drags the whole selection; any other row, itself.
    const batch = batchFor({ path: row.dataset.path, kind: row.dataset.kind });
    dragPaths = batch && row.dataset.pin !== '1' ? batch.map((it) => it.path) : [row.dataset.path];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragPaths));
    e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
  });

  host.addEventListener('dragend', endDrag);

  host.addEventListener('dragover', (e) => {
    const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
    const internal = !!dragPaths || types.includes(DRAG_TYPE);
    const external = types.includes('Files');
    if (!internal && !external) { setDropEl(null); return; }
    const t = dropTargetOf(e.target);
    // Every dragged item has to be able to land there, or the folder does not light up.
    if (!t || (internal && !(dragPaths || []).every((p) => canDropInto(p, t.dir)))) {
      setDropEl(null);
      e.preventDefault();                       // still ours: no browser navigation
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    setDropEl(t.el);
  });

  host.addEventListener('dragleave', (e) => {
    if (dropEl && !dropEl.contains(e.relatedTarget)) setDropEl(null);
  });

  host.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = dropTargetOf(e.target);
    const from = dragPaths || parseDrag(e.dataTransfer ? e.dataTransfer.getData(DRAG_TYPE) : '');
    const files = e.dataTransfer ? e.dataTransfer.files : null;
    endDrag();
    if (!t) return;
    if (from && from.length) void moveMany(from.map((p) => ({ path: p })), t.dir);
    else if (files && files.length) void importFiles(files, t.dir);
  });
}

/* ------------------------------------------------------- tree commands and menu */

/**
 * The href a link to `path` should carry (N14, N15). It is the editor's `relativeHref` and
 * nothing else, resolved against the page that is open: paste the result into that page and
 * it works, which is the whole point of the command and is what it did not do before — it
 * wrote a vault-absolute path with four characters escaped, so `Chapter #3.md` was truncated
 * at the `#` and a link pasted anywhere but the vault root did not resolve.
 *
 * With no page open there is nothing to be relative to, so the vault-root form is written with
 * a leading `/`, which `resolveHref` reads as "from the root" wherever it is later pasted.
 */
function linkUrl(path, dir) {
  const r = currentRoute();
  const from = r && r.type === 'page' ? r.path : null;
  const href = from ? relativeHref(from, clean(path)) : '/' + relativeHref('', clean(path));
  return (href || baseName(path)) + (dir ? '/' : '');
}

/** `copy path` and `copy link` (CONTRACT.md batch 5). A folder links as `[name](path/)`. */
async function copyPath(path) {
  const ok = await copyText(clean(path));
  toast(ok ? 'copied' : 'could not copy', ok ? 'info' : 'err', 1600);
}

async function copyLink(path, kind) {
  const dir = kind === 'dir';
  const ok = await copyText(`[${dir ? baseName(path) : titleOf(path)}](${linkUrl(path, dir)})`);
  toast(ok ? 'copied' : 'could not copy', ok ? 'info' : 'err', 1600);
}

/**
 * The thing a tree command acts on (D3): `{ path, kind }` for the focused tree row (the row
 * focus will return to, while a palette or menu is up: see focusOrigin), else the open page,
 * else null. The vault root is `{ path: '', kind: 'dir' }`, which the missing-scratch line and
 * the blank space under the tree stand for.
 */
function treeTarget() {
  const o = focusOrigin();
  const row = o && scrollEl && scrollEl.contains(o) && o.closest ? o.closest('.sb-row[data-path]') : null;
  if (row) return { path: row.dataset.path, kind: row.dataset.kind };
  const r = currentRoute();
  if (r && r.type === 'page') return { path: r.path, kind: 'file' };
  return null;
}

const folderOf = (t) => (t.kind === 'dir' ? t.path : dirName(t.path));
const reveal = (path) => bridge.reveal(path).catch((e) => toast(e.message || e, 'err'));

/** `Name 2.md` beside a file, byte for byte, then the tree shows it (N23). Files only. */
async function duplicateAt(path) {
  const src = clean(path);
  const dot = baseName(src).lastIndexOf('.');
  const ext = dot > 0 ? baseName(src).slice(dot) : '';
  const stem = dot > 0 ? baseName(src).slice(0, dot) : baseName(src);
  const dir = dirName(src);
  try {
    let to = join(dir, `${stem} 2${ext}`);
    for (let n = 3; n < 500 && await bridge.exists(to); n++) to = join(dir, `${stem} ${n}${ext}`);
    // Text through readText/writeText so the bytes are not re-encoded through base64 for
    // nothing; anything else could be binary and has no business being read as UTF-8.
    if (isMd(src) || isTextFile(src)) await bridge.writeText(to, await bridge.readText(src));
    else { toast('only text files can be duplicated from the tree', 'warn'); return; }
    focusAfterRender = 'path:' + to;
    await refreshTree();
    toast('duplicated · ' + baseName(to), 'info', 2200);
  } catch (e) { toast('could not duplicate: ' + (e.message || e), 'err'); }
}

/** Every folder in the tree, or none of them (N26). One persist, one render. */
function setAllExpanded(open) {
  if (!open) { expanded = new Set(); }
  else {
    const all = new Set();
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.kind !== 'dir' || isHiddenName(c.name)) continue;
        all.add(c.path);
        walk(c);
      }
    };
    if (tree) walk(tree);
    expanded = all;
  }
  persistExpanded();
  render();
}

// One table for the palette and the context menu, so the two cannot drift: the menu is built
// from these entries (label, icon, shortcut all come from the registered command) and each
// entry's `applies(target)` decides both the palette's `when` and the menu's rows. The
// commands take an explicit target from the menu (the row under the pointer, which right-click
// never focuses) and fall back to `treeTarget()` from the palette or a chord. Pin, unpin,
// move and trash act on the whole selection when the target is part of one (C17, batchFor);
// the rest are one-row verbs and never see a selection.
const TREE_COMMANDS = [
  { id: 'tree.new-page', title: 'New page here', icon: 'plus', group: 'tree',
    applies: () => true, run: (t) => void newPageIn(folderOf(t)) },
  { id: 'tree.new-folder', title: 'New folder', icon: 'folderPlus', group: 'tree',
    applies: () => true, run: (t) => void newFolderIn(folderOf(t)) },
  { id: 'tree.pin', title: 'Pin', icon: 'pin', group: 'tree',
    applies: (t) => !!t.path && (batchFor(t) || [t]).some((it) => !isPinned(it.path)),
    run: (t) => { const b = batchFor(t); if (b) pinMany(b.map((it) => it.path)); else pin(t.path); } },
  { id: 'tree.unpin', title: 'Unpin', icon: 'pin', group: 'tree',
    applies: (t) => !!t.path && (batchFor(t) || [t]).some((it) => isPinned(it.path)),
    run: (t) => { const b = batchFor(t); if (b) unpinMany(b.map((it) => it.path)); else unpin(t.path); } },
  { id: 'app.focus-enter', title: 'Focus folder', icon: 'focus', group: 'app',
    applies: (t) => !!t.path && t.kind === 'dir' && getFocus() !== t.path, run: (t) => setFocus(t.path) },
  { id: 'tree.rename', title: 'Rename…', icon: 'rename', group: 'tree',
    applies: (t) => !!t.path, run: (t) => void renameAt(t.path, t.kind) },
  // A lone folder is not offered Move to… (it drags); a selection may hold folders, and each
  // is checked against the destination when it lands.
  // A folder can be moved from the menu now as well as dragged (N22): dragging is a mouse,
  // and everything in this app has to be reachable without one.
  { id: 'tree.move', title: 'Move to…', icon: 'folder', group: 'tree',
    applies: (t) => !!t.path, run: (t) => void moveTo(batchFor(t) || [t]) },
  { id: 'tree.duplicate', title: 'Duplicate', icon: 'copy', group: 'tree',
    applies: (t) => !!t.path && t.kind !== 'dir', run: (t) => void duplicateAt(t.path) },
  { id: 'tree.copy-path', title: 'Copy path', icon: 'copy', group: 'tree',
    applies: (t) => !!t.path, run: (t) => void copyPath(t.path) },
  { id: 'tree.copy-link', title: 'Copy link', icon: 'link', group: 'tree',
    applies: (t) => !!t.path, run: (t) => void copyLink(t.path, t.kind) },
  // Every row, folders included (CONTRACT "Files"): a folder handed to the platform opens in
  // the file manager, which is a real thing to want and what `openPath` already does with one
  // (QA defect 9). `Reveal in Explorer` stays what it is — the row selected in its parent.
  { id: 'tree.open-external', title: 'Open with default app', icon: 'reveal', group: 'tree',
    applies: (t) => !!t.path, run: (t) => openWith(t.path) },
  { id: 'tree.reveal', title: 'Reveal in Explorer', icon: 'reveal', group: 'tree',
    applies: () => true, run: (t) => void reveal(t.path) },
  // Search, already narrowed: the overlay opens with `path:<folder>/` typed for you (N38).
  { id: 'tree.search-here', title: 'Search in folder', icon: 'search', group: 'tree',
    applies: (t) => !!t.path && t.kind === 'dir', run: (t) => openSearch({ prefill: `path:${t.path}/ ` }) },
  { id: 'tree.collapse-all', title: 'Collapse all folders', icon: 'chevron', group: 'tree',
    applies: () => true, run: () => setAllExpanded(false) },
  { id: 'tree.expand-all', title: 'Expand all folders', icon: 'chevron', group: 'tree',
    applies: () => true, run: () => setAllExpanded(true) },
  { id: 'tree.trash', title: 'Move to trash', icon: 'trash', group: 'tree', danger: true,
    applies: (t) => !!t.path, run: (t) => void trashAt(batchFor(t) || [t]) },
];

function registerTreeCommands() {
  for (const c of TREE_COMMANDS) {
    commands.register({
      id: c.id, title: c.title, group: c.group, icon: c.icon,
      when: () => { const t = treeTarget(); return !!t && c.applies(t); },
      run: (target) => { const t = target && typeof target === 'object' ? target : treeTarget(); if (t && c.applies(t)) c.run(t); },
    });
  }
}

// The menu's order, as it has always read: create, then the row's own verbs, then the
// clipboard and Explorer, then the one destructive action. `app.focus-exit` lives in
// focus.js; its menu row shows only on the folder that is the focus.
const MENU = [
  'tree.new-page', 'tree.new-folder',
  null,
  'tree.pin', 'tree.unpin', 'app.focus-enter', { id: 'app.focus-exit', applies: (t) => !!t.path && t.kind === 'dir' && getFocus() === t.path },
  'tree.rename', 'tree.move', 'tree.duplicate',
  null,
  'tree.copy-path', 'tree.copy-link',
  null,
  'tree.search-here', 'tree.open-external', 'tree.reveal',
  null,
  'tree.trash',
];

/** A menu row from a registered command: its title, icon and chord, run against `target`. */
function menuItem(id, target, label) {
  const c = commands.get(id);
  if (!c) return null;
  const local = TREE_COMMANDS.find((x) => x.id === id);
  return {
    label: label || c.title, iconSvg: c.icon ? icon(c.icon) : '', shortcut: shortcutFor(id) || '',
    danger: !!(local && local.danger),
    run: () => commands.run(id, target),
  };
}

function menuFor(path, kind) {
  const target = { path: clean(path || ''), kind: path ? kind : 'dir' };
  const items = [];
  for (const entry of MENU) {
    if (entry === null) { items.push({ sep: true }); continue; }
    const id = typeof entry === 'string' ? entry : entry.id;
    const applies = typeof entry === 'string' ? TREE_COMMANDS.find((x) => x.id === id)?.applies : entry.applies;
    if (!applies || !applies(target)) continue;
    const it = menuItem(id, target);
    if (it) items.push(it);
  }
  // No two separators in a row and none at either end, whatever was filtered out between.
  return items.filter((it, i, all) => !it.sep || (i > 0 && i < all.length - 1 && !all[i - 1].sep));
}

// The menu for a row inside a selection of several (C17): only what makes sense for many.
// No rename, no focus, no copy: those are one-row verbs. Labels carry the count so the user
// knows the menu is for the selection, not the row under the pointer.
const MULTI_MENU = ['tree.pin', 'tree.unpin', 'tree.move', null, 'tree.trash'];

function multiMenu(batch) {
  const target = batch[0];
  const items = [];
  for (const id of MULTI_MENU) {
    if (id === null) { items.push({ sep: true }); continue; }
    const local = TREE_COMMANDS.find((x) => x.id === id);
    if (!local || !local.applies(target)) continue;
    const it = menuItem(id, target, `${local.title} (${batch.length})`);
    if (it) items.push(it);
  }
  return items.filter((it, i, all) => !it.sep || (i > 0 && i < all.length - 1 && !all[i - 1].sep));
}

/**
 * The menu for a row, whichever way it was asked for: right-click, Shift+F10 or the Menu key.
 * A row inside a selection of several gets the selection's menu; any other row drops the
 * selection first, so a menu is never about rows the user is not pointing at.
 */
function menuItemsForRow(row) {
  const target = { path: row.dataset.path, kind: row.dataset.kind };
  const batch = isSelectable(row) ? batchFor(target) : null;
  if (!batch && isSelectable(row)) clearSelection();
  return batch ? multiMenu(batch) : menuFor(row.dataset.path, row.dataset.kind);
}

/** The keyboard's context menu (S12): under the row, aligned with where its name starts. */
function openMenuAt(row) {
  if (!row || row.dataset.path === undefined) return;
  const r = row.getBoundingClientRect();
  contextMenu(Math.round(r.left + 24), Math.round(r.bottom), menuItemsForRow(row));
}

/** Right-click on the empty space under the tree: create in scratch, or in the focus folder. */
function emptyMenu() {
  const dir = getFocus() || scratchFolder();
  const where = baseName(dir) || 'the vault root';
  const target = { path: dir, kind: 'dir' };
  return [
    menuItem('tree.new-page', target, `New page in ${where}`),
    menuItem('tree.new-folder', target, `New folder in ${where}`),
  ];
}

/* ------------------------------------------------------------------ init */

export function initSidebar(node) {
  el = node;
  el.className = 'sidebar';
  el.innerHTML = '<div class="sb-scroll" tabindex="-1"></div>';
  scrollEl = el.querySelector('.sb-scroll');

  const saved = stateCache().sidebar || {};
  if (Array.isArray(saved.expanded)) expanded = new Set(saved.expanded.filter(Boolean));
  const savedPins = stateCache().pins;
  if (Array.isArray(savedPins)) pins = savedPins.filter((p) => typeof p === 'string' && p).map(clean);

  // A click and Enter do the same thing (activateRow); the clicked row also becomes the tab
  // stop, so Tab back into the sidebar returns to where the mouse left off (D2). Ctrl+click
  // toggles a tree row in the selection and Shift+click selects the run from the anchor to
  // it, neither of which opens anything (C17); a plain click is a single row again.
  scrollEl.addEventListener('click', (e) => {
    const row = e.target.closest('.sb-row, .sb-missing');
    if (!row) return;
    // Enter and Space on a focused button also synthesise a click (detail 0); the keydown
    // handler has already acted on those, and acting twice would toggle a folder shut again.
    if (e.detail === 0) return;
    if (isSelectable(row) && (e.ctrlKey || e.metaKey)) {
      toggleSelected(row);
      anchor = rowKey(row);
      focusRow(row);
      return;
    }
    if (isSelectable(row) && e.shiftKey) {
      if (!anchor || !rowByKey(anchor)) anchor = roving;
      selectRange(row);
      focusRow(row);
      return;
    }
    clearSelection();
    anchor = rowKey(row);
    setRoving(row);
    activateRow(row);
  });

  scrollEl.addEventListener('keydown', onTreeKey);

  // Right-click inside a selection of several opens the menu for all of them; outside it,
  // the selection is dropped first, so the menu is never about rows other than the one
  // under the pointer.
  scrollEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.sb-row:not(.sb-view)');
    e.preventDefault();
    if (!row) { contextMenu(e.clientX, e.clientY, emptyMenu()); return; }
    contextMenu(e.clientX, e.clientY, menuItemsForRow(row));
  });

  bindDnd(scrollEl);

  const onFs = debounce(() => refreshTree(), 350);
  const askLater = debounce(() => void askAboutRenames(), 600);
  bus.on('fs', (payload) => { onFsRenames(payload); askLater(); onFs(); });
  bus.on('route', () => { const r = currentRoute(); if (r && r.type === 'page') expandAncestors(r.path); render(); scrollToCurrent(); });
  bus.on('booted', () => render());
  bus.on('focus', () => { render(); scrollToCurrent(); });
  // The scratch section is a source; repointing it in settings moves the section straight away.
  bus.on('sources', ({ key }) => { if (key === 'scratch') { render(); scrollToCurrent(); } });

  commands.register({
    id: 'app.sidebar', title: 'Toggle sidebar', group: 'app',
    run: () => store.set('sidebar.open', !store.get('sidebar.open')),
  });
  commands.register({
    id: 'app.focus-sidebar', title: 'Focus sidebar', group: 'app', hint: 'Esc returns to the page',
    run: () => focusTree(),
  });
  registerTreeCommands();

  refreshTree();
}

// Focus mode lives in focus.js; re-exported here so callers have one sidebar import.
export { getFocus, setFocus, exitFocus, isUnderFocus, defaultNewFolder } from './focus.js';
