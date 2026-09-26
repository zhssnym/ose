// @vitest-environment happy-dom
// Live's table widget: the model read from the tree, the drawn table, and a click that only
// moves the caret (contract §3.2, §8.1).

import './dom-shim.js';
import { StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { readTable, table, TableWidget } from '../../../src/editor/live/widgets/table.js';
import { ctxOf, decorations, nodesOf, stateOf } from './support.js';

const DOC = [
  'Intro',
  '',
  '| Name | Note |',
  '|:-----|-----:|',
  '| one  |      |',
  '| a \\| b | `c` |',
  '',
  'After',
].join('\n');

describe('readTable', () => {
  it('reads the head, the rows, empty cells and the alignment', () => {
    const state = stateOf(DOC);
    const [node] = nodesOf(state, 'Table');
    expect(node).toBeDefined();
    const model = readTable(state, node);
    expect(model).not.toBeNull();
    if (!model) return;
    expect(model.head.map((c) => c.text)).toEqual(['Name', 'Note']);
    expect(model.align).toEqual(['left', 'right']);
    expect(model.rows.map((r) => r.map((c) => c.text))).toEqual([['one', ''], ['a \\| b', '`c`']]);
    // Each cell's offset points at its first character in the source.
    const base = state.doc.lineAt(node.from).from;
    for (const cell of [...model.head, ...model.rows.flat()]) {
      if (!cell.text) continue;
      expect(state.doc.sliceString(base + cell.at, base + cell.at + cell.text.length)).toBe(cell.text);
    }
  });

  it('a table without outer pipes', () => {
    const state = stateOf('a | b\n--- | ---\n1 | 2\n');
    const [node] = nodesOf(state, 'Table');
    const model = node ? readTable(state, node) : null;
    expect(model && model.head.map((c) => c.text)).toEqual(['a', 'b']);
    expect(model && model.rows.map((r) => r.map((c) => c.text))).toEqual([['1', '2']]);
  });
});

describe('decorate', () => {
  it('replaces the table lines with one block widget', () => {
    const state = stateOf(DOC);
    const out = decorations(table, ctxOf(state));
    expect(out.length).toBe(1);
    const [d] = out;
    expect(state.doc.lineAt(d.from).number).toBe(3);
    expect(state.doc.lineAt(d.to).number).toBe(6);
    expect(d.from).toBe(state.doc.line(3).from);
    expect(d.to).toBe(state.doc.line(6).to);
    expect(d.deco.spec.block).toBe(true);
    expect(d.deco.spec.widget).toBeInstanceOf(TableWidget);
  });

  it('eq is the source: the same table elsewhere is not redrawn', () => {
    const a = decorations(table, ctxOf(stateOf(DOC)))[0].deco.spec.widget;
    const b = decorations(table, ctxOf(stateOf(`more\n\n${DOC}`)))[0].deco.spec.widget;
    const c = decorations(table, ctxOf(stateOf(DOC.replace('one', 'two'))))[0].deco.spec.widget;
    expect(a.eq(b)).toBe(true);
    expect(a.eq(c)).toBe(false);
  });

  it('the same lines drawn differently are redrawn: a wikilink whose page appeared', () => {
    const state = stateOf(DOC);
    const before = decorations(table, ctxOf(state, { inlineHtml: (md) => `<span class="missing">${md}</span>` }))[0].deco.spec.widget;
    const after = decorations(table, ctxOf(state, { inlineHtml: (md) => `<a>${md}</a>` }))[0].deco.spec.widget;
    const again = decorations(table, ctxOf(state, { inlineHtml: (md) => `<a>${md}</a>` }))[0].deco.spec.widget;
    expect(before.eq(after)).toBe(false);
    expect(after.eq(again)).toBe(true);
  });
});

describe('the drawn table', () => {
  it('cells are rendered inline, sanitised by the core, with their source offsets', () => {
    const state = stateOf(DOC);
    const seen = [];
    const ctx = ctxOf(state, { inlineHtml: (md) => { seen.push(md); return `<em>${md.length}</em>`; } });
    const widget = decorations(table, ctx)[0].deco.spec.widget;
    const dom = widget.toDOM(/** @type {any} */ ({}));
    expect(dom.className).toBe('cm-live-table');
    expect([...dom.querySelectorAll('th')].length).toBe(2);
    expect([...dom.querySelectorAll('tbody tr')].length).toBe(2);
    expect(seen).toEqual(['Name', 'Note', 'one', 'a \\| b', '`c`']);
    expect(dom.querySelector('th')?.getAttribute('style') || '').toContain('left');
    expect(dom.querySelector('th:nth-child(2)')?.getAttribute('style') || '').toContain('right');
    expect(dom.querySelector('td')?.innerHTML).toBe('<em>3</em>');
  });

  it('an inline renderer that throws leaves the plain text', () => {
    const state = stateOf(DOC);
    const ctx = ctxOf(state, { inlineHtml: () => { throw new Error('no'); } });
    const dom = decorations(table, ctx)[0].deco.spec.widget.toDOM(/** @type {any} */ ({}));
    expect(dom.querySelector('th')?.textContent).toBe('Name');
  });

  it('a mousedown on a cell sets the selection to its source, and changes nothing', () => {
    const field = StateField.define({
      create: (state) => {
        const ranges = decorations(table, ctxOf(state)).map((d) => d.deco.range(d.from, d.to));
        return Decoration.set(ranges);
      },
      update: (v) => v,
      provide: (f) => EditorView.decorations.from(f),
    });
    const state = stateOf(DOC, [field]);
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({ state, parent });
    // Focusing is the browser's part; happy-dom answers it with a synchronous selectionchange
    // from wherever its own DOM selection sits, which a browser never does.
    view.focus = () => {};
    try {
      const cells = view.dom.querySelectorAll('.cm-live-table td');
      expect(cells.length).toBe(4);
      const target = cells[2];                            // `a \| b`
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      const at = view.state.selection.main.head;
      expect(view.state.doc.sliceString(at, at + 6)).toBe('a \\| b');
      expect(view.state.doc.toString()).toBe(DOC);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
