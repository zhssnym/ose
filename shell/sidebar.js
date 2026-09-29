// Sidebar: the pins, then one tree of the whole vault rooted at its name, then Trash. One
// scrolling column under a small tool strip. The vault is shown as it is on disk, the way a
// file manager shows it (H16, H20, M20, L8): every file with its real name and extension,
// folders first, nothing hidden by name. Dotfiles and files the OS marks hidden appear only
// while Show hidden items is on, greyed; `.ose`, `.git` and the exe are the host's to keep out
// and never arrive here (docs/HOST.md, the one hide rule).
//
// A folder row goes to the folder's own view (`{type:'folder'}`) on a click or Enter; its
// chevron, Left and Right fold it. A file row opens the file, whatever it is: the page host
// decides how (H17). Each folder sorts the way its folder view says (M22, `folder-model.js`),
// by name with numbers in number order unless the person chose otherwise.
//
// The tree is read once at boot (`ose.files.tree`) and then patched in place (M16): a batch
// of watcher changes re-lists only the folders those changes are in, and the app's own file
// operations do the same off their `paths:*` events. Only a watcher `rescan` or `lost`, or
// Show hidden items flipping, reads the whole tree again. An autosave of a page already in
// the tree touches that one node and draws nothing.
//
// Several rows can be selected at once (C17) and cut, copied, moved, trashed, pinned or dragged
// together. Create, rename, move, copy, duplicate and trash are not done here: every gesture
// of the tree ends in shell/fileops.js and from there in `ose.fileops`, which saves the open
// page first and refuses when it cannot (C6), and journals what it did so Ctrl+Z in the tree
// takes it back (M17). This file only follows what happened: expansion, the selection and the
// focused row. Pins are shell/pins.js's; a pin whose file is gone is greyed, never dropped
// (L22).
import { ose } from 'ose:core';
import {
  esc, icon, hasIcon, contextMenu, toast, copyText, confirm,
  focusOrigin, retargetFocusOrigin, overlayCount,
} from 'ose:ui';
import { vaultLost } from './vault.js';
import { clean, join, baseName, dirName, extOf, titleOf, segments, vaultName as nameOfVault, errorOf } from './paths.js';
import { DRAG_TYPE, hasOsFiles, isInternal, takeDropped, importDropped, setDragged, dragged } from './drag.js';
import { openSearch } from './search.js';
import { openInNewTab } from './tabs.js';
import {
  newFile, newFolder, renamePath, movePaths, trashPaths, duplicatePath, setContext, canMoveInto,
  cut, copy, paste, clipboard, onClipboard, clearClipboard, undo,
} from './fileops.js';
import * as pins from './pins.js';
import { sortEntries, nextSortSpec, visibleEntries, iconName, SORT_KEYS } from './folder-model.js';
import { sortSpec, setSortSpec } from './folder.js';
import { focusPage, sidebarVisible, setSidebarOpen, toggleSidebar } from './layout.js';

const { bus, commands, debounce, files, links, route } = ose;

// The core's hoses this file leans on, named the way the batch-12 shell named them, so the
// code below reads as it always did. Everything here is `ose` and nothing else.
const navigate = (r, opts) => route.navigate(r, opts);
const currentRoute = () => route.current();
const shortcutFor = (id) => ose.keys.shortcutFor(id);
const getFocus = () => ose.focus.get();
const setFocus = (path) => ose.focus.set(path);
const exitFocus = () => ose.focus.exit();
const isUnderFocus = (path) => ose.focus.isUnder(path);
const relativeHref = (from, to) => links.href(from, to);
const rewriteInboundMany = (pairs) => links.rewriteMoved(pairs);
const findInbound = (path) => links.inbound(path);
/** What a caught error says: its message, or the thing itself when it has none. */
const messageOf = (e) => (e && typeof e === 'object' && 'message' in e && e.message ? e.message : e);

/** An icon from the set, or `fallback` while the core does not carry that name yet. */
const ic = (name, fallback) => (hasIcon(name) ? name : fallback);

// Per-machine UI state (`ose.local`, W5): the tree's open folders beside the layout's open
// switch and width. Every folder's sort is shell/folder.js's (`sortSpec`, `setSortSpec`).
// Every write is read-modify-write of the whole slot, so the layout's writes to `sidebar.open`
// and this file's to `sidebar.expanded` never clobber each other. Never the vault's
// `.ose/state.json`: UI state is per machine and never lands in a synced file.
const slot = (key) => ose.local(key);

let el = null, scrollEl = null, headEl = null;
let tree = null;
let expanded = new Set();
// The root row is open unless the person folded it.
let rootOpen = true;
// The one row that is a tab stop (D2). A key, not an element: rows are rebuilt on every render.
let roving = null;
// Set by a rename, a move or a new file so the next render puts focus on that row (B4).
let focusAfterRender = null;
// The multi-selection (C17): tree paths, never pins. Empty means the focused row is
// the only target, as before; two or more and the tree commands act on all of them. `anchor`
// is the row a Shift-range grows from, set by every plain click or arrow.
let selected = new Set();
let anchor = null;
// Set while the tree itself tells the pins it changed: it draws right after, once.
let quietPins = false;
/** The pins are told the tree changed (missing or back), without a second draw. */
function pinsRefresh() { quietPins = true; try { pins.refresh(); } finally { quietPins = false; } }
// Show hidden items as the tree was last read with, so a settings change that flips it reads
// the tree again and one that does not leaves it be.
let readHidden = null;

const showHidden = () => !!(ose.settings.get() || {}).showHidden;

/* ------------------------------------------------------------------ tree data */

function findNode(path) {
  if (!tree) return null;
  let node = tree;
  for (const s of segments(path)) {
    if (!node || !node.children) return null;
    node = node.children.find((c) => c.name === s);
  }
  return node || null;
}

/** A folder's children as they are drawn: hidden ones only when asked for, in its sort. */
function kidsOf(node) {
  const list = visibleEntries((node && node.children) || [], { showHidden: showHidden() });
  return sortEntries(list, sortSpec(node ? node.path || '' : ''));
}

const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const isMarkdown = (p) => MD_EXTS.has(extOf(p));

/** Every file under `node`, depth first in drawing order, never under a link or into a hidden entry. */
function walkFiles(keep) {
  const out = [];
  const walk = (n) => {
    if (!n || !n.children) return;
    for (const c of sortEntries(n.children.filter((x) => !x.hidden), sortSpec(n.path || ''))) {
      if (c.kind === 'dir') { if (!c.link) walk(c); } else if (keep(c)) out.push(c.path);
    }
  };
  walk(tree);
  return getFocus() ? out.filter((p) => isUnderFocus(p)) : out;
}

/** Every markdown path in the vault, for the link picker and the page list. Focus mode narrows it. */
export function allPages() { return walkFiles((c) => isMarkdown(c.name)); }

/**
 * Every file in the vault that is not hidden, for quick open (H17): each one opens in the app,
 * so each one can be found without the tree. Focus mode narrows it.
 */
export function allFiles() { return walkFiles(() => true); }

/* ------------------------------------------------------------------ expansion */

function persistExpanded() {
  const s = slot('sidebar');
  s.set({ ...(s.get() || {}), expanded: [...expanded], root: rootOpen });
}

const isOpen = (path) => (path === '' ? rootOpen : expanded.has(path));

function expandAncestors(path) {
  const segs = segments(dirName(path));
  let acc = '';
  for (const s of segs) { acc = acc ? acc + '/' + s : s; expanded.add(acc); }
  if (!getFocus()) rootOpen = true;
}

/* ------------------------------------------------------------------ rendering */

/** The glyph of a row: the folder view's own choice (`iconName`), so a file looks the same in both. */
function glyphFor(node) {
  const name = iconName(node);
  return icon(ic(name, name === 'fileText' ? 'page' : 'file'));
}

const LINK_WORDS = {
  dir: 'Link to a folder', file: 'Link to a file', broken: 'Broken link: its target is gone',
  loop: 'Link that points back into itself', outside: 'Link to a place outside the vault',
};

// Every row is the same grid: 16px chevron slot, 14px glyph, name, an optional tail. Folders
// and files at the same depth put their text at the same x.
/**
 * @param {{cls?: string, depth?: number, glyphHtml?: string, chevron?: boolean | null, text: string,
 *   tail?: string, hint?: string, badge?: string, title?: string, data?: Record<string, string>}} row
 */
