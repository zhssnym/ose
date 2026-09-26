// `createLiveView`: the Live editor itself, CodeMirror 6 over the whole file.
//
// The file text is the only truth (state.js). The page host (page.js) treats a LiveView the
// way it treats the source view: `getText()` is what a save writes, `setText` and
// `replaceMinimal` put a text from outside in, `onChange` fires for the user's edits only.
// Decorations draw over the text and never touch it: inline ones over the visible ranges
// (inline.js), block ones from a state field (blocks.js), both under the reveal rule
// (reveal.js).
//
// Nothing but a user gesture changes the document, and every dispatch made here says so with
// a user event under `input.live.*` or `select.live.*`. Building decorations never dispatches.

import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, drawSelection, dropCursor, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, isolateHistory } from '@codemirror/commands';
import { SearchQuery, closeSearchPanel, openSearchPanel, search, searchKeymap, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { ensureSyntaxTree, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { textFormat } from '../source.js';
import { HIGHLIGHT } from '../highlight.js';
import { collect } from './registry.js';
import { coreExtensions, docOf, liveText, setFormat } from './state.js';
import { frontmatterRange, wikiParts } from './syntax.js';
import { focusTracking, revealedSpans, revealer, revealing } from './reveal.js';
import { buildInline } from './inline.js';
import { blockField, openFrontmatter, redraw } from './blocks.js';
import { toggleFromWidget } from './tasks.js';
import { liveKeymap, runCommand } from './commands.js';
import { wikiCompletion } from './complete.js';
import { makeInlineHtml, missingImageBox } from './cellhtml.js';

/**
 * @typedef {object} LiveOptions
 * @property {HTMLElement} host
 * @property {string} text                 the whole file as read: BOM and CR/CRLF kept
 * @property {string} path                 vault path or abs: path (resolution, never I/O)
 * @property {boolean} [readOnly]
 * @property {boolean} [spellcheck]
 * @property {LiveSnapshot} [restore]
 * @property {(src: string) => string | null} resolveAsset
 * @property {(target: string) => { path: string | null, exists: boolean }} [resolveWikilink]
 * @property {(href: string, o: { newTab: boolean }) => void} onOpenLink
 * @property {(file: File) => Promise<string | null>} [saveAttachment]   vault path, or null = refused
 * @property {(vaultPath: string) => string} [linkTo]                      href from this file
 * @property {() => void} onChange          a user edit only (never setText, never replaceMinimal without edit)
 * @property {() => void} [onFocus]
 * @property {() => void} [onBlur]
 * @property {() => void} [onEscape]        Escape with no panel open
 * @property {(s: { from: number, to: number, line: number }) => void} [onSelection]
 * @property {readonly import('./registry.js').LiveWidget[]} [widgets]   index.js hands WIDGETS in
 * @property {((ctx: import('./registry.js').PasteContext) => import('@codemirror/state').Extension) | null} [paste]
 * @property {() => readonly string[] | Promise<readonly string[]>} [pages]   the vault's page paths, for `[[`
 *                                          completion (complete.js); without it, no completion
 */

/** @typedef {{ mode: 'live', from: number, to: number, scrollTop: number }} LiveSnapshot */

/**
 * @typedef {object} LiveView
 * @property {EditorView} view
 * @property {() => string} getText         applyFormat(doc.toString(), fmt): the bytes a save writes
 * @property {() => string} viewText        doc.toString(): counting only, never writing
 * @property {(text: string, o?: { history?: 'isolate' | 'drop' }) => boolean} setText
 * @property {(text: string, o?: { edit?: boolean }) => boolean} replaceMinimal
 * @property {(on: boolean) => void} setReadOnly     freeze and unfreeze (H1)
 * @property {(on: boolean) => void} setSpellcheck
 * @property {() => void} focus
 * @property {() => boolean} hasFocus
 * @property {() => void} refresh           after park/reattach, or when a wikilink's target may have
 *                                          appeared: re-measure and redraw
 * @property {(o?: { query?: string, replace?: boolean }) => void} openFind
 * @property {() => void} closeFind
 * @property {() => boolean} findOpen
 * @property {(line: number, col?: number) => boolean} goToLine   1-based file line
 * @property {() => number} topLine         first visible file line, 1-based
 * @property {() => { from: number, to: number }} selection
 * @property {(s: { from: number, to: number }) => void} setSelection
 * @property {() => string | null} linkAtCaret
 * @property {() => LiveSnapshot} snapshot
 * @property {(id: string) => boolean} run  an id of LIVE_COMMANDS; false = not applicable here
 * @property {() => void} destroy
 */

/**
 * The CodeMirror surfaces, stated in tokens: its base theme is light-only. Live reads as the
 * document it is, so the text is in the document face at the body size, as in Rich; code and
 * raw frontmatter go monospace in live.css.
 */
const theme = EditorView.theme({
  '&': { color: 'var(--fg)', backgroundColor: 'transparent', fontFamily: 'var(--font-doc)', fontSize: 'var(--fs-body)' },
  '.cm-content': { padding: '0', caretColor: 'var(--fg)', lineHeight: 'var(--lh-body)', fontFamily: 'var(--font-doc)' },
  '.cm-scroller': { fontFamily: 'var(--font-doc)', lineHeight: 'var(--lh-body)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: 'var(--fg-3)' },
  '.cm-panels': {
    backgroundColor: 'var(--bg-2)', color: 'var(--fg)', border: '1px solid var(--border)',
    fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-chrome)',
  },
  '.cm-panels.cm-panels-bottom': { borderWidth: '1px 0 0' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-chrome)',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', backgroundImage: 'none', padding: 'var(--sp-half) var(--sp-2)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--amber-soft)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  // The `[[` completion list (complete.js), in the palette's surface.
  '.cm-tooltip': {
    backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-menu)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-chrome)', maxHeight: '20em', padding: 'var(--sp-1) 0',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: 'var(--sp-half) var(--sp-3)', lineHeight: 'var(--lh-body)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--fg)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionDetail': { color: 'var(--fg-3)', fontStyle: 'normal', marginLeft: 'var(--sp-2)' },
});


