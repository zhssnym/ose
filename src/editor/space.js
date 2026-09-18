// Deliberate space, in the file and on the screen.
//
// A blank line separates two blocks: that is what markdown means by one, and remark writes
// exactly one between every pair of blocks. A SECOND blank line means nothing to markdown, and
// that is precisely why it is free to mean something here: it is space the writer put there.
// The rule, in one line:
//
//   a run of N blank lines between two blocks is N minus 1 empty paragraphs of space.
//
// So `a\n\nb` is two paragraphs, `a\n\n\nb` is two paragraphs with one empty line between them,
// and `a\n\n\n\nb` has two. Enter twice at the end of a paragraph leaves one line of space, as
// in Word. Nothing sweeps anything: what is on screen is in the file, and what is in the file
// is on screen. The empty paragraph is a real block — the caret goes in it, Backspace takes it
// away, typing fills it.
//
// Three pieces carry that, and they are the whole of it:
//
//   readSpace   a remark transformer: after the file is parsed, the blank lines remark threw
//               away are read back off the source positions and put in as empty paragraphs.
//   spaceJoin   the mdast-util-to-markdown `join` rule: an empty paragraph writes nothing, so
//               it is the SEPARATOR after it that is shortened to a single newline. One empty
//               paragraph therefore costs exactly one more blank line than none.
//   trailing    the landing pad: the empty paragraph the editor keeps after a block that cannot
//               hold a caret (a table, a code block, a formula). It is the editor's own, not
//               the file's, so it is tagged here and left out of what is written.
//
// Where the rule does NOT apply: inside a list item and inside a table cell, where a blank line
// already means something to markdown (it makes a list loose) and stealing it would change the
// document. Inside a blockquote it does apply, because a blockquote's blank line is written
// `>` on a line of its own and carries back and forth cleanly.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { $remark } from '@milkdown/kit/utils';

// ---------------------------------------------------------------------------
// reading: the blank lines of the file, back into the tree

/** Where space is space and not markdown. A list item and a table cell are not here. */
const SPACED_PARENT = new Set(['root', 'blockquote']);

const emptyParagraph = () => ({ type: 'paragraph', children: [] });

/**
 * How many blank lines the source has between these two offsets, or -1 when what is there is
 * not blank at all. The `>` of a quoted line counts as blank: it is the blockquote's marker,
 * not content, and an empty line inside a blockquote is written exactly `>`.
 */
