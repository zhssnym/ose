// Part of the sidebar (./sidebar.js). Drag and drop, the tree commands and their menu, and the
// tool strip.

import { ose } from 'ose:core';
import { contextMenu, copyText, focusOrigin, icon, toast } from 'ose:ui';
import { baseName, clean, dirName } from './paths.js';
import {
  DRAG_TYPE, dragged, hasOsFiles, importDropped, isInternal, setDragged, takeDropped,
} from './drag.js';
import { openSearch } from './search.js';
import { openInNewTab } from './tabs.js';
import {
  canMoveInto, clipboard, copy, cut, duplicatePath, movePaths, newFile, newFolder, paste,
  renamePath, trashPaths,
} from './fileops.js';
import { nextSortSpec, SORT_KEYS, visibleEntries } from './folder-model.js';
import { setSortSpec, sortSpec } from './folder.js';
import {
  commands, currentRoute, getFocus, ic, messageOf, relativeHref, setFocus, shortcutFor,
  showHidden, state,
} from './sidebar-state.js';
import { findNode, persistExpanded, render, rowFor, vaultName } from './sidebar-tree.js';
import {
  batchFor, clearSelection, folderOf, isSelectable, openWith, targetOf,
} from './sidebar-select.js';

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

export function bindDnd(host) {
  host.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.sb-row[data-path]');
    if (!row || row.dataset.root === '1') { e.preventDefault(); return; }
    // A row inside a selection of several drags the whole selection; any other row, itself.
    const batch = batchFor({ path: row.dataset.path, kind: row.dataset.kind });
    const paths = batch ? batch.map((it) => it.path) : [row.dataset.path];
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
export function treeTarget() {
  const o = focusOrigin();
  const row = o && state.scrollEl && state.scrollEl.contains(o) && o.closest ? o.closest('.sb-row[data-path]') : null;
  // A tree row carries its path and its kind, `file` or `dir`.
  if (row instanceof HTMLElement) return /** @type {import('./fileops.js').Target} */ ({ path: row.dataset.path, kind: row.dataset.kind });
  const r = currentRoute();
  if (r && r.type === 'page') return { path: r.path, kind: 'file' };
  if (r && r.type === 'folder') return { path: clean(r.path || ''), kind: 'dir' };
  return null;
}


/** Every folder in the tree, or none of them (N26). One persist, one render. */
function setAllExpanded(open) {
  if (!open) { state.expanded = new Set(); }
  else {
    const all = new Set();
    const walk = (n) => {
      for (const c of visibleEntries(n.children || [], { showHidden: showHidden() })) {
        if (c.kind !== 'dir' || c.link) continue;
        all.add(c.path);
        walk(c);
      }
    };
    if (state.tree) walk(state.tree);
    state.expanded = all;
    state.rootOpen = true;
  }
  persistExpanded();
  render();
}

/** Show hidden items (H16): a machine setting, read by the tree, the folder view and search. */
export function toggleHidden() {
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
  const row = at || rowFor(path) || state.scrollEl;
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

export function registerTreeCommands() {
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
  'app.focus-enter', { id: 'app.focus-exit', applies: (t) => !!t.path && t.kind === 'dir' && getFocus() === t.path },
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
const MULTI_MENU = ['file.cut', 'file.copy', 'file.move', null, 'file.trash'];

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
export function menuItemsForRow(row) {
  // Both callers hand a row with a path: openMenuAt checks it, and the right-click leaves out
  // the view rows, the only ones without.
  const target = /** @type {{path: string, kind: string}} */ (targetOf(row));
  const batch = isSelectable(row) ? batchFor(target) : null;
  if (!batch && isSelectable(row)) clearSelection();
  return batch ? multiMenu(batch) : menuFor(target.path, target.kind);
}

/** The keyboard's context menu (S12): under the row, aligned with where its name starts. */
export function openMenuAt(row) {
  if (!row || row.dataset.path === undefined) return;
  const r = row.getBoundingClientRect();
  contextMenu(Math.round(r.left + 24), Math.round(r.bottom), menuItemsForRow(row));
}

/** Right-click on the empty space under the tree: the vault root, or the focus folder. */
export function emptyMenu() {
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

export function buildHead() {
  state.headEl.innerHTML = '';
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
    state.headEl.appendChild(b);
  }
  paintHead();
}

export function paintHead() {
  if (!state.headEl) return;
  const on = showHidden();
  const b = state.headEl.querySelector('[data-cmd="view.toggle-hidden"]');
  if (b) {
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
    b.innerHTML = icon(on ? ic('eye', 'dot') : ic('eyeOff', 'dot'));
    b.title = on ? 'Hide hidden items' : 'Show hidden items';
  }
}