function rowEl({ cls = '', depth = 0, glyphHtml = '', chevron = null, text, tail = '', hint = '', badge = '', title = '', data = {} }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row sb-row ' + cls;
  const inTree = data.path !== undefined && data.pin !== '1' && data.root !== '1';
  if (inTree && selected.has(data.path)) b.classList.add('selected');
  b.style.setProperty('--d', String(depth));
  for (const k of Object.keys(data)) b.dataset[k] = data[k];
  if (inTree || data.pin === '1') b.draggable = true; // moves within the vault; see drag and drop
  // A tree to a screen reader, not a list of unrelated buttons (S39): the level is 1-based,
  // `aria-selected` is on every selectable row so the reader can say "not selected" too, and
  // only a folder that unfolds claims to expand.
  b.setAttribute('role', 'treeitem');
  b.setAttribute('aria-level', String(depth + 1));
  if (inTree) b.setAttribute('aria-selected', String(selected.has(data.path)));
  if (chevron !== null) b.setAttribute('aria-expanded', String(!!chevron));
  if (title) b.title = title;
  b.innerHTML =
    `<span class="tw${chevron ? ' open' : ''}">${chevron === null ? '' : icon('chevron')}</span>` +
    `<span class="gl">${glyphHtml}</span>` +
    `<span class="grow">${esc(text)}</span>` +
    (badge || '') +
    (tail ? `<span class="par">${esc(tail)}</span>` : '') +
    (hint ? `<span class="hint">${esc(hint)}</span>` : '');
  return b;
}

function label(text, dropPath) {
  const d = document.createElement('div');
  d.className = 'section-label';
  d.textContent = text;
  if (dropPath !== undefined && dropPath !== null) d.dataset.drop = dropPath;
  return d;
}

function emptyLine(text, depth) {
  const d = document.createElement('div');
  d.className = 'empty sb-empty';
  d.style.setProperty('--d', depth);
  d.textContent = text;
  return d;
}

/**
 * A `role="tree"` box for one section, so every `treeitem` has a tree to belong to (S39).
 * One tree per section rather than one for the whole sidebar: the sections are separate lists
 * with separate names, and claiming otherwise would make a reader announce wrong positions.
 */
function treeBox(frag, name, multi = false) {
  const box = document.createElement('div');
  box.className = 'sb-group';
  box.setAttribute('role', 'tree');
  box.setAttribute('aria-label', name);
  if (multi) box.setAttribute('aria-multiselectable', 'true');
  frag.appendChild(box);
  return box;
}

const cutPaths = () => { const c = clipboard(); return c && c.mode === 'cut' ? new Set(c.paths) : null; };

/** Pinned files and folders, in pin order; a missing one greyed and kept. Nothing while none. */
function renderPinned(frag, cur) {
  const list = pins.list();
  if (!list.length) return;
  const names = new Map();
  for (const p of list) names.set(baseName(p.path), (names.get(baseName(p.path)) || 0) + 1);
  frag.appendChild(label('Pinned'));
  const box = treeBox(frag, 'Pinned');
  for (const p of list) {
    const dir = p.kind === 'dir';
    const ambiguous = (names.get(baseName(p.path)) || 0) > 1;
    const parent = dirName(p.path);
    const current = dir ? cur.folder === p.path : cur.page === p.path;
    box.appendChild(rowEl({
      cls: 'sb-pin ' + (dir ? 'dir' : 'file') + (current ? ' current' : '') + (p.missing ? ' missing' : ''),
      depth: 0,
      glyphHtml: dir ? icon('folder') : glyphFor({ name: baseName(p.path), kind: 'file' }),
      text: dir ? baseName(p.path) : titleOf(p.path),
      tail: ambiguous ? (parent ? baseName(parent) : '/') : '',
      hint: p.missing ? 'missing' : '',
      title: p.missing ? `${p.path} is not there any more. The pin stays until you unpin it.` : '',
      data: { path: p.path, kind: dir ? 'dir' : 'file', pin: '1' },
    }));
  }
}

function renderNode(node, depth, box, cur, cuts) {
  const hidden = !!node.hidden;
  const link = node.link || '';
  const badge = link
    ? `<span class="sb-link" title="${esc(LINK_WORDS[link] || 'Link')}">${icon('link')}</span>`
    : '';
  const flags = (hidden ? ' hidden-entry' : '') + (link ? ' link' : '') + (cuts && cuts.has(node.path) ? ' cut' : '');
  if (node.kind === 'dir') {
    // A link is listed, never walked: the tree does not unfold one, its folder view lists it
    // when the target is inside the vault.
    const unfolds = !link;
    const open = unfolds && isOpen(node.path);
    box.appendChild(rowEl({
      cls: 'dir' + flags + (cur.folder === node.path ? ' current' : ''),
      depth, chevron: unfolds ? open : null, glyphHtml: icon('folder'), text: node.name, badge,
      data: { path: node.path, kind: 'dir' },
    }));
    if (!open) return;
    if (node.readable === false) { box.appendChild(emptyLine('No permission to open this folder', depth + 1)); return; }
    if (!node.children) { box.appendChild(emptyLine('Reading…', depth + 1)); void loadChildren(node.path); return; }
    for (const c of kidsOf(node)) renderNode(c, depth + 1, box, cur, cuts);
  } else {
    box.appendChild(rowEl({
      cls: 'file' + flags + (cur.page === node.path ? ' current' : ''),
      depth, glyphHtml: glyphFor(node), text: titleOf(node.path), badge,
      data: { path: node.path, kind: 'file' },
    }));
  }
}

/**
 * In focus mode the tree is rooted at one folder, and its label is the indicator: `focus ·
 * <folder>` with the way out on the right, where the vault's root row would be.
 */
