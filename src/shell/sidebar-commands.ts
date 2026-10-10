// Part of the sidebar (./sidebar.ts). Drag and drop, the tree commands and their menu, and the
// tool strip.

import { ose } from '../core/core.ts';
import { contextMenu, copyText, focusOrigin, icon, toast } from '../ui/index.ts';
import { baseName, clean, dirName } from './paths.ts';
import { DRAG_TYPE, dragged, isInternal, setDragged } from './drag.ts';
import { openSearch } from './search.ts';
import { openInNewTab } from './tabs.ts';
import {
  canMoveInto, clipboard, copy, cut, duplicatePath, movePaths, newFile, newFolder, paste,
  renamePath, trashPaths,
} from './fileops.ts';
import type { Target } from './fileops.ts';
import { visibleEntries } from './folder-model.ts';
import {
  commands, currentRoute, getFocus, ic, messageOf, relativeHref, setFocus, shortcutFor,
  showHidden, state,
} from './sidebar-state.ts';
import type { TreeNode } from './sidebar-state.ts';
import {
  allPlannerViews, canMoveSection, findNode, hiddenViews, isPinned, moveSection, persistExpanded, render,
  scratchNode, SECTION_TITLES, setPinned, setViewHidden, vaultName,
} from './sidebar-tree.ts';
import {
  batchFor, clearSelection, folderOf, isSelectable, openWith, revealIn, targetOf,
} from './sidebar-select.ts';

/* ------------------------------------------------------------- drag and drop */

// Internal drags carry the vault paths (a JSON list: a selection drags together, C17) in a
// private type (drag.ts `DRAG_TYPE`); `dragPaths` mirrors it because dataTransfer.getData is
// unreadable during dragover, and the self/descendant guard has to run there, for every item,
// to decide whether the row may light up at all. A drop from Explorer or Finder is not taken:
// the window's guard (layout.ts) ignores it.

let dragPaths: string[] | null = null;
// Where the drop in progress would land, and the dashed box drawn around all of it.
let dropDir: string | null = null;
let ghost: HTMLElement | null = null;

/** The list an internal payload holds. A bare path (an older build's payload) is a list of one. */
function parseDrag(data) {
  if (!data) return null;
  try { const v = JSON.parse(data); if (Array.isArray(v)) return v.map(clean).filter(Boolean); } catch { /* not JSON: a bare path */ }
  return [clean(data)].filter(Boolean);
}

type DropTarget = { dir: string, region: { from: Element, to: Element } };

const depthOf = (el: Element) => Number((el as HTMLElement).style.getPropertyValue('--d')) || 0;

/** A section's heading and its box, top to bottom: the region a drop on the section fills. */
function sectionRegion(name: string): DropTarget['region'] | null {
  const scroll = state.scrollEl;
  const head = scroll && scroll.querySelector(`.section-label[data-section="${name}"]`);
  const box = scroll && scroll.querySelector(`.sb-group[data-section="${name}"]`);
  return box ? { from: head || box, to: box } : null;
}

/** A folder's row and every row drawn under it (its open contents), as one region. */
function folderRegion(row: Element): DropTarget['region'] {
  let last: Element = row;
  const d = depthOf(row);
  for (let n = row.nextElementSibling; n && depthOf(n) > d; n = n.nextElementSibling) last = n;
  return { from: row, to: last };
}

/** The top of a section: the vault (or the focus folder) for Vault, the scratchpad folder for Scratchpad. */
function sectionDir(name: string): string | null {
  if (name === 'vault') return getFocus() || '';
  if (name === 'scratch') { const s = scratchNode(); return s ? s.path : null; }
  return null;
}

/** The region that stands for folder `dir`: its section when it is one's top, else its row's block. */
function regionOfDir(dir: string, section: string): DropTarget['region'] | null {
  if (sectionDir(section) === dir) return sectionRegion(section);
  const row = state.scrollEl && state.scrollEl.querySelector(`.sb-row.dir[data-path="${CSS.escape(dir)}"]`);
  return row ? folderRegion(row) : sectionRegion(section);
}

