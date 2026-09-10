// Tables (batch 12, package P2). Keymap inside a cell (Enter, Tab, Shift+Enter, Ctrl+Enter),
// the row/column/alignment/delete commands, Esc escalation cell -> table, and a cell
// selection that only ever empties cells. See docs/CONTRACT.md batch 12 "Tables".
//
// Exports read by extensions.js: plugins(ctx, o), registerCommands(api).
//
// Why a plugin and not Milkdown's keymap: `preset-gfm` binds `ExitTable` to plain `Enter`, so
// Enter in a cell throws the caret out of the table, and `plugin-indent` binds a bare `Tab`, so
// Tab in the last cell types four literal spaces into it. Milkdown builds every keymap into one
// plugin appended after `prosePluginsCtx`; extensions.js puts this module first in that list, so
// the handlers below are asked before any of them, and before `blocks.js`.
//
// Everything here answers only when the selection is inside a table, so no key changes meaning
// anywhere else in the document.

import { commands } from '../registry.js';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@milkdown/kit/prose/state';
import { Slice } from '@milkdown/kit/prose/model';
import {
  CellSelection, TableMap, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable,
  selectedRect,
} from '@milkdown/kit/prose/tables';
import './table.css';

export const TABLE_KEY = new PluginKey('os-table-keys');

const CELL_TYPES = ['table_cell', 'table_header'];

// ---------------------------------------------------------------------------
// where we are

/** The innermost table cell around a position: `{ node, pos, depth }`, outer position. */
function cellAt($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (CELL_TYPES.includes(node.type.name)) return { node, pos: $pos.before(d), depth: d };
  }
  return null;
}

/** The table around a position: `{ node, pos, start }`, `pos` outer, `start` inside. */
function tableAt($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'table') return { node, pos: $pos.before(d), start: $pos.start(d) };
  }
  return null;
}

/** A NodeSelection sitting on a whole table, or null. */
function tableNodeSelection(state) {
  const sel = state.selection;
  return sel instanceof NodeSelection && sel.node.type.name === 'table' ? sel : null;
}

/** True while the caret or a cell selection is inside a table. */
export function inTable(state) {
  return !!state && isInTable(state);
}

/** True while `table.delete` should be offered: inside a table, or with the table selected. */
function onTable(state) {
  return !!state && (isInTable(state) || !!tableNodeSelection(state));
}

// ---------------------------------------------------------------------------
// structure: rows and columns
//
// prosemirror-tables' own `addRow` / `addColumn` fill new cells with `createAndFill()`, and the
// gfm cell schema defaults `alignment` to `'left'` — which is written into the delimiter row as
// `:---`. A cell that was never aligned must carry `alignment: null` so the row stays `---`. So
// the two insertions are written out here; the deletions are prosemirror-tables' own.

/** The alignment a new cell in `col` inherits: whatever the header cell of that column has. */
function columnAlignment(rect, col) {
  const header = rect.table.nodeAt(rect.map.map[col]);
  return header ? (header.attrs.alignment ?? null) : null;
}

/** Insert a row of empty cells at row index `row` (0 is above the header, never used). */
function insertRow(state, rect, row) {
  const { map, table, tableStart } = rect;
  const cellType = state.schema.nodes.table_cell;
  const rowType = state.schema.nodes.table_row;
  const cells = [];
  for (let col = 0; col < map.width; col++) {
    cells.push(cellType.createAndFill({ alignment: columnAlignment(rect, col) }));
  }
  let pos = tableStart;
  for (let i = 0; i < row; i++) pos += table.child(i).nodeSize;
  return { tr: state.tr.insert(pos, rowType.create(null, cells)), pos };
}

/** Insert an empty column at column index `col` (0 .. map.width). */
function insertColumn(state, rect, col) {
  const { map, table, tableStart } = rect;
  const header = state.schema.nodes.table_header;
  const cell = state.schema.nodes.table_cell;
  const tr = state.tr;
  for (let row = 0; row < map.height; row++) {
    const type = table.child(row).type.name === 'table_header_row' ? header : cell;
    const at = tableStart + map.positionAt(row, col, table);
    tr.insert(tr.mapping.map(at), type.createAndFill({ alignment: null }));
  }
  return tr;
}