function focusLabel(focus) {
  const d = document.createElement('div');
  d.className = 'section-label sb-focus-label';
  d.dataset.drop = focus;
  d.innerHTML = `<span class="sb-focus-key">Focus</span>`
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

function currentOf() {
  const r = currentRoute();
  return {
    page: r && r.type === 'page' ? clean(r.path) : null,
    folder: r && r.type === 'folder' ? clean(r.path || '') : null,
    view: r && r.type === 'view' ? r.name : null,
  };
}

/** The root row's name: the tree's own answer, else the core's. */
function vaultName() {
  return (tree && tree.name) || nameOfVault();
}

function renderTree() {
  const frag = document.createDocumentFragment();
  const cur = currentOf();
  const focus = getFocus();
  const cuts = cutPaths();

  if (!focus) renderPinned(frag, cur);

  if (focus) frag.appendChild(focusLabel(focus));
  const box = treeBox(frag, focus ? `Focus: ${baseName(focus)}` : 'Files', true);
  box.classList.add('sb-files');
  if (!tree) {
    box.appendChild(emptyLine('Reading the vault…', 0));
  } else if (focus) {
    const root = findNode(focus);
    if (!root || root.kind !== 'dir') box.appendChild(emptyLine('The focus folder is gone', 0));
    else if (!root.children) { box.appendChild(emptyLine('Reading…', 0)); void loadChildren(root.path); }
    else for (const c of kidsOf(root)) renderNode(c, 0, box, cur, cuts);
  } else {
    // The root row: the vault by its name. It goes to the vault's own folder view, and folds.
    box.appendChild(rowEl({
      cls: 'dir sb-root' + (cur.folder === '' ? ' current' : ''),
      depth: 0, chevron: rootOpen, glyphHtml: icon('folder'), text: vaultName(),
      title: (ose.vault && ose.vault.root) || '',
      data: { path: '', kind: 'dir', root: '1' },
    }));
    if (rootOpen) {
      const kids = kidsOf(tree);
      if (!kids.length) box.appendChild(emptyLine('Nothing here yet', 1));
      for (const c of kids) renderNode(c, 1, box, cur, cuts);
    }
  }

  // The last row: what was moved to the trash, and the way back (M18).
  const tail = treeBox(frag, 'Trash');
  tail.classList.add('sb-tail');
  tail.appendChild(rowEl({
    cls: 'sb-view sb-trash' + (cur.view === 'trash' ? ' current' : ''),
    depth: 0, glyphHtml: icon('trash'), text: 'Trash', data: { view: 'trash' },
  }));

  // The rebuild would drop keyboard focus on the floor (B4): note which row had it, rebuild,
  // put it back. A row that is gone (trashed) hands focus to whatever now sits at its index,
  // so Delete on a run of files keeps working. `focusOrigin` rather than activeElement: while
  // a confirm or rename dialog is up, the row is where focus will return to, and the dialog
  // must be told the row's replacement or it would hand focus back to a detached node.
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

  const wanted = rowByKey(focusAfterRender);
  if (wanted) focusAfterRender = null;
  if (wanted) roving = rowKey(wanted);
  applyRoving();
  if (wanted && !had && !overlayCount()) { focusRow(wanted); return; }
  if (had) {
    const list = treeRows();
    // ...or, for a control that was not a row (the focus-mode exit), the tab-stop row.
    const back = wanted || rowByKey(hadKey) || rowByKey(movedKey(hadKey)) || (hadIndex >= 0 ? list[Math.min(hadIndex, list.length - 1)] : null) || rovingRow();
    if (back) {
      setRoving(back);
      if (overlayCount()) retargetFocusOrigin(back); else back.focus({ preventScroll: true });
    }
  }
}

function render() {
  if (!scrollEl) return;
  renderTree();
  paintHead();
}

function rowFor(path) {
  return scrollEl ? scrollEl.querySelector(`.sb-row[data-path="${CSS.escape(path)}"]:not(.sb-pin)`) : null;
}

/* ------------------------------------------------------------ keyboard tree */

// Everything a key can land on, top to bottom: pins, the tree, Trash. It is read out of the
// DOM, so it is the drawing order by construction and the Up/Down walk can never disagree with
// what is on screen. Folded folders draw no children, so this is exactly the visible rows.
function treeRows() {
  return scrollEl ? [...scrollEl.querySelectorAll('.sb-row')] : [];
}

/** A stable identity for a row across renders: the path (pins apart from tree rows) or the view. */
function rowKey(row) {
  if (!row || !row.dataset) return null;
  if (row.dataset.view) return 'view:' + row.dataset.view;
  if (row.dataset.path !== undefined) return (row.dataset.pin === '1' ? 'pin:' : 'path:') + row.dataset.path;
  return null;
}

function rowByKey(key) {
  if (!key) return null;
  return treeRows().find((r) => rowKey(r) === key) || null;
}

/** The row Tab lands on: the remembered one if it still exists, else the current route's, else the first. */
function rovingRow() {
  const list = treeRows();
  if (!list.length) return null;
  const cur = currentOf();
  return rowByKey(roving)
    || (cur.page && rowFor(cur.page))
    || (cur.folder !== null && rowFor(cur.folder))
    || (cur.view && rowByKey('view:' + cur.view))
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
  if (!sidebarVisible()) setSidebarOpen(true);
  focusRow(rovingRow());
}

/* -------------------------------------------------------------- selection (C17) */

const isSelectable = (row) => !!row && row.dataset.path !== undefined && row.dataset.pin !== '1' && row.dataset.root !== '1';

/** The rows that can be part of a selection: tree rows with a path, so no pins, no root, no views. */
function selectableRows() { return treeRows().filter(isSelectable); }

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

/** Fold or unfold a tree folder row. A pinned folder has nothing to unfold: it goes there. */
function toggleDir(row) {
  const path = row.dataset.path;
  if (row.dataset.pin === '1') { void navigate({ type: 'folder', path }); return; }
  if (row.getAttribute('aria-expanded') === null) return;
  if (path === '') rootOpen = !rootOpen;
  else if (expanded.has(path)) expanded.delete(path);
  else expanded.add(path);
  persistExpanded();
  render();
}

/**
 * The route a row opens: a folder's view, a file's page, a view. Every file has one (H17): the
 * page host decides whether it is text, a picture, or a box with the ways out.
 */
function routeForRow(row) {
  if (!row) return null;
  if (row.dataset.view) return { type: 'view', name: row.dataset.view };
  const path = row.dataset.path;
  if (path === undefined) return null;
  return row.dataset.kind === 'dir' ? { type: 'folder', path } : { type: 'page', path };
}

/** Enter, or a click: what the row is, opened in the tab in front. */
function activateRow(row) {
  const r = routeForRow(row);
  if (r) void navigate(r);
}

/** A row opened on purpose, in a tab of its own. Answers whether there was anything to open. */
function openRowAside(row) {
  const r = routeForRow(row);
  if (!r) return false;
  setRoving(row);
  void openInNewTab(r);
  return true;
}

/** `ose.files.open`, with the refusal said out loud rather than left in a console (N10). */
function openWith(path) {
  files.open(path).catch((err) => toast(err.message || err, 'err'));
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

const rowOf = (e) => (e.target && e.target.closest && e.target.closest('.sb-row'))
  || (document.activeElement && document.activeElement.closest ? document.activeElement.closest('.sb-row') : null);

const targetOf = (row) => (row && row.dataset.path !== undefined ? { path: row.dataset.path, kind: row.dataset.kind } : null);
const folderOf = (t) => (!t ? '' : t.kind === 'dir' ? t.path : dirName(t.path));

/**
 * The tree's chords (M17): Ctrl+X, C and V cut, copy and paste, Ctrl+Z undoes the last file
 * operation, Ctrl+Enter opens in a tab of its own, Cmd+Backspace trashes on a Mac. They are
 * the tree's only while a row has focus, so the editor and every text field keep their own.
 * Answers whether the key was handled.
 */
function onTreeChord(e, row) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const t = targetOf(row);
  const batch = t ? batchFor(t) || (isSelectable(row) || row.dataset.pin === '1' ? [t] : []) : [];
  if (k === 'Enter' && !e.shiftKey) return !!row && openRowAside(row);
  if (e.shiftKey) return false;
  if (k === 'x') { if (batch.length) cut(batch); return true; }
  if (k === 'c') { if (batch.length) copy(batch); return true; }
  if (k === 'v') { void paste(folderOf(t)); return true; }
  if (k === 'z') { void undo(); return true; }
  if (k === 'Backspace' && e.metaKey && batch.length) { void trashPaths(batch); return true; }
  return false;
}

/**
 * The tree's keys (D1), bound on `.sb-scroll` so they only run while a row has focus. Up/Down
 * move focus only: nothing opens until Enter, so browsing the tree never churns the editor
 * (B3). Shift+Up/Down grow the selection from the anchor (C17); a plain move drops it and
 * moves the anchor, so the selection never trails a user who has moved on.
 */
function onTreeKey(e) {
  const row = rowOf(e);
  if (row && onTreeChord(e, row)) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const list = treeRows();
  if (!list.length) return;
  // A click on the blank space under the tree focuses the scroller itself: the first arrow
  // key steps onto the tab-stop row instead of doing nothing.
  if (!row) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); focusRow(rovingRow()); }
    return;
  }
  const at = list.indexOf(row);
  const isDir = row.dataset.kind === 'dir';
  const unfolds = isDir && row.getAttribute('aria-expanded') !== null;
  const inTree = isSelectable(row) || row.dataset.root === '1';
  const target = targetOf(row);
  const k = e.key;
  let next = null;

  if (k === 'ArrowDown') next = list[Math.min(list.length - 1, at + 1)];
  else if (k === 'ArrowUp') next = list[Math.max(0, at - 1)];
  else if (k === 'Home') next = list[0];
  else if (k === 'End') next = list[list.length - 1];
  else if (k === 'ArrowRight') {
    if (!unfolds) return;
    if (!isOpen(row.dataset.path)) { e.preventDefault(); toggleDir(row); return; }
    // Open already: the first child is the very next row, when there is one.
    const kid = list[at + 1];
    if (kid && kid.dataset.path !== undefined && isSelectable(kid) && dirName(kid.dataset.path) === row.dataset.path) next = kid; else return;
  } else if (k === 'ArrowLeft') {
    if (unfolds && inTree && isOpen(row.dataset.path)) { e.preventDefault(); toggleDir(row); return; }
    if (!isSelectable(row)) return;
    const parent = dirName(row.dataset.path);
    next = rowFor(parent);
    if (!next) return;
  } else if (k === 'Enter') { e.preventDefault(); activateRow(row); return; }
  else if (k === ' ') { e.preventDefault(); if (unfolds) toggleDir(row); return; }
  // F2 renames in place, with the stem selected (H13). It is `file.rename` on the row: the
  // window's own F2 (keys.json) would reach the same function with the same row.
  else if (k === 'F2') { if (!target || !target.path) return; e.preventDefault(); e.stopPropagation(); void renamePath(target); return; }
  // Delete: to the trash, with Undo in the toast (M18). Backspace does nothing here: on a Mac
  // it is Cmd+Backspace, as in Finder, and a lone Backspace is too easy to press by accident.
  else if (k === 'Delete') { if (!target || !target.path) return; e.preventDefault(); void trashPaths(batchFor(target) || [target]); return; }
  // Shift+F10 and the Menu key are the Windows convention for "the context menu of the thing
  // that has focus", and the tree is the one place in the app with a context menu (S12).
  else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
    e.preventDefault();
    openMenuAt(row);
    return;
  }
  else if (k === 'Escape') {
    // A selection goes first, then a pending cut; the page gets focus on the next Esc.
    e.preventDefault();
    if (selected.size) { clearSelection(); return; }
    const c = clipboard();
    if (c && c.mode === 'cut') { clearClipboard(); return; }
    focusPage();
    return;
  }
  else if (k.length === 1 && k !== ' ') { next = typeAhead(list, at, k); if (!next) return; }
  else return;

  e.preventDefault();
  if (!next) return;
  // Shift + a vertical move extends the range from the anchor to where focus lands; a move
  // without it is a single row again. Only tree rows can be selected, so a range that runs
  // into the pins or the root simply skips them.
  if (e.shiftKey && (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') && (isSelectable(row) || isSelectable(next))) {
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
  const cur = currentOf();
  const node = cur.page ? rowFor(cur.page) : cur.folder !== null ? rowFor(cur.folder) : null;
  if (node) node.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ data load */

const codeOf = (e) => errorOf(e).code;

/**
 * Whether the vault folder itself is gone. `tree` answers `io` for a root it cannot read, so the
 * root is listed once more: a missing folder answers `not_found` there, as every listing does.
 */
async function vaultGone(e) {
  const code = codeOf(e);
  if (code === 'no_vault' || code === 'not_found') return true;
  try { await files.list('', { hidden: false }); return false; } catch (again) {
    const c = codeOf(again);
    return c === 'not_found' || c === 'no_vault';
  }
}

let treeLoad = null;

/**
 * Read the whole tree again. Boot, a watcher `rescan` or `lost`, and Show hidden items
 * flipping; everything else patches (M16).
 */
export async function refreshTree() {
  if (treeLoad) return treeLoad;
  treeLoad = (async () => {
    const hidden = showHidden();
    try {
      tree = await files.tree({ hidden });
      readHidden = hidden;
    } catch (e) {
      console.error('[shell] tree', e);
      // A read that fails because the folder itself is gone is not a tree bug, and a toast per
      // failed call is noise on top of a vault that has been unplugged (S29): the shell has
      // one dialog for it, and `vaultLost` is idempotent while that dialog is up.
      if (await vaultGone(e)) { vaultLost(); return; }
      toast('Could not read the vault: ' + messageOf(e), 'err');
      return;
    }
    if (tree) { tree.path = ''; if (!tree.children) tree.children = []; }
    pinsRefresh();
    render();
    scrollToCurrent();
  })();
  try { await treeLoad; } finally { treeLoad = null; }
}

/**
 * List one folder and put its entries in place of the ones the tree holds. A subfolder the tree
 * had already read keeps its children; one it had not is answered in the list of new folders.
 * Answers null when the folder could not be listed (and a gone one hands the question up to
 * its parent).
 */
async function relistOne(path) {
  let entries;
  try { entries = await files.list(path, { hidden: showHidden() }); } catch (e) {
    const code = codeOf(e);
    if (code === 'not_found' && path) { pendingDirs.add(dirName(path)); return null; }
    if (code === 'no_vault') { vaultLost(); return null; }
    console.warn('[shell] list', path, e);
    return null;
  }
  const node = findNode(path);
  if (!node || node.kind !== 'dir') return null;
  const old = new Map((node.children || []).map((c) => [c.name, c]));
  const fresh = [];
  node.children = (entries || []).map((e) => {
    const n = { ...e, path: e.path != null ? clean(e.path) : join(path, e.name) };
    const prev = old.get(e.name);
    if (n.kind === 'dir' && !n.link) {
      if (prev && prev.kind === 'dir' && prev.children) n.children = prev.children;
      else fresh.push(n.path);
    }
    return n;
  });
  return fresh;
}

// Folders whose listing is out of date, gathered from a batch of changes and read together.
const pendingDirs = new Set();
let patchTimer = null;
let patching = null;
// A folder that arrived whole (moved in from Explorer) is read down to its files, so quick
// open finds them; past this many listings in one batch the whole tree is read instead.
const PATCH_BUDGET = 200;

function schedulePatch(dirs) {
  for (const d of dirs) pendingDirs.add(clean(d));
  if (patchTimer) return;
  patchTimer = setTimeout(() => { patchTimer = null; void flushPatch(); }, 60);
}

async function flushPatch() {
  if (patching) { await patching; if (pendingDirs.size) schedulePatch([]); return; }
  patching = (async () => {
    if (!tree) { pendingDirs.clear(); await refreshTree(); return; }
    let budget = PATCH_BUDGET;
    while (pendingDirs.size) {
      // Each changed path's nearest folder the tree has read: a change inside a folder the tree
      // never unfolded is that folder's news, not the tree's.
      const targets = new Set();
      for (let d of pendingDirs) {
        let n = findNode(d);
        while (d && (!n || n.kind !== 'dir' || !n.children)) { d = dirName(d); n = findNode(d); }
        if (n && n.kind === 'dir' && n.children) targets.add(d);
      }
      pendingDirs.clear();
      const order = [...targets].sort((a, b) => segments(a).length - segments(b).length);
      const queue = [...order];
      while (queue.length) {
        if (--budget < 0) { pendingDirs.clear(); await refreshTree(); return; }
        const fresh = await relistOne(queue.shift());
        if (fresh) queue.push(...fresh);
      }
    }
    pinsRefresh();
    render();
  })();
  try { await patching; } finally { patching = null; }
}

/** A folder the tree had not read (past the walk's depth), read when it is unfolded. */
const loadingDirs = new Set();
async function loadChildren(path) {
  if (loadingDirs.has(path)) return;
  loadingDirs.add(path);
  try {
    await relistOne(path);
    const n = findNode(path);
    if (n && n.kind === 'dir' && !n.children) n.readable = false;
  } finally { loadingDirs.delete(path); }
  render();
}

// Autosaves: a `modify` of a file the tree already has only changes its size and time, which
// the tree does not draw; the node is brought up to date quietly, a few at a time.
const staleFiles = new Set();
const statStale = debounce(async () => {
  const list = [...staleFiles];
  staleFiles.clear();
  for (const p of list) {
    try {
      const st = await files.stat(p);
      const n = findNode(p);
      if (n && st && st.exists !== false) { if (st.mtime != null) n.mtime = st.mtime; if (st.size != null) n.size = st.size; }
    } catch { /* the next listing of its folder says the rest */ }
  }
}, 400);

/** The watcher's half of M16: which folders to re-list, and nothing more. */
function onFsTree(payload) {
  if (!payload) return;
  if (payload.lost || payload.rescan) { void refreshTree(); return; }
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const dirs = [];
  for (const c of changes) {
    if (!c || !c.path) continue;
    const p = clean(c.path);
    if (c.hidden && !c.to && !showHidden()) continue;
    if (c.kind === 'modify' && !c.to) {
      const n = findNode(p);
      if (n && n.kind === 'file') { staleFiles.add(p); continue; }
    }
    dirs.push(dirName(p));
    if (c.to) dirs.push(dirName(clean(c.to)));
    // A folder itself changed (created, removed, renamed): its own listing may be stale too.
    if (c.dir) dirs.push(p);
  }
  if (staleFiles.size) statStale();
  if (dirs.length) schedulePatch(dirs);
}

/* ------------------------------------------------------------------ what the app did */

/**
 * The from/to pairs a move produces, read from the tree before it happens: the path itself,
 * and for a folder every file under it, because the watcher reports a folder moved in the app
 * as one rename per file and the N19 question below must not ask about any of them.
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

// The focused row's path when a move of it began (`paths:moving`), so `paths:moved` can put the
// keyboard back on it even if a watcher re-list moved focus in between.
let movedFocus = null;

const followMove = (p, from, to) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null);

/**
 * `paths:moving` (shell/fileops.js, before the host call): the watcher will report these a
 * moment later, and the links are about to be rewritten by `ose.fileops` itself, so the N19
 * question must not offer to fix them.
 */
function onMoving(d) {
  movedFocus = null;
  for (const m of (d && d.moves) || []) {
    if (!m || !m.from || !m.to) continue;
    if (roving === 'path:' + clean(m.from)) movedFocus = clean(m.from);
    for (const p of filePairs(clean(m.from), clean(m.to))) noteSelfMove(p.from, p.to);
  }
}

/**
 * `paths:moved` (`ose.fileops`, after the host call): expansion, the selection and the focused
 * row follow the files to their new paths, and the two folders are listed again. The page and
 * its tab have followed already; nothing here navigates.
 */
function onMoved(d) {
  const moves = ((d && d.moves) || []).filter((m) => m && m.from && m.to).map((m) => ({ from: clean(m.from), to: clean(m.to) }));
  if (!moves.length) return;
  const dirs = [];
  for (const m of moves) {
    noteSelfMove(m.from, m.to);
    for (const p of [...expanded]) { const n = followMove(p, m.from, m.to); if (n) { expanded.delete(p); expanded.add(n); } }
    // Where it went is opened, so the row can be seen and focused there.
    expandAncestors(m.to);
    // The row the user was on has a new name; the next render focuses it there (B4, D1).
    if (roving === 'path:' + m.from || movedFocus === m.from) focusAfterRender = 'path:' + m.to;
    else if (roving === 'pin:' + m.from) focusAfterRender = 'pin:' + m.to;
    dirs.push(dirName(m.from), dirName(m.to));
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
  schedulePatch(dirs);
}

/** `paths:trashed`: what went takes its expansion and its place in the selection. Pins stay (L22). */
function onTrashed(d) {
  const paths = ((d && d.paths) || []).map(clean).filter(Boolean);
  if (!paths.length) return;
  for (const p of paths) {
    for (const e of [...expanded]) if (followMove(e, p, p)) expanded.delete(e);
    for (const s of [...selected]) if (followMove(s, p, p)) selected.delete(s);
  }
  persistExpanded();
  schedulePatch(paths.map(dirName));
}

/** `paths:created`, `paths:copied`, `paths:restored`: the tree opens down to them and lists their folders. */
function onArrived(paths) {
  const list = paths.map(clean).filter(Boolean);
  if (!list.length) return;
  for (const p of list) expandAncestors(p);
  persistExpanded();
  schedulePatch(list.map(dirName));
}

/** `tree:reveal` (shell/fileops.js): show a path the person just made, and with `focus` put the keyboard on it. */
function onReveal(d) {
  const p = clean(d && d.path);
  if (!p) return;
  expandAncestors(p);
  persistExpanded();
  if (d.focus) focusAfterRender = 'path:' + p;
  schedulePatch([dirName(p)]);
}

/* ------------------------------------------------- renames made outside the app (N19) */

// A move the app made itself: the watcher reports it a moment later, and the links have
// already been rewritten by `ose.fileops`. Keyed `from>to`, forgotten after a few seconds.
const selfMoves = new Map();
const SELF_MOVE_MS = 8000;

function noteSelfMove(from, to) {
  const now = Date.now();
  selfMoves.set(from + '>' + to, now);
  for (const [k, at] of selfMoves) if (now - at > SELF_MOVE_MS) selfMoves.delete(k);
}

/**
 * Where a row went, when the app is moving it right now: the watcher can re-list the folder
 * before `paths:moved` arrives, and the focused row must follow the file, not fall to its
 * neighbour.
 */
function movedKey(key) {
  if (!key || !key.startsWith('path:')) return null;
  const from = key.slice(5);
  let best = null, at = 0;
  for (const [k, t] of selfMoves) {
    const i = k.indexOf('>');
    if (k.slice(0, i) === from && t >= at && Date.now() - t <= SELF_MOVE_MS) { best = k.slice(i + 1); at = t; }
  }
  return best ? 'path:' + best : null;
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
    let count = 0;
    const where = new Set();
    for (const m of moves) {
      let inbound = [];
      try { inbound = await findInbound(m.from); } catch (e) { console.error('[shell] links', e); continue; }
      if (!inbound.length) continue;
      real.push(m);
      for (const p of inbound) { count += p.count; where.add(p.path); }
    }
    if (!real.length) return;
    const one = real.length === 1 ? real[0] : null;
    const linksWord = `${count} link${count === 1 ? '' : 's'}`;
    const filesWord = `${where.size} file${where.size === 1 ? '' : 's'}`;
    const ok = await confirm({
      title: 'Update links?',
      body: one
        ? `${baseName(one.from)} was moved to ${one.to} outside the app. ${linksWord} in ${filesWord} still point at the old name.`
        : `${real.length} files were moved outside the app. ${linksWord} in ${filesWord} still point at their old names.`,
      ok: `Update ${linksWord}`,
    });
    if (!ok) return;
    const res = await rewriteInboundMany(real);
    toast(res.links
      ? `${res.links} link${res.links === 1 ? '' : 's'} in ${res.files} file${res.files === 1 ? '' : 's'} updated`
      : 'Nothing to update', 'info', 2600);
    for (const p of res.failed || []) toast('Could not update links in ' + p, 'err', 0);
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
    // Into `.trash` or another hidden place: the file left, and a link to it has nowhere to go.
    const dotted = (p) => p.split('/').some((seg) => seg.startsWith('.'));
    if (dotted(to) && !dotted(from)) continue;
    pendingRenames.push({ from, to });
  }
}

/** Expand the tree down to a folder and bring it into view. No navigation. */
export function revealFolder(path) {
  const dir = clean(path);
  setSidebarOpen(true);
  if (dir) { expandAncestors(dir + '/x'); expanded.add(dir); } else rootOpen = true;
  persistExpanded();
  render();
  requestAnimationFrame(() => {
    const n = rowFor(dir);
    if (n) n.scrollIntoView({ block: 'center' });
  });
}

/* ------------------------------------------------------------- drag and drop */

// Internal drags carry the vault paths (a JSON list: a selection drags together, C17) in a
// private type (drag.js `DRAG_TYPE`); `dragPaths` mirrors it because dataTransfer.getData is
// unreadable during dragover, and the self/descendant guard has to run there, for every item,
// to decide whether the row may light up at all. A drop from Explorer or Finder is copied in,
// folders and all, through drag.js `importDropped`.

let dragPaths = null;
let dropEl = null;

/** The list an internal payload holds. A bare path (an older build's payload) is a list of one. */
function parseDrag(data) {
  if (!data) return null;
  try { const v = JSON.parse(data); if (Array.isArray(v)) return v.map(clean).filter(Boolean); } catch { /* not JSON: a bare path */ }
  return [clean(data)].filter(Boolean);
}

/** A folder row (tree, root or pin) or a label that stands for a folder. */
function dropTargetOf(node) {
  if (!node || !node.closest) return null;
  const lab = node.closest('.section-label[data-drop]');
  if (lab) return { el: lab, dir: lab.dataset.drop };
  const row = node.closest('.sb-row.dir');
  if (row && row.dataset.path !== undefined && !row.classList.contains('missing')) return { el: row, dir: row.dataset.path };
  return null;
}

// Into itself, under itself, or where it already is: no. The same rule Move to… uses.
const canDropInto = (from, dir) => canMoveInto(from, dir);

function setDropEl(node) {
  if (dropEl === node) return;
  if (dropEl) dropEl.classList.remove('drop-on');
  dropEl = node;
  if (dropEl) dropEl.classList.add('drop-on');
}

function endDrag() { dragPaths = null; setDragged(null); setDropEl(null); }

function bindDnd(host) {
  host.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.sb-row[data-path]');
    if (!row || row.dataset.root === '1') { e.preventDefault(); return; }
    // A row inside a selection of several drags the whole selection; any other row, itself.
    const batch = batchFor({ path: row.dataset.path, kind: row.dataset.kind });
    const paths = batch && row.dataset.pin !== '1' ? batch.map((it) => it.path) : [row.dataset.path];
    dragPaths = paths;
    setDragged(paths);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragPaths));
    e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
  });

  host.addEventListener('dragend', endDrag);

  host.addEventListener('dragover', (e) => {
    // A row dragged from a folder view is internal too: its paths are drag.js's.
    const moving = dragPaths || dragged();
    const internal = !!moving || isInternal(e.dataTransfer);
    const external = !internal && hasOsFiles(e.dataTransfer);
    if (!internal && !external) { setDropEl(null); return; }
    const t = dropTargetOf(e.target);
    // Every dragged item has to be able to land there, or the folder does not light up.
    if (!t || (internal && !(moving || []).every((p) => canDropInto(p, t.dir)))) {
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
    const from = dragPaths || dragged() || parseDrag(e.dataTransfer ? e.dataTransfer.getData(DRAG_TYPE) : '');
    // The drop's items are readable only now, inside the event: taken before anything awaits.
    const dropped = !(from && from.length) && t && hasOsFiles(e.dataTransfer) ? takeDropped(e.dataTransfer) : null;
    endDrag();
    if (!t) return;
    if (from && from.length) void movePaths(from.map((p) => ({ path: p, kind: findNode(p)?.kind === 'dir' ? 'dir' : 'file' })), t.dir);
    else if (dropped) void importDropped(dropped, clean(t.dir));
  });
}

