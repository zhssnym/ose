// Block keys: selecting, deleting and moving whole blocks with the keyboard.
//
// CONTRACT.md batch 5, "Block keys (editor)":
//
//   Esc                     select the block the caret is in (the list item inside a list)
//   Esc again, or a click   back to a text caret
//   Backspace / Delete      remove the selected block(s), caret into the neighbour
//   Shift+Up / Shift+Down   extend the selection to the previous / next block
//   Ctrl+Shift+Backspace    delete the current block without selecting first
//   Ctrl+Shift+Up / Down    move the current block (or the selection) up or down
//
// None of it fires inside a code block (CodeMirror keeps its keys) or while the slash menu is
// open.
//
// How a selection of several blocks is represented: the plugin state holds one flat range
// `{from, to, head}` in document positions, where `from` and `to` are the outer positions of
// the first and last selected sibling nodes and `head` says which end the arrows move. That
// range is the truth: it is what the decorations paint, what Backspace deletes and what
// Ctrl+Shift+Arrow moves, so a deletion always removes whole nodes and can never merge two
// blocks into one. The editor's own selection is kept in step for the sake of ProseMirror and
// the browser — a NodeSelection when the range holds exactly one node, otherwise a TextSelection
// spanning it — but nothing here reads it back except as a starting point.

import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { slashMenuOpen } from './slash.js';

export const BLOCK_KEY = new PluginKey('os-block-keys');

// ---------------------------------------------------------------------------
// where a block starts and ends

/**
 * The block a position sits in: the innermost list item when inside a list, otherwise the
 * top-level node (depth 1). Returns outer positions, so `from` is before the node's opening
 * token and `to` after its closing one.
 */
export function blockAt($pos) {
  if (!$pos || $pos.depth < 1) return null;
  let depth = 1;
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === 'list_item') { depth = d; break; }
  }
  return { from: $pos.before(depth), to: $pos.after(depth), head: 'end' };
}

/** The range the keys act on: the block selection, a node selection, else the caret's block. */
export function actingRange(state) {
  const s = BLOCK_KEY.getState(state);
  if (s) return s;
  const sel = state.selection;
  if (sel instanceof NodeSelection) return { from: sel.from, to: sel.to, head: 'end' };
  return blockAt(sel.$from);
}

/** Every node lying directly in `[from, to)`, with its start position. */
function nodesIn(doc, from, to) {
  const out = [];
  let pos = from;
  while (pos < to) {
    const node = doc.nodeAt(pos);
    if (!node) break;
    out.push({ node, pos });
    pos += node.nodeSize;
  }
  return out;
}

// ---------------------------------------------------------------------------
// applying a range

/** Dispatch a new block selection (or `null` to drop it) and keep the editor selection in step. */
function setRange(view, range, extra) {
  const tr = (extra || view.state.tr).setMeta(BLOCK_KEY, range || null);
  if (range) {
    const nodes = nodesIn(tr.doc, range.from, range.to);
    const single = nodes.length === 1;
    let sel = null;
    if (single && NodeSelection.isSelectable(nodes[0].node)) {
      try { sel = NodeSelection.create(tr.doc, range.from); } catch { sel = null; }
    }
    if (!sel) sel = TextSelection.between(tr.doc.resolve(range.from), tr.doc.resolve(range.to));
    tr.setSelection(sel);
  }
  tr.scrollIntoView();
  view.dispatch(tr);
  if (!view.hasFocus()) view.focus();
  return true;
}

/** Back to a text caret at the end the arrows were last moving. */
function collapse(view) {
  const s = BLOCK_KEY.getState(view.state);
  const range = s || actingRange(view.state);
  if (!range) return false;
  const tr = view.state.tr.setMeta(BLOCK_KEY, null);
  const at = range.head === 'start' ? range.from : range.to;
  tr.setSelection(Selection.near(tr.doc.resolve(at), range.head === 'start' ? 1 : -1));
  view.dispatch(tr);
  view.focus();
  return true;
}

// ---------------------------------------------------------------------------
// the four actions

export function selectBlock(view) {
  const range = actingRange(view.state);
  if (!range) return false;
  return setRange(view, { from: range.from, to: range.to, head: 'end' });
}

