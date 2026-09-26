// Live's tables: a GFM table off the caret is drawn as an HTML table, and raw with its pipes as
// soon as the caret is on one of its lines (the core reveals a table whole).
//
// The widget replaces the table's lines with one block. The cells are read from the syntax
// tree's pipes, so an empty cell stays a column and an escaped `\|` stays inside its cell; the
// alignment row gives each column its alignment. A cell's text is rendered with the core's own
// inline rules (`ctx.inlineHtml`), which answers sanitised HTML.
//
// A mousedown on a cell does one thing: it puts the caret at that cell's first character in
// the source, which reveals the table raw with the caret where the click was. Nothing here
// changes the document, and a link in a cell is not followed from the drawn table (Alt, click
// and Enter all work on the raw one).

import { Decoration, WidgetType } from '@codemirror/view';

/**
 * @typedef {object} TableCell
 * @property {string} text   the cell's source, trimmed
 * @property {number} at     the source offset of its first character, from the table's first line
 *
 * @typedef {object} TableModel
 * @property {TableCell[]} head
 * @property {TableCell[][]} rows
 * @property {Array<'left' | 'center' | 'right' | null>} align
 */

/**
 * The cells of one row: the stretches between its pipes, a leading and a trailing pipe
 * dropped. `pipes` are absolute positions of the row's `TableDelimiter` children.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} from
 * @param {number} to
 * @param {number[]} pipes
 * @param {number} base  the table's first line start
 * @returns {TableCell[]}
 */
function rowCells(state, from, to, pipes, base) {
  const bounds = [from, ...pipes, to];
  /** @type {TableCell[]} */
  const cells = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = /** @type {number} */ (bounds[i]);
    const b = /** @type {number} */ (bounds[i + 1]);
    const start = i === 0 ? a : a + 1;
    const raw = state.doc.sliceString(start, b);
    // The stretch in front of a leading pipe and behind a trailing one is not a cell.
    if (i === 0 && pipes.length && !raw.trim() && pipes[0] === b) continue;
    if (i === bounds.length - 2 && pipes.length && !raw.trim() && pipes[pipes.length - 1] === a) continue;
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim(), at: start + lead - base });
  }
  return cells;
}

/** `:--`, `:-:`, `--:` or `---` to an alignment. */
function alignOf(spec) {
  const s = spec.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/**
 * The table a `Table` node holds.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {import('@lezer/common').SyntaxNodeRef} node
 * @returns {TableModel | null}
 */
export function readTable(state, node) {
  const base = state.doc.lineAt(node.from).from;
  /** @type {TableModel} */
  const model = { head: [], rows: [], align: [] };
  let sawHead = false;
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader' || child.name === 'TableRow') {
      const line = state.doc.lineAt(child.from);
      const pipes = child.getChildren('TableDelimiter').map((d) => d.from);
      const cells = rowCells(state, Math.max(line.from, child.from), child.to, pipes, base);
      if (child.name === 'TableHeader') { model.head = cells; sawHead = true; } else model.rows.push(cells);
    } else if (child.name === 'TableDelimiter' && sawHead && !model.align.length) {
      // The alignment row is a delimiter of the table itself, on its own line.
      const text = state.doc.sliceString(child.from, child.to);
      model.align = text.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(alignOf);
    }
  }
  return sawHead ? model : null;
}

export class TableWidget extends WidgetType {
  /**
   * @param {string} source  the table's lines, as the key for `eq`
   * @param {TableModel} model
   * @param {(md: string) => string} inlineHtml
   */
  constructor(source, model, inlineHtml) {
    super();
    this.source = source;
    this.model = model;
    this.inlineHtml = inlineHtml;
    /** @type {{ head: string[], rows: string[][] } | null} */
    this.cells = null;
    /** @type {string | null} */
    this.key = null;
  }

  /**
   * Same lines and the same drawn cells: a cell's HTML also reads what lies outside the text
   * (whether a wikilink's target exists, where an image resolves), so a `refresh()` that finds a
   * page appeared must draw the table again even when its lines did not change.
   * @param {TableWidget} other
   */
  eq(other) { return other.source === this.source && other.drawnKey() === this.drawnKey(); }

  /** Every cell's HTML, rendered once per widget, and the key `eq` compares. */
  drawn() {
    if (!this.cells) {
      const one = (cell) => (cell && cell.text ? this.cellHtml(cell.text) : '');
      this.cells = { head: this.model.head.map(one), rows: this.model.rows.map((r) => r.map(one)) };
      this.key = JSON.stringify(this.cells);
    }
    return this.cells;
  }

  /** @returns {string} */
  drawnKey() { this.drawn(); return this.key || ''; }

  /** @param {import('@codemirror/view').EditorView} view */
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-table';
    const table = document.createElement('table');
    const width = Math.max(this.model.head.length, ...this.model.rows.map((r) => r.length));
    const drawn = this.drawn();
    const row = (cells, html, tag) => {
      const tr = document.createElement('tr');
      for (let i = 0; i < width; i++) {
        const cell = cells[i];
        const td = document.createElement(tag);
        const align = this.model.align[i];
        if (align) td.style.textAlign = align;
        if (cell) {
          td.dataset.at = String(cell.at);
          td.innerHTML = html[i] || '';
        }
        tr.append(td);
      }
      return tr;
    };
    const thead = document.createElement('thead');
    thead.append(row(this.model.head, drawn.head, 'th'));
    const tbody = document.createElement('tbody');
    this.model.rows.forEach((r, n) => { tbody.append(row(r, drawn.rows[n] || [], 'td')); });
    table.append(thead);
    if (this.model.rows.length) table.append(tbody);
    wrap.append(table);

    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const target = e.target instanceof Element ? e.target : null;
      const cell = target ? target.closest('[data-at]') : null;
      let base;
      try { base = view.posAtDOM(wrap); } catch { return; }
      const rel = cell instanceof HTMLElement ? Number(cell.dataset.at) || 0 : 0;
      const at = Math.min(view.state.doc.length, base + rel);
      view.dispatch({ selection: { anchor: at }, userEvent: 'select.live.table' });
      view.focus();
    });
    // A link inside a drawn cell would take the web view with it.
    wrap.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('a')) e.preventDefault();
    });
    return wrap;
  }

  /** A cell's HTML: the core's inline renderer, and the plain text if it throws. */
  cellHtml(text) {
    try {
      return this.inlineHtml(text);
    } catch {
      const span = document.createElement('span');
      span.textContent = text;
      return span.innerHTML;
    }
  }

  ignoreEvent() { return true; }
}

/** @type {import('../registry.js').LiveWidget} */
export const table = {
  id: 'table',
  kind: 'block',
  nodes: ['Table'],
  decorate(ctx, node, out) {
    const model = readTable(ctx.state, node);
    if (!model) return;
    const first = ctx.state.doc.lineAt(node.from);
    const last = ctx.state.doc.lineAt(Math.max(node.from, node.to));
    const source = ctx.state.doc.sliceString(first.from, last.to);
    const widget = new TableWidget(source, model, ctx.inlineHtml);
    out.add(first.from, last.to, Decoration.replace({ widget, block: true }));
  },
};
