// Part of the sidebar (./sidebar.ts). The tree: its data, which folders are open, how its rows are
// drawn, and the keys that walk it.

import { ose } from '../core/core.ts';
import { esc, focusOrigin, hasIcon, icon, overlayCount, retargetFocusOrigin } from '../ui/index.ts';
import { byViewOrder } from './order.ts';
import {
  baseName, clean, dirName, extOf, segments, titleOf, vaultName as nameOfVault,
} from './paths.ts';
import { clipboard } from './fileops.ts';
import { DEFAULT_SORT, iconName, sortEntries, visibleEntries } from './folder-model.ts';
import { setSidebarOpen, sidebarVisible } from './layout.ts';
import {
  currentRoute, exitFocus, getFocus, ic, isUnderFocus, showHidden, slot, state,
} from './sidebar-state.ts';
import type { TreeNode } from './sidebar-state.ts';
import { pruneSelection } from './sidebar-select.ts';
import { loadChildren, movedKey } from './sidebar-load.ts';

/* ------------------------------------------------------------------ tree data */

export function findNode(path): TreeNode | null {
  if (!state.tree) return null;
  let node: TreeNode | undefined = state.tree;
  for (const s of segments(path)) {
    if (!node || !node.children) return null;
    node = node.children.find((c) => c.name === s);
  }
  return node || null;
}

/** A folder's children as they are drawn: hidden ones only when asked for, in its sort. */
/**
 * The scratchpad: a folder named `scratchpad` at the top of the vault, for throwaway notes and
 * ideas. It has its own section under the vault, drawn flat (its files as rows, its folders
 * unfolding in place), and the empty-space menu creates there. No such folder, no section.
 */
export function scratchNode(): TreeNode | null {
  const kids = (state.tree && state.tree.children) || [];
  return kids.find((c) => c && c.kind === 'dir' && String(c.name).toLowerCase() === 'scratchpad') || null;
}

function renderScratch(frag, node, cur, cuts) {
  heading(frag, 'Scratchpad', 'scratch');
  const box = treeBox(frag, 'Scratchpad', true);
  box.classList.add('sb-scratch');
  box.dataset.section = 'scratch';
  if (!node.children) { box.appendChild(emptyLine('Reading…', 0)); void loadChildren(node.path); return; }
  const kids = kidsOf(node);
  if (!kids.length) box.appendChild(emptyLine('Nothing here', 0));
  for (const c of kids) renderNode(c, 0, box, cur, cuts);
}

function kidsOf(node) {
  const list = visibleEntries((node && node.children) || [], { showHidden: showHidden() });
  return sortEntries(list, DEFAULT_SORT);
}

const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const isMarkdown = (p) => MD_EXTS.has(extOf(p));