/** True on a Mac, as the rest of the app decides it. */
const onMac = () => {
  const os = document.documentElement.dataset.os;
  return os ? os === 'mac' : /mac/i.test(navigator.platform || navigator.userAgent || '');
};

/**
 * The nearest ancestor that scrolls the page, or the editor's own scroller.
 * @param {EditorView} view
 */
function scrollerOf(view) {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el).overflowY;
    if (s === 'auto' || s === 'scroll') return el;
  }
  return view.scrollDOM;
}

/**
 * Mount Live into `o.host`.
 * @param {LiveOptions} o
 * @returns {LiveView}
 */
export function createLiveView(o) {
  const collected = collect(o.widgets || []);
  const editable = new Compartment();
  const spell = new Compartment();
  const historian = new Compartment();
  let quiet = false;                       // true while a text from outside goes in
  const fmt = textFormat(o.text);
  const doc = docOf(fmt);
  const path = o.path || '';

  /**
   * The href a wikilink stands for, from this page: through `resolveWikilink` and `linkTo`
   * when the page gave them, else the target as a relative page (`.md` added), which the
   * router opens or offers to create.
   * @param {string} ref   `target#heading`
   */
  const wikiHref = (ref) => {
    const parts = wikiParts(`[[${ref}]]`);
    const frag = parts.heading ? `#${encodeURIComponent(parts.heading)}` : '';
    if (!parts.target) return frag;
    try {
      const r = o.resolveWikilink ? o.resolveWikilink(parts.target) : null;
      if (r && r.path && o.linkTo) return o.linkTo(r.path) + frag;
    } catch { /* fall through to the written target */ }
    const target = /\.[A-Za-z0-9]{1,8}$/.test(parts.target) ? parts.target : `${parts.target}.md`;
    return target.split('/').map((s) => encodeURIComponent(s)).join('/') + frag;
  };

  /** @param {string} href @param {{ newTab: boolean }} x */
  const openLink = (href, x) => { if (href) o.onOpenLink(href, x); };

  /** @param {string} src */
  const resolveAsset = (src) => { try { return o.resolveAsset ? o.resolveAsset(src) : null; } catch { return null; } };

  /** @type {Omit<import('./inline.js').Env, 'revealed'>} */
  const base = {
    collected,
    path,
    resolveAsset,
    resolveWikilink: o.resolveWikilink || null,
    openLink,
    // A table cell reads like the rest of Live: maths, wikilinks, images through the vault.
    inlineHtml: makeInlineHtml({ resolveAsset, resolveWikilink: o.resolveWikilink || null }),
    toggleTask: toggleFromWidget,
    openFrontmatter,
  };

  const inlinePlugin = ViewPlugin.fromClass(class {
    /** @param {EditorView} view */
    constructor(view) { this.decorations = this.build(view); }
    /** @param {import('@codemirror/view').ViewUpdate} u */
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet
        || syntaxTree(u.state) !== syntaxTree(u.startState)
        || u.transactions.some((tr) => tr.effects.some((e) => e.is(redraw)))
        || revealing(u.state) !== revealing(u.startState)) {
        this.decorations = this.build(u.view);
      }
    }
    /** @param {EditorView} view */
    build(view) {
      // Parse at least what is on screen, within a small budget; the parser keeps going in
      // the background and its progress arrives as a new tree, which rebuilds.
      ensureSyntaxTree(view.state, view.viewport.to, 20);
      return buildInline(view.state, view.visibleRanges, { ...base, revealed: revealer(revealedSpans(view.state)) });
    }
  }, { decorations: (v) => v.decorations });

  /** Clicks on links: follow, a new tab with the modifier, and Alt places the caret. */
  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0 || e.altKey) return false;
      const t = e.target instanceof Element ? e.target.closest('[data-href], [data-wiki]') : null;
      if (!(t instanceof HTMLElement) || !view.contentDOM.contains(t)) return false;
      const mod = onMac() ? e.metaKey : e.ctrlKey;
      if (!mod && !t.classList.contains('cm-live-follow')) return false;
      const href = t.dataset.href != null ? t.dataset.href : wikiHref(t.dataset.wiki || '');
      e.preventDefault();
      openLink(href, { newTab: mod });
      return true;
    },
  });

  /**
   * An image drawn inside a widget's HTML (a table cell) that fails to load becomes the
   * "Missing image" box, as widgets/image.js does for its own. `error` does not bubble, so it
   * is caught on the way down.
   */
  const onImageError = (/** @type {Event} */ e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.closest('.cm-live-table')) return;
    const want = img.getAttribute('data-live-src') || img.getAttribute('src') || '';
    img.replaceWith(missingImageBox(want));
    view.requestMeasure();
  };

  /** Tab indents a list item and claims the key everywhere else (D2): focus never walks out. */
  const tab = (/** @type {boolean} */ shift) => (/** @type {EditorView} */ view) => {
    if (view.state.readOnly) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const listy = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/.test(line.text);
    if (!listy && !view.state.selection.ranges.some((r) => !r.empty)) return true;
    const command = shift ? indentLess : indentMore;
    command({
      state: view.state,
      dispatch: (tr) => view.dispatch(tr.startState.update({
        changes: tr.changes, selection: tr.selection, userEvent: 'input.live.indent',
      })),
    });
    return true;
  };

  const blocks = blockField(base);

  /**
   * Up and Down step *into* a drawn block (a table, the frontmatter, a maths block) instead of
   * over it. CodeMirror moves a caret past a block widget in one step, which would leave a
   * table's source out of reach of the keyboard; here the caret lands on the block's edge,
   * which reveals it raw, and the next press moves through its lines as usual.
   */
  const intoBlock = (/** @type {-1 | 1} */ dir) => (/** @type {EditorView} */ view) => {
    const { state } = view;
    const main = state.selection.main;
    if (!main.empty || state.selection.ranges.length > 1) return false;
    const line = state.doc.lineAt(main.head);
    const next = view.moveVertically(main, dir > 0);
    if (state.doc.lineAt(next.head).number === line.number) return false;
    const deco = state.field(blocks).deco;
    let edge = -1;
    if (dir > 0) {
      const lo = Math.min(state.doc.length, line.to + 1);
      deco.between(lo, next.head, (f, t, v) => {
        if (edge < 0 && v.spec.block && t > f && f >= lo && f <= next.head) edge = f;
      });
    } else {
      const hi = Math.max(0, line.from - 1);
      deco.between(next.head, hi, (f, t, v) => {
        if (v.spec.block && t > f && t <= hi && t >= next.head) edge = Math.max(edge, t);
      });
    }
    if (edge < 0) return false;
    view.dispatch({ selection: { anchor: edge }, scrollIntoView: true, userEvent: 'select.live.block' });
    return true;
  };

  /** @param {boolean} on */
  const editableExt = (on) => [EditorState.readOnly.of(!on), EditorView.editable.of(on)];
  /** @param {boolean} on */
  const spellExt = (on) => EditorView.contentAttributes.of({
    spellcheck: on ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off',
  });

  // The caret starts where it was left, else on the first line after the frontmatter, so a page
  // opens with its properties folded rather than revealed.
  let anchor = 0;
  let head = 0;
  if (o.restore && typeof o.restore.from === 'number') {
    anchor = Math.max(0, Math.min(doc.length, o.restore.from));
    head = Math.max(0, Math.min(doc.length, typeof o.restore.to === 'number' ? o.restore.to : anchor));
  } else {
    const fm = frontmatterRange(doc);
    if (fm) anchor = head = Math.min(doc.length, fm.to + 1);
  }

  /** @type {LiveView} */
  let api;
  const view = new EditorView({
    parent: o.host,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [
        coreExtensions(fmt, collected),
        focusTracking,
        historian.of(history()),
        drawSelection(),
        dropCursor(),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        search({ top: false }),
        wikiCompletion(o.pages, path),
        syntaxHighlighting(HIGHLIGHT),
        blocks,
        inlinePlugin,
        clicks,
        collected.extensions,
        o.paste ? o.paste({
          path,
          saveAttachment: o.saveAttachment || (async () => null),
          linkTo: o.linkTo || ((p) => p),
        }) : [],
        placeholder('Empty page'),
        EditorView.editorAttributes.of({ class: 'cm-live' }),
        spell.of(spellExt(!!o.spellcheck)),
        editable.of(editableExt(!o.readOnly)),
        liveKeymap((id) => api.run(id)),
        keymap.of([
          {
            key: 'Escape',
            run: (v) => {
              if (searchPanelOpen(v.state)) return closeSearchPanel(v);
              if (typeof o.onEscape === 'function') { o.onEscape(); return true; }
              return false;
            },
          },
          { key: 'Tab', run: tab(false), shift: tab(true) },
          { key: 'ArrowUp', run: intoBlock(-1) },
          { key: 'ArrowDown', run: intoBlock(1) },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !quiet && typeof o.onChange === 'function') o.onChange();
          if (u.focusChanged) {
            const fn = u.view.hasFocus ? o.onFocus : o.onBlur;
            if (typeof fn === 'function') fn();
          }
          if (u.selectionSet && typeof o.onSelection === 'function') {
            const m = u.state.selection.main;
            o.onSelection({ from: m.from, to: m.to, line: u.state.doc.lineAt(m.head).number });
          }
        }),
        theme,
      ],
    }),
  });

  view.contentDOM.addEventListener('error', onImageError, true);

  if (o.restore && o.restore.scrollTop > 0) {
    const top = o.restore.scrollTop;
    requestAnimationFrame(() => {
      if (!view.dom.isConnected) return;
      const sc = scrollerOf(view);
      sc.scrollTop = top;
    });
  }

  const clearHistory = () => {
    view.dispatch({ effects: historian.reconfigure([]), userEvent: 'select.live.history' });
    view.dispatch({ effects: historian.reconfigure(history()), userEvent: 'select.live.history' });
  };

  /** The link under the caret, as an href for `onOpenLink`, or null. */
  const linkAtCaret = () => {
    const { state } = view;
    const pos = state.selection.main.head;
    const tree = syntaxTree(state);
    for (const side of /** @type {const} */ ([-1, 1])) {
      /** @type {import('@lezer/common').SyntaxNode | null} */
      let n = tree.resolveInner(pos, side);
      for (; n; n = n.parent) {
        if (n.from > pos || n.to < pos) continue;
        if (n.name === 'Wikilink') {
          const parts = wikiParts(state.sliceDoc(n.from, n.to));
          return wikiHref(parts.ref) || null;
        }
        if (n.name === 'Link' || n.name === 'Autolink') {
          const url = n.getChild('URL');
          return url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '') : null;
        }
        if (n.name === 'URL' && (!n.parent || n.parent.name !== 'Image')) return state.sliceDoc(n.from, n.to);
      }
    }
    return null;
  };

  api = {
    view,
    getText: () => liveText(view.state),
    viewText: () => view.state.doc.toString(),
    setText(text, opts = {}) {
      const next = textFormat(text);
      const nextDoc = docOf(next);
      const same = nextDoc === view.state.doc.toString();
      const mode = opts.history || 'isolate';
      quiet = true;
      try {
        view.dispatch({
          changes: same ? undefined : { from: 0, to: view.state.doc.length, insert: nextDoc },
          effects: setFormat.of(next),
          annotations: mode === 'drop' ? Transaction.addToHistory.of(false) : isolateHistory.of('full'),
          userEvent: 'input.live.set',
        });
        if (!same && mode === 'drop') clearHistory();
      } finally { quiet = false; }
      return !same;
    },
    replaceMinimal(text, opts = {}) {
      const next = textFormat(text);
      const nextDoc = docOf(next);
      const cur = view.state.doc.toString();
      if (nextDoc === cur) {
        // Same lines, maybe other bytes around them (a mark, an ending): the format follows.
        view.dispatch({ effects: setFormat.of(next), userEvent: 'input.live.replace' });
        return false;
      }
      const n = Math.min(cur.length, nextDoc.length);
      let a = 0;
      while (a < n && cur.charCodeAt(a) === nextDoc.charCodeAt(a)) a++;
      let b = 0;
      while (b < n - a && cur.charCodeAt(cur.length - 1 - b) === nextDoc.charCodeAt(nextDoc.length - 1 - b)) b++;
      quiet = !opts.edit;
      try {
        view.dispatch({
          changes: { from: a, to: cur.length - b, insert: nextDoc.slice(a, nextDoc.length - b) },
          effects: setFormat.of(next),
          annotations: opts.edit
            ? isolateHistory.of('full')
            : [isolateHistory.of('full'), Transaction.addToHistory.of(false)],
          userEvent: 'input.live.replace',
        });
      } finally { quiet = false; }
      return true;
    },
    setReadOnly(on) {
      view.dispatch({ effects: editable.reconfigure(editableExt(!on)), userEvent: 'select.live.readonly' });
    },
    setSpellcheck(on) {
      view.dispatch({ effects: spell.reconfigure(spellExt(!!on)), userEvent: 'select.live.spellcheck' });
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    refresh() {
      view.dispatch({ effects: redraw.of(null), userEvent: 'select.live.refresh' });
      view.requestMeasure();
    },
    openFind({ query = null, replace = false } = {}) {
      openSearchPanel(view);
      if (typeof query === 'string' && query) {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: query })), userEvent: 'select.live.find' });
      }
      const panel = view.dom.querySelector('.cm-search');
      if (!panel) return;
      const field = (replace && panel.querySelector('input[name="replace"]')) || panel.querySelector('input[name="search"]');
      if (field instanceof HTMLInputElement) { field.focus(); field.select(); }
    },
    closeFind: () => { closeSearchPanel(view); },
    findOpen: () => searchPanelOpen(view.state),
    goToLine(line, col) {
      const n = Math.floor(Number(line));
      if (!Number.isFinite(n)) return false;
      const at = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      const offset = Math.max(0, Math.min(Math.floor(Number(col) || 1) - 1, at.length));
      view.dispatch({ selection: { anchor: at.from + offset }, scrollIntoView: true, userEvent: 'select.live.goto' });
      view.focus();
      return true;
    },
    topLine() {
      const sc = scrollerOf(view);
      const top = sc === view.scrollDOM ? view.scrollDOM.getBoundingClientRect().top : Math.max(0, sc.getBoundingClientRect().top);
      const block = view.lineBlockAtHeight(Math.max(0, top - view.documentTop));
      return view.state.doc.lineAt(Math.min(block.from, view.state.doc.length)).number;
    },
    selection() {
      const m = view.state.selection.main;
      return { from: m.from, to: m.to };
    },
    setSelection(s) {
      const len = view.state.doc.length;
      const from = Math.max(0, Math.min(len, Number(s && s.from) || 0));
      const to = Math.max(0, Math.min(len, s && typeof s.to === 'number' ? s.to : from));
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true, userEvent: 'select.live' });
    },
    linkAtCaret,
    snapshot() {
      const m = view.state.selection.main;
      return { mode: 'live', from: m.from, to: m.to, scrollTop: scrollerOf(view).scrollTop || 0 };
    },
    run(id) {
      if (id === 'page.follow-link') {
        const href = linkAtCaret();
        if (!href) return false;
        openLink(href, { newTab: false });
        return true;
      }
      return runCommand(view, id);
    },
    destroy() {
      try { view.contentDOM.removeEventListener('error', onImageError, true); } catch { /* gone */ }
      try { view.destroy(); } catch (e) { console.error('[live] destroy', e); }
    },
  };
  return api;
}