/** The document position of the text inside the cell at (row, col). */
function cellTextPos(rect, row, col) {
  const { map, table, tableStart } = rect;
  const index = row * map.width + col;
  const pos = map.map[index];
  if (pos == null) return null;
  return tableStart + pos + 1;
}

/** Put the caret inside the cell at (row, col) of the table `tr` holds at `tableStart`. */
function caretInCell(tr, tableStart, row, col) {
  const table = tr.doc.nodeAt(tableStart - 1);
  if (!table || table.type.name !== 'table') return tr;
  const map = TableMap.get(table);
  const pos = map.map[row * map.width + col];
  if (pos == null) return tr;
  return tr.setSelection(Selection.near(tr.doc.resolve(tableStart + pos + 1), 1)).scrollIntoView();
}

// ---------------------------------------------------------------------------
// the actions the keys and the commands share

/** Move the caret to the cell below; on the last row, add a row and go into it. */
function cellBelow(view) {
  const { state } = view;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const { map } = rect;
  const row = rect.top;
  const col = rect.left;
  if (row + 1 < map.height) {
    const at = cellTextPos(rect, row + 1, col);
    if (at == null) return false;
    view.dispatch(state.tr.setSelection(Selection.near(state.tr.doc.resolve(at), 1)).scrollIntoView());
    return true;
  }
  return addRow(view, 'below', col);
}

/** Add a row above or below the caret's row, and put the caret in it (column `col`). */
function addRow(view, where, col) {
  const { state } = view;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const index = where === 'above' ? Math.max(1, rect.top) : rect.bottom;
  const { tr } = insertRow(state, rect, index);
  const target = typeof col === 'number' ? col : rect.left;
  view.dispatch(caretInCell(tr, rect.tableStart, index, target));
  return true;
}

/** Add a column left of or right of the caret's column, and put the caret in it. */
function addColumn(view, where) {
  const { state } = view;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const index = where === 'left' ? rect.left : rect.right;
  const tr = insertColumn(state, rect, index);
  view.dispatch(caretInCell(tr, rect.tableStart, 0, index));
  return true;
}

/** Next or previous cell; Tab in the last cell grows the table instead of doing nothing. */
function moveCell(view, dir) {
  const { state } = view;
  if (!isInTable(state)) return false;
  if (goToNextCell(dir)(state, view.dispatch)) return true;
  if (dir < 0) return true;                         // first cell: swallow Tab, never type spaces
  const rect = selectedRect(state);
  const { tr } = insertRow(state, rect, rect.map.height);
  view.dispatch(caretInCell(tr, rect.tableStart, rect.map.height, 0));
  return true;
}

/** What plain Enter used to do: a paragraph after the table, with the caret in it. */
function exitTable(view) {
  const { state } = view;
  const table = tableAt(state.selection.$head);
  if (!table) return false;
  const para = state.schema.nodes.paragraph.createAndFill();
  if (!para) return false;
  const at = table.pos + table.node.nodeSize;
  const tr = state.tr.insert(at, para);
  tr.setSelection(Selection.near(tr.doc.resolve(at), 1)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

/** A hard break inside the cell. P6 makes it survive a round trip as `<br>`. */
function hardBreak(view) {
  const { state } = view;
  const type = state.schema.nodes.hardbreak;
  if (!type) return false;
  view.dispatch(state.tr.replaceSelectionWith(type.create()).scrollIntoView());
  return true;
}

/**
 * Backspace / Delete over a cell selection: empty exactly the selected cells.
 *
 * prosemirror-tables' own `deleteCellSelection` does this, but it is not the only handler that
 * sees the key, and the observed behaviour (research L3) was a whole row disappearing. This runs
 * first and claims the key, so nothing outside the selection can be touched.
 */
function emptyCells(view) {
  const { state } = view;
  const sel = state.selection;
  if (!(sel instanceof CellSelection)) return false;
  const tr = state.tr;
  sel.forEachCell((cell, pos) => {
    const bare = cell.type.createAndFill();
    if (!bare || cell.content.eq(bare.content)) return;   // already empty: leave it alone
    tr.replace(tr.mapping.map(pos + 1), tr.mapping.map(pos + cell.nodeSize - 1),
      new Slice(bare.content, 0, 0));
  });
  // The selection maps itself through the transaction: a CellSelection knows how to.
  if (tr.docChanged) view.dispatch(tr);
  return true;
}

/** Esc escalation: caret -> the cell -> the whole table as a block. */
function escalate(view) {
  const { state } = view;
  const sel = state.selection;
  if (tableNodeSelection(state)) return false;      // the table is already the block: blocks.js
  if (sel instanceof CellSelection) {
    const table = tableAt(sel.$anchorCell);
    if (!table) return false;
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, table.pos)).scrollIntoView());
    return true;
  }
  const cell = cellAt(sel.$head);
  if (!cell) return false;
  view.dispatch(state.tr.setSelection(CellSelection.create(state.doc, cell.pos)).scrollIntoView());
  return true;
}