/**
 * Where a drop at `node` lands. A folder row: into it. A file row: beside it, in its folder. A
 * section's heading or its empty space: its top (the vault, the focus folder or the
 * scratchpad). The empty space under the last section belongs to that section. Views take nothing.
 */
function dropTargetOf(node): DropTarget | null {
  if (!node || !node.closest || !state.scrollEl) return null;
  const sectionEl = node.closest('[data-section]') || (node === state.scrollEl ? [...state.scrollEl.querySelectorAll('.sb-group[data-section]')].pop() : null);
  const section = sectionEl ? sectionEl.dataset.section : null;
  if (!section || section === 'views') return null;
  const row = node.closest('.sb-row[data-path]');
  if (row && row.classList.contains('dir') && !row.classList.contains('missing')) {
    return { dir: row.dataset.path, region: folderRegion(row) };
  }
  const dir = row ? dirName(row.dataset.path) : sectionDir(section);
  if (dir === null) return null;
  const region = regionOfDir(dir, section);
  return region ? { dir, region } : null;
}

// Into itself, under itself, or where it already is: no. The same rule Move to… uses.
const canDropInto = (from, dir) => canMoveInto(from, dir);

/** Draw the dashed box over `t`'s region, or take it away. */
function showGhost(t: DropTarget | null) {
  const scroll = state.scrollEl;
  dropDir = t ? t.dir : null;
  if (!t || !scroll) { if (ghost) ghost.hidden = true; return; }
  if (!ghost || ghost.parentElement !== scroll) {
    ghost = document.createElement('div');
    ghost.className = 'sb-drop-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    scroll.appendChild(ghost);
  }
  const base = scroll.getBoundingClientRect();
  const a = t.region.from.getBoundingClientRect();
  const b = t.region.to.getBoundingClientRect();
  ghost.style.top = `${a.top - base.top + scroll.scrollTop}px`;
  ghost.style.height = `${b.bottom - a.top}px`;
  ghost.hidden = false;
}

function endDrag() { dragPaths = null; setDragged(null); showGhost(null); }

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
    // A drag `dragPaths` missed is internal too when it carries drag.ts's paths.
    const moving = dragPaths || dragged();
    if (!moving && !isInternal(e.dataTransfer)) { showGhost(null); return; }
    const t = dropTargetOf(e.target);
    // Every dragged item has to be able to land there, or nothing is outlined.
    if (!t || !(moving || []).every((p) => canDropInto(p, t.dir))) {
      showGhost(null);
      e.preventDefault();                       // still ours: the web view never navigates to it
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (t.dir !== dropDir) showGhost(t);
  });

  host.addEventListener('dragleave', (e) => {
    // Out of the sidebar altogether: nothing would land.
    if (!(e.relatedTarget instanceof Node) || !host.contains(e.relatedTarget)) showGhost(null);
  });

  host.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = dropTargetOf(e.target);
    const from = dragPaths || dragged() || parseDrag(e.dataTransfer ? e.dataTransfer.getData(DRAG_TYPE) : '');
    endDrag();
    if (!t || !(from && from.length) || !from.every((p) => canDropInto(p, t.dir))) return;
    void movePaths(from.map((p) => ({ path: p, kind: findNode(p)?.kind === 'dir' ? 'dir' : 'file' })), t.dir);
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
 */
export function treeTarget(): Target | null {
  const o = focusOrigin();
  const row = o && state.scrollEl && state.scrollEl.contains(o) && o.closest ? o.closest('.sb-row[data-path]') : null;
  // A tree row carries its path and its kind, `file` or `dir`.
  if (row instanceof HTMLElement) return { path: row.dataset.path, kind: row.dataset.kind } as Target;
  // A pinned row stands for its file or folder, so Unpin from the palette means that one.
  const pin = o && state.scrollEl && state.scrollEl.contains(o) && o.closest ? o.closest('.sb-row[data-pin]:not(.missing)') : null;
  if (pin instanceof HTMLElement) return { path: pin.dataset.pin, kind: pin.dataset.kind } as Target;
  const r = currentRoute();
  if (r && r.type === 'page') return { path: r.path, kind: 'file' };
  if (r && r.type === 'folder') return { path: clean(r.path || ''), kind: 'dir' };
  return null;
}


