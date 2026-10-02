// Source mode: the open page as raw markdown in CodeMirror, toggled with Ctrl+E, sharing the
// title strip, the save path and the conflict dialog with the block editor. Also the editor
// for non-markdown text files.
//
// Two things live here, both of them about the edges of the page:
//   - the CodeMirror host (`createSourceView`), and
//   - `plugins(ctx, o)`, the ProseMirror keymap for the seam between the title and the body.
//     It is in this file because extensions.ts is the only way a module reaches the editor's
//     plugin list, and because a caret leaving the top of the body is the same kind of
//     question as a page leaving the block editor: where does the page begin.
//
// CodeMirror is already in the bundle: @milkdown/kit's code-mirror feature depends on every
// package imported below. No dependency was added.

import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, isolateHistory } from '@codemirror/commands';
import { SearchQuery, closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { Plugin, Selection } from '@milkdown/kit/prose/state';
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import { HIGHLIGHT } from './highlight.ts';
import { commands } from './host.ts';
import './source.css';

/** The api handed over by page/commands.ts at boot (registerExtensionCommands). */
let api: any = null;

// ---------------------------------------------------------------------------
// the bytes CodeMirror does not keep (M3)
//
// CodeMirror splits its document on `\r\n`, `\r` and `\n` alike and joins it back with `\n`,
// and a byte-order mark is a character it draws. So the text a view hands back is never quite
// the file: a CRLF page came out LF from end to end after one keystroke in source mode, and a
// BOM was either drawn as a red dot or lost. A page's source view is built with `exact: true`
// and keeps the file's own shape here: the mark, and the separator each line had. `getText`
// puts them back the way composeDoc does for the rich view (doc.ts `restoreEols`): the lines
// before the first difference and after the last one keep theirs, every line in between gets
// the file's usual ending.

/**
 * The shape of `raw`: `{bom, lines, seps, eol, plain}`. `lines` and `seps` are split exactly
 * where CodeMirror splits, so line `i` of the view is `lines[i]` until someone edits it.
 * `plain` is a file with no mark and nothing but `\n`, which needs nothing put back.
 */
export function textFormat(raw: string) {
  let text = String(raw ?? '');
  const bom = text.charCodeAt(0) === 0xFEFF;
  if (bom) text = text.slice(1);
  const lines: any[] = [];
  const seps: any[] = [];
  const count = { '\n': 0, '\r\n': 0, '\r': 0 };
  const re = /\r\n|\r|\n/g;
  let at = 0;
  let m;
  while ((m = re.exec(text))) {
    lines.push(text.slice(at, m.index));
    seps.push(m[0]);
    count[m[0]]++;
    at = re.lastIndex;
  }
  lines.push(text.slice(at));
  let eol = '\n';
  if (count['\r\n'] > count['\n'] && count['\r\n'] >= count['\r']) eol = '\r\n';
  else if (count['\r'] > count['\n'] && count['\r'] > count['\r\n']) eol = '\r';
  return { bom, lines, seps, eol, plain: !bom && count['\r\n'] === 0 && count['\r'] === 0 };
}

/**
 * `text` (what a view holds, lines joined by `\n`) with the mark and the line endings of the
 * file `fmt` was taken from. A pure LF file without a mark comes back exactly as it went in.
 */
export function applyFormat(text: string, fmt: ReturnType<typeof textFormat> | null) {
  const out = String(text ?? '');
  if (!fmt || fmt.plain) return out;
  const A = fmt.lines;
  const B = out.split('\n');
  const n = Math.min(A.length, B.length);
  let p = 0;
  while (p < n && A[p] === B[p]) p++;
  let s = 0;
  while (s < n - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  // The separator after line i: its own while the line is in the untouched head or tail, the
  // file's usual one otherwise. `own` says which, for the pass below.
  const seps: string[] = [];
  const own: boolean[] = [];
  for (let i = 0; i < B.length - 1; i++) {
    const j = i < p ? i : i >= B.length - s ? A.length - (B.length - i) : -1;
    const mine = j >= 0 && j < fmt.seps.length ? fmt.seps[j] : undefined;
    seps.push(mine || fmt.eol);
    own.push(!!mine);
  }
  // A `\r`, an empty line and a `\n` read back as one CRLF: two line breaks would become one,
  // and every line after them would move up. That only happens where an edit put two
  // separators of different kinds side by side in a file of mixed endings; the one that is
  // not a line's own gives way (the property tests' edit locality).
  for (let i = 0; i + 1 < seps.length; i++) {
    if (seps[i] !== '\r' || B[i + 1] !== '' || seps[i + 1] !== '\n') continue;
    if (!own[i + 1]) seps[i + 1] = '\r';
    else seps[i] = '\r\n';
  }
  let r = '';
  for (let i = 0; i < B.length; i++) {
    r += B[i];
    if (i < seps.length) r += seps[i];
  }
  return (fmt.bom ? '\uFEFF' : '') + r;
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
 * The very small IDE. What a file of code gets and a page of prose does not.
 *
 * Nothing here is invented: every extension is already in the bundle and is the stock
 * CodeMirror one. What it adds, in the order it is written:
 *
 *   - a language slot, empty until `setLanguage` fills it. The grammar is what makes every
 *     other line of this list mean anything: `syntaxHighlighting` has tokens to colour,
 *     `indentOnInput` knows the word that closes a block, `Mod-/` knows what a comment looks
 *     like, and bracket matching stops guessing.
 *   - HIGHLIGHT, the app's own token classes, not a fallback: it stands in front of the
 *     markdown style below, which a code file never uses anyway.
 *   - brackets that close as they are typed, a line that re-indents itself, a stripe under the
 *     caret's line, and the other occurrences of whatever is selected marked faintly.
 *   - more than one cursor: the facet has to say so, and with it Ctrl+Alt+Up and Down
 *     (`defaultKeymap`), Ctrl+D (`searchKeymap`) and Ctrl+click all work.
 *
 * Deliberately not here: completion, lint, a fold gutter, a minimap. A small editor for
 * reading and fixing a file, not a workbench.
 */
function ide(lang) {
  return [
    lang.of([]),
    syntaxHighlighting(HIGHLIGHT),
    closeBrackets(),
    indentOnInput(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorState.allowMultipleSelections.of(true),
  ];
}

/**
 * Mount CodeMirror into `host`.
 *
 * @param o.text            the whole file
 * @param o.markdown     highlight as markdown (a `.md` page); plain text otherwise
 * @param o.code         a file of code: the small IDE above, and `setLanguage`
 * @param o.gutter       line numbers (on for non-markdown files)
 * @param o.placeholder   the line shown while the buffer is empty
 * @param o.indent        what Tab inserts; two spaces, the app's own, by default
 * @param o.exact       keep the file's BOM and line endings (M3): `getText` hands
 *                                  back the file's own bytes, not CodeMirror's `\n` join
 * @param o.onChange  a user edit (never our own setText)
 * @param o.onEscape  Escape with no search panel open
 */
export function createSourceView(o: { host: HTMLElement; text: string; markdown?: boolean; code?: boolean; gutter?: boolean; readOnly?: boolean; placeholder?: string; indent?: string; exact?: boolean; onChange?: () => void; onEscape?: () => void; }) {
  const editable = new Compartment();
  const lang = new Compartment();
  // The history lives in a compartment so `setText` can empty it. Reconfiguring an extension
  // rebuilds the state fields it provides from their `init`, and that is the only way to throw
  // CodeMirror's undo stack away — which loading a file into a view that mounted empty has to
  // do, or Ctrl+Z walks back into the empty buffer and the next save writes it (A, finding 1).
  const historian = new Compartment();
  let quiet = false;                                   // true while setText replaces the doc
  // The file's own shape, for an `exact` view (M3): taken from every text loaded into it.
  let fmt = o.exact ? textFormat(o.text) : null;
  const inView = (text) => (fmt ? fmt.lines.join('\n') : String(text ?? ''));

  const view = new EditorView({
    parent: o.host,
    state: EditorState.create({
      doc: inView(o.text),
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
        o.code ? ide(lang) : [],
        syntaxHighlighting(highlight, { fallback: true }),
        placeholder(o.placeholder || 'Empty file'),
        theme,
        // One keymap, in order, because within one `keymap.of` the first binding that answers
        // wins. `closeBracketsKeymap` has to stand before `defaultKeymap` so that Backspace
        // between an empty pair takes both halves instead of one; ordering them here is what
        // the standalone editor used to do from the outside with `Prec.high`.
        keymap.of([
          {
            key: 'Escape',
            run: (v) => {
              if (searchPanelOpen(v.state)) return closeSearchPanel(v);
              if (typeof o.onEscape === 'function') { o.onEscape(); return true; }
              return false;
            },
          },
          ...(o.code ? closeBracketsKeymap : []),
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
    /** The buffer as the file would hold it: with its BOM and line endings when `exact`. */
    getText: () => (fmt ? applyFormat(view.state.doc.toString(), fmt) : view.state.doc.toString()),
    /** The buffer as CodeMirror holds it, lines joined by `\n`: for counting, never for writing. */
    viewText: () => view.state.doc.toString(),
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
    setText(text, opts: any = {}) {
      // A text put in from outside is a file's text: an exact view takes its shape from it.
      if (o.exact) fmt = textFormat(text);
      const next = inView(text);
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
     * Replace the document with `text` by the smallest change that gets there (wave 2, H7, H5):
     * the common head and tail are left alone, so the caret and the selection map through the
     * change instead of jumping to the top. A text from outside (the disk's, a merge) is not
     * something the user typed: it stays out of the undo history (Ctrl+Z would otherwise revert
     * it, and autosave write the old text over the disk) and `onChange` is not called, unless
     * `opts.edit` says it is one (a link rewritten in place), which is one undoable step.
     * An exact view takes the file's shape from `text`, as `setText` does. Answers true when
     * the document changed.
     */
    replaceText(text, opts: any = {}) {
      if (o.exact) fmt = textFormat(text);
      const next = inView(text);
      const cur = view.state.doc.toString();
      if (next === cur) return false;
      const n = Math.min(cur.length, next.length);
      let a = 0;
      while (a < n && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
      let b = 0;
      while (b < n - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
      quiet = !opts.edit;
      try {
        view.dispatch({
          changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) },
          // Not an edit: outside the undo history, so Ctrl+Z never reverts the other program's
          // change and autosaves over it; the user's earlier steps map through it instead.
          annotations: opts.edit
            ? isolateHistory.of('full')
            : [isolateHistory.of('full'), Transaction.addToHistory.of(false)],
        });
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
    /**
     * Put a grammar in, or take it out with `null`. The pack loads a language over the network
     * of chunks, long after the file is already on screen, so this is always a second step and
     * never a reason to wait: the text is readable from the first frame and gains its colours
     * when the grammar lands. Does nothing when the view was not built with `code: true`.
     */
    setLanguage(support) {
      if (!o.code) return false;
      view.dispatch({ effects: lang.reconfigure(support || []) });
      return true;
    },
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
    /**
     * The first file line (1-based) whose top is in view: what the Reading view opens at when it
     * takes the place of this editor (wave 3, X3). The editor's own scroller when it has one,
     * else the page's, is what "in view" is measured against.
     */
    topLine() {
      try {
        const rect = view.scrollDOM.getBoundingClientRect();
        let top = Math.max(0, rect.top);
        for (let el = view.dom.parentElement; el; el = el.parentElement) {
          const cs = getComputedStyle(el);
          if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) {
            top = Math.max(top, el.getBoundingClientRect().top);
            break;
          }
        }
        const block = view.lineBlockAtHeight(top - view.documentTop);
        return view.state.doc.lineAt(block.from).number;
      } catch {
        return 1;
      }
    },
    /** Caret onto file line `n` (1-based), column `col` (1-based), scrolled into view. */
    goToLine(n, col?) {
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
 * well and answers true when it did. Both are supplied by the page editor, which owns the
 * title strip; with neither, the plugin does nothing.
 */
export function plugins(_ctx, o) {
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

  /** A whole-document selection: what a second Ctrl+A leaves behind (P3's blocks.ts). */
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
  // The words a person types into the palette looking for this are "source", "raw" and
  // "markdown", so the title carries all three (H14). The three modes have commands of their
  // own (page.ts: `page.mode-rich`, `page.mode-source`); this chord goes
  // between Source and the mode the page was in before it (wave 3, §4.5).
  commands.register({
    id: 'page.source-toggle',
    title: 'Switch between source (raw markdown) and the editing view',
    group: 'page',
    shortcut: 'Ctrl+E',
    // `hasPage` only: a file that is not markdown has one mode, and `toggleSource` says so in
    // its own words. Guarding on `canToggleSource` here made that sentence unreachable — the
    // chord fell through to the shell's generic "not available here" instead (QA F20).
    when: () => !!(api && api.hasPage()),
    run: () => (api && api.toggleSource ? api.toggleSource() : undefined),
  });
}
