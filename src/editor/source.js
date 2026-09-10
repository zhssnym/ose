// Source mode (batch 12, package P5): the open page as raw markdown in CodeMirror, toggled
// with Ctrl+E, sharing the title strip, the save path and the conflict dialog with the block
// editor. Also the editor for non-markdown text files. See docs/CONTRACT.md batch 12 "Source".
//
// Two things live here, both of them about the edges of the page:
//   - the CodeMirror host (`createSourceView`) and the per-page memory of the mode, and
//   - `plugins(ctx, o)`, the ProseMirror keymap for the seam between the title and the body
//     (L10, L19). It is in this file because extensions.js is the only way a module reaches
//     the editor's plugin list, and because a caret leaving the top of the body is the same
//     kind of question as a page leaving the block editor: where does the page begin.
//
// CodeMirror is already in the bundle: @milkdown/kit's code-mirror feature depends on every
// package imported below. No dependency was added.

import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeSearchPanel, openSearchPanel, search, searchKeymap, searchPanelOpen } from '@codemirror/search';
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { Plugin } from '@milkdown/kit/prose/state';
import { keydownHandler } from '@milkdown/kit/prose/keymap';
import { commands } from '../registry.js';
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
  remembered = new Set(list.filter((p) => typeof p === 'string').slice(0, REMEMBER_CAP));
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
  await patchState({ sourcePages: [...set] });
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
    caretColor: 'var(--accent)',
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
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
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
 * Mount CodeMirror into `host`.
 *
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {string} o.text            the whole file
 * @param {boolean} [o.markdown]     highlight as markdown (a `.md` page); plain text otherwise
 * @param {boolean} [o.gutter]       line numbers (on for non-markdown files)
 * @param {boolean} [o.readOnly]
 * @param {() => void} [o.onChange]  a user edit (never our own setText)
 * @param {() => void} [o.onEscape]  Escape with no search panel open
 */
export function createSourceView(o) {
  const editable = new Compartment();
  let quiet = false;                                   // true while setText replaces the doc

  const view = new EditorView({
    parent: o.host,
    state: EditorState.create({
      doc: String(o.text ?? ''),
      extensions: [
        history(),
        drawSelection(),
        highlightSpecialChars(),
        bracketMatching(),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        search({ top: false }),
        o.gutter ? lineNumbers() : [],
        o.markdown === false ? [] : markdown(),
        syntaxHighlighting(highlight, { fallback: true }),
        placeholder('Empty file'),
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
          indentWithTab,
        ]),
        editable.of([EditorState.readOnly.of(!!o.readOnly), EditorView.editable.of(!o.readOnly)]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || quiet) return;
          if (typeof o.onChange === 'function') o.onChange();
        }),
      ],
    }),
  });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      const next = String(text ?? '');
      if (next === view.state.doc.toString()) return;
      quiet = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      } finally { quiet = false; }
    },
    setReadOnly(on) {
      view.dispatch({
        effects: editable.reconfigure([EditorState.readOnly.of(!!on), EditorView.editable.of(!on)]),
      });
    },
    focus: () => view.focus(),
    openFind: () => { openSearchPanel(view); },
    closeFind: () => { closeSearchPanel(view); },
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

  /** The first position the caret can hold in the document. */
  const topOf = (state) => {
    const first = state.doc.firstChild;
    if (!first) return 1;
    // A leaf (a code block's node view, an image) has no text position of its own inside it.
    return first.isTextblock ? 1 : 0;
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
    when: () => !!(api && api.hasPage() && api.canToggleSource && api.canToggleSource()),
    run: () => { if (api && api.toggleSource) void api.toggleSource(); },
  });
}