/** Every folder in the tree, or none of them (N26). One persist, one render. */
function setAllExpanded(open) {
  if (!open) { state.expanded = new Set(); }
  else {
    const all = new Set<string>();
    const walk = (n: TreeNode) => {
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

/** Show hidden items (H16): a machine setting, read by the tree and search. */
export function toggleHidden() {
  const next = !showHidden();
  Promise.resolve(ose.settings.set({ showHidden: next })).catch((e) => toast(String(e.message || e), 'err', 0));
}

// One table for the palette and the context menu, so the two cannot drift: the menu is built
// from these entries (label, icon, shortcut all come from the registered command) and each
// entry's `applies(target)` decides both the palette's `when` and the menu's rows. The
// commands take an explicit target from the menu (the row under the pointer, which right-click
// never focuses) and fall back to `treeTarget()` from the palette or a chord. Pin, unpin, cut,
// copy, move and trash act on the whole selection when the target is part of one (C17).
//
// The file operations are not the tree's: `file.*` and `tree.new-folder` are registered by
// src/shell/fileops.ts, the one UI for them. Their rows here (`own: false`) only say when the menu
// offers them and hand them the row.
const TREE_COMMANDS = [
  { id: 'file.new', title: 'New file…', icon: 'plus', group: 'file', own: false,
    applies: () => true, run: (t) => void newFile(t) },
  { id: 'tree.new-folder', title: 'New folder', icon: 'folderPlus', group: 'file', own: false,
    applies: () => true, run: (t) => void newFolder(folderOf(t)) },
  { id: 'tree.pin', title: 'Pin', icon: 'pin', group: 'tree',
    applies: (t) => !!t.path && !isPinned(t.path), run: (t) => setPinned(batchFor(t) || [t], true) },
  { id: 'tree.unpin', title: 'Unpin', icon: 'pin', group: 'tree',
    applies: (t) => !!t.path && isPinned(t.path), run: (t) => setPinned(batchFor(t) || [t], false) },
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
  // A file in the system's default app for its type; an executable is shown, never run. A
  // folder has the file manager instead, which is the next row.
  { id: 'tree.open-external', title: 'Open with default app', icon: 'reveal', group: 'tree',
    applies: (t) => !!t.path && t.kind !== 'dir', run: (t) => openWith(t.path) },
  // Every row, folders included: selected in Explorer, Finder or the file manager. The title is
  // the platform's, read when the commands are registered, after the host has said which.
  { id: 'tree.reveal', title: 'Open containing folder', icon: 'folder', group: 'tree',
    applies: (t) => !!t.path, run: (t) => revealIn(t.path) },
  // Search, already narrowed to the folder (N38).
  { id: 'tree.search-here', title: 'Search in folder', icon: 'search', group: 'tree',
    applies: (t) => t.kind === 'dir', run: (t) => openSearch({ folder: t.path }) },
  { id: 'tree.collapse-all', title: 'Collapse all folders', icon: 'chevron', group: 'tree',
    applies: () => true, run: () => setAllExpanded(false) },
  { id: 'tree.expand-all', title: 'Expand all folders', icon: 'chevron', group: 'tree',
    applies: () => true, run: () => setAllExpanded(true) },
  // The title the menus draw is the registered command's, which names the real bin (fileops.ts).
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
  // The sections move up and down: the one the focused row is in, or the heading's from its menu.
  for (const [id, title, step] of [['sidebar.section-up', 'Move section up', -1], ['sidebar.section-down', 'Move section down', 1]] as const) {
    commands.register({
      id, title, group: 'tree', icon: 'chevron',
      when: () => { const n = sectionTarget(); return !!n && canMoveSection(n, step); },
      run: (name) => { const n = typeof name === 'string' ? name : sectionTarget(); if (n) moveSection(n, step); },
    });
  }
  // A view's row can leave the sidebar, and come back. The view itself still opens from the palette.
  commands.register({
    id: 'tree.hide-view', title: 'Hide view', group: 'tree', icon: 'eyeOff',
    when: () => !!viewTarget(),
    run: (name) => { const v = typeof name === 'string' ? name : viewTarget(); if (v) setViewHidden(v, true); },
  });
  commands.register({
    id: 'tree.show-views', title: 'Show hidden views', group: 'tree', icon: 'eye',
    when: () => hiddenNow().length > 0,
    run: () => { for (const v of hiddenNow()) setViewHidden(v, false); },
  });
}

/* ------------------------------------------------------------------ the sections */

/** The section the focused row sits in, by name, or null. */
function sectionTarget(): string | null {
  const o = focusOrigin();
  const box = o && state.scrollEl && state.scrollEl.contains(o) && o.closest ? o.closest('.sb-group[data-section]') : null;
  return box instanceof HTMLElement ? box.dataset.section || null : null;
}

/** A section heading's menu: move it up or down among the sections on screen. */
export function sectionMenu(name: string): MenuRow[] {
  const rows: MenuRow[] = [];
  const title = SECTION_TITLES[name] || name;
  if (canMoveSection(name, -1)) rows.push({ label: `Move ${title} up`, iconSvg: icon(ic('chevron', 'dot')), shortcut: shortcutFor('sidebar.section-up') || '', run: () => moveSection(name, -1) });
  if (canMoveSection(name, 1)) rows.push({ label: `Move ${title} down`, iconSvg: icon(ic('chevron', 'dot')), shortcut: shortcutFor('sidebar.section-down') || '', run: () => moveSection(name, 1) });
  return rows;
}

/* ------------------------------------------------------------------ the views */

/** The hidden views that still exist, by name. */
const hiddenNow = () => { const off = hiddenViews(); return allPlannerViews().map((v) => v.name).filter((n) => off.has(n)); };

/** The view a "Hide view" is about: the focused view row, else the view on screen, if it has a row. */
function viewTarget(): string | null {
  const o = focusOrigin();
  const row = o && state.scrollEl && state.scrollEl.contains(o) && o.closest ? o.closest('.sb-view[data-view]') : null;
  if (row instanceof HTMLElement) return row.dataset.view || null;
  const r = currentRoute();
  const off = hiddenViews();
  return r && r.type === 'view' && !off.has(r.name) && allPlannerViews().some((v) => v.name === r.name) ? r.name : null;
}

/** A view row's menu: hide it, and bring back the ones hidden before. */
export function viewMenu(row: HTMLElement): MenuRow[] {
  const name = row.dataset.view || '';
  const hidden = hiddenNow();
  const rows: (MenuRow | null)[] = [
    { label: 'Hide view', iconSvg: icon(ic('eyeOff', 'dot')), shortcut: shortcutFor('tree.hide-view') || '', run: () => setViewHidden(name, true) },
    hidden.length ? { sep: true } : null,
    hidden.length ? { label: `Show hidden views (${hidden.length})`, iconSvg: icon(ic('eye', 'dot')), run: () => commands.run('tree.show-views') } : null,
  ];
  return tidy(rows.filter((it): it is MenuRow => !!it));
}

/**
 * A pinned row's menu: unpin it, open it aside, find it on disk. A pin whose file is gone
 * offers only Unpin.
 */
export function pinMenu(row: HTMLElement): MenuRow[] {
  const target = { path: row.dataset.pin || '', kind: row.dataset.kind === 'dir' ? 'dir' : 'file' } as Target;
  if (row.classList.contains('missing')) {
    return [{ label: 'Unpin', iconSvg: icon('pin'), run: () => setPinned([target], false) }];
  }
  return tidy([
    menuItem('tree.unpin', target),
    menuItem('tree.open-tab', target),
    { sep: true },
    menuItem('tree.copy-path', target),
    menuItem('tree.copy-link', target),
    { sep: true },
    target.kind === 'dir' ? menuItem('tree.search-here', target) : menuItem('tree.open-external', target),
    menuItem('tree.reveal', target),
  ].filter((it): it is MenuRow => !!it));
}

// The menu's order: create, then focus (first after the line on a folder, Hassan's ask), open,
// the row's own verbs, the clipboard, then copy and Explorer, then the one destructive action.
// `app.focus-exit` lives in src/core/focus.ts; its menu row shows only on the folder that is
// the focus.
const MENU = [
  'file.new', 'tree.new-folder',
  null,
  'app.focus-enter', { id: 'app.focus-exit', applies: (t) => !!t.path && t.kind === 'dir' && getFocus() === t.path },
  'tree.open-tab', 'tree.pin', 'tree.unpin',
  'file.rename', 'file.move', 'file.duplicate',
  null,
  'file.cut', 'file.copy', 'file.paste',
  null,
  'tree.copy-path', 'tree.copy-link',
  null,
  'tree.search-here', 'tree.open-external', 'tree.reveal',
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
function menuItem(id, target, label?: string): MenuRow | null {
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

/** A row of the context menu (the kit's `contextMenu`): a command, or a separator. */
type MenuRow = { label?: string, iconSvg?: string, shortcut?: string, danger?: boolean, sep?: boolean, run?: () => void };

/** No two separators in a row and none at either end, whatever was filtered out between. */
const tidy = (items: MenuRow[]) => items.filter((it, i, all) => !it.sep || (i > 0 && i < all.length - 1 && !all[i - 1]!.sep));

function menuFor(path, kind) {
  const target = { path: clean(path || ''), kind: path ? kind : 'dir' };
  const items: MenuRow[] = [];
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
const MULTI_MENU = ['tree.pin', 'file.cut', 'file.copy', 'file.move', null, 'file.trash'];

function multiMenu(batch) {
  const target = batch[0];
  const items: MenuRow[] = [];
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
  const target = targetOf(row) as Target;
  const batch = isSelectable(row) ? batchFor(target) : null;
  if (!batch && isSelectable(row)) clearSelection();
  return batch ? multiMenu(batch) : menuFor(target.path, target.kind);
}

/** The keyboard's context menu (S12): under the row, aligned with where its name starts. */
export function openMenuAt(row) {
  if (!row || (row.dataset.path === undefined && !row.dataset.view && !row.dataset.pin)) return;
  const r = row.getBoundingClientRect();
  contextMenu(Math.round(r.left + 24), Math.round(r.bottom), row.dataset.view ? viewMenu(row) : row.dataset.pin ? pinMenu(row) : menuItemsForRow(row));
}

/** Right-click on the empty space under the tree: the vault root, or the focus folder. */
export function emptyMenu() {
  const scratch = scratchNode();
  const dir = getFocus() || (scratch ? scratch.path : '');
  const where = baseName(dir) || vaultName();
  const target = { path: dir, kind: 'dir' };
  return tidy([
    menuItem('file.new', target, `New file in ${where}…`),
    menuItem('tree.new-folder', target, `New folder in ${where}`),
    clipboard() ? menuItem('file.paste', target, `Paste into ${where}`) : null,
    // Focus mode says nothing on screen and its folder has no row of its own, so the way out
    // is here, on the tree's empty space, as well as in the palette.
    dir ? { sep: true } : null,
    getFocus() ? menuItem('app.focus-exit', target) : null,
    { sep: true },
    { label: 'Collapse all folders', iconSvg: icon(ic('chevron', 'dot')), run: () => commands.run('tree.collapse-all') },
    { label: showHidden() ? 'Hide hidden items' : 'Show hidden items', iconSvg: icon(ic(showHidden() ? 'eyeOff' : 'eye', 'dot')), run: () => commands.run('view.toggle-hidden') },
    hiddenNow().length ? { label: `Show hidden views (${hiddenNow().length})`, iconSvg: icon(ic('eye', 'dot')), run: () => commands.run('tree.show-views') } : null,
  ].filter((it): it is MenuRow => !!it));
}

