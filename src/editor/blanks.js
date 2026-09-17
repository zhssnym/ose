// Empty paragraphs, and the promise the editor used to break.
//
// What happened before. Press Enter twice and two empty paragraphs appear and stay on screen.
// The serializer never writes them: `postProcess` (stringify.js) keeps the owner's own rule that
// no file has two blank lines in a row, so the autosave 600ms later writes the file without the
// gap and says nothing. The screen still shows it, and goes on showing it until the page is
// built again from the file, which happens on a navigation, on Ctrl+R, on a mode switch, or when
// anything outside touches the file and the watcher reloads the page. The owner runs Claude Code
// over the vault while he writes, so for him that last one arrives a few seconds later, and the
// text "jumbles up again".
//
// What happens now. An empty paragraph is a place to type, not a quantity of space: it lives
// while the caret is in it and goes the moment the caret leaves. The screen and the file agree
// at every keystroke, so nothing is ever taken back later. Four things are never touched: the
// last block of the document, which is where one types next; an empty paragraph inside a list
// item, a table cell or anything else that is not the document or a blockquote; the only child
// of the block it is in, which cannot be removed without emptying that block; and anything the
// selection is touching.
//
// The sweep is one transaction outside the history, so undo never walks back through a line the
// user did not put there. Ctrl+Z takes back what was typed, not the gaps around it.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state';

const KEY = new PluginKey('os-blank-lines');

/** Where an empty paragraph is allowed to be swept from. */
const SWEEPABLE_PARENT = new Set(['doc', 'blockquote']);

/**
 * Every empty paragraph that should not be on screen any more, outermost last, so deleting them
 * in order leaves the earlier positions valid.
 */
function stale(state) {
  const { doc, selection } = state;
  const out = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name === 'code_block' || node.type.name === 'table') return false;
    if (node.type.name !== 'paragraph') return true;
    if (node.content.size !== 0) return false;
    if (!parent || !SWEEPABLE_PARENT.has(parent.type.name)) return false;
    // The last block of the document is where the caret goes next; a block's only child cannot
    // go at all without leaving the block empty.
    if (parent.childCount < 2) return false;
    if (parent.type.name === 'doc' && index === parent.childCount - 1) return false;
    // Touched by the selection, caret included: the user is there.
    if (selection.from <= pos + node.nodeSize && selection.to >= pos) return false;
    out.push({ pos, size: node.nodeSize });
    return false;
  });
  return out;
}

export function plugins() {
  return [new Plugin({
    key: KEY,
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((tr) => tr.docChanged || tr.selectionSet)) return null;
      const list = stale(newState);
      if (!list.length) return null;
      const tr = newState.tr;
      for (let i = list.length - 1; i >= 0; i--) tr.delete(list[i].pos, list[i].pos + list[i].size);
      // Outside the history: the gaps were never in the file, so undo has nothing to put back
      // and the user never has to press Ctrl+Z twice for one word.
      return tr.setMeta('addToHistory', false);
    },
  })];
}