/* ------------------------------------------------------- tree commands and menu */

/**
 * The href a link to `path` should carry (N14, N15): the editor's `relativeHref`, resolved
 * against the page that is open, so pasting it into that page works. With no page open there
 * is nothing to be relative to, so the vault-root form is written with a leading `/`.
 */
function linkUrl(path, dir) {
  const r = currentRoute();
  const from = r && r.type === 'page' ? r.path : null;
  const href = from ? relativeHref(from, clean(path)) : '/' + relativeHref('', clean(path));
  return (href || baseName(path)) + (dir ? '/' : '');
}

/** `Copy path` and `Copy link`. A folder links as `[name](path/)`. */
async function copyPathText(path) {
  const ok = await copyText(clean(path));
  toast(ok ? 'Copied' : 'Could not copy', ok ? 'info' : 'err', 1600);
}

async function copyLink(path, kind) {
  const dir = kind === 'dir';
  const ok = await copyText(`[${baseName(path)}](${linkUrl(path, dir)})`);
  toast(ok ? 'Copied' : 'Could not copy', ok ? 'info' : 'err', 1600);
}

/**
 * The thing a tree command acts on (D3): `{ path, kind }` for the focused tree row (the row
 * focus will return to, while a palette or menu is up: see focusOrigin), else the route on
 * screen (a page, or a folder), else null. The root row is `{ path: '', kind: 'dir' }`.
 * @returns {import('./fileops.js').Target | null}
 */