/**
 * The whole body, from a block selection (L19). Notion's widening: Esc selects the block,
 * Ctrl+A from there takes the body. `index.js` (P5) carries the next press on to the title,
 * and reads an `AllSelection` — what Milkdown's own `selectAll` leaves — as the signal.
 */
export function selectBody(view) {
  const tr = view.state.tr.setMeta(BLOCK_KEY, null);
  tr.setSelection(new AllSelection(tr.doc));
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Grow or shrink the range by one sibling at the head end. */
function extend(view, dir) {
  const { state } = view;
  const cur = BLOCK_KEY.getState(state) || actingRange(state);
  if (!cur) return false;
  let { from, to, head } = cur;
  const doc = state.doc;
  const nodes = nodesIn(doc, from, to);
  if (!nodes.length) return false;

  if (head === 'end') {
    if (dir > 0) {
      const after = doc.resolve(to).nodeAfter;
      if (!after) return setRange(view, cur);
      to += after.nodeSize;
    } else if (nodes.length > 1) {
      to = nodes[nodes.length - 1].pos;                 // give the last one back
    } else {
      const before = doc.resolve(from).nodeBefore;
      if (!before) return setRange(view, cur);
      from -= before.nodeSize;
      head = 'start';
    }
  } else {
    if (dir < 0) {
      const before = doc.resolve(from).nodeBefore;
      if (!before) return setRange(view, cur);
      from -= before.nodeSize;
    } else if (nodes.length > 1) {
      from += nodes[0].node.nodeSize;                   // give the first one back
    } else {
      const after = doc.resolve(to).nodeAfter;
      if (!after) return setRange(view, cur);
      to += after.nodeSize;
      head = 'end';
    }
  }
  return setRange(view, { from, to, head });
}

/** Remove the range and put the caret in the block after it, or before it at the end. */
export function deleteRange(view) {
  const { state } = view;
  const range = actingRange(state);
  if (!range) return false;
  const whole = range.from <= 0 && range.to >= state.doc.content.size;
  const tr = state.tr;
  if (whole) {
    // The document may not be empty: `doc` is `block+`. Leave one paragraph behind.
    const empty = state.schema.nodes.paragraph.createAndFill();
    tr.replaceWith(range.from, range.to, empty ? [empty] : []);
  } else {
    tr.delete(range.from, range.to);
  }
  tr.setMeta(BLOCK_KEY, null);
  const at = Math.max(0, Math.min(range.from, tr.doc.content.size));
  const $at = tr.doc.resolve(at);
  const near = Selection.near($at, 1);
  tr.setSelection(near instanceof TextSelection ? near : Selection.near($at, -1));
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

/**
 * Copy the range in below itself and put the caret in the copy (E28, Ctrl+D). A block
 * selection stays a block selection, over the copy.
 */
export function duplicateRange(view) {
  const { state } = view;
  const range = actingRange(state);
  if (!range) return false;
  const slice = state.doc.slice(range.from, range.to);
  const held = BLOCK_KEY.getState(state);
  const offset = state.selection.from - range.from;
  const tr = state.tr.insert(range.to, slice.content);
  const at = range.to;
  const moved = { from: at, to: at + (range.to - range.from), head: range.head || 'end' };
  if (held) return setRange(view, moved, tr);
  tr.setMeta(BLOCK_KEY, null);
  const caret = Math.max(0, Math.min(at + offset, tr.doc.content.size));
  tr.setSelection(Selection.near(tr.doc.resolve(caret), 1));
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Move the range over its neighbouring sibling, keeping whatever was selected selected. */
export function moveRange(view, dir) {
  const { state } = view;
  const range = actingRange(state);
  if (!range) return false;
  const sibling = dir < 0 ? state.doc.resolve(range.from).nodeBefore : state.doc.resolve(range.to).nodeAfter;
  if (!sibling) return true;                              // nowhere to go, but the key is ours
  const held = BLOCK_KEY.getState(state);
  const offset = state.selection.from - range.from;
  const slice = state.doc.slice(range.from, range.to);

  const tr = state.tr.delete(range.from, range.to);
  const at = dir < 0 ? range.from - sibling.nodeSize : range.from + sibling.nodeSize;
  tr.insert(at, slice.content);
  const moved = { from: at, to: at + (range.to - range.from), head: range.head || 'end' };
  if (held) return setRange(view, moved, tr);
  tr.setMeta(BLOCK_KEY, null);
  const caret = Math.max(0, Math.min(at + offset, tr.doc.content.size));
  tr.setSelection(Selection.near(tr.doc.resolve(caret), 1));
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

// ---------------------------------------------------------------------------
// when the keys are ours

/** Code blocks keep their own keys, and so does an open menu. */
function busy(view, event) {
  if (!view.editable) return true;
  if (slashMenuOpen()) return true;
  if (document.querySelector('.os-slash[data-show="true"]')) return true;
  const t = event.target;
  if (t instanceof Element && t.closest('.cm-editor, .milkdown-code-block, pre')) return true;
  const $from = view.state.selection.$from;
  if ($from.parent && $from.parent.type.spec.code) return true;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'code_block') return true;
  return false;
}

function handleKeyDown(view, event) {
  // An IME conversion is not a gesture: while a composition is running, Escape and the arrows
  // belong to the candidate window (E44).
  if (event.isComposing || event.keyCode === 229) return false;
  if (busy(view, event)) return false;
  const key = event.key;
  const mod = event.ctrlKey || event.metaKey;
  const held = BLOCK_KEY.getState(view.state);

  // D2/L21: while a block is selected, a printable character does not replace it. The
  // selection collapses to a caret at the end of the block first, and the character is then
  // typed there by the browser — losing a paragraph to a stray Esc is not an editor's job.
  if (held && !mod && key.length === 1) { collapse(view); return false; }

  // Notion's widening (L19): from a block selection, Ctrl+A takes the whole body.
  if (held && mod && !event.shiftKey && !event.altKey && key.toLowerCase() === 'a') return selectBody(view);

  if (mod && event.shiftKey && !event.altKey) {
    if (key === 'Backspace' || key === 'Delete') return deleteRange(view);
    if (key === 'ArrowUp') return moveRange(view, -1);
    if (key === 'ArrowDown') return moveRange(view, 1);
    return false;
  }
  if (mod || event.altKey) return false;

  if (key === 'Escape') return held ? collapse(view) : selectBlock(view);

  const onNode = held || view.state.selection instanceof NodeSelection;
  if (!onNode) return false;
  if (key === 'Backspace' || key === 'Delete') return deleteRange(view);
  if (event.shiftKey && key === 'ArrowUp') return extend(view, -1);
  if (event.shiftKey && key === 'ArrowDown') return extend(view, 1);
  if (held && (key === 'Enter' || key === 'Home' || key === 'End'
      || key === 'PageUp' || key === 'PageDown' || key.startsWith('Arrow'))) return collapse(view);
  return false;
}

// ---------------------------------------------------------------------------
// the plugin

/** `crepe.js` concatenates this onto `prosePluginsCtx`, next to the slash plugin. */
export function blockKeysPlugin() {
  return new Plugin({
    key: BLOCK_KEY,
    state: {
      init: () => null,
      apply(tr, prev) {
        const meta = tr.getMeta(BLOCK_KEY);
        if (meta !== undefined) return meta || null;
        if (!prev) return null;
        if (tr.docChanged) return null;                 // any edit ends it
        if (tr.selectionSet) {
          // ProseMirror re-reads the DOM selection whenever the window loses or regains
          // focus; that lands inside the range we already hold and must not drop it. A real
          // move out of the range does. Clicks are ended by the mousedown handler, arrows by
          // the keymap, so both still collapse to a caret.
          const { from, to } = tr.selection;
          return from >= prev.from && to <= prev.to ? prev : null;
        }
        return prev;
      },
    },
    props: {
      handleKeyDown,
      handleDOMEvents: {
        mousedown: (view) => {
          if (BLOCK_KEY.getState(view.state)) view.dispatch(view.state.tr.setMeta(BLOCK_KEY, null));
          return false;
        },
      },
      // A block selection is not a text selection: hide the native highlight under it.
      attributes: (state) => (BLOCK_KEY.getState(state) ? { class: 'os-blocksel' } : null),
      decorations(state) {
        const s = BLOCK_KEY.getState(state);
        if (!s) return null;
        const decos = nodesIn(state.doc, s.from, s.to)
          .map(({ node, pos }) => Decoration.node(pos, pos + node.nodeSize, { class: 'os-block-sel' }));
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
    },
  });
}
