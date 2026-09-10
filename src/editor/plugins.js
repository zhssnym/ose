// Small ProseMirror plugins the page editor adds on top of Crepe (CONTRACT.md batch 9).
//
//   urlPastePlugin      a URL pasted over selected text links the text instead of replacing it
//   calloutPlugin       Obsidian's `> [!note] Title` gets a class; the text is left as typed
//   strikethroughRule   `~~x~~` typed becomes strikethrough; a single `~` never does
//   findPlugin          find in page (C1): every match decorated, the current one marked
//
// None of these change what is written to disk. The paste handler only adds a mark the file
// format already has; the callout is a decoration, so `[!note]` stays in the document byte
// for byte; the input rule replaces one Crepe ships with a stricter one; find only reads.

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

// ---------------------------------------------------------------------------
// find in page (C1)

export const FIND_KEY = new PluginKey('os-find');

const EMPTY_FIND = { query: '', hits: [], index: -1, decos: DecorationSet.empty, caseSensitive: false, wholeWord: false };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The matcher for one query. `wholeWord` is a look-around on letters, digits and underscore
 * rather than `\b`, so it means the same thing on a French word as on an English one; the `u`
 * flag makes the classes match accented letters.
 */
function findRe(query, { caseSensitive = false, wholeWord = false } = {}) {
  const body = escapeRe(query);
  const pattern = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(pattern, caseSensitive ? 'gu' : 'giu');
}

/**
 * Every `[from, to)` where `query` occurs, case-insensitively, in document order. Each
 * textblock is searched on its own text with every inline leaf (an image, a hard break)
 * standing in as one character, so a text offset is a document offset: `pos + 1` is the
 * block's first character. Code blocks are textblocks too, so their text is searched — the
 * CodeMirror node view has no contentDOM, so a hit inside one is counted and can be jumped
 * to, but its decoration is not drawn.
 */
function findHits(doc, query, opts) {
  if (!query) return [];
  let re;
  try { re = findRe(query, opts); } catch { return []; }
  const hits = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, '\ufffc');
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) hits.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
    return false;
  });
  return hits;
}

function findDecorations(doc, hits, index) {
  if (!hits.length) return DecorationSet.empty;
  return DecorationSet.create(doc, hits.map((h, i) =>
    Decoration.inline(h.from, h.to, { class: i === index ? 'find-hit current' : 'find-hit' })));
}

/** The first hit at or after `pos`, wrapping to the first; -1 when there are none. */
function hitAtOrAfter(hits, pos) {
  if (!hits.length) return -1;
  const i = hits.findIndex((h) => h.from >= pos);
  return i < 0 ? 0 : i;
}

/**
 * State: `{query, hits, index, decos}`. Rebuilt only on a find transaction (meta on FIND_KEY:
 * `{query}` to search, `{step: ±1}` to move, `{clear: true}` to stop) or when the document
 * changes under a live query; every other transaction returns the same object. Moving the
 * selection is the bar's job (find.js), not the plugin's, so a plain caret move never fights
 * a decoration update — and the toolbar Crepe shows on a non-empty selection is never
 * triggered: the current hit is a decoration, the selection a caret at its start.
 */
export function findPlugin() {
  return new Plugin({
    key: FIND_KEY,
    state: {
      init: () => EMPTY_FIND,
      apply(tr, prev) {
        const meta = tr.getMeta(FIND_KEY);
        if (meta && meta.clear) return EMPTY_FIND;
        if (meta && typeof meta.query === 'string') {
          const query = meta.query;
          const caseSensitive = !!meta.caseSensitive;
          const wholeWord = !!meta.wholeWord;
          if (!query) return { ...EMPTY_FIND, caseSensitive, wholeWord };
          const opts = { caseSensitive, wholeWord };
          const hits = findHits(tr.doc, query, opts);
          const same = query === prev.query && caseSensitive === prev.caseSensitive && wholeWord === prev.wholeWord;
          // A replacement says where it left off; a new query starts at the caret; the same
          // one typed again keeps its place.
          const index = typeof meta.at === 'number' ? hitAtOrAfter(hits, meta.at)
            : (same && prev.index >= 0 && prev.index < hits.length
              ? prev.index : hitAtOrAfter(hits, tr.selection.from));
          return { query, hits, index, decos: findDecorations(tr.doc, hits, index), ...opts };
        }
        if (meta && meta.step && prev.hits.length) {
          const n = prev.hits.length;
          const index = (prev.index + meta.step + n) % n;
          return { ...prev, index, decos: findDecorations(tr.doc, prev.hits, index) };
        }
        if (tr.docChanged && prev.query) {
          const hits = findHits(tr.doc, prev.query, prev);
          const index = hits.length ? Math.min(Math.max(prev.index, 0), hits.length - 1) : -1;
          return { ...prev, hits, index, decos: findDecorations(tr.doc, hits, index) };
        }
        return prev;
      },
    },
    props: {
      decorations: (state) => FIND_KEY.getState(state).decos,
    },
    // The bar (find.js) keeps its count in step by listening for this on the page column;
    // the plugin knows nothing about the bar.
    view: () => ({
      update(view, prev) {
        if (FIND_KEY.getState(view.state) === FIND_KEY.getState(prev)) return;
        view.dom.dispatchEvent(new CustomEvent('os-find', { bubbles: true }));
      },
    }),
  });
}

/** The plugin state for a view, or the empty state when the plugin is not installed. */
export const findState = (state) => FIND_KEY.getState(state) || EMPTY_FIND;