function treeTarget() {
  const o = focusOrigin();
  const row = o && scrollEl && scrollEl.contains(o) && o.closest ? o.closest('.sb-row[data-path]') : null;
  // A tree row carries its path and its kind, `file` or `dir`.
  if (row instanceof HTMLElement) return /** @type {import('./fileops.js').Target} */ ({ path: row.dataset.path, kind: row.dataset.kind });
  const r = currentRoute();
  if (r && r.type === 'page') return { path: r.path, kind: 'file' };
  if (r && r.type === 'folder') return { path: clean(r.path || ''), kind: 'dir' };
  return null;
}


/** Every folder in the tree, or none of them (N26). One persist, one render. */
function setAllExpanded(open) {
  if (!open) { expanded = new Set(); }
  else {
    const all = new Set();
    const walk = (n) => {
      for (const c of visibleEntries(n.children || [], { showHidden: showHidden() })) {
        if (c.kind !== 'dir' || c.link) continue;
        all.add(c.path);
        walk(c);
      }
    };
    if (tree) walk(tree);
    expanded = all;
    rootOpen = true;
  }
  persistExpanded();
  render();
}

/** Show hidden items (H16): a machine setting, read by the tree, the folder view and search. */
function toggleHidden() {
  const next = !showHidden();
  Promise.resolve(ose.settings.set({ showHidden: next })).catch((e) => toast(String(e.message || e), 'err', 0));
}