/** Ctrl+A: the cell's own text, then every cell of the table, then out of our hands. */
function widen(view) {
  const { state } = view;
  const sel = state.selection;
  if (sel instanceof CellSelection) {
    const rect = selectedRect(state);
    const whole = rect.left === 0 && rect.top === 0
      && rect.right === rect.map.width && rect.bottom === rect.map.height;
    if (whole) return false;                        // a third press is the document's
    return selectWholeTable(view);
  }
  const cell = cellAt(sel.$head);
  if (!cell) return false;
  const from = cell.pos + 2;                        // inside the cell, inside its paragraph
  const to = cell.pos + cell.node.nodeSize - 2;
  if (sel.from === from && sel.to === to) return selectWholeTable(view);
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  return true;
}

function selectWholeTable(view) {
  const { state } = view;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const { map, tableStart } = rect;
  const first = map.map[0];
  const last = map.map[map.map.length - 1];
  if (first == null || last == null) return false;
  view.dispatch(state.tr.setSelection(CellSelection.create(state.doc, tableStart + first, tableStart + last)));
  return true;
}

/**
 * Every cell of the caret's column (or of every selected column) takes `value`.
 *
 * It toggles: a column already aligned that way goes back to no alignment at all. Markdown
 * distinguishes `| --- |` from `| :--- |`, and without the toggle there would be no way back to
 * the first — a file Hassan wrote unaligned could never be returned to how he wrote it.
 * Serialisation reads the header row's cells (`preset-gfm` `tableSchema.toMarkdown`); the body
 * cells carry it too so the column also *looks* aligned.
 */
function alignColumn(view, value) {
  const { state } = view;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const { map, table, tableStart } = rect;
  let already = true;
  for (let col = rect.left; col < rect.right && already; col++) {
    const header = table.nodeAt(map.map[col]);
    if (!header || header.attrs.alignment !== value) already = false;
  }
  const next = already ? null : value;
  const tr = state.tr;
  for (let col = rect.left; col < rect.right; col++) {
    for (let row = 0; row < map.height; row++) {
      const at = map.map[row * map.width + col];
      const cell = table.nodeAt(at);
      if (!cell || cell.attrs.alignment === next) continue;
      tr.setNodeMarkup(tableStart + at, null, { ...cell.attrs, alignment: next });
    }
  }
  if (tr.docChanged) view.dispatch(tr);
  return true;
}

/** Select the caret's whole row or whole column, the way clicking a handle does. */
function selectLine(view, which) {
  const { state } = view;
  if (!isInTable(state)) return false;
  const cell = cellAt(state.selection.$head);
  if (!cell) return false;
  const $cell = state.doc.resolve(cell.pos);
  const sel = which === 'row' ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell);
  view.dispatch(state.tr.setSelection(sel).scrollIntoView());
  return true;
}

