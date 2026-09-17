// Formulas in the block editor: two nodes, two node views, two input rules and the keys that
// reach them.
//
// A formula is an atom. The TeX lives in one attribute and nowhere else, so there is exactly one
// copy of it and the serializer writes that copy back:
//
//   math_inline  { value }   the TeX between the two `$`, as the file wrote it
//   math_block   { value }   everything between the two `$$`, newlines included, so `$$x$$` and
//                            `$$\nx\n$$` each write themselves back
//
// On screen the atom is the rendered MathML. Put the caret in it, or click it, and it shows its
// source instead: a small plain-text box in the code face, in the place the formula was, so
// nothing around it moves. Enter (inline), Escape, an arrow key out of either end, or the caret
// going anywhere else commits the source and renders it again. A display formula takes Enter as
// a new line, because `\begin{aligned}` cannot be written without one, and commits on Escape or
// on leaving. The commit is one transaction, so undo takes the formula back in one step.
//
// What is NOT here: the parsing rule and the renderer, which are math.js, because `render()` and
// the serializer need them and neither of those knows what a ProseMirror node is.

import { $nodeSchema, $remark } from '@milkdown/kit/utils';
import { InputRule, inputRules } from '@milkdown/kit/prose/inputrules';
import { keymap } from '@milkdown/kit/prose/keymap';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { commands } from './host.js';
import { renderMath, remarkOseMath } from './math.js';

export const INLINE = 'math_inline';
export const BLOCK = 'math_block';

/** The remark plugin: the syntax, both directions of the tree, and the escaping rule. */
export const remarkMath = $remark('os-math', () => remarkOseMath);

// ---------------------------------------------------------------------------
// schema

export const mathInlineSchema = $nodeSchema(INLINE, () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { value: { default: '', validate: 'string' } },
  // What a copy writes on the clipboard, and what the word count reads: the formula as it is
  // written in the file, dollars included.
  leafText: (node) => `$${node.attrs.value}$`,
  parseDOM: [{
    tag: `span[data-type="${INLINE}"]`,
    getAttrs: (dom) => ({ value: dom.dataset.value ?? '' }),
  }],
  toDOM: (node) => ['span', { 'data-type': INLINE, 'data-value': node.attrs.value, class: 'ose-math' }, node.attrs.value],
  parseMarkdown: {
    match: ({ type }) => type === 'inlineMath',
    runner: (state, node, type) => { state.addNode(type, { value: node.value ?? '' }); },
  },
  toMarkdown: {
    match: (node) => node.type.name === INLINE,
    runner: (state, node) => { state.addNode('inlineMath', undefined, node.attrs.value); },
  },
}));

export const mathBlockSchema = $nodeSchema(BLOCK, () => ({
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  isolating: true,
  attrs: { value: { default: '\n', validate: 'string' } },
  leafText: (node) => `$$${node.attrs.value}$$`,
  parseDOM: [{
    tag: `div[data-type="${BLOCK}"]`,
    getAttrs: (dom) => ({ value: dom.dataset.value ?? '\n' }),
  }],
  toDOM: (node) => ['div', { 'data-type': BLOCK, 'data-value': node.attrs.value, class: 'ose-math ose-math-display' }, node.attrs.value.trim()],
  parseMarkdown: {
    match: ({ type }) => type === 'mathBlock',
    runner: (state, node, type) => { state.addNode(type, { value: node.value ?? '' }); },
  },
  toMarkdown: {
    match: (node) => node.type.name === BLOCK,
    runner: (state, node) => { state.addNode('mathBlock', undefined, node.attrs.value); },
  },
}));

/** Everything crepe.js has to `use()` before `create()`. */
export const mathSchemas = [remarkMath, mathInlineSchema, mathBlockSchema];

// ---------------------------------------------------------------------------
// the node view

/** The TeX a display formula's source box shows, and the value a commit writes back. */
const blockValue = (tex, wasMultiline) =>
  (tex.includes('\n') || wasMultiline ? `\n${tex}\n` : tex);