// The folder view's words for its columns, so the tree's menu and the view's say the same thing.
const SORT_WORDS = { name: 'Name', modified: 'Modified', size: 'Size', type: 'Type' };

/**
 * Sort a folder by… (M22): the folder view's menu, row for row — the four columns, then the two
 * directions, the current choice wearing the dot — writing through `setSortSpec`, the one writer
 * of the per-folder sort, which announces `folders:sort` so the tree and the view both redraw.
 */
function sortMenu(t, at) {
  const path = folderOf(t);
  const spec = sortSpec(path);
  const mark = (on) => (on ? icon('dot') : '');
  /** @type {{label?: string, iconSvg?: string, run?: () => void, sep?: boolean}[]} */
  const items = SORT_KEYS.map((k) => ({
    label: SORT_WORDS[k], iconSvg: mark(spec.key === k),
    run: () => setSortSpec(path, { key: k, dir: spec.key === k ? spec.dir : nextSortSpec(spec, k).dir }),
  }));
  items.push({ sep: true });
  items.push({ label: 'Ascending', iconSvg: mark(spec.dir === 'asc'), run: () => setSortSpec(path, { key: spec.key, dir: 'asc' }) });
  items.push({ label: 'Descending', iconSvg: mark(spec.dir === 'desc'), run: () => setSortSpec(path, { key: spec.key, dir: 'desc' }) });
  const row = at || rowFor(path) || scrollEl;
  const r = row ? row.getBoundingClientRect() : { left: 0, bottom: 0 };
  contextMenu(Math.round(r.left + 24), Math.round(r.bottom), items);
}

