// An outline's numbering: a numbered list with numbered lists inside it is drawn I. A. 1. a.,
// the way a course plan is written, and a numbered list with none inside it stays 1. 2. 3.
//
// Nothing of it is in the file or in the document: markdown writes every level `1.` and so does
// the editor. The mark is a decoration on the list item, a custom property its label draws
// (editor.css), so what is saved is what was saved before. `render()` gets the same look from
// CSS alone (render.css), where a list item is a real one.
//
// The level is the number of numbered lists the item is inside, whatever lies between them (a
// bullet list, a quote): 1 is I. II. III., 2 is A. B. C., 3 is 1. 2. 3., 4 is a. b. c., and
// from 5 on i. ii. iii.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

type PmNode = import('@milkdown/kit/prose/model').Node;

const ROMAN: Array<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function roman(n: number): string {
  if (!(n >= 1 && n < 4000)) return String(n);
  let out = '';
  for (const [value, letters] of ROMAN) while (n >= value) { out += letters; n -= value; }
  return out;
}

/** 1 is A, 26 is Z, 27 is AA. */
export function letters(n: number): string {
  if (!(n >= 1)) return String(n);
  let out = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** The mark of item `n` at `level`, or null where the editor's own `n.` is already the mark. */
export function markOf(level: number, n: number): string | null {
  if (level === 1) return `${roman(n)}.`;
  if (level === 2) return `${letters(n)}.`;
  if (level === 3) return null;
  if (level === 4) return `${letters(n).toLowerCase()}.`;
  return `${roman(n).toLowerCase()}.`;
}

const ORDERED = 'ordered_list';

function holdsOrdered(node: PmNode): boolean {
  let found = false;
  node.descendants((child) => {
    if (child.type.name === ORDERED) found = true;
    return !found;
  });
  return found;
}

/** Every list item that wears a mark of its own: where it is, the mark, and its level. */
export function listMarks(doc: PmNode): Array<{ from: number, to: number, mark: string, level: number }> {
  const out: Array<{ from: number, to: number, mark: string, level: number }> = [];
  const visit = (node: PmNode, pos: number, level: number) => {
    node.forEach((child, offset, index) => {
      const at = pos + offset;
      let inner = level;
      if (node.type.name === ORDERED && level > 0) {
        const mark = markOf(level, (node.attrs.order ?? 1) + index);
        if (mark) out.push({ from: at, to: at + child.nodeSize, mark, level });
      }
      if (child.type.name === ORDERED) {
        // A numbered list outside every other is an outline only if it holds one.
        if (level > 0) inner = level + 1;
        else inner = holdsOrdered(child) ? 1 : 0;
        if (inner === 0) return;
      }
      if (!child.isLeaf && !child.isTextblock) visit(child, at + 1, inner);
    });
  };
  visit(doc, 0, 0);
  return out;
}

const KEY = new PluginKey('os-list-marks');

function decorations(doc: PmNode) {
  const marks = listMarks(doc);
  if (!marks.length) return DecorationSet.empty;
  return DecorationSet.create(doc, marks.map((m) => Decoration.node(m.from, m.to, {
    class: m.level === 1 ? 'ol-mark ol-roman' : 'ol-mark',
    style: `--ol-mark: "${m.mark}"`,
  })));
}

export function listMarksPlugin() {
  return new Plugin({
    key: KEY,
    state: {
      init: (_, state) => decorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? decorations(tr.doc) : old),
    },
    props: {
      decorations: (state) => KEY.getState(state),
    },
  });
}
