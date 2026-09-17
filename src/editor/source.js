// Source mode: the open page as raw markdown in CodeMirror, toggled with Ctrl+E, sharing the
// title strip, the save path and the conflict dialog with the block editor. Also the editor
// for non-markdown text files.
//
// Two things live here, both of them about the edges of the page:
//   - the CodeMirror host (`createSourceView`) and the per-page memory of the mode, and
//   - `plugins(ctx, o)`, the ProseMirror keymap for the seam between the title and the body.
//     It is in this file because extensions.js is the only way a module reaches the editor's
//     plugin list, and because a caret leaving the top of the body is the same kind of
//     question as a page leaving the block editor: where does the page begin.
//
// CodeMirror is already in the bundle: @milkdown/kit's code-mirror feature depends on every
// package imported below. No dependency was added.

import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, isolateHistory } from '@codemirror/commands';
import { SearchQuery, closeSearchPanel, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { Plugin, Selection } from '@milkdown/kit/prose/state';
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import { commands } from './host.js';
import { patchState, readState } from './deps.js';
import './source.css';

/** The api handed over by index.js at boot (registerExtensionCommands). */
let api = null;

// ---------------------------------------------------------------------------
// which pages open in source mode

/** Vault paths the user last left in source mode. Hydrated from `.ose/state.json` at boot. */
let remembered = null;
const REMEMBER_CAP = 200;

async function rememberedSet() {
  if (remembered) return remembered;
  const state = await readState();
  const list = Array.isArray(state.sourcePages) ? state.sourcePages : [];
  // The newest 200, the same end `rememberSource` writes: hydrating from the *oldest* 200 threw
  // away exactly the pages most likely to be opened again (QA F22).
  remembered = new Set(list.filter((p) => typeof p === 'string').slice(-REMEMBER_CAP));
  return remembered;
}

/** True when `path` was left in source mode. Awaited once per open; the set is in memory. */
export async function wasInSource(path) {
  if (!path) return false;
  return (await rememberedSet()).has(path);
}

/** Remember (or forget) that `path` is in source mode. */
export async function rememberSource(path, on) {
  if (!path) return;
  const set = await rememberedSet();
  if (on === set.has(path)) return;
  if (on) set.add(path); else set.delete(path);
  const list = [...set].slice(-REMEMBER_CAP);
  remembered = new Set(list);
  await patchState({ sourcePages: list });
}

/** A rename moves the memory with the file, so a moved page does not forget its mode. */
export async function renameRemembered(from, to) {
  const set = await rememberedSet();
  if (!set.has(from)) return;
  set.delete(from);
  set.add(to);
  await patchState({ sourcePages: [...set].slice(-REMEMBER_CAP) });
}

// ---------------------------------------------------------------------------
// the CodeMirror host

/**
 * Colours come from tokens.css through `var()`; nothing here is a literal. CodeMirror's own
 * base theme is light-only and would show through in dark mode, so every surface, caret and
 * selection colour is stated.
 */
const theme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    backgroundColor: 'transparent',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-ui)',
  },
  '.cm-content': {
    padding: '0',
    // `--fg`, not the accent: the accent on the light ground is 2.94:1, under the 3:1 floor a
    // non-text element has to meet, on a line two pixels wide (ADV-N). The code block inside a
    // page already draws its caret in `--fg` (editor.css), so the two agree now as well.
    caretColor: 'var(--fg)',
    lineHeight: '1.7',
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--fg-3)',
    border: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-chrome-sm)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-2)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--sel)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '.cm-panels': {
    backgroundColor: 'var(--bg-2)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-chrome)',
  },
  '.cm-panels.cm-panels-bottom': { borderWidth: '1px 0 0' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-chrome)',
  },
  '.cm-panel.cm-search input': {
    background: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '2px var(--sp-2)',
  },
  '.cm-panel.cm-search button': {
    background: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    backgroundImage: 'none',
    padding: '2px var(--sp-2)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--amber-soft)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
});

/** Markdown highlighting in the app's own palette. Structure is weight, colour means a role. */
const highlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--fg)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--accent)' },
  { tag: tags.monospace, color: 'var(--fg-2)' },
  { tag: tags.quote, color: 'var(--fg-2)' },
  { tag: tags.list, color: 'var(--fg-2)' },
  { tag: tags.processingInstruction, color: 'var(--fg-3)' },
  { tag: tags.contentSeparator, color: 'var(--fg-3)' },
  { tag: tags.comment, color: 'var(--fg-3)' },
  { tag: tags.keyword, color: 'var(--accent-ink)' },
  { tag: tags.string, color: 'var(--ok-ink)' },
  { tag: tags.number, color: 'var(--info)' },
]);