// One table for the palette and the context menu, so the two cannot drift: the menu is built
// from these entries (label, icon, shortcut all come from the registered command) and each
// entry's `applies(target)` decides both the palette's `when` and the menu's rows. The
// commands take an explicit target from the menu (the row under the pointer, which right-click
// never focuses) and fall back to `treeTarget()` from the palette or a chord. Pin, unpin, cut,
// copy, move and trash act on the whole selection when the target is part of one (C17).
//
// The file operations are not the tree's: `file.*` and `tree.new-folder` are registered by
// shell/fileops.js, the one UI for them. Their rows here (`own: false`) only say when the menu
// offers them and hand them the row.
const TREE_COMMANDS = [
  { id: 'file.new', title: 'New file…', icon: 'plus', group: 'file', own: false,
    applies: () => true, run: (t) => void newFile(t) },
  { id: 'tree.new-folder', title: 'New folder', icon: 'folderPlus', group: 'file', own: false,
    applies: () => true, run: (t) => void newFolder(folderOf(t)) },
  { id: 'tree.open-tab', title: 'Open in new tab', icon: 'plus', group: 'tree',
    applies: (t) => t.path !== undefined, run: (t) => void openInNewTab(t.kind === 'dir' ? { type: 'folder', path: t.path } : { type: 'page', path: t.path }) },
  { id: 'tree.pin', title: 'Pin', icon: 'pin', group: 'tree',
    applies: (t) => !!t.path && (batchFor(t) || [t]).some((it) => !pins.has(it.path)),
    run: (t) => pins.add((batchFor(t) || [t]).map((it) => it.path)) },
  { id: 'tree.unpin', title: 'Unpin', icon: 'pin', group: 'tree',
    applies: (t) => !!t.path && (batchFor(t) || [t]).some((it) => pins.has(it.path)),
    run: (t) => pins.remove((batchFor(t) || [t]).map((it) => it.path)) },
  { id: 'app.focus-enter', title: 'Focus folder', icon: 'focus', group: 'app',
    applies: (t) => !!t.path && t.kind === 'dir' && getFocus() !== t.path, run: (t) => setFocus(t.path) },
  { id: 'file.rename', title: 'Rename…', icon: 'rename', group: 'file', own: false,
    applies: (t) => !!t.path, run: (t) => void renamePath(t) },
  // A folder can be moved from the menu as well as dragged (N22): dragging is a mouse, and
  // everything in this app has to be reachable without one.
  { id: 'file.move', title: 'Move to…', icon: 'folder', group: 'file', own: false,
    applies: (t) => !!t.path, run: (t) => void movePaths(batchFor(t) || [t]) },
  { id: 'file.duplicate', title: 'Duplicate', icon: 'copy', group: 'file', own: false,
    applies: (t) => !!t.path && t.kind !== 'dir', run: (t) => void duplicatePath(t) },
  { id: 'file.cut', title: 'Cut', icon: 'scissors', group: 'file', own: false,
    applies: (t) => !!t.path, run: (t) => cut(batchFor(t) || [t]) },
  { id: 'file.copy', title: 'Copy', icon: 'copy', group: 'file', own: false,
    applies: (t) => !!t.path, run: (t) => copy(batchFor(t) || [t]) },
  { id: 'file.paste', title: 'Paste', icon: 'clipboard', group: 'file', own: false,
    applies: () => !!clipboard(), run: (t) => void paste(folderOf(t)) },
  { id: 'tree.copy-path', title: 'Copy path', icon: 'copy', group: 'tree',
    applies: (t) => !!t.path, run: (t) => void copyPathText(t.path) },
  { id: 'tree.copy-link', title: 'Copy link', icon: 'link', group: 'tree',
    applies: (t) => !!t.path, run: (t) => void copyLink(t.path, t.kind) },
  // Every row, folders included: a folder handed to the platform opens in the file manager.
  { id: 'tree.open-external', title: 'Open in a browser tab', icon: 'reveal', group: 'tree',
    applies: (t) => !!t.path, run: (t) => openWith(t.path) },
  // Search, already narrowed to the folder (N38).
  { id: 'tree.search-here', title: 'Search in folder', icon: 'search', group: 'tree',
    applies: (t) => t.kind === 'dir', run: (t) => openSearch({ folder: t.path }) },
  { id: 'tree.sort', title: 'Sort folder by…', icon: ic('sortAsc', 'view'), group: 'tree',
    applies: (t) => t.path !== undefined, run: (t) => sortMenu(t, rowFor(folderOf(t))) },
  { id: 'tree.collapse-all', title: 'Collapse all folders', icon: 'chevron', group: 'tree',
    applies: () => true, run: () => setAllExpanded(false) },
  { id: 'tree.expand-all', title: 'Expand all folders', icon: 'chevron', group: 'tree',
    applies: () => true, run: () => setAllExpanded(true) },
  // The title the menus draw is the registered command's, which names the real bin (fileops.js).
  { id: 'file.trash', title: 'Move to the trash', icon: 'trash', group: 'file', danger: true, own: false,
    applies: (t) => !!t.path, run: (t) => void trashPaths(batchFor(t) || [t]) },
];

function registerTreeCommands() {
  for (const c of TREE_COMMANDS) {
    if (c.own === false) continue;
    commands.register({
      id: c.id, title: c.title, group: c.group, icon: c.icon,
      when: () => { const t = treeTarget(); return !!t && c.applies(t); },
      run: (target) => { const t = target && typeof target === 'object' ? target : treeTarget(); if (t && c.applies(t)) c.run(t); },
    });
  }
}

// The menu's order: create, open, the row's own verbs, the clipboard, then copy and Explorer,
// then the one destructive action. `app.focus-exit` lives in focus.js; its menu row shows only
// on the folder that is the focus.
const MENU = [
  'file.new', 'tree.new-folder',
  null,
  'tree.open-tab',
  'tree.pin', 'tree.unpin', 'app.focus-enter', { id: 'app.focus-exit', applies: (t) => !!t.path && t.kind === 'dir' && getFocus() === t.path },
  'file.rename', 'file.move', 'file.duplicate',
  null,
  'file.cut', 'file.copy', 'file.paste',
  null,
  'tree.copy-path', 'tree.copy-link',
  null,
  'tree.sort', 'tree.search-here', 'tree.open-external',
  null,
  'file.trash',
];

/**
 * A menu row from a registered command: its title, icon and chord, run against `target`.
 *
 * The row runs the table's own function with the row, not `commands.run`: that asks the
 * command's `when`, which knows only the focused row, and right-click never focused one (H21).
 * The menu has asked `applies(target)` of this very row before offering it.
 */
function menuItem(id, target, label) {
  const c = commands.get(id);
  if (!c) return null;
  const local = TREE_COMMANDS.find((x) => x.id === id);
  return {
    label: label || c.title, iconSvg: c.icon ? icon(c.icon) : '', shortcut: shortcutFor(id) || '',
    danger: !!(local && local.danger),
    run: () => {
      try {
        const out = local ? local.run(target) : c.run(target);
        if (out && typeof out.catch === 'function') out.catch((e) => toast(String(e.message || e), 'err', 0));
      } catch (e) {
        console.error('[shell] menu', id, e);
        toast(String(messageOf(e)), 'err', 0);
      }
    },
  };
}

/** No two separators in a row and none at either end, whatever was filtered out between. */
const tidy = (items) => items.filter((it, i, all) => !it.sep || (i > 0 && i < all.length - 1 && !all[i - 1].sep));

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
  return tidy(items);
}

// The menu for a row inside a selection of several (C17): only what makes sense for many.
// Labels carry the count so the user knows the menu is for the selection.
const MULTI_MENU = ['tree.pin', 'tree.unpin', null, 'file.cut', 'file.copy', 'file.move', null, 'file.trash'];

function multiMenu(batch) {
  const target = batch[0];
  const items = [];
  for (const id of MULTI_MENU) {
    if (id === null) { items.push({ sep: true }); continue; }
    const local = TREE_COMMANDS.find((x) => x.id === id);
    if (!local || !local.applies(target)) continue;
    const it = menuItem(id, target, `${(commands.get(id) || local).title} (${batch.length})`);
    if (it) items.push(it);
  }
  return tidy(items);
}

/**
 * The menu for a row, whichever way it was asked for: right-click, Shift+F10 or the Menu key.
 * A row inside a selection of several gets the selection's menu; any other row drops the
 * selection first, so a menu is never about rows the user is not pointing at.
 */
function menuItemsForRow(row) {
  // Both callers hand a row with a path: openMenuAt checks it, and the right-click leaves out
  // the view rows, the only ones without.
  const target = /** @type {{path: string, kind: string}} */ (targetOf(row));
  const batch = isSelectable(row) ? batchFor(target) : null;
  if (!batch && isSelectable(row)) clearSelection();
  return batch ? multiMenu(batch) : menuFor(target.path, target.kind);
}

/** The keyboard's context menu (S12): under the row, aligned with where its name starts. */
function openMenuAt(row) {
  if (!row || row.dataset.path === undefined) return;
  const r = row.getBoundingClientRect();
  contextMenu(Math.round(r.left + 24), Math.round(r.bottom), menuItemsForRow(row));
}

/** Right-click on the empty space under the tree: the vault root, or the focus folder. */
function emptyMenu() {
  const dir = getFocus() || '';
  const where = baseName(dir) || vaultName();
  const target = { path: dir, kind: 'dir' };
  return tidy([
    menuItem('file.new', target, `New file in ${where}…`),
    menuItem('tree.new-folder', target, `New folder in ${where}`),
    clipboard() ? menuItem('file.paste', target, `Paste into ${where}`) : null,
  ].filter(Boolean));
}

/* ------------------------------------------------------------------ the tool strip */

// Four buttons over the tree, each also a command in the palette: New file, New folder,
// Collapse all, and Show hidden items, which is a toggle and says so (`aria-pressed`).
const TOOLS = [
  { id: 'file.new', icon: 'plus', label: 'New file…' },
  { id: 'tree.new-folder', icon: 'folderPlus', label: 'New folder' },
  { id: 'tree.collapse-all', icon: 'chevron', label: 'Collapse all folders', cls: 'sb-tool-collapse' },
  { id: 'view.toggle-hidden', icon: 'eye', label: 'Show hidden items', toggle: true },
];

