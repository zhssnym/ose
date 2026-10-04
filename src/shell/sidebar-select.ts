// Part of the sidebar (./sidebar.ts). The selection: the rows the tree commands act on.

import { toast } from '../ui/index.ts';
import { dirName } from './paths.ts';
import { openInNewTab } from './tabs.ts';
import {
  clearClipboard, clipboard, copy, cut, paste, renamePath, trashPaths, undo,
} from './fileops.ts';
import type { Target } from './fileops.ts';
import { focusPage } from './layout.ts';
import { files, navigate, state } from './sidebar-state.ts';
import {
  currentOf, focusRow, isOpen, persistExpanded, render, rovingRow, rowByKey, rowFor, rowKey,
  setRoving, treeRows,
} from './sidebar-tree.ts';
import { openMenuAt } from './sidebar-commands.ts';

/* -------------------------------------------------------------- selection (C17) */

export const isSelectable = (row) => !!row && row.dataset.path !== undefined && row.dataset.root !== '1';

/**
 * The rows that can be part of a selection: tree rows with a path, so no root, no views. Each
 * one's `dataset.path` is therefore set.
 */
function selectableRows() { return treeRows().filter(isSelectable); }

function paintSelection() {
  for (const r of selectableRows()) {
    const on = state.selected.has(r.dataset.path!);
    r.classList.toggle('selected', on);
    r.setAttribute('aria-selected', String(on));
  }
}

export function pruneSelection() {
  if (!state.selected.size) return;
  const visible = new Set(selectableRows().map((r) => r.dataset.path));
  for (const p of [...state.selected]) if (!visible.has(p)) state.selected.delete(p);
}

export function clearSelection() {
  if (!state.selected.size) return;
  state.selected.clear();
  paintSelection();
}

export function toggleSelected(row) {
  const p = row.dataset.path;
  if (state.selected.has(p)) state.selected.delete(p); else state.selected.add(p);
  paintSelection();
}

/** Select exactly the visible rows between the anchor and `row`, both included. */
export function selectRange(row) {
  const rows = selectableRows();
  const b = rows.indexOf(row);
  if (b < 0) return;
  const anchorRow = rowByKey(state.anchor);
  const a0 = anchorRow ? rows.indexOf(anchorRow) : -1;
  const a = a0 < 0 ? b : a0;
  state.selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.dataset.path!));
  paintSelection();
}

/**
 * What a tree command acts on when its target is one of several selected rows: every
 * selected row, in tree order, as `{ path, kind }`. Null when the target is not part of a
 * selection of two or more, in which case the command keeps its single-target behaviour.
 */
export function batchFor(t): Target[] | null {
  if (!t || !t.path || state.selected.size < 2 || !state.selected.has(t.path)) return null;
  return selectableRows().filter((r) => state.selected.has(r.dataset.path!)).map((r) => ({ path: r.dataset.path!, kind: r.dataset.kind as Target['kind'] }));
}

/** Fold or unfold a tree folder row. */
export function toggleDir(row) {
  const path = row.dataset.path;
  if (row.getAttribute('aria-expanded') === null) return;
  if (path === '') state.rootOpen = !state.rootOpen;
  else if (state.expanded.has(path)) state.expanded.delete(path);
  else state.expanded.add(path);
  persistExpanded();
  render();
}

/**
 * The route a row opens: a file's page, or a view. A folder has none: it folds and unfolds here.
 * Every file opens (H17): the page host decides whether it is text, a picture, or a box with
 * the ways out.
 */
function routeForRow(row) {
  if (!row) return null;
  if (row.dataset.view) return { type: 'view', name: row.dataset.view };
  const path = row.dataset.path;
  if (path === undefined) return null;
  return row.dataset.kind === 'dir' ? null : { type: 'page', path };
}

/** Enter, or a click: a folder folds or unfolds, anything else opens in the tab in front. */
export function activateRow(row) {
  if (row && row.dataset.kind === 'dir' && !row.dataset.view) { toggleDir(row); return; }
  const r = routeForRow(row);
  if (r) void navigate(r);
}

/** A row opened on purpose, in a tab of its own. Answers whether there was anything to open. */
export function openRowAside(row) {
  const r = routeForRow(row);
  if (!r) return false;
  setRoving(row);
  void openInNewTab(r);
  return true;
}

/** `ose.files.open`, with the refusal said out loud rather than left in a console (N10). */
export function openWith(path) {
  files.open(path).catch((err) => toast(err.message || err, 'err'));
}

/** `ose.files.reveal`: the row selected in Explorer, Finder or the file manager, a refusal said. */
export function revealIn(path) {
  files.reveal(path).catch((err) => toast(err.message || err, 'err'));
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

export const targetOf = (row): Target | null => (row && row.dataset.path !== undefined ? { path: row.dataset.path, kind: row.dataset.kind } : null);
export const folderOf = (t) => (!t ? '' : t.kind === 'dir' ? t.path : dirName(t.path));

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
  const batch = t ? batchFor(t) || (isSelectable(row) ? [t] : []) : [];
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
export function onTreeKey(e) {
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
  let next: HTMLElement | null | undefined = null;

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
    if (state.selected.size) { clearSelection(); return; }
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
  // into the root simply skips it.
  if (e.shiftKey && (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') && (isSelectable(row) || isSelectable(next))) {
    if (!state.anchor || !rowByKey(state.anchor)) state.anchor = rowKey(row);
    if (isSelectable(next)) selectRange(next);
    if (next !== row) focusRow(next);
    return;
  }
  clearSelection();
  state.anchor = rowKey(next);
  if (next !== row) focusRow(next);
}

export function scrollToCurrent() {
  const cur = currentOf();
  const node = cur.page ? rowFor(cur.page) : cur.folder !== null ? rowFor(cur.folder) : null;
  if (node) node.scrollIntoView({ block: 'nearest' });
}