/** A fresh 3-column table: one header row, two body rows, nothing aligned. */
function insertTable(view) {
  const { state } = view;
  const { schema } = state;
  const cells = (type) => Array.from({ length: 3 }, () => type.createAndFill({ alignment: null }));
  const rows = [
    schema.nodes.table_header_row.create(null, cells(schema.nodes.table_header)),
    schema.nodes.table_row.create(null, cells(schema.nodes.table_cell)),
    schema.nodes.table_row.create(null, cells(schema.nodes.table_cell)),
  ];
  const table = schema.nodes.table.create(null, rows);
  const { from } = state.selection;
  const tr = state.tr.replaceSelectionWith(table);
  // The caret belongs in the first header cell, not wherever the replacement left it.
  let at = null;
  const upTo = Math.min(tr.doc.content.size, from + table.nodeSize + 2);
  tr.doc.nodesBetween(Math.max(0, from - 1), upTo, (node, pos) => {
    if (at == null && node.type.name === 'table') at = pos;
    return at == null;
  });
  if (at != null) caretInCell(tr, at + 1, 0, 0);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Remove the table the caret is in, or the one the block selection holds. */
function removeTable(view) {
  const { state } = view;
  const held = tableNodeSelection(state);
  if (held) {
    view.dispatch(state.tr.delete(held.from, held.to).scrollIntoView());
    return true;
  }
  if (!isInTable(state)) return false;
  return deleteTable(state, view.dispatch);
}

// ---------------------------------------------------------------------------
// the keymap

function handleKeyDown(view, event) {
  if (event.isComposing || event.keyCode === 229) return false;      // E44
  if (!view.editable) return false;
  const { state } = view;
  if (!isInTable(state)) return false;              // never claim a key outside a table
  const mod = event.ctrlKey || event.metaKey;
  const { key } = event;

  if (key === 'Enter') {
    if (event.altKey) return false;
    if (mod) return exitTable(view);
    if (event.shiftKey) return hardBreak(view);
    return cellBelow(view);
  }
  if (key === 'Tab' && !mod && !event.altKey) return moveCell(view, event.shiftKey ? -1 : 1);
  if ((key === 'Backspace' || key === 'Delete') && !event.altKey) {
    if (state.selection instanceof CellSelection) return emptyCells(view);
    return false;
  }
  if (key === 'Escape' && !mod && !event.altKey && !event.shiftKey) return escalate(view);
  if (key === 'a' && mod && !event.altKey && !event.shiftKey) return widen(view);
  return false;
}

/**
 * `extensions.js` asks for this first, so these handlers run before Milkdown's keymap
 * (`ExitTable` on plain Enter, `NextCell` on Tab), before `plugin-indent`'s bare Tab, and
 * before `blocks.js`.
 */
export function plugins() {
  return [new Plugin({
    key: TABLE_KEY,
    props: { handleKeyDown },
    view: (editorView) => popoverKeys(editorView),
  })];
}

// ---------------------------------------------------------------------------
// the popover
//
// The row/column handles are a Vue node view inside `@milkdown/components` that this module
// cannot rewrite: the alignment and delete buttons are bound to `pointerdown` only, the handles
// are parked off screen until a pointer moves over the table, and nothing is focusable. What can
// be done from outside is done here: the handles are positioned and shown from the caret, every
// button becomes a labelled, focusable `<button>`, and Enter or Space on one is turned into the
// `pointerdown` its own handler is waiting for. The rest (visible on hover or focus, the focus
// ring) is `table.css`.

const LABELS = {
  'col-drag-handle': 'Column',
  'row-drag-handle': 'Row',
};
const COL_BUTTONS = ['Align column left', 'Align column center', 'Align column right', 'Delete column'];
const ROW_BUTTONS = ['Delete row'];

/** Label and make focusable every button of one table's popover. Idempotent. */
function dressHandles(block) {
  for (const handle of block.querySelectorAll('.handle.cell-handle')) {
    const role = handle.dataset.role || '';
    if (!handle.hasAttribute('role')) {
      handle.setAttribute('role', 'button');
      handle.setAttribute('tabindex', '-1');
      handle.setAttribute('aria-label', `${LABELS[role] || 'Table'} actions`);
    }
    const labels = role === 'row-drag-handle' ? ROW_BUTTONS : COL_BUTTONS;
    const buttons = handle.querySelectorAll('.button-group button');
    buttons.forEach((b, i) => {
      b.setAttribute('type', 'button');
      if (labels[i] && b.getAttribute('aria-label') !== labels[i]) b.setAttribute('aria-label', labels[i]);
    });
  }
  for (const handle of block.querySelectorAll('.handle.line-handle')) {
    const add = handle.querySelector('.add-button');
    if (!add) continue;
    add.setAttribute('type', 'button');
    const label = handle.dataset.role === 'x-line-drag-handle' ? 'Add row here' : 'Add column here';
    if (add.getAttribute('aria-label') !== label) add.setAttribute('aria-label', label);
  }
}

/**
 * Park the row and column handles on the caret's cell, so a keyboard user can reach them at all:
 * Milkdown only ever positions them from `pointermove`. Same geometry as its own
 * `computeRowHandlePositionByIndex` (`placement: 'left'`) and column handle (`'top'`), computed
 * against the handle's offset parent instead of pulling in floating-ui.
 */
function parkHandles(block, cellEl) {
  const rows = block.querySelectorAll('table.children tr');
  const rowEl = cellEl.parentElement;
  const colIndex = rowEl ? [...rowEl.children].indexOf(cellEl) : -1;
  const headerCell = rows[0] ? rows[0].children[colIndex] : null;
  place(block.querySelector('[data-role="row-drag-handle"]'), rowEl, 'left');
  place(block.querySelector('[data-role="col-drag-handle"]'), headerCell, 'top');
}

function place(handle, ref, side) {
  if (!handle || !ref) return;
  handle.dataset.show = 'true';
  // In the tab order only while it is on screen: a page with five tables must not collect ten
  // invisible tab stops parked at -999px.
  handle.setAttribute('tabindex', '0');
  const parent = handle.offsetParent || handle.parentElement;
  if (!parent) return;
  const p = parent.getBoundingClientRect();
  const r = ref.getBoundingClientRect();
  const h = handle.getBoundingClientRect();
  // `left`/`top` are against the offset parent's padding box and do not move with its scroll,
  // so the scroll offset goes back in by hand. Same conversion floating-ui does for Milkdown.
  const ox = p.left + parent.clientLeft - parent.scrollLeft;
  const oy = p.top + parent.clientTop - parent.scrollTop;
  const x = side === 'left' ? r.left - ox - h.width : r.left - ox + (r.width - h.width) / 2;
  const y = side === 'left' ? r.top - oy + (r.height - h.height) / 2 : r.top - oy - h.height;
  handle.style.left = `${Math.round(x)}px`;
  handle.style.top = `${Math.round(y)}px`;
}

/** Hide both cell handles of a table nobody is in. */
function unpark(block) {
  for (const handle of block.querySelectorAll('.handle.cell-handle')) {
    if (handle.contains(document.activeElement)) continue;
    handle.dataset.show = 'false';
    handle.setAttribute('tabindex', '-1');
    const group = handle.querySelector('.button-group');
    if (group) group.dataset.show = 'false';
  }
}

/** The `.milkdown-table-block` element holding a document position, or null. */
function blockAtPos(view, pos) {
  try {
    const at = view.domAtPos(pos);
    let node = at.node;
    if (node.nodeType === 3) node = node.parentElement;
    return node instanceof Element ? node.closest('.milkdown-table-block') : null;
  } catch { return null; }
}

/**
 * The handle is a toolbar, and it lives inside a `contenteditable`, where Tab does not walk into
 * nested controls — it leaves the editable region altogether. So the group navigates the way
 * every other menu in the app does (CONTRACT batch 9: Up/Down wrap, Enter/Space run, Esc
 * closes), with Left/Right for a horizontal strip:
 *
 *   Enter / Space on the handle   focus its first button
 *   Left / Right / Home / End     move along the buttons
 *   Enter / Space on a button     run it, then hand focus back to the text
 *   Esc                           back to the text, caret untouched
 */
function popoverKeys(view) {
  const buttonsOf = (handle) => [...handle.querySelectorAll('.button-group button')];

  const onKeyDown = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest('.milkdown-table-block .handle.cell-handle');
    if (!handle) return;
    const take = () => { event.preventDefault(); event.stopPropagation(); };
    const buttons = buttonsOf(handle);
    const at = buttons.indexOf(target.closest('button'));
    const isRun = event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';

    if (event.key === 'Escape') { take(); view.focus(); return; }
    if (at < 0) {
      // Focus is on the handle itself. Its own `click` handler selects the whole row or column
      // — which is what the buttons act on — and opens the group; pressing it is exactly what a
      // mouse user does before reaching for one of them.
      if (isRun && buttons.length) {
        take();
        const role = handle.dataset.role;
        // The buttons act on the editor's selection, so the row or column has to be selected
        // first — that is all Milkdown's own `click` handler does, except that it reads the
        // index from the cell the *pointer* was last over, which for a keyboard user is
        // always (0, 0). Selecting from the caret is the same gesture, done honestly.
        if (!selectLine(view, role === 'row-drag-handle' ? 'row' : 'col')) return;
        // That selection makes Milkdown throw the whole node view away and build a new one, so
        // this handle and the block it is in are detached by the next frame: the button is
        // found again on whatever is there then, addressed through the selection.
        requestAnimationFrame(() => {
          const st = view.state;
          const cell = isInTable(st) ? cellAt(st.selection.$head) : null;
          const blk = cell ? blockAtPos(view, cell.pos + 1) : null;
          const fresh = blk && blk.querySelector(`.handle.cell-handle[data-role="${role}"]`);
          const first = fresh && fresh.querySelector('.button-group button');
          if (first) first.focus();
        });
      }
      return;
    }
    if (isRun) {
      take();
      // Milkdown binds these buttons to `pointerdown`, so `click` never reaches them.
      target.closest('button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      view.focus();
      return;
    }
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next >= 0) { take(); buttons[next].focus(); }
  };
  view.dom.addEventListener('keydown', onKeyDown, true);

  const syncOnce = () => {
    for (const block of view.dom.querySelectorAll('.milkdown-table-block')) dressHandles(block);
    const { state } = view;
    if (!isInTable(state)) {
      for (const block of view.dom.querySelectorAll('.milkdown-table-block')) unpark(block);
      return;
    }
    const cell = cellAt(state.selection.$head);
    if (!cell) return;
    const block = blockAtPos(view, cell.pos + 1);
    if (!block) return;
    for (const other of view.dom.querySelectorAll('.milkdown-table-block')) if (other !== block) unpark(other);
    let cellEl = view.nodeDOM(cell.pos);
    if (!(cellEl instanceof Element)) cellEl = null;
    if (cellEl) parkHandles(block, cellEl);
  };

  // The Vue node view rebuilds its handles one frame after a selection change and throws away
  // the labels and the parking with them, so every sync is repeated on the next frame.
  let queued = false;
  const sync = () => {
    syncOnce();
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; if (view.dom.isConnected) syncOnce(); });
  };
  sync();

  return {
    update: sync,
    destroy() { view.dom.removeEventListener('keydown', onKeyDown, true); },
  };
}

