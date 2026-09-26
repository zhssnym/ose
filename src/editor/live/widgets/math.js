// Live's maths: `$…$` in running text and `$$…$$` as a block, read by the pandoc rule and drawn
// with Temml, the same two pieces the rich view uses (../../math-rule.js, ../../math.js).
//
// The rule, once more, because it is the one thing this file must not get wrong: an opening
// `$` is followed by a non-space, a closing `$` is preceded by a non-space and not followed by
// a digit, a formula stays on its line, and `$$` opens nothing in running text. So `$x$` is
// maths and `5 $ puis 10 $` is two prices. A `$` straight after another `$` opens nothing
// either (micromark's `previous`, which the rich view's parser applies).
//
// A display formula is `$$` at the start of a block (up to three spaces in), closed by the
// first `$$` with nothing but whitespace after it on its line, on the same line or a later one.
// It does not interrupt a paragraph, and a `$$` that is never closed is not a formula: both as
// in the rich view, so the two modes agree on what the file says.
//
// Two registrations, as for images: `math` draws the inline formulas over the visible ranges,
// `math-block` replaces a display formula's lines from the state field. A formula Temml refuses
// shows its own source in `cm-live-math-error`, with Temml's message as the tooltip.

import { Decoration, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { inlineMathEnd } from '../../math-rule.js';
import { renderMath } from '../../math.js';

/** How far ahead a `$$` looks for its closing fence before it is taken for text. */
const LOOKAHEAD = 64 * 1024;

/** A line that closes a display formula: `$$` with nothing but whitespace after it. */
const CLOSER = /\$\$[ \t]*$/;

/**
 * The column of the closing `$$` on `text` at or after `from`, or -1.
 * @param {string} text
 * @param {number} from
 */
function closerIn(text, from) {
  const m = CLOSER.exec(text.slice(from));
  return m ? from + m.index : -1;
}

/**
 * True when some line after the one ending at `lineEnd` closes the formula. Read from the raw
 * input: the block context has no way back once it has moved a line, and an unclosed `$$` must
 * stay text.
 */
function closesAhead(cx, lineEnd) {
  const input = /** @type {any} */ (cx).input;           // BlockContext.input: public in the JS, not typed
  if (!input || typeof input.read !== 'function') return true;
  const start = lineEnd + 1;
  if (start >= input.length) return false;
  const chunk = String(input.read(start, Math.min(input.length, start + LOOKAHEAD)));
  return chunk.split('\n').some((l) => CLOSER.test(l));
}

/** @type {import('@lezer/markdown').MarkdownConfig} */
export const mathSyntax = {
  defineNodes: [
    { name: 'InlineMath', style: tags.special(tags.content) },
    { name: 'BlockMath', block: true, style: tags.special(tags.content) },
    { name: 'MathMark', style: tags.processingInstruction },
  ],
  parseInline: [{
    name: 'InlineMath',
    before: 'Escape',
    parse(cx, next, pos) {
      if (next !== 36) return -1;
      if (pos > cx.offset && cx.char(pos - 1) === 36) return -1;
      const rest = cx.slice(pos, cx.end);
      const nl = rest.indexOf('\n');
      const end = inlineMathEnd(nl < 0 ? rest : rest.slice(0, nl), 0);
      if (end < 0) return -1;
      return cx.addElement(cx.elt('InlineMath', pos, pos + end, [
        cx.elt('MathMark', pos, pos + 1),
        cx.elt('MathMark', pos + end - 1, pos + end),
      ]));
    },
  }],
  parseBlock: [{
    name: 'BlockMath',
    before: 'FencedCode',
    // No `endLeaf`: a `$$` line inside a paragraph stays part of the paragraph.
    parse(cx, line) {
      if (line.indent - line.baseIndent >= 4) return false;
      const text = line.text;
      const at = line.pos;
      if (text.charCodeAt(at) !== 36 || text.charCodeAt(at + 1) !== 36 || text.charCodeAt(at + 2) === 36) return false;
      const from = cx.lineStart + at;
      const same = closerIn(text, at + 2);
      if (same >= 0) {
        const end = cx.lineStart + text.length;
        cx.addElement(cx.elt('BlockMath', from, end, [
          cx.elt('MathMark', from, from + 2),
          cx.elt('MathMark', cx.lineStart + same, cx.lineStart + same + 2),
        ]));
        cx.nextLine();
        return true;
      }
      if (!closesAhead(cx, cx.lineStart + text.length)) return false;
      const marks = [cx.elt('MathMark', from, from + 2)];
      const depth = cx.depth;                              // the composite blocks this line is inside
      const l = /** @type {any} */ (line);                // Line.depth: public in the JS, not typed
      while (cx.nextLine() && (l.depth === undefined || l.depth >= depth)) {
        for (const m of line.markers) marks.push(m);
        const close = closerIn(line.text, line.basePos);
        if (close >= 0) {
          marks.push(cx.elt('MathMark', cx.lineStart + close, cx.lineStart + close + 2));
          cx.nextLine();
          break;
        }
      }
      cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), marks));
      return true;
    },
  }],
};

