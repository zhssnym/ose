// Part of the sidebar (./sidebar.js). Putting the sidebar up.

import { contextMenu } from 'ose:ui';
import { baseName, dirName } from './paths.js';
import { onClipboard, setContext } from './fileops.js';
import * as pins from './pins.js';
import { toggleSidebar } from './layout.js';
import { bus, commands, debounce, ic, showHidden, slot, state } from './sidebar-state.js';
import {
  currentOf, expandAncestors, findNode, focusRow, focusTree, render, rowByKey, rowKey, setRoving,
} from './sidebar-tree.js';
import {
  activateRow, batchFor, clearSelection, isSelectable, onTreeKey, openRowAside, scrollToCurrent,
  selectRange, toggleDir, toggleSelected,
} from './sidebar-select.js';
import {
  askAboutRenames, onArrived, onFsRenames, onFsTree, onMoved, onMoving, onReveal, onTrashed,
  refreshTree,
} from './sidebar-load.js';
import {
  bindDnd, buildHead, emptyMenu, menuItemsForRow, registerTreeCommands, toggleHidden, treeTarget,
} from './sidebar-commands.js';

/* ------------------------------------------------------------------ init */

/**
 * Draw the sidebar into `node` and wire it: the tool strip, the tree, its keys, menus, drag and
 * drop, and the events it follows. Called once by the layout.
 * @param {HTMLElement} node
 */
export function initSidebar(node) {
  state.el = node;
  state.el.className = 'sidebar';
  state.el.innerHTML = '<div class="sb-head" role="toolbar" aria-label="Files"></div><div class="sb-scroll" tabindex="-1"></div>';
  state.headEl = state.el.querySelector('.sb-head');
  // Drawn just above.
  state.scrollEl = /** @type {HTMLElement} */ (state.el.querySelector('.sb-scroll'));

  const saved = slot('sidebar').get() || {};
  if (Array.isArray(saved.expanded)) state.expanded = new Set(saved.expanded.filter((p) => typeof p === 'string' && p));
  if (saved.root === false) state.rootOpen = false;

  // A pin is a file or a folder, there or not, as the tree says; until the tree is read, it
  // is not called missing on a guess (`undefined`).
  pins.setLookup((path) => {
    if (!state.tree) return undefined;
    const n = findNode(path);
    if (n) return n;
    const parent = findNode(dirName(path));
    if (!parent || !parent.children) return undefined;
    if (baseName(path).startsWith('.') && !showHidden()) return undefined;
    return null;
  });
  pins.on(() => { if (!state.quietPins) render(); });
  onClipboard(() => render());

  // A click and Enter do the same thing (activateRow); the clicked row also becomes the tab
  // stop, so Tab back into the sidebar returns to where the mouse left off (D2). A click on a
  // folder's chevron folds it and goes nowhere. Ctrl+click toggles a tree row in the
  // selection and Shift+click selects the run from the anchor to it (C17).
  state.scrollEl.addEventListener('click', (e) => {
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
      state.anchor = rowKey(row);
      focusRow(row);
      return;
    }
    if (isSelectable(row) && e.shiftKey) {
      if (!state.anchor || !rowByKey(state.anchor)) state.anchor = state.roving;
      selectRange(row);
      focusRow(row);
      return;
    }
    clearSelection();
    state.anchor = rowKey(row);
    // The clicked row takes the keyboard (H21): a click does not focus a button on macOS, and
    // every tree command asks the focused row what it is about.
    focusRow(row);
    activateRow(row);
  });

  // A double click on a folder also folds it, as a file manager's tree does.
  state.scrollEl.addEventListener('dblclick', (e) => {
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest('.sb-row.dir');
    if (!row || e.target.closest('.tw') || row.getAttribute('aria-expanded') === null) return;
    toggleDir(row);
  });

  // The middle button opens a row in a tab of its own, in the tree and in the pins alike.
  state.scrollEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest('.sb-row');
    if (!row) return;
    e.preventDefault();
    openRowAside(row);
  });
  // Firefox and Chromium both start an autoscroll on a middle press unless it is refused.
  state.scrollEl.addEventListener('mousedown', (e) => { if (e.button === 1 && e.target instanceof Element && e.target.closest('.sb-row')) e.preventDefault(); });

  // A name the column cut gets the whole path on hover, and a name that fits gets nothing
  // (R21). Measured on the row under the pointer, one row at a time.
  state.scrollEl.addEventListener('mouseover', (e) => {
    const name = e.target instanceof Element && e.target.closest('.sb-row > .grow');
    if (!(name instanceof HTMLElement)) return;
    const cut = name.scrollWidth > name.clientWidth;
    if (cut) name.title = name.parentElement?.dataset.path || name.textContent || '';
    else name.removeAttribute('title');
  });

  state.scrollEl.addEventListener('keydown', onTreeKey);
  // However a row got the keyboard (a click, an arrow, a dialog handing focus back), it is the
  // tab stop and the row a rename or move follows to its new name.
  state.scrollEl.addEventListener('focusin', (e) => {
    const row = e.target instanceof Element && e.target.closest('.sb-row');
    if (row && rowKey(row) !== state.roving) setRoving(row);
  });

  // Right-click inside a selection of several opens the menu for all of them; outside it,
  // the selection is dropped first.
  state.scrollEl.addEventListener('contextmenu', (e) => {
    if (!(e.target instanceof Element)) return;
    const row = e.target.closest('.sb-row:not(.sb-view)');
    e.preventDefault();
    if (!row) { contextMenu(e.clientX, e.clientY, emptyMenu()); return; }
    // The row under the pointer is the row the menu is about, and the row the keyboard comes
    // back to when the menu closes (H21).
    focusRow(row);
    contextMenu(e.clientX, e.clientY, menuItemsForRow(row));
  });

  bindDnd(state.scrollEl);

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
    if (state.readHidden !== null && showHidden() !== state.readHidden) void refreshTree();
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