class MathView {
  constructor(node, view, getPos, display) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.display = display;
    this.editing = false;
    this.box = null;
    this.dom = document.createElement(display ? 'div' : 'span');
    this.paint();
  }

  /** The rendered formula, in place of whatever is in the element now. */
  paint() {
    const out = renderMath(this.tex(), { display: this.display });
    this.dom.className = out.className;
    if (out.title) this.dom.title = out.title; else this.dom.removeAttribute('title');
    this.dom.replaceChildren(...out.childNodes);
  }

  tex() {
    const v = this.node.attrs.value || '';
    return this.display ? v.trim() : v;
  }

  /** Show the source. Idempotent, and never on a page that cannot be written. */
  edit() {
    if (this.editing || !this.view.editable) return;
    this.editing = true;
    const box = document.createElement(this.display ? 'div' : 'span');
    box.className = 'ose-math-src';
    box.contentEditable = 'plaintext-only';
    box.spellcheck = false;
    box.textContent = this.tex();
    box.title = this.display ? 'Escape to render' : 'Enter or Escape to render';
    box.addEventListener('keydown', (e) => this.onKey(e));
    box.addEventListener('blur', () => this.commit());
    this.box = box;
    this.dom.title = '';
    this.dom.removeAttribute('title');
    this.dom.className = this.display ? 'ose-math ose-math-display' : 'ose-math';
    this.dom.replaceChildren(box);
    box.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  onKey(e) {
    if (e.key === 'Escape' || (e.key === 'Enter' && (!this.display || e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      this.commit({ caret: 'after' });
      return;
    }
    // The way out of either end, so a formula is never a trap for the keyboard.
    if (e.key === 'ArrowRight' && this.atEnd()) { e.preventDefault(); this.commit({ caret: 'after' }); return; }
    if (e.key === 'ArrowLeft' && this.atStart()) { e.preventDefault(); this.commit({ caret: 'before' }); return; }
    // Everything else belongs to the box, including Ctrl+Z, which is the browser's own undo
    // over the source text. The document's undo takes the whole formula, after the commit.
    e.stopPropagation();
  }

  atStart() {
    const sel = getSelection();
    if (!sel || !sel.isCollapsed || !this.box) return false;
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(this.box);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length === 0;
  }

  atEnd() {
    const sel = getSelection();
    if (!sel || !sel.isCollapsed || !this.box) return false;
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(this.box);
    r.setStart(sel.anchorNode, sel.anchorOffset);
    return r.toString().length === 0;
  }

  /**
   * Put the source back into the document. One transaction, so one undo step; nothing at all
   * when the text did not change, so arrowing through a formula writes no history and marks
   * no page dirty.
   *
   * `opt.caret` is a key the user pressed to leave, and only then does the caret move and the
   * editor take the focus back: a commit that happens because the box lost the focus must not
   * pull it out of wherever the user just clicked.
   */
  commit(opt = {}) {
    if (!this.editing) return;
    this.editing = false;
    const typed = (this.box ? this.box.textContent : '').replace(/\r\n?/g, '\n');
    this.box = null;
    const tex = typed.trim();
    const value = this.display ? blockValue(tex, (this.node.attrs.value || '').includes('\n')) : tex;
    const pos = typeof this.getPos === 'function' ? this.getPos() : null;
    if (typeof pos !== 'number') { this.paint(); return; }
    if (!tex) { this.empty(pos, opt); return; }
    if (value === this.node.attrs.value) {
      this.paint();
      if (opt.caret) this.moveCaret(pos, opt.caret);
      return;
    }
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value });
    if (opt.caret) {
      const to = opt.caret === 'before' ? pos : pos + this.node.nodeSize;
      tr.setSelection(TextSelection.near(tr.doc.resolve(to), opt.caret === 'before' ? -1 : 1));
    }
    this.view.dispatch(tr);
    if (opt.caret) this.view.focus();
  }

  /**
   * A formula with nothing in it is not a formula. An inline one goes, and the sentence closes
   * over it; a display one leaves the empty paragraph it took the place of, so `$$` and then a
   * change of mind puts the caret back on an empty line instead of nowhere.
   */
  empty(pos, opt) {
    const { state } = this.view;
    const to = pos + this.node.nodeSize;
    const paragraph = this.display ? state.schema.nodes.paragraph.createAndFill() : null;
    const tr = paragraph ? state.tr.replaceWith(pos, to, paragraph) : state.tr.delete(pos, to);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1));
    this.view.dispatch(tr);
    if (opt.caret || this.display) this.view.focus();
  }

  moveCaret(pos, where) {
    const to = where === 'before' ? pos : pos + this.node.nodeSize;
    const tr = this.view.state.tr.setSelection(
      TextSelection.near(this.view.state.doc.resolve(to), where === 'before' ? -1 : 1));
    this.view.dispatch(tr);
    this.view.focus();
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.editing) this.paint();
    return true;
  }

  selectNode() { this.edit(); }
  deselectNode() { this.commit(); }
  stopEvent() { return this.editing; }
  ignoreMutation() { return true; }
  destroy() { this.editing = false; this.box = null; }
}