// ---------------------------------------------------------------------------
// commands
//
// Ids are fixed: P3 binds the chords and builds the context menu from them. Every one but
// `table.insert` is invisible outside a table. Each acts on the open page's editor view and
// hands focus back, so running one from the palette leaves the caret where the user can type.

export function registerCommands(api) {
  const view = () => api.getView();
  const run = (fn) => () => {
    const v = view();
    if (!v) return;
    fn(v);
    v.focus();
  };
  const when = () => { const v = view(); return !!v && inTable(v.state); };
  const whenTable = () => { const v = view(); return !!v && onTable(v.state); };

  const list = [
    ['table.insert', 'Insert table', () => !!view(), (v) => insertTable(v)],
    ['table.row-above', 'Add row above', when, (v) => addRow(v, 'above')],
    ['table.row-below', 'Add row below', when, (v) => addRow(v, 'below')],
    ['table.col-left', 'Add column left', when, (v) => addColumn(v, 'left')],
    ['table.col-right', 'Add column right', when, (v) => addColumn(v, 'right')],
    ['table.delete-row', 'Delete row', when, (v) => deleteRow(v.state, v.dispatch)],
    ['table.delete-col', 'Delete column', when, (v) => deleteColumn(v.state, v.dispatch)],
    ['table.delete', 'Delete table', whenTable, (v) => removeTable(v)],
    ['table.align-left', 'Align column left', when, (v) => alignColumn(v, 'left')],
    ['table.align-center', 'Align column center', when, (v) => alignColumn(v, 'center')],
    ['table.align-right', 'Align column right', when, (v) => alignColumn(v, 'right')],
  ];

  for (const [id, title, gate, fn] of list) {
    commands.register({ id, title, group: 'table', when: gate, run: run(fn) });
  }
}