/**
 * Tab.
 *
 * `indentWithTab`, which this used to bind, runs `indentMore`, and `indentMore` re-indents
 * whole lines whatever the selection is: with the caret in the middle of `    x = 1` it moved
 * the line's own indentation and carried the caret along with it, which is not what Tab means
 * in any editor a person arrives from (A, finding 11). With a range selected that *is* what
 * Tab means, so the range case is still `indentMore`, and Shift+Tab is still `indentLess` in
 * both cases.
 *
 * CodeMirror's own `insertTab` would be the obvious binding and cannot be used: it inserts a
 * literal tab character, and this app indents with spaces (`indentUnit`, four for Python and
 * two for everything else). So the empty-selection case inserts the indent unit itself.
 */
const indentAtCaret = ({ state, dispatch }) => {
  // `indentMore` and `indentLess` open with this line and it is not decoration: a command that
  // dispatches a change into a read-only state writes into it, and Tab in a read-only editor
  // indented the first line (A's bench, section K, caught on the re-run).
  if (state.readOnly) return false;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore({ state, dispatch });
  dispatch(state.update(state.replaceSelection(state.facet(indentUnit)), {
    scrollIntoView: true, userEvent: 'input',
  }));
  return true;
};

/**
 * Mount CodeMirror into `host`.
 *
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {string} o.text            the whole file
 * @param {boolean} [o.markdown]     highlight as markdown (a `.md` page); plain text otherwise
 * @param {boolean} [o.gutter]       line numbers (on for non-markdown files)
 * @param {boolean} [o.readOnly]
 * @param {string} [o.placeholder]   the line shown while the buffer is empty
 * @param {string} [o.indent]        what Tab inserts; two spaces, the app's own, by default
 * @param {() => void} [o.onChange]  a user edit (never our own setText)
 * @param {() => void} [o.onEscape]  Escape with no search panel open
 */
export function createSourceView(o) {
  const editable = new Compartment();
  // The history lives in a compartment so `setText` can empty it. Reconfiguring an extension
  // rebuilds the state fields it provides from their `init`, and that is the only way to throw
  // CodeMirror's undo stack away — which loading a file into a view that mounted empty has to
  // do, or Ctrl+Z walks back into the empty buffer and the next save writes it (A, finding 1).
  const historian = new Compartment();
  let quiet = false;                                   // true while setText replaces the doc

  const view = new EditorView({
    parent: o.host,
    state: EditorState.create({
      doc: String(o.text ?? ''),
      extensions: [
        historian.of(history()),
        drawSelection(),
        highlightSpecialChars(),
        bracketMatching(),
        indentUnit.of(o.indent || '  '),
        EditorView.lineWrapping,
        search({ top: false }),
        o.gutter ? lineNumbers() : [],
        o.markdown === false ? [] : markdown(),
        syntaxHighlighting(highlight, { fallback: true }),
        placeholder(o.placeholder || 'Empty file'),
        theme,
        keymap.of([
          {
            key: 'Escape',
            run: (v) => {
              if (searchPanelOpen(v.state)) return closeSearchPanel(v);
              if (typeof o.onEscape === 'function') { o.onEscape(); return true; }
              return false;
            },
          },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          { key: 'Tab', run: indentAtCaret, shift: indentLess },
        ]),
        editable.of([EditorState.readOnly.of(!!o.readOnly), EditorView.editable.of(!o.readOnly)]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || quiet) return;
          if (typeof o.onChange === 'function') o.onChange();
        }),
      ],
    }),
  });

  const clearHistory = () => {
    view.dispatch({ effects: historian.reconfigure([]) });
    view.dispatch({ effects: historian.reconfigure(history()) });
  };

  return {
    view,
    getText: () => view.state.doc.toString(),
    /**
     * Replace the whole document. Answers **true when the document actually changed**, so a
     * caller can tell a real replacement from a no-op and mark itself dirty accordingly
     * (A, finding 4).
     *
     * `history` says what the replacement is:
     *   `'isolate'` (the default) — an edit like any other, but a step of its own in the undo
     *     stack, so one Ctrl+Z takes it back and lands on what the user had. That is what
     *     "Reload from disk" needs: the edits the user just agreed to lose are one undo away,
     *     instead of being swallowed into the same history event as the typing that preceded
     *     them (A, finding 12).
     *   `'drop'` — not an edit at all. The transaction is kept out of the history and the
     *     history is emptied behind it. Loading a file into a view that mounted empty is this:
     *     without it, the load was undo step one of every path-backed editor and Ctrl+Z twice
     *     left an empty buffer the next save wrote to disk (A, finding 1).
     */
    setText(text, opts = {}) {
      const next = String(text ?? '');
      if (next === view.state.doc.toString()) return false;
      const mode = opts.history || 'isolate';
      quiet = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          annotations: mode === 'drop'
            ? Transaction.addToHistory.of(false)
            : isolateHistory.of('full'),
        });
        if (mode === 'drop') clearHistory();
      } finally { quiet = false; }
      return true;
    },
    /**
     * Throw the undo stack away. Reconfiguring an extension rebuilds the state fields it
     * provides from their `init`, which is the only way CodeMirror offers to empty a history.
     * `setText(…, { history: 'drop' })` calls it; the code editor calls it on its own after a
     * load that did *not* replace the buffer, because nothing before that moment was an edit
     * the user would want back (A, finding 1).
     */
    clearHistory,
    setReadOnly(on) {
      view.dispatch({
        effects: editable.reconfigure([EditorState.readOnly.of(!!on), EditorView.editable.of(!on)]),
      });
    },
    focus: () => view.focus(),
    /**
     * CodeMirror's own search panel, opened the way the block editor's bar opens (C1, S22):
     * `query` seeds the field outright — a vault-search hit hands its term over and expects to
     * see it highlighted (N36) — and `replace: true` puts the caret in the replacement field,
     * which is what Ctrl+H means here. The panel is CodeMirror's, so replace is already in it;
     * the argument used to be ignored altogether (QA F5/F6).
     */
    openFind({ query = null, replace = false } = {}) {
      openSearchPanel(view);
      // After the panel exists, not before: `openSearchPanel` re-seeds the query from the
      // selection when it finds a panel whose field is not focused.
      if (typeof query === 'string' && query) {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query })) });
      }
      const panel = view.dom.querySelector('.cm-search');
      if (!panel) return;
      // The replace row is not built on a read-only page; the search field always is.
      const field = (replace && panel.querySelector('input[name="replace"]'))
        || panel.querySelector('input[name="search"]');
      if (field instanceof HTMLInputElement) { field.focus(); field.select(); }
    },
    closeFind: () => { closeSearchPanel(view); },
    findOpen: () => searchPanelOpen(view.state),
    /** Caret onto file line `n` (1-based), column `col` (1-based), scrolled into view. */
    goToLine(n, col) {
      const line = Math.max(1, Math.min(Math.floor(Number(n) || 1), view.state.doc.lines));
      const at = view.state.doc.line(line);
      const offset = Math.max(0, Math.min(Math.floor(Number(col) || 1) - 1, at.length));
      view.dispatch({ selection: { anchor: at.from + offset }, scrollIntoView: true });
      view.focus();
    },
    destroy() { try { view.destroy(); } catch (e) { console.error('[editor] source destroy', e); } },
  };
}