// ---------------------------------------------------------------------------
// input rules
//
// Two, and both are the pandoc rule again: the opening `$` is followed by a non-space and the
// closing one is preceded by one, so a price is never turned into a formula while it is typed.

const INLINE_RULE = /(?<![\\$])\$([^\s$](?:[^$]*[^\s$])?)\$$/;
const BLOCK_RULE = /^\$\$$/;

function mathInputRules(ctx) {
  return inputRules({
    rules: [
      new InputRule(INLINE_RULE, (state, match, start, end) => {
        const type = mathInlineSchema.type(ctx);
        if (!type || !state.doc.resolve(start).parent.type.spec.content) return null;
        return state.tr.replaceWith(start, end, type.create({ value: match[1] }));
      }),
      new InputRule(BLOCK_RULE, (state, match, start) => {
        const $start = state.doc.resolve(start);
        // Only on a line of its own: `$$` at the end of a sentence stays two dollars.
        if (!$start.parent.isTextblock || $start.parent.type.name !== 'paragraph') return null;
        if ($start.parent.textContent !== '$') return null;
        const from = $start.before();
        const tr = state.tr.replaceRangeWith(from, $start.after(), mathBlockSchema.type(ctx).create({ value: '\n' }));
        return tr.setSelection(NodeSelection.create(tr.doc, tr.mapping.map(from, -1)));
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// the keys that reach a formula
//
// ProseMirror walks over an inline atom as if it were one character, so without this an inline
// formula could only be opened with the mouse.

const isMath = (node) => !!node && (node.type.name === INLINE || node.type.name === BLOCK);

function selectSide(state, dispatch, dir) {
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return false;
  const $pos = sel.$from;
  const node = dir > 0 ? $pos.nodeAfter : $pos.nodeBefore;
  if (!isMath(node)) return false;
  const at = dir > 0 ? $pos.pos : $pos.pos - node.nodeSize;
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)));
  return true;
}

function mathKeymap() {
  return keymap({
    ArrowRight: (state, dispatch) => selectSide(state, dispatch, 1),
    ArrowLeft: (state, dispatch) => selectSide(state, dispatch, -1),
  });
}

const VIEW_KEY = new PluginKey('os-math-views');

/** extensions.js asks for this: the node views, the input rules and the keymap. */
export function plugins(ctx) {
  return [
    new Plugin({
      key: VIEW_KEY,
      props: {
        nodeViews: {
          [INLINE]: (node, view, getPos) => new MathView(node, view, getPos, false),
          [BLOCK]: (node, view, getPos) => new MathView(node, view, getPos, true),
        },
      },
    }),
    mathInputRules(ctx),
    mathKeymap(),
  ];
}

/** extensions.js asks for this once, at boot. */
export function registerCommands(api) {
  commands.register({
    id: 'page.math',
    title: 'Insert a formula',
    group: 'page',
    when: () => api.hasCrepe(),
    run: () => insertFormula(api),
  });
}

/**
 * A formula at the caret, with its source already open. A selection becomes the TeX, so
 * selecting `x^2` and running the command is the whole gesture.
 */
function insertFormula(api) {
  const view = api.getView();
  if (!view || !view.editable) return;
  const type = view.state.schema.nodes[INLINE];
  if (!type) return;
  const { from, to } = view.state.selection;
  const value = view.state.doc.textBetween(from, to, '', '').trim();
  const tr = view.state.tr.replaceWith(from, to, type.create({ value }));
  tr.setSelection(NodeSelection.create(tr.doc, tr.mapping.map(from, -1)));
  view.dispatch(tr);
  api.touch();
  view.focus();
}