function blankRun(source, from, to) {
  if (!(to > from)) return 0;
  const text = source.slice(from, to);
  if (/[^\s>]/.test(text)) return -1;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

const offsets = (node) => (node && node.position && node.position.start
  && typeof node.position.start.offset === 'number' ? node.position : null);

/**
 * One container's children, with the space between them put back.
 *
 * Between two blocks the first blank line is the separator markdown needs, so N newlines in the
 * gap leave N minus 2 empty paragraphs. After the last block the newline that ends its own line
 * is not space either, so N newlines leave N minus 1. Before the first block there is nothing
 * to pay for and N newlines leave N: the line above the first block is not the end of anything.
 *
 * `from` and `to` are where the container's own content starts and ends, which for the root is
 * the whole file.
 */
function readContainer(node, source, from, to) {
  const kids = node.children;
  if (!kids || !kids.length) return;
  const out = [];
  const pad = (n) => { for (let i = 0; i < n; i++) out.push(emptyParagraph()); };

  const first = offsets(kids[0]);
  if (first) pad(Math.max(0, blankRun(source, from, first.start.offset)));

  for (let i = 0; i < kids.length; i++) {
    out.push(kids[i]);
    const a = offsets(kids[i]);
    const b = offsets(kids[i + 1]);
    if (!a || !b) continue;
    pad(Math.max(0, blankRun(source, a.end.offset, b.start.offset) - 2));
  }

  const last = offsets(kids[kids.length - 1]);
  if (last) pad(Math.max(0, blankRun(source, last.end.offset, to) - 1));

  node.children = out;
}

/** Walk the tree, deepest first, so an inserted paragraph is never walked into. */
function readSpace(node, source, root) {
  if (!node || !node.children) return;
  for (const child of node.children) readSpace(child, source, false);
  if (!SPACED_PARENT.has(node.type)) return;
  // The root's own position can stop short of the trailing newlines; the file's length cannot.
  const here = offsets(node);
  if (root) readContainer(node, source, 0, source.length);
  else if (here) readContainer(node, source, here.start.offset, here.end.offset);
}

/** The remark plugin: the blank lines of the source, as empty paragraphs. */
function remarkOseSpace() {
  return (tree, file) => {
    const source = String(file ?? '');
    if (!source) return;
    readSpace(tree, source, true);
  };
}

export const remarkSpace = $remark('os-space', () => remarkOseSpace);

// ---------------------------------------------------------------------------
// writing: what an empty paragraph costs

const isEmptyParagraphNode = (n) => !!n && n.type === 'paragraph' && !(n.children && n.children.length);

/**
 * The `join` rule handed to remark-stringify (stringify.js). mdast writes an empty paragraph as
 * the empty string and puts a blank line on each side of it, which would make one empty
 * paragraph cost three blank lines instead of two. Returning 0 asks for a single newline after
 * it, so the arithmetic is exact: n empty paragraphs between two blocks, n plus 1 blank lines.
 *
 * mdast-util-to-markdown walks the join list backwards, so this one is asked before its own
 * defaults and the list-looseness rule below it is never reached for an empty paragraph.
 */
export const spaceJoin = (left) => (isEmptyParagraphNode(left) ? 0 : undefined);

// ---------------------------------------------------------------------------
// the landing pad
//
// A document that ends in a table, a code block, a display formula or an image has nowhere to
// put the caret after it, so the editor keeps one empty paragraph at the end. Milkdown's own
// trailing plugin did that and crepe.js takes it out in favour of the one below, for one reason:
// now that an empty paragraph is written, the pad has to be told apart from an empty paragraph
// the file actually contains, and no rule about the SHAPE of the document can do it (a file
// ending `- item\n\n` holds a real one in exactly the place a pad would sit). So the pad is
// remembered instead. It is the editor's own furniture: it is never written, and it comes back
// by itself the next time the page is built.

const PAD = new PluginKey('os-trailing-pad');

/** A block one cannot type after. Milkdown's own rule, kept as it is. */
const needsPad = (doc) => {
  const last = doc.lastChild;
  return !!last && last.type.name !== 'paragraph' && last.type.name !== 'heading';
};

const isEmptyBlock = (node) => !!node && node.type.name === 'paragraph' && node.content.size === 0;

/** True while the last block of the document is the pad this plugin put there. */
function hasPad(state) {
  try { return !!PAD.getState(state) && isEmptyBlock(state.doc.lastChild); } catch { return false; }
}

/**
 * The document as it should be written: the pad taken off the end. Null when there is nothing
 * to take off, and null when the pad is all there is, because a document needs one block.
 */
export function docWithoutPad(state) {
  if (!hasPad(state)) return null;
  const { doc } = state;
  if (doc.childCount < 2) return null;
  return doc.copy(doc.content.cut(0, doc.content.size - doc.lastChild.nodeSize));
}

export function plugins() {
  return [new Plugin({
    key: PAD,
    state: {
      // False, not `needsPad`: the pad is not there until the transaction below puts it there.
      init: () => false,
      apply(tr, was, _old, next) {
        if (tr.getMeta(PAD)) return true;
        if (!tr.docChanged) return was;
        // The pad stays the editor's while it is still the last block and still empty. Type in
        // it, or put anything after it, and it is a paragraph like any other from then on.
        return was && isEmptyBlock(next.doc.lastChild);
      },
    },
    appendTransaction(_trs, _old, state) {
      if (!needsPad(state.doc)) return null;
      const para = state.schema.nodes.paragraph.createAndFill();
      if (!para) return null;
      // Outside the history: the pad is not something the user did, so Ctrl+Z never walks back
      // through it.
      return state.tr.insert(state.doc.content.size, para)
        .setMeta(PAD, 'added')
        .setMeta('addToHistory', false);
    },
  })];
}