/**
 * The TeX of a math node: what lies between its two marks. For a display formula inside a
 * quote or a callout, the quote markers of its inner lines are taken off.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {import('@lezer/common').SyntaxNodeRef} node
 * @returns {{ tex: string, open: number, close: number } | null}
 */
export function readMath(state, node) {
  const marks = node.node.getChildren('MathMark');
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (!open || !close || marks.length < 2 || open === close) return null;
  let tex = state.doc.sliceString(open.to, close.from);
  if (node.name === 'BlockMath') {
    const first = state.doc.lineAt(open.from);
    const lead = first.text.slice(0, open.from - first.from);
    if (/>/.test(lead)) {
      tex = tex.split('\n').map((l, i) => (i === 0 ? l : l.replace(/^[ \t]*(?:>[ \t]?)+/, ''))).join('\n');
    }
  }
  return { tex, open: open.from, close: close.to };
}

export class MathWidget extends WidgetType {
  /**
   * @param {string} tex
   * @param {boolean} display
   * @param {number} caret  where a click puts the caret, from the start of the replaced range
   */
  constructor(tex, display, caret) {
    super();
    this.tex = tex;
    this.display = display;
    this.caret = caret;
  }

  /** @param {MathWidget} other */
  eq(other) {
    return other.tex === this.tex && other.display === this.display && other.caret === this.caret;
  }

  /** @param {import('@codemirror/view').EditorView} view */
  toDOM(view) {
    /** @type {HTMLElement} */
    const wrap = document.createElement(this.display ? 'div' : 'span');
    wrap.className = this.display ? 'cm-live-math cm-live-math-block' : 'cm-live-math';
    const el = renderMath(this.display ? this.tex.trim() : this.tex, { display: this.display });
    if (el.classList.contains('ose-math-bad')) {
      wrap.classList.add('cm-live-math-error');
      el.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
    }
    wrap.append(el);
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      let base;
      try { base = view.posAtDOM(wrap); } catch { return; }
      const at = Math.min(view.state.doc.length, base + this.caret);
      view.dispatch({ selection: { anchor: at }, userEvent: 'select.live.math' });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent() { return true; }
}

/** @type {import('../registry.js').LiveWidget} */
export const math = {
  id: 'math',
  kind: 'inline',
  nodes: ['InlineMath'],
  markdown: mathSyntax,
  decorate(ctx, node, out) {
    const m = readMath(ctx.state, node);
    if (!m) return;
    out.add(node.from, node.to, Decoration.replace({ widget: new MathWidget(m.tex, false, 1) }));
  },
};

/** @type {import('../registry.js').LiveWidget} */
export const mathBlock = {
  id: 'math-block',
  kind: 'block',
  nodes: ['BlockMath'],
  decorate(ctx, node, out) {
    const m = readMath(ctx.state, node);
    if (!m) return;                                     // unclosed at the end of its container: raw
    const first = ctx.state.doc.lineAt(node.from);
    const last = ctx.state.doc.lineAt(Math.max(node.from, node.to));
    const widget = new MathWidget(m.tex, true, m.open + 2 - first.from);
    out.add(first.from, last.to, Decoration.replace({ widget, block: true }));
  },
};