function buildHead() {
  headEl.innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sb-tool' + (t.cls ? ' ' + t.cls : '');
    b.dataset.cmd = t.id;
    b.setAttribute('aria-label', t.label);
    b.title = t.label + (shortcutFor(t.id) ? ` (${shortcutFor(t.id)})` : '');
    b.innerHTML = icon(ic(t.icon, 'dot'));
    b.addEventListener('click', () => {
      // From the strip, "here" is the folder of the route on screen, not a row.
      const r = currentRoute();
      /** @type {import('./fileops.js').Target} */
      const here = r && r.type === 'folder' ? { path: clean(r.path || ''), kind: 'dir' }
        : r && r.type === 'page' ? { path: dirName(r.path), kind: 'dir' } : { path: getFocus() || '', kind: 'dir' };
      if (t.id === 'file.new') void newFile(here);
      else if (t.id === 'tree.new-folder') void newFolder(here.path);
      else commands.run(t.id);
    });
    headEl.appendChild(b);
  }
  paintHead();
}

function paintHead() {
  if (!headEl) return;
  const on = showHidden();
  const b = headEl.querySelector('[data-cmd="view.toggle-hidden"]');
  if (b) {
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
    b.innerHTML = icon(on ? ic('eye', 'dot') : ic('eyeOff', 'dot'));
    b.title = on ? 'Hide hidden items' : 'Show hidden items';
  }
}

/* ------------------------------------------------------------------ init */

/**
 * Draw the sidebar into `node` and wire it: the tool strip, the tree, its keys, menus, drag and
 * drop, and the events it follows. Called once by the layout.
 * @param {HTMLElement} node
 */
export function initSidebar(node) {
  el = node;
  el.className = 'sidebar';
  el.innerHTML = '<div class="sb-head" role="toolbar" aria-label="Files"></div><div class="sb-scroll" tabindex="-1"></div>';
  headEl = el.querySelector('.sb-head');
  // Drawn just above.
  scrollEl = /** @type {HTMLElement} */ (el.querySelector('.sb-scroll'));

  const saved = slot('sidebar').get() || {};
  if (Array.isArray(saved.expanded)) expanded = new Set(saved.expanded.filter((p) => typeof p === 'string' && p));
  if (saved.root === false) rootOpen = false;

  // A pin is a file or a folder, there or not, as the tree says; until the tree is read, it
  // is not called missing on a guess (`undefined`).
  pins.setLookup((path) => {
    if (!tree) return undefined;
    const n = findNode(path);
    if (n) return n;
    const parent = findNode(dirName(path));
    if (!parent || !parent.children) return undefined;
    if (baseName(path).startsWith('.') && !showHidden()) return undefined;
    return null;
  });
  pins.on(() => { if (!quietPins) render(); });
  onClipboard(() => render());

  // A click and Enter do the same thing (activateRow); the clicked row also becomes the tab
  // stop, so Tab back into the sidebar returns to where the mouse left off (D2). A click on a
  // folder's chevron folds it and goes nowhere. Ctrl+click toggles a tree row in the
  // selection and Shift+click selects the run from the anchor to it (C17).
  scrollEl.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest('.sb-row');
    if (!(row instanceof HTMLElement)) return;
    // Enter and Space on a focused button also synthesise a click (detail 0); the keydown
    // handler has already acted on those, and acting twice would toggle a folder shut again.
    if (e.detail === 0) return;
    if (e.target.closest('.tw') && row.getAttribute('aria-expanded') !== null) {
      focusRow(row);
      toggleDir(row);
      return;
    }
    // A pinned row is not selectable, so Ctrl+click is free on it: open in a tab of its own.
    if (row.dataset.pin === '1' && (e.ctrlKey || e.metaKey) && openRowAside(row)) return;
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
    // The clicked row takes the keyboard (H21): a click does not focus a button on macOS, and
    // every tree command asks the focused row what it is about.
    focusRow(row);
    activateRow(row);
  });

  // A double click on a folder also folds it, as a file manager's tree does.
  scrollEl.addEventListener('dblclick', (e) => {
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest('.sb-row.dir');
    if (!row || e.target.closest('.tw') || row.getAttribute('aria-expanded') === null) return;
    toggleDir(row);
  });

  // The middle button opens a row in a tab of its own, in the tree and in the pins alike.
  scrollEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest('.sb-row');
    if (!row) return;
    e.preventDefault();
    openRowAside(row);
  });
  // Firefox and Chromium both start an autoscroll on a middle press unless it is refused.
  scrollEl.addEventListener('mousedown', (e) => { if (e.button === 1 && e.target instanceof Element && e.target.closest('.sb-row')) e.preventDefault(); });

  // A name the column cut gets the whole path on hover, and a name that fits gets nothing
  // (R21). Measured on the row under the pointer, one row at a time.
  scrollEl.addEventListener('mouseover', (e) => {
    const name = e.target instanceof Element && e.target.closest('.sb-row > .grow');
    if (!(name instanceof HTMLElement)) return;
    const cut = name.scrollWidth > name.clientWidth;
    if (cut) name.title = name.parentElement?.dataset.path || name.textContent || '';
    else name.removeAttribute('title');
  });

  scrollEl.addEventListener('keydown', onTreeKey);
  // However a row got the keyboard (a click, an arrow, a dialog handing focus back), it is the
  // tab stop and the row a rename or move follows to its new name.
  scrollEl.addEventListener('focusin', (e) => {
    const row = e.target instanceof Element && e.target.closest('.sb-row');
    if (row && rowKey(row) !== roving) setRoving(row);
  });

  // Right-click inside a selection of several opens the menu for all of them; outside it,
  // the selection is dropped first.
  scrollEl.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest('.sb-row:not(.sb-view)');
    e.preventDefault();
    if (!row) { contextMenu(e.clientX, e.clientY, emptyMenu()); return; }
    // The row under the pointer is the row the menu is about, and the row the keyboard comes
    // back to when the menu closes (H21).
    focusRow(row);
    contextMenu(e.clientX, e.clientY, menuItemsForRow(row));
  });

  bindDnd(scrollEl);

  // What "here" is for the file commands run from the palette or a chord (shell/fileops.js):
  // the focused row, else the route on screen; and the selection that row is part of.
  setContext({
    target: () => treeTarget(),
    batch: () => { const t = treeTarget(); return t && t.path ? batchFor(t) || [t] : []; },
  });
  bus.on('paths:moving', onMoving);
  bus.on('paths:moved', onMoved);
  bus.on('paths:trashed', onTrashed);
  bus.on('paths:created', (d) => onArrived((d && d.paths) || []));
  bus.on('paths:copied', (d) => onArrived(((d && d.pairs) || []).map((p) => p && p.to).filter(Boolean)));
  bus.on('paths:restored', (d) => onArrived(((d && d.items) || []).map((it) => it && it.path).filter(Boolean)));
  bus.on('tree:reveal', onReveal);
  bus.on('folders:sort', () => render());

  const askLater = debounce(() => void askAboutRenames(), 600);
  bus.on('fs', (payload) => { onFsRenames(payload); askLater(); onFsTree(payload); });
  bus.on('route', () => {
    const cur = currentOf();
    if (cur.page) expandAncestors(cur.page);
    else if (cur.folder) expandAncestors(cur.folder);
    render();
    scrollToCurrent();
  });
  bus.on('booted', () => render());
  bus.on('focus', () => { render(); scrollToCurrent(); });
  // Show hidden items flipping reads the tree again (the host lists hidden entries only when
  // asked); `hideMdExt` and the rest only redraw.
  bus.on('settings', () => {
    if (readHidden !== null && showHidden() !== readHidden) void refreshTree();
    else render();
  });

  commands.register({
    id: 'app.sidebar', title: 'Toggle sidebar', group: 'app',
    // What is on screen, flipped — layout.js owns the window's own auto-hide.
    run: () => toggleSidebar(),
  });
  commands.register({
    id: 'app.focus-sidebar', title: 'Focus sidebar', group: 'app', hint: 'Esc returns to the page',
    run: () => focusTree(),
  });
  commands.register({
    id: 'view.toggle-hidden', title: 'Show hidden items', group: 'view', icon: ic('eye', 'view'),
    hint: 'dotfiles and files the system hides',
    run: () => toggleHidden(),
  });
  registerTreeCommands();
  buildHead();

  void refreshTree();
}