/** Every file under `node`, depth first in drawing order, never under a link or into a hidden entry. */
function walkFiles(keep: (c: TreeNode) => boolean): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode | null) => {
    if (!n || !n.children) return;
    for (const c of sortEntries(n.children.filter((x) => !x.hidden), DEFAULT_SORT)) {
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

/** The glyph of a row: `iconName` (folder-model.ts), so a file looks the same wherever it is drawn. */
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
interface RowSpec {
  cls?: string;
  depth?: number;
  glyphHtml?: string;
  chevron?: boolean | null;
  text: string;
  tail?: string;
  hint?: string;
  badge?: string;
  title?: string;
  data?: Record<string, string>;
}

function rowEl({ cls = '', depth = 0, glyphHtml = '', chevron = null, text, tail = '', hint = '', badge = '', title = '', data = {} }: RowSpec) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row sb-row ' + cls;
  const path = data.path;
  const inTree = path !== undefined && data.root !== '1';
  if (inTree && state.selected.has(path)) b.classList.add('selected');
  b.style.setProperty('--d', String(depth));
  for (const k of Object.keys(data)) b.dataset[k] = data[k];
  if (inTree) b.draggable = true; // moves within the vault; see drag and drop
  // A tree to a screen reader, not a list of unrelated buttons (S39): the level is 1-based,
  // `aria-selected` is on every selectable row so the reader can say "not selected" too, and
  // only a folder that unfolds claims to expand.
  b.setAttribute('role', 'treeitem');
  b.setAttribute('aria-level', String(depth + 1));
  if (inTree) b.setAttribute('aria-selected', String(state.selected.has(path)));
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
/**
 * In focus mode the Vault heading is replaced by this one: same row, same baseline, same padding
 * as every other heading, reading `Focus <folder>` with the way out on the right.
 */
function focusLabel(focus) {
  const d = document.createElement('div');
  d.className = 'section-label sb-focus-label';
  d.dataset.section = 'vault';
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

/** A section's heading: "Views", "Vault", "Scratchpad"; `section` says which, for a drop. */
function heading(frag, text, section) {
  const d = document.createElement('div');
  d.className = 'section-label';
  d.dataset.section = section;
  d.textContent = text;
  frag.appendChild(d);
}

/** The views hidden from the sidebar (a view row's Hide view), by name, kept with the sidebar's state. */
export const hiddenViews = (): Set<string> => new Set((slot('sidebar').get() || {}).hiddenViews || []);

/** Hide a view's row, or show it again. It still opens from the palette either way. */
export function setViewHidden(name: string, hide: boolean) {
  const s = slot('sidebar');
  const next = hiddenViews();
  if (hide) next.add(name); else next.delete(name);
  s.set({ ...(s.get() || {}), hiddenViews: [...next] });
  render();
}

/** Every view of the planner section, hidden ones included, in their own order (order.ts). */
export const allPlannerViews = () => ose.views.list().filter((v) => v && v.section === 'planner').sort(byViewOrder);

/** The views the sidebar draws: the planner's, less the hidden ones. */
const plannerViews = () => { const off = hiddenViews(); return allPlannerViews().filter((v) => !off.has(v.name)); };

/* ------------------------------------------------------------------ pins */

/** A pinned file or folder: its vault path and what it is, kept with the sidebar's state. */
export interface Pin { path: string; kind: 'file' | 'dir'; }

/** The pins, in the order they were pinned. */
export function pins(): Pin[] {
  const raw = (slot('sidebar').get() || {}).pins;
  return Array.isArray(raw)
    ? raw.filter((p) => p && typeof p.path === 'string' && p.path).map((p) => ({ path: clean(p.path), kind: p.kind === 'dir' ? 'dir' : 'file' }))
    : [];
}

export const isPinned = (path: string) => pins().some((p) => p.path === clean(path));

function savePins(next: Pin[]) {
  const s = slot('sidebar');
  s.set({ ...(s.get() || {}), pins: next });
  render();
}

/** Pin these rows (a new pin goes to the end), or unpin them. */
export function setPinned(targets: Pin[], on: boolean) {
  const want = new Set(targets.map((t) => clean(t.path)));
  const kept = pins().filter((p) => !want.has(p.path));
  savePins(on ? [...kept, ...targets.map((t) => ({ path: clean(t.path), kind: t.kind === 'dir' ? 'dir' as const : 'file' as const }))] : kept);
}

/** A move or a rename: every pin at or under `from` follows it to `to`. */
export function followPins(moves: Array<{ from: string; to: string; }>) {
  let changed = false;
  const next = pins().map((p) => {
    for (const m of moves) {
      if (p.path === m.from || p.path.startsWith(m.from + '/')) { changed = true; return { ...p, path: m.to + p.path.slice(m.from.length) }; }
    }
    return p;
  });
  if (changed) savePins(next);
}

/**
 * Where a pin stands in the tree as it has been read: its node, or `missing` when the folder it
 * sits in has been read and it is not there (trashed, or moved outside the app). A pin in a
 * folder not read yet is neither, and is drawn from what it was pinned as.
 */
function pinNode(path: string): { node: TreeNode | null; missing: boolean; } {
  let node: TreeNode | null = state.tree;
  for (const s of segments(path)) {
    if (!node || !node.children) return { node: null, missing: false };
    node = node.children.find((c) => c.name === s) || null;
    if (!node) return { node: null, missing: true };
  }
  return { node, missing: false };
}

/**
 * Pinned: a shortcut row per pin, under Views. A file opens; a folder is not a page, so it is
 * shown in the Vault tree (the router's `folder` route). Two pins with one name carry their
 * folder on the right. A pin whose file is gone stays, greyed, until it is unpinned: a file
 * that comes back (an undo, a restore) is pinned again.
 */
function renderPins(frag, cur) {
  const list = pins();
  if (!list.length) return;
  heading(frag, 'Pinned', 'pins');
  const box = treeBox(frag, 'Pinned');
  box.classList.add('sb-pins');
  box.dataset.section = 'pins';
  const names: string[] = list.map((p) => (p.kind === 'dir' ? baseName(p.path) : titleOf(p.path)));
  list.forEach((p, i) => {
    const { node, missing } = pinNode(p.path);
    const name = names[i] ?? p.path;
    const twin = names.indexOf(name) !== i || names.lastIndexOf(name) !== i;
    const current = p.kind === 'dir' ? cur.folder === p.path : cur.page === p.path;
    box.appendChild(rowEl({
      cls: 'sb-pin ' + p.kind + (missing ? ' missing' : '') + (current ? ' current' : ''),
      depth: 0, glyphHtml: p.kind === 'dir' ? icon('folder') : glyphFor(node || { name: baseName(p.path), path: p.path, kind: 'file' }),
      text: name || p.path, tail: twin ? baseName(dirName(p.path)) || vaultName() : '',
      title: missing ? `${p.path}: no longer there` : p.path,
      data: { pin: p.path, kind: p.kind },
    }));
  });
}

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
    // A link is listed, never walked: the tree does not unfold one.
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

function renderTree(scrollEl: HTMLElement) {
  const frag = document.createDocumentFragment();
  const cur = currentOf();
  const focus = getFocus();
  const cuts = cutPaths();

  // Views: the app's own pages over the vault's files (Journal, Month, …), one row each.
  const views = focus ? [] : plannerViews();
  if (views.length) {
    heading(frag, 'Views', 'views');
    const vbox = treeBox(frag, 'Views');
    vbox.classList.add('sb-views');
    vbox.dataset.section = 'views';
    for (const v of views) {
      vbox.appendChild(rowEl({
        cls: 'sb-view' + (cur.view === v.name ? ' current' : ''),
        depth: 0, glyphHtml: icon(v.icon && hasIcon(v.icon) ? v.icon : 'calendar'), text: v.title || v.name,
        data: { view: v.name },
      }));
    }
  }

  if (!focus) renderPins(frag, cur);

  // Vault: what is in the vault folder, directly; the folder itself has no row. In focus mode
  // the heading *is* the indicator: `Focus  <folder>` with the way out on the right, in place
  // of "Vault", so focus mode costs no extra line.
  if (focus) frag.appendChild(focusLabel(focus));
  else heading(frag, 'Vault', 'vault');
  const box = treeBox(frag, 'Vault', true);
  box.classList.add('sb-files');
  box.dataset.section = 'vault';
  if (!state.tree) {
    box.appendChild(emptyLine('Reading the vault…', 0));
  } else if (focus) {
    const root = findNode(focus);
    if (!root || root.kind !== 'dir') box.appendChild(emptyLine('The focus folder is gone', 0));
    else if (!root.children) { box.appendChild(emptyLine('Reading…', 0)); void loadChildren(root.path); }
    else for (const c of kidsOf(root)) renderNode(c, 0, box, cur, cuts);
  } else {
    // The scratchpad has its own section below: it is never drawn twice.
    const scratch = scratchNode();
    const kids = kidsOf(state.tree).filter((c) => c !== scratch);
    if (!kids.length) box.appendChild(emptyLine('Nothing here yet', 0));
    for (const c of kids) renderNode(c, 0, box, cur, cuts);
    if (scratch) renderScratch(frag, scratch, cur, cuts);
  }

  // The rebuild would drop keyboard focus on the floor (B4): note which row had it, rebuild,
  // put it back. A row that is gone (trashed) hands focus to whatever now sits at its index,
  // so Delete on a run of files keeps working. `focusOrigin` rather than activeElement: while
  // a confirm or rename dialog is up, the row is where focus will return to, and the dialog
  // must be told the row's replacement or it would hand focus back to a detached node.
  const origin = focusOrigin();
  const had = origin && origin !== scrollEl && scrollEl.contains(origin) ? origin : null;
  const hadKey = had ? rowKey(had) : null;
  const hadIndex = had ? (treeRows() as Element[]).indexOf(had) : -1;

  const keep = scrollEl.scrollTop;
  scrollEl.textContent = '';
  scrollEl.appendChild(frag);
  scrollEl.scrollTop = keep;
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
  renderTree(state.scrollEl);
}

export function rowFor(path): HTMLElement | null {
  return state.scrollEl ? state.scrollEl.querySelector<HTMLElement>(`.sb-row[data-path="${CSS.escape(path)}"]`) : null;
}

/* ------------------------------------------------------------ keyboard tree */

// Everything a key can land on, top to bottom: the tree, Trash. It is read out of the
// DOM, so it is the drawing order by construction and the Up/Down walk can never disagree with
// what is on screen. Folded folders draw no children, so this is exactly the visible rows.
export function treeRows(): HTMLElement[] {
  return state.scrollEl ? [...state.scrollEl.querySelectorAll<HTMLElement>('.sb-row')] : [];
}

/** A stable identity for a row across renders: the path or the view. */
export function rowKey(row) {
  if (!row || !row.dataset) return null;
  if (row.dataset.view) return 'view:' + row.dataset.view;
  if (row.dataset.pin) return 'pin:' + row.dataset.pin;
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