// ---------------------------------------------------------------------------
// the top edge of the body (L10, L19)

/**
 * The keys that only mean something at the very start of the body.
 *
 * `o.onLeaveTop()` takes the caret to the end of the title and answers true when there was a
 * title to take it to; `o.onSelectAll()` widens a whole-document selection to the title as
 * well and answers true when it did. Both are supplied by index.js, which owns the title strip;
 * the harness supplies neither, so the plugin does nothing there.
 */
export function plugins(ctx, o) {
  const opts = o || {};
  if (typeof opts.onLeaveTop !== 'function' && typeof opts.onSelectAll !== 'function') return [];

  /**
   * The first position the caret can hold in the document. `Selection.atStart` walks into the
   * first block whatever it is — the first list item, the first cell, the first quoted
   * paragraph — and stops on the block itself when it is an atom, which is where a gap cursor
   * sits. Asking `firstChild.isTextblock` instead answered 1 for a paragraph and 0 for
   * everything else, and no caret inside a list can be at 0, so the whole way back to the
   * title was missing on any page that did not open with a paragraph (QA defect 4).
   */
  const topOf = (state) => {
    const at = Selection.atStart(state.doc);
    return at ? at.from : 0;
  };

  const atTop = (state) => state.selection.empty && state.selection.from <= topOf(state);

  /** A whole-document selection: what a second Ctrl+A leaves behind (P3's blocks.js). */
  const wholeDoc = (state) =>
    state.selection.from <= 1 && state.selection.to >= state.doc.content.size - 1;

  const leaveTop = () => (typeof opts.onLeaveTop === 'function' ? !!opts.onLeaveTop() : false);

  return [new Plugin({
    props: {
      handleKeyDown: keydownHandler({
        ArrowUp: (state) => (atTop(state) ? leaveTop() : false),
        Backspace: (state) => {
          if (!atTop(state)) return false;
          // Never at the top of a list or a blockquote: Backspace there lifts the block out,
          // which is the base keymap's job and much more useful than leaving the body.
          const first = state.doc.firstChild;
          if (!first || !first.isTextblock) return false;
          return leaveTop();
        },
        'Mod-a': (state) => {
          if (!wholeDoc(state) || typeof opts.onSelectAll !== 'function') return false;
          return !!opts.onSelectAll();
        },
      }),
    },
  })];
}

// ---------------------------------------------------------------------------
// the command

export function registerCommands(a) {
  api = a;
  commands.register({
    id: 'page.source-toggle',
    title: 'Toggle source mode',
    group: 'page',
    shortcut: 'Ctrl+E',
    // `hasPage` only: a file that is not markdown has one mode, and `toggleSource` says so in
    // its own words. Guarding on `canToggleSource` here made that sentence unreachable — the
    // chord fell through to the shell's generic "not available here" instead (QA F20).
    when: () => !!(api && api.hasPage()),
    run: () => { if (api && api.toggleSource) void api.toggleSource(); },
  });
}
