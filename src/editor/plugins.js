// Small ProseMirror plugins the page editor adds on top of Crepe (CONTRACT.md batch 9).
//
//   urlPastePlugin      a URL pasted over selected text links the text instead of replacing it
//   calloutPlugin       Obsidian's `> [!note] Title` gets a class; the text is left as typed
//   strikethroughRule   `~~x~~` typed becomes strikethrough; a single `~` never does
//
// None of these change what is written to disk. The paste handler only adds a mark the file
// format already has; the callout is a decoration, so `[!note]` stays in the document byte
// for byte; the input rule replaces one Crepe ships with a stricter one.

import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { markRule } from '@milkdown/kit/prose';
import { $inputRule } from '@milkdown/kit/utils';
import { strikethroughSchema } from '@milkdown/kit/preset/gfm';

// ---------------------------------------------------------------------------
// paste a URL over a selection (C10)

const URL_PASTE_KEY = new PluginKey('os-url-paste');
const BARE_URL = /^https?:\/\/\S+$/;

/**
 * The clipboard holds exactly one URL and the selection is text: wrap the selection in a link
 * to it. Everything else (an empty selection, several lines, HTML, a selection in a code
 * block) falls through to the default paste, which Milkdown's clipboard plugin handles. The
 * plugin is put first in `prosePluginsCtx` so it is asked before that one.
 */
export function urlPastePlugin() {
  return new Plugin({
    key: URL_PASTE_KEY,
    props: {
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data || !view.editable) return false;
        const text = (data.getData('text/plain') || '').trim();
        if (!text || !BARE_URL.test(text)) return false;
        const { state } = view;
        const sel = state.selection;
        if (sel.empty || !(sel instanceof TextSelection)) return false;
        if (sel.$from.parent.type.spec.code || sel.$to.parent.type.spec.code) return false;
        const link = state.schema.marks.link;
        if (!link) return false;
        // Spec-checked: a link inside a link is not markdown. Replace an existing one.
        const tr = state.tr.removeMark(sel.from, sel.to, link)
          .addMark(sel.from, sel.to, link.create({ href: text }));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// callouts (C15)

const CALLOUT_KEY = new PluginKey('os-callout');
/** Obsidian's marker: `[!note]`, `[!warning]`, `[!tip]-` (a fold sign may follow). */
const CALLOUT = /^\[!([A-Za-z][\w-]*)\][+-]?/;

/**
 * Every blockquote whose first paragraph starts with the marker gets the classes `callout`
 * and `callout-<word>` (lowercased), and the marker itself gets `callout-marker` so the
 * stylesheet can set it in mono. Positions: `pos` is before the blockquote, `pos + 1` is
 * inside it at its first child, `pos + 2` is inside that paragraph at text offset 0 — and
 * the marker is plain text at the very start, so text offsets are document positions.
 */
function calloutDecorations(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') return true;
    const first = node.firstChild;
    if (!first || !first.isTextblock) return true;
    const m = CALLOUT.exec(first.textContent);
    if (!m) return true;
    const word = m[1].toLowerCase();
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: `callout callout-${word}` }));
    decos.push(Decoration.inline(pos + 2, pos + 2 + m[0].length, { class: 'callout-marker' }));
    return true;
  });
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

/** Recomputed on every document change; a whole-document walk over pages this size is cheap. */
export function calloutPlugin() {
  return new Plugin({
    key: CALLOUT_KEY,
    state: {
      init: (_, state) => calloutDecorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? calloutDecorations(tr.doc) : old),
    },
    props: {
      decorations: (state) => CALLOUT_KEY.getState(state),
    },
  });
}

// ---------------------------------------------------------------------------
// strikethrough by typing (C4)

/**
 * Crepe's rule fires on one tilde as well as two (`~10 months~` would strike the text). The
 * vault writes `~` for "about", and GFM_OPTIONS already refuses a single tilde at parse time
 * (stringify.js), so the typing rule has to agree: `~~x~~` only.
 */
export const strikethroughRule = $inputRule((ctx) =>
  markRule(/(?<![\w:/~])(~~)([^~]+?)~~(?!\w|\/)$/, strikethroughSchema.type(ctx)));
