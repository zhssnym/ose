// Part of the sidebar (./sidebar.js). The tree: its data, which folders are open, how its rows are
// drawn, and the keys that walk it.

import { ose } from 'ose:core';
import { esc, focusOrigin, icon, overlayCount, retargetFocusOrigin } from 'ose:ui';
import {
  baseName, clean, dirName, extOf, segments, titleOf, vaultName as nameOfVault,
} from './paths.js';
import { clipboard } from './fileops.js';
import { iconName, sortEntries, visibleEntries } from './folder-model.js';
import { sortSpec } from './folder.js';
import { setSidebarOpen, sidebarVisible } from './layout.js';
import {
  currentRoute, exitFocus, getFocus, ic, isUnderFocus, showHidden, slot, state,
} from './sidebar-state.js';
import { pruneSelection } from './sidebar-select.js';
import { loadChildren, movedKey } from './sidebar-load.js';
import { paintHead } from './sidebar-commands.js';

/* ------------------------------------------------------------------ tree data */

export function findNode(path) {
  if (!state.tree) return null;
  let node = state.tree;
  for (const s of segments(path)) {
    if (!node || !node.children) return null;
    node = node.children.find((c) => c.name === s);
  }
  return node || null;
}

/** A folder's children as they are drawn: hidden ones only when asked for, in its sort. */
function kidsOf(node) {
  const list = visibleEntries((node && node.children) || [], { showHidden: showHidden() });
  return sortEntries(list, sortSpec());
}

const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const isMarkdown = (p) => MD_EXTS.has(extOf(p));

/** Every file under `node`, depth first in drawing order, never under a link or into a hidden entry. */
function walkFiles(keep) {
  const out = [];
  const walk = (n) => {
    if (!n || !n.children) return;
    for (const c of sortEntries(n.children.filter((x) => !x.hidden), sortSpec())) {
      if (c.kind === 'dir') { if (!c.link) walk(c); } else if (keep(c)) out.push(c.path);
    }
  };
  walk(state.tree);
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

export function persistExpanded() {
  const s = slot('sidebar');
  s.set({ ...(s.get() || {}), expanded: [...state.expanded], root: state.rootOpen });
}

export const isOpen = (path) => (path === '' ? state.rootOpen : state.expanded.has(path));

export function expandAncestors(path) {
  const segs = segments(dirName(path));
  let acc = '';
  for (const s of segs) { acc = acc ? acc + '/' + s : s; state.expanded.add(acc); }
  if (!getFocus()) state.rootOpen = true;
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
  const inTree = data.path !== undefined && data.root !== '1';
  if (inTree && state.selected.has(data.path)) b.classList.add('selected');
  b.style.setProperty('--d', String(depth));
  for (const k of Object.keys(data)) b.dataset[k] = data[k];
  if (inTree) b.draggable = true; // moves within the vault; see drag and drop
  // A tree to a screen reader, not a list of unrelated buttons (S39): the level is 1-based,
  // `aria-selected` is on every selectable row so the reader can say "not selected" too, and
  // only a folder that unfolds claims to expand.
  b.setAttribute('role', 'treeitem');
  b.setAttribute('aria-level', String(depth + 1));
  if (inTree) b.setAttribute('aria-selected', String(state.selected.has(data.path)));
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

export function currentOf() {
  const r = currentRoute();
  return {
    page: r && r.type === 'page' ? clean(r.path) : null,
    folder: r && r.type === 'folder' ? clean(r.path || '') : null,
    view: r && r.type === 'view' ? r.name : null,
  };
}

/** The root row's name: the tree's own answer, else the core's. */
export function vaultName() {
  return (state.tree && state.tree.name) || nameOfVault();
}

function renderTree() {
  const frag = document.createDocumentFragment();
  const cur = currentOf();
  const focus = getFocus();
  const cuts = cutPaths();

  if (focus) frag.appendChild(focusLabel(focus));
  const box = treeBox(frag, focus ? `Focus: ${baseName(focus)}` : 'Files', true);
  box.classList.add('sb-files');
  if (!state.tree) {
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
      depth: 0, chevron: state.rootOpen, glyphHtml: icon('folder'), text: vaultName(),
      title: (ose.vault && ose.vault.root) || '',
      data: { path: '', kind: 'dir', root: '1' },
    }));
    if (state.rootOpen) {
      const kids = kidsOf(state.tree);
      if (!kids.length) box.appendChild(emptyLine('Nothing here yet', 1));
      for (const c of kids) renderNode(c, 1, box, cur, cuts);
    }
  }

  // The rebuild would drop keyboard focus on the floor (B4): note which row had it, rebuild,
  // put it back. A row that is gone (trashed) hands focus to whatever now sits at its index,
  // so Delete on a run of files keeps working. `focusOrigin` rather than activeElement: while
  // a confirm or rename dialog is up, the row is where focus will return to, and the dialog
  // must be told the row's replacement or it would hand focus back to a detached node.
  const origin = focusOrigin();
  const had = origin && origin !== state.scrollEl && state.scrollEl.contains(origin) ? origin : null;
  const hadKey = had ? rowKey(had) : null;
  const hadIndex = had ? treeRows().indexOf(had) : -1;

  const keep = state.scrollEl.scrollTop;
  state.scrollEl.textContent = '';
  state.scrollEl.appendChild(frag);
  state.scrollEl.scrollTop = keep;
  // A selected row that is no longer drawn (its folder collapsed, the file gone) is no longer
  // selected: a batch must never act on something the user cannot see.
  pruneSelection();

  const wanted = rowByKey(state.focusAfterRender);
  if (wanted) state.focusAfterRender = null;
  if (wanted) state.roving = rowKey(wanted);
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

export function render() {
  if (!state.scrollEl) return;
  renderTree();
  paintHead();
}

export function rowFor(path) {
  return state.scrollEl ? state.scrollEl.querySelector(`.sb-row[data-path="${CSS.escape(path)}"]`) : null;
}

/* ------------------------------------------------------------ keyboard tree */

// Everything a key can land on, top to bottom: the tree, Trash. It is read out of the
// DOM, so it is the drawing order by construction and the Up/Down walk can never disagree with
// what is on screen. Folded folders draw no children, so this is exactly the visible rows.
export function treeRows() {
  return state.scrollEl ? [...state.scrollEl.querySelectorAll('.sb-row')] : [];
}

/** A stable identity for a row across renders: the path or the view. */
export function rowKey(row) {
  if (!row || !row.dataset) return null;
  if (row.dataset.view) return 'view:' + row.dataset.view;
  if (row.dataset.path !== undefined) return 'path:' + row.dataset.path;
  return null;
}

export function rowByKey(key) {
  if (!key) return null;
  return treeRows().find((r) => rowKey(r) === key) || null;
}

/** The row Tab lands on: the remembered one if it still exists, else the current route's, else the first. */
export function rovingRow() {
  const list = treeRows();
  if (!list.length) return null;
  const cur = currentOf();
  return rowByKey(state.roving)
    || (cur.page && rowFor(cur.page))
    || (cur.folder !== null && rowFor(cur.folder))
    || (cur.view && rowByKey('view:' + cur.view))
    || list[0];
}

export function setRoving(row) {
  state.roving = rowKey(row);
  for (const r of treeRows()) r.tabIndex = r === row ? 0 : -1;
}

function applyRoving() { setRoving(rovingRow()); }

export function focusRow(row) {
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
