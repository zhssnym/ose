// The page editor as an instance: a markdown file rendered as a Notion-style column.
//
//   properties strip   only when the file has YAML frontmatter; raw text preserved, simple
//                      `key: value` lines editable in place, everything else read-only
//   title              the file's first H1, editable; the file name when there is no H1
//   meta               folder, word count, last save
//   body               Crepe (Milkdown) over everything after the title
//
// Markdown is the source of truth. Nothing is written on open; a save happens only after the
// user has actually typed, and only when the composed text differs from what is on disk.
// Before every write the file is read again: if it no longer matches the text this page was
// opened from (or last wrote), the user decides, never the editor (CONTRACT.md batch 9, B1).
//
// Round four (K1c): everything above is per instance. `markdownPage(el, path, opts)` builds
// one and hands back a handle; the state that used to be the module's `page` singleton is the
// closure of that call, so two pages can stand side by side in one document. What stays at
// module level is what is genuinely shared: the command registry (registered when the first
// page mounts, removed when the last one closes), the watcher and window listeners, and the
// pointer to the **active** page — the one holding the focus — which is the page the commands
// and the extension modules act on.

import {
  bus, commands, status, store, bridge, navigate, clearRoute, defaultNewFolder, scratchFolder,
  copyText, icon, attachmentFolder, spellcheckOn, trashDestination, rewriteInbound,
  collectCommands, onWindowClose,
} from './host.js';
import { prompt, confirm, choose, patchState, toast } from './deps.js';
import { makeCrepe, readMarkdown, editorView } from './crepe.js';
import { bindPagePath, insertPageLink } from './link.js';
import { DRAG_TYPE, dropInto, payloadOf } from './drop.js';
import { createFind } from './find.js';
import { pickHeading } from './outline.js';
import { bodyStartLine, titleLineNo, posForBodyLine } from './lines.js';
import { caretAt, scrollerOf } from './reveal.js';
import { registerExtensionCommands } from './extensions.js';
import { keepVersion, keepDiskVersion } from './versions.js';
import { backlinkCount } from './backlinks.js';
import { followHref } from './linkstate.js';
import { createSourceView, rememberSource, renameRemembered, wasInSource } from './source.js';
import { TextSelection } from '@milkdown/kit/prose/state';
import { parseDoc, composeDoc, countWords, frontmatterEditable, setFrontmatterValue } from './doc.js';
import * as P from './paths.js';
import './editor.css';

const SAVE_DEBOUNCE = 600;
/** A file still carrying the name `newPage` gave it: the first real title renames it (C12). */
const UNTITLED = /^Untitled( \d+)?$/i;

/** Every mounted page, and the one the commands act on (the focused one, or the last mounted). */
const instances = new Set();
let active = null;

const activeInst = () => active;
const activeApi = () => (active ? active.api : null);

// ---------------------------------------------------------------------------
// the instance

const blankPage = () => ({
  path: '', doc: null, title: '', baseline: '',
  el: null, host: null, titleEl: null, metaEl: null, bodyEl: null, crepe: null, find: null,
  // Batch 12 (P5). mode: 'block' (Crepe) or 'source' (the whole file in CodeMirror), swapped by
  // `page.source-toggle`. plain: a text file that is not markdown — source mode is its only
  // mode and composeDoc is never applied to it. words/wordTimer: the meta line's count, taken
  // from the ProseMirror document and debounced with the save rather than serialised per key.
  mode: 'block', plain: false, source: null, words: 0, chars: 0, mtime: 0, wordTimer: 0, titleSelected: false,
  dirty: false, touched: false, ready: false,
  // rev counts user edits, so a write can tell whether the document moved on under it.
  // readOnly: the file is gone from disk; nothing is written again (C18). hold: the user
  // answered "cancel" to the changed-on-disk question; autosave stays quiet until an explicit
  // save asks again. warnedDisk: the disk text the last toast was about, so one external
  // change produces one toast.
  rev: 0, readOnly: false, hold: false, asking: false, warnedDisk: null, titleToBody: false,
  saveTimer: 0, savedAt: null, selfWriteAt: 0, saving: null,
  cleanups: [],
});

/**
 * Mount the file at `path` into `el` and answer the handle (docs/KERNEL.md `ose:editor`).
 * The handle comes back at once; `handle.ready` is the open in flight.
 *
 * `opts.line` (1-based, a line of the file as the search overlay counts them) puts the caret in
 * the block that holds that line once the editor is up (C7); `opts.selection` is a `{from,to}`
 * a router remembered; `opts.query` seeds the find bar.
 */
export function markdownPage(el, path, opts = {}) {
  /** @type {null | ReturnType<typeof blankPage>} */
  let page = null;
  let openToken = 0;
  let opening = Promise.resolve();
  let closed = false;

  const listeners = new Map();
  const inst = {
    el,
    api: null,
    handle: null,
    path: () => (page ? page.path : null),
    isDirty: () => !!(page && page.dirty),
    titleEl: () => (page ? page.titleEl : null),
    onFsChange: (payload) => onFsChange(payload),
    applySpellcheck: () => { if (page) applySpellcheck(page); },
    save: (o) => saveNow(o),
    close: () => closePage(),
  };

  const isActive = () => active === inst;
  /** The shell's status bar belongs to one page at a time: the focused one (K1c). */
  const setStatus = (field, text) => { if (isActive()) status.set(field, text); };

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[editor:${event}]`, e); }
    }
  }

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => { listeners.get(event)?.delete(fn); };
  }

  // -------------------------------------------------------------------------
  // open and close

  async function open(nextPath, options = {}) {
    if (closed) return;
    if (options.line && page && page.path === nextPath && (page.crepe || page.source) && page.el && page.el.parentNode === el) {
      scrollToLine(options.line, options.col);
      openFindWith(page, options.query);
      return;
    }
    const token = ++openToken;
    await closePage({ keepAlive: true });
    if (token !== openToken) return;

    const p = blankPage();
    p.path = nextPath;
    page = p;
    take();

    let text;
    try {
      text = await bridge.readText(nextPath);
    } catch (e) {
      page = null;
      el.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `cannot open ${nextPath}: ${e.message || e}`;
      el.append(empty);
      setStatus('path', nextPath);
      setStatus('doc', null);
      setStatus('save', null);
      return;
    }
    if (token !== openToken) return;

    // A file that is not markdown is never parsed as one (batch 12): it opens in source mode,
    // with no title strip, and what is written back is exactly what CodeMirror holds.
    p.plain = !P.isMarkdown(nextPath);
    p.doc = p.plain ? plainDoc(text) : parseDoc(text);
    p.title = p.doc.title;
    p.baseline = text;
    publishTitle(p);
    p.mode = p.plain || (await wasInSource(nextPath)) ? 'source' : 'block';
    if (token !== openToken) return;

    buildDom(p, el);
    updateMeta(p, true);
    setStatus('path', nextPath);
    setStatus('save', null);

    if (!await mountBody(p, text, token)) return;
    void readMtime(p);

    // The jump waits for the layout: node views have to be laid out before a block has a height
    // to scroll to, and the router puts a remembered scroll back one frame after the mount — the
    // jump must come after that, not be undone by it. `selection` is the router handing back
    // where the caret was when the page was last left (N44); a line wins over it.
    if (options.line || options.selection || options.query) {
      afterLayout(() => {
        if (p !== page) return;
        if (options.line) scrollToLine(options.line, options.col);
        else if (options.selection) restoreSelection(p, options.selection);
        openFindWith(p, options.query);
      });
    }

    void patchState({ last: nextPath });
  }

  /**
   * Put the body in: Crepe in block mode, CodeMirror over the whole file in source mode. `text`
   * is the whole file. Answers false when the open was superseded while the editor was building.
   */
  async function mountBody(p, text, token) {
    p.ready = false;
    if (p.mode === 'source') {
      p.bodyEl.classList.add('ed-source');
      p.el.classList.add('ed-source-on');
      // The title line is inside the text now; a strip that could also edit it would be a second
      // source of truth for the same bytes. It stays as a label until the mode goes back.
      if (p.titleEl) p.titleEl.contentEditable = 'false';
      p.source = createSourceView({
        host: p.bodyEl,
        text,
        markdown: !p.plain,
        gutter: p.plain,
        readOnly: p.readOnly,
        onChange: () => { p.touched = true; markDirty(p); },
        onEscape: () => { try { p.source.view.contentDOM.blur(); } catch { /* nothing to blur */ } },
      });
      // The same three methods `createFind` gives the block editor, over CodeMirror's own panel:
      // the options go through, so a seeded query highlights and Ctrl+H reaches replace (QA F5).
      p.find = {
        open: (o) => { if (p.source) p.source.openFind(o || {}); },
        close: () => { if (p.source) p.source.closeFind(); },
        isOpen: () => !!(p.source && p.source.findOpen()),
        destroy: () => {},
      };
      p.ready = true;
    } else {
      p.crepe = await makeCrepe({
        root: p.bodyEl,
        markdown: p.doc.body,
        resolveImage: (src) => resolveImage(p, src),
        uploadImage: (file) => uploadImage(p, file),
        attachFile: (file) => attachFile(p, file),
        pagePath: () => p.path,
        onChange: () => { if (p.ready) markDirty(p); },
        // The two keys at the top edge of the body (L10, L19); source.js holds the keymap.
        onLeaveTop: () => focusTitleEnd(p),
        onSelectAll: () => selectAllWithTitle(p),
        on: (crepeApi) => {
          crepeApi.blur(() => { if (p.dirty) void saveNow(); });
        },
      });
      if (token !== undefined && token !== openToken) { await p.crepe.destroy().catch(() => {}); return false; }
      wireDrops(p);
      // The third argument is what a replacement calls: the find bar's own keys and clicks are
      // not "touching the page" (see `touch` below), so a replace on a page the user had not
      // typed in would otherwise never be saved.
      p.find = createFind(p.el, () => (p.crepe ? editorView(p.crepe) : null),
        () => { p.touched = true; markDirty(p); });
      // Anything the editor does to the document while it is settling (the trailing plugin adds
      // an empty paragraph, node views mount) must not count as a user edit. Two frames is the
      // normal path; the timer is the fallback, because a hidden window fires no frames at all.
      const ready = () => { p.ready = true; };
      requestAnimationFrame(() => requestAnimationFrame(ready));
      setTimeout(ready, 80);
    }
    wireEditorEvents(p);
    applySpellcheck(p);
    updateMeta(p, true);
    p.cleanups.push(() => { if (p.find) p.find.destroy(); p.find = null; });
    return true;
  }

  /** Tear the body down, whichever kind it is, and forget everything wired around it. */
  async function unmountBody(p) {
    clearTimeout(p.wordTimer);
    for (const fn of p.cleanups) { try { fn(); } catch (e) { console.error(e); } }
    p.cleanups.length = 0;
    if (p.crepe) { try { await p.crepe.destroy(); } catch (e) { console.error('[editor] destroy', e); } }
    if (p.source) p.source.destroy();
    p.crepe = null;
    p.source = null;
  }

  async function closePage({ keepAlive = false } = {}) {
    const p = page;
    if (!p) { if (!keepAlive) release(); return; }
    page = null;
    clearTimeout(p.saveTimer);
    // Leaving the page is deliberate: a held changed-on-disk question is asked now, and the
    // route change waits for the answer.
    if (p.dirty) await saveDoc(p, { explicit: true });
    await unmountBody(p);
    if (p.el && p.el.parentNode) p.el.remove();
    const gone = p.path;
    p.el = p.host = p.titleEl = p.metaEl = p.bodyEl = null;
    publishTitle(null);
    setStatus('doc', null);
    setStatus('save', null);
    if (keepAlive) return;
    release();
    emit('closed', { path: gone });
  }

  /**
   * The document shape of a file that is not markdown (`.txt`, `.csv`, `.py`, a log). Every
   * field is empty but `body`, so nothing above the body is drawn and `compose` never rewrites
   * a byte: source mode hands the file back exactly as it holds it.
   */
  function plainDoc(text) {
    return {
      eol: '\n', eols: null, lines: null, bom: false, endsWithNewline: /\n$/.test(String(text ?? '')),
      frontmatterRaw: '', frontmatter: null, preTitle: '', titleLine: null, title: '', gap: '',
      body: String(text ?? ''), plain: true,
    };
  }

  /**
   * `page.source-toggle` (Ctrl+E). The buffer, not the file, crosses over: `compose` gives the
   * whole file as a save would write it, CodeMirror shows exactly that, and `parseDoc` takes it
   * back. Nothing is written, the dirty flag and the baseline are untouched, and the only thing
   * lost is the undo history of the editor being left — which the status bar says.
   */
  async function toggleSource() {
    const p = page;
    if (!p || (!p.crepe && !p.source)) return;
    if (p.plain) { toast(`${P.basename(p.path)} is not markdown: source is its only mode`, 'info'); return; }

    let text;
    try {
      text = compose(p);
    } catch (e) {
      toast('could not serialise the page, the mode was not changed: ' + (e.message || e), 'err');
      return;
    }
    const host = p.el ? p.el.parentNode : null;
    if (!host) return;
    const scroller = scrollerOf(host);
    const top = scroller ? scroller.scrollTop : 0;

    await unmountBody(p);
    if (p !== page) return;
    p.mode = p.mode === 'source' ? 'block' : 'source';
    p.doc = parseDoc(text);
    p.title = p.doc.title;
    publishTitle(p);
    p.titleSelected = false;
    buildDom(p, host);
    if (!await mountBody(p, text)) return;
    if (scroller) scroller.scrollTop = top;
    if (p.source) p.source.focus(); else focusBody();
    void rememberSource(p.path, p.mode === 'source');
    toast(p.mode === 'source' ? 'source mode · the block editor\'s undo history was cleared'
      : 'block mode · the text editor\'s undo history was cleared', 'info', 3500);
  }

  /**
   * Put the caret in the block holding file line `line` (1-based) and bring it into view. A
   * line above the body — frontmatter, the title — scrolls to the top, with the caret in the
   * title when the line is the title's. True when there was a page to scroll.
   */
  function scrollToLine(line, col) {
    const p = page;
    const n = Math.floor(Number(line) || 0);
    if (!p || !p.el || n < 1) return false;
    // Source mode counts the same lines the search overlay counts: the file's own.
    if (p.source) { p.source.goToLine(n, col); return true; }
    if (!p.crepe) return false;
    const view = editorView(p.crepe);
    if (!view) return false;
    const start = bodyStartLine(p.doc);
    if (n < start) {
      const scroller = scrollerOf(p.el);
      if (scroller) scroller.scrollTop = 0;
      if (n === titleLineNo(p.doc)) focusTitle(p);
      return true;
    }
    const pos = posForBodyLine(p.crepe, view, p.doc.body, n - start + 1, col);
    caretAt(view, pos, { block: 'start', always: true, focus: true });
    return true;
  }

  /**
   * The find bar, seeded with the term a search hit was found by (N36). Silent when there is no
   * term; loud in the console when there is one and no bar to put it in, because a search hit
   * that opens the page and highlights nothing looks like the search was wrong.
   */
  function openFindWith(p, query) {
    if (!query) return;
    // Both kinds of bar take `{query}` now: the block editor's own, and the source-mode stub
    // over CodeMirror's panel, which used to drop the term on the floor (QA F6).
    if (p && p.find && typeof p.find.open === 'function') { p.find.open({ query }); return; }
    console.warn('[editor] no find bar to seed with', query);
  }

  /**
   * Put a `{from, to}` the router remembered back on the document (N44). `caretAt` does the
   * dispatch itself, and `always` makes it scroll even when the position is already on screen —
   * without it a caret restored into the first visible screenful is set and then left invisible,
   * which reads as "it did nothing".
   */
  function restoreSelection(p, sel) {
    const view = p && p.crepe ? editorView(p.crepe) : null;
    if (!view || !sel) return;
    const size = view.state.doc.content.size;
    const from = Math.max(0, Math.min(Math.floor(Number(sel.from) || 0), size));
    caretAt(view, from, { block: 'center', always: true, focus: true });
  }

  /** Where the caret is, for the router to hand back at the next open (N44, P7). */
  function currentSelection() {
    const view = page && page.crepe ? editorView(page.crepe) : null;
    return view ? { from: view.state.selection.from, to: view.state.selection.to } : null;
  }

  /** The top of the page, caret at the start of the title (when the file has one). */
  function focusTitle(p) {
    const scroller = scrollerOf(p.el);
    if (scroller) scroller.scrollTop = 0;
    if (!p.titleEl) return;
    p.titleEl.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(p.titleEl);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }

  /**
   * Flush now. `explicit` is a user gesture (Ctrl+S, leaving the page, closing the window):
   * it lifts a `hold` and asks the changed-on-disk question again. `closing` means the window
   * is about to go, so the question cannot be awaited: the save resolves `false` instead, the
   * bridge keeps the window, and the dialog is shown for the user to answer.
   * Resolves true when nothing stands in the way of closing.
   */
  async function saveNow(o = {}) {
    if (!page) return true;
    clearTimeout(page.saveTimer);
    return saveDoc(page, o);
  }

  // -------------------------------------------------------------------------
  // DOM

  function buildDom(p, host) {
    host.innerHTML = '';
    const col = document.createElement('div');
    col.className = 'page-col ed';
    p.el = col;
    p.host = col;

    if (p.doc.frontmatterRaw) col.append(propertiesStrip(p));

    // A file that is not markdown has no title of any kind: the meta line names it.
    if (p.plain) {
      // nothing above the body
    } else if (p.doc.titleLine !== null) {
      col.append(makeTitleEl(p, p.doc.title));
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'page-title untitled';
      wrap.textContent = P.stem(p.path);
      const add = document.createElement('button');
      add.className = 'ed-add-title';
      add.type = 'button';
      add.textContent = 'add title';
      add.title = 'Insert a level-1 heading at the top of the file';
      add.addEventListener('click', () => addTitle(p));
      wrap.append(add);
      col.append(wrap);
    }

    const meta = document.createElement('div');
    meta.className = 'page-meta';
    p.metaEl = meta;
    col.append(meta);

    const body = document.createElement('div');
    body.className = 'ed-body';
    p.bodyEl = body;
    col.append(body);

    host.append(col);
    // Which page the commands act on: the one the caret is in (K1c). With one page mounted —
    // the stock rice — this never changes anything.
    col.addEventListener('focusin', take);
  }

  /** The editable H1. `plaintext-only` keeps pasted formatting out of a file's title line. */
  function makeTitleEl(p, text) {
    const h1 = document.createElement('h1');
    h1.className = 'page-title';
    h1.contentEditable = 'plaintext-only';
    h1.spellcheck = false;
    h1.dataset.placeholder = 'Untitled';
    h1.textContent = text;
    h1.addEventListener('input', () => {
      p.title = h1.textContent.replace(/\s+/g, ' ').trim();
      publishTitle(p);
      p.touched = true;
      markDirty(p);
    });
    h1.addEventListener('keydown', onTitleKey);
    // Enter and Tab leave the title through focusBody, so blur is the one place a finished
    // title is handled: save it, then let it name the file if the file is still `Untitled`.
    h1.addEventListener('blur', () => { void onTitleDone(p); });
    p.titleEl = h1;
    return h1;
  }

  async function onTitleDone(p) {
    // Enter/Tab/Down set this before moving the caret into the body; a rename remounts the
    // page, and the caret the user just asked for must come back afterwards.
    const toBody = p.titleToBody;
    p.titleToBody = false;
    if (p.dirty) await saveNow();
    if (await renameUntitledFromTitle(p) && toBody) focusBody();
  }

  /**
   * The YAML block above the title. Every row is shown; a row whose value sits on one plain
   * `key: value` line is editable in place (C6). The edit rewrites that line only, inside the
   * raw block that composeDoc writes back verbatim, so unknown keys, comments and multi-line
   * values are never reformatted — the block is still never parsed as YAML.
   */
  function propertiesStrip(p) {
    const rows = p.doc.frontmatter || [];
    const box = document.createElement('div');
    box.className = 'ed-props';

    const head = document.createElement('button');
    head.className = 'ed-props-head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');
    // The shell's chevron, so the fold glyph is the sidebar's (same grid, same weight).
    head.innerHTML = `${icon('chevron')}<span>properties</span><span class="ed-props-count">${rows.length}</span>`;

    const list = document.createElement('div');
    list.className = 'ed-props-list';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'ed-prop';
      const k = document.createElement('span');
      k.className = 'ed-prop-key';
      k.textContent = r.key;
      const v = document.createElement('span');
      v.className = 'ed-prop-val text-select';
      v.textContent = r.value;
      if (r.key && frontmatterEditable(p.doc.frontmatterRaw, r.key)) wirePropEdit(p, v, r.key);
      row.append(k, v);
      list.append(row);
    }
    head.addEventListener('click', () => {
      const open_ = box.classList.toggle('closed');
      head.setAttribute('aria-expanded', String(!open_));
    });
    box.append(head, list);
    return box;
  }

  /** One editable value: plain text, one line; Enter or Esc leaves, blur saves. */
  function wirePropEdit(p, v, key) {
    v.contentEditable = 'plaintext-only';
    v.spellcheck = false;
    v.classList.add('editable');
    v.dataset.placeholder = 'empty';
    v.title = 'Click to edit';
    v.addEventListener('input', () => {
      if (p !== page || p.readOnly) return;
      // After a save `p.doc` is re-parsed from what was written, so the raw block here is always
      // the current one; a line that stopped being locatable (it cannot, from this edit alone,
      // but be safe) leaves the file untouched.
      const raw = setFrontmatterValue(p.doc.frontmatterRaw, key, v.textContent);
      if (raw === null || raw === p.doc.frontmatterRaw) return;
      p.doc.frontmatterRaw = raw;
      p.touched = true;
      markDirty(p);
    });
    v.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); v.blur(); }
    });
    v.addEventListener('blur', () => {
      v.textContent = v.textContent.replace(/[\r\n]+/g, ' ').trim();
      if (p.dirty) void saveNow();
    });
  }

  function onTitleKey(e) {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (page) page.titleToBody = true;
      focusBody();
    }
  }

  /**
   * L11: the caret lands at the **start of the first body block**, not wherever it happened to
   * be last. Leaving the title is a move to the top of the body, and nothing else.
   */
  function focusBody() {
    const p = page;
    if (!p) return;
    if (p.source) { p.source.focus(); return; }
    const view = p.crepe ? editorView(p.crepe) : null;
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView());
    view.focus();
  }

  /**
   * L10: the way back. Backspace or ArrowUp at the very start of the body puts the caret at the
   * **end** of the title, where a user who just walked backwards out of the body expects it.
   * False when there is no title to go to, so the key keeps its ordinary meaning.
   */
  function focusTitleEnd(p) {
    if (!p || !p.titleEl || p.titleEl.contentEditable === 'false') return false;
    p.titleEl.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(p.titleEl);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /**
   * L19: Ctrl+A once selects the block, twice the body (P3, blocks.js), a third time the title
   * as well — so the copy that follows is the whole note. The title is not part of the
   * ProseMirror document, so the selection cannot literally reach it: it is marked instead, and
   * the copy handler in `wireEditorEvents` writes the title line in front of the body.
   */
  function selectAllWithTitle(p) {
    if (!p || !p.titleEl || p.titleSelected) return false;
    p.titleSelected = true;
    p.titleEl.classList.add('ed-all-selected');
    return true;
  }

  function clearTitleSelection(p) {
    if (!p || !p.titleSelected) return;
    p.titleSelected = false;
    if (p.titleEl) p.titleEl.classList.remove('ed-all-selected');
  }

  /** The note without its frontmatter: the title line, the gap, the body, as a save would write. */
  function wholeNote(p) {
    const body = readMarkdown(p.crepe, p.doc.body);
    return composeDoc({ ...p.doc, frontmatterRaw: '', preTitle: '' }, { title: p.title, body });
  }

  /** Give a file with no H1 one. A user action, never automatic. */
  function addTitle(p) {
    const doc = p.doc;
    doc.titleLine = '# ';
    doc.title = '';
    doc.gap = doc.body.trim() ? '\n\n' : '\n';
    p.title = P.stem(p.path);
    p.touched = true;
    // Rebuild the header only; the editor keeps its document and its undo history.
    const h1 = makeTitleEl(p, p.title);
    p.el.querySelector('.page-title').replaceWith(h1);
    markDirty(p);
    h1.focus();
    const range = document.createRange();
    range.selectNodeContents(h1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }

  /**
   * Spellcheck is a setting, not a guess (L12/E43). The old code sniffed the document's language
   * from a dozen stop words and switched checking off whenever the guess disagreed with the
   * Windows display language — which, on this fr-FR machine, meant no spellcheck at all on every
   * English page and red underlines under every French word on a page it read as English.
   * `settings.spellcheck` (P8, default true) decides; the language is the app's own.
   */
  function applySpellcheck(p) {
    if (!p || !p.el) return;
    const on_ = spellcheckOn();
    const lang = navigator.language || 'en';
    p.el.setAttribute('lang', lang);
    const view = p.crepe ? editorView(p.crepe) : null;
    for (const dom of [view && view.dom, p.source && p.source.view.contentDOM]) {
      if (!dom) continue;
      dom.setAttribute('spellcheck', String(on_));
      dom.setAttribute('lang', lang);
    }
  }

  // -------------------------------------------------------------------------
  // events inside the page

  function wireEditorEvents(p) {
    const host = p.host;
    // `touched` means "the user has interacted with this page", and a save needs it as well as
    // a changed document. Mouse counts: ticking a task checkbox or dragging a block never
    // produces a key event. On its own it can never cause a write, because saveDoc also
    // requires a dirty document and text that differs from what is on disk. Typing into the
    // find bar is not touching the page.
    const touch = (e) => { if (!(e.target instanceof Element && e.target.closest('.ed-find'))) p.touched = true; };
    for (const ev of ['keydown', 'beforeinput', 'paste', 'drop', 'cut', 'pointerdown']) {
      host.addEventListener(ev, touch, true);
      p.cleanups.push(() => host.removeEventListener(ev, touch, true));
    }
    // L19: the widened selection is a mode of exactly one gesture. Anything but the chords that
    // read it (Ctrl+A again, Ctrl+C, Ctrl+X) puts the page back to an ordinary selection.
    const MODIFIERS = ['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'];
    const keeps = (e) => MODIFIERS.includes(e.key)
      || ((e.ctrlKey || e.metaKey) && ['a', 'c', 'x', 'insert'].includes(String(e.key).toLowerCase()));
    const clearAll = (e) => { if (e.type !== 'keydown' || !keeps(e)) clearTitleSelection(p); };
    const onCopy = (e) => {
      if (!p.titleSelected || !e.clipboardData || !p.crepe) return;
      let text;
      try { text = wholeNote(p); } catch (err) { console.error('[editor] copy whole note', err); return; }
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.setData('text/plain', text);
    };
    host.addEventListener('keydown', clearAll, true);
    host.addEventListener('pointerdown', clearAll, true);
    host.addEventListener('copy', onCopy, true);
    p.cleanups.push(() => {
      host.removeEventListener('keydown', clearAll, true);
      host.removeEventListener('pointerdown', clearAll, true);
      host.removeEventListener('copy', onCopy, true);
    });

    host.addEventListener('pointerdown', onLinkPointerDown, true);
    host.addEventListener('click', onLinkClick, true);
    p.cleanups.push(() => host.removeEventListener('pointerdown', onLinkPointerDown, true));
    p.cleanups.push(() => host.removeEventListener('click', onLinkClick, true));
    // Nothing here guards the shell's chords: the kernel's keys.js listens on `window` in the
    // capture phase, strictly outside this host, and exempts the chords CodeMirror owns inside
    // a code block itself. The editor's second copy of that table could never match (F7).

    // Notion behaviour: a click in the empty space below the last block puts the caret at the
    // end of the page instead of leaving the editor unfocused.
    const scroller = host.parentElement;
    const onBlankClick = (e) => {
      if (e.button !== 0) return;
      if (e.target !== host && e.target !== scroller && e.target !== p.bodyEl) return;
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return;
      e.preventDefault();
      const end = view.state.doc.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)));
      view.focus();
    };
    host.addEventListener('mousedown', onBlankClick);
    scroller && scroller.addEventListener('mousedown', onBlankClick);
    p.cleanups.push(() => { host.removeEventListener('mousedown', onBlankClick); scroller && scroller.removeEventListener('mousedown', onBlankClick); });
  }

  /**
   * Ctrl/Cmd+click follows a link. It has to be caught on pointerdown: ProseMirror treats
   * Ctrl+mousedown as "select this node", re-renders the paragraph, and by the time the click
   * event arrives its target is the paragraph and the anchor is gone.
   */
  function onLinkPointerDown(e) {
    if (!page || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
    const a = anchorAt(e);
    if (!a || inTooltip(a)) return;
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    void followLink(href);
  }

  /**
   * The link tooltip's own open action. Crepe renders it as `<a target="_blank">`, which would
   * take the whole app with it, so it is always intercepted. A plain click in the text is left
   * alone: it must still place the caret.
   */
  function onLinkClick(e) {
    if (!page) return;
    const a = anchorAt(e);
    if (!a) return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); return; }
    if (!inTooltip(a)) return;
    const href = (a.textContent || a.getAttribute('href') || '').trim();
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    void followLink(href);
  }

  async function followLink(href) {
    if (!page) return;
    // linkstate.js (P7) owns where a href goes: anchors, missing pages, text files into source
    // mode, the platform for everything else. The editor only says which page it was written in.
    return followHref(href, page.path);
  }

  // -------------------------------------------------------------------------
  // images

  function resolveImage(p, src) {
    const s = String(src || '');
    if (!s || P.isExternal(s) || s.startsWith('blob:')) return s;
    const target = P.resolveHref(p.path, s);
    return target ? bridge.assetUrl(target) : s;
  }

  /**
   * A pasted or dropped file lands in `<page folder>/attachments/<yyyy-mm-dd>-<slug>.<ext>`,
   * numbered when taken, so the folder stays portable. Resolves to the vault path of the copy.
   * Images and every other kind of file get the same name (drop.js links the others).
   */
  async function attachFile(p, file) {
    const image = /^image\//.test(file.type || '');
    const ext = (/\.([a-z0-9]{1,8})$/i.exec(file.name || '') || [])[1]
      || (image ? (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg') : 'bin');
    const base = `${P.today()}-${P.slugify(P.stem(file.name || ''), image ? 'image' : 'file')}`;
    // Where attachments go is a setting (S35, P8); the default answers the page's own folder.
    // The setting can answer `''` (the user named `/`, the vault root): `/name.png` would then
    // be a leading slash the bridges strip on write but `relativeHref` does not, so the markdown
    // src would point one level wrong (QA F23). The root is a path with no folder in front of it.
    const folder = attachmentFolder(p.path);
    const named = (name) => (folder ? `${folder}/${name}` : name);
    let target = named(`${base}.${ext.toLowerCase()}`);
    for (let n = 2; await bridge.exists(target); n++) target = named(`${base}-${n}.${ext.toLowerCase()}`);
    await bridge.writeBinary(target, await readAsBase64(file));
    p.touched = true;
    return target;
  }

  /** Milkdown's uploader (crepe.js onUpload): the attachment as a markdown src relative to the page. */
  async function uploadImage(p, file) {
    return P.relativeHref(p.path, await attachFile(p, file));
  }

  /**
   * The drops the body's own handler (drop.js) never sees. On the title or the meta line the
   * browser would put the payload's text into the title, or the shell's window guard would
   * refuse the drop; both are the page, so the links go at the top of the body (position 0).
   * Inside a node view that keeps its events — the code block, where CodeMirror would insert
   * the sidebar's `text/plain` paths as code — or any other non-editable node, the drop is
   * taken here at the pointer, and drop.js puts the blocks after the node. A read-only page
   * takes nothing anywhere: Milkdown's editable-only handlers no longer cover the body then,
   * and an unhandled file drop navigates the window to the file. Text drags are left alone.
   */
  function wireDrops(p) {
    const host = p.host;
    const above = (t) => t instanceof Element && !!(t.closest('.page-title') || t.closest('.page-meta'));
    const held = (t) => t instanceof Element && !!t.closest('.ProseMirror [contenteditable="false"]');
    const o = { pagePath: () => p.path, attach: (file) => attachFile(p, file) };
    const onOver = (e) => {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
      const ours = types.includes(DRAG_TYPE) || types.includes('Files');
      if (!p.readOnly && !(ours && (above(e.target) || held(e.target)))) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = p.readOnly ? 'none' : types.includes(DRAG_TYPE) ? 'move' : 'copy';
    };
    const onDrop = (e) => {
      if (p.readOnly) { e.preventDefault(); return; }
      const top = above(e.target);
      if (!top && !held(e.target)) return;
      const payload = payloadOf(e.dataTransfer);
      if (!payload) return;
      e.preventDefault();
      e.stopPropagation();
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return;
      const at = top ? null : view.posAtCoords({ left: e.clientX, top: e.clientY });
      p.touched = true;
      void dropInto(view, payload, at ? at.pos : 0, o);
    };
    host.addEventListener('dragover', onOver, true);
    host.addEventListener('drop', onDrop, true);
    p.cleanups.push(() => { host.removeEventListener('dragover', onOver, true); host.removeEventListener('drop', onDrop, true); });
  }

  // -------------------------------------------------------------------------
  // saving

  /**
   * The window title is the note's own name, not the file's stem (S13): the router listens on
   * this store key and titles the window from it, so an H1 the user is typing right now reaches
   * the title bar too (QA defect 8). `null` when no page is open.
   */
  function publishTitle(p) {
    if (!p || !p.path) { if (isActive()) store.set('pageTitle', null); return; }
    const title = String(p.title || '').trim() || P.stem(p.path);
    if (isActive()) store.set('pageTitle', { path: p.path, title });
    emit('title', { path: p.path, title });
  }

  function markDirty(p) {
    if (p !== page) return;
    // Editor-internal normalisation (tables, trailing paragraph) is not a user edit: no dirty
    // state, no "unsaved" in the status bar, until the user has actually interacted with the page.
    if (!p.touched) return;
    p.rev++;
    if (!p.dirty) {
      p.dirty = true;
      if (isActive()) bus.emit('doc:dirty', { path: p.path, dirty: true });
      emit('dirty', { path: p.path, dirty: true });
    }
    setStatus('save', p.hold ? 'unsaved · changed on disk' : 'unsaved');
    updateMeta(p);
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
    clearTimeout(p.wordTimer);
    p.wordTimer = setTimeout(() => { if (p === page) updateMeta(p, true); }, SAVE_DEBOUNCE);
  }

  /**
   * The file exactly as a save would write it. `page.copy-markdown` copies this (C14). In source
   * mode the text in CodeMirror *is* the file — frontmatter, title and body — so it is handed
   * back untouched; composeDoc would only have the chance to change bytes nobody edited.
   */
  function compose(p) {
    if (p.source) return p.source.getText();
    const body = readMarkdown(p.crepe, p.doc.body);
    return composeDoc(p.doc, { title: p.title, body });
  }

  const clean = (p) => {
    p.dirty = false;
    if (isActive()) bus.emit('doc:dirty', { path: p.path, dirty: false });
    emit('dirty', { path: p.path, dirty: false });
    setStatus('save', p.savedAt ? 'saved ' + p.savedAt : null);
    updateMeta(p);
  };

  /**
   * Save the page. Resolves `true` when the caller may move on (written, nothing to write,
   * or nothing that can be written) and `false` when the save is waiting on the user.
   *
   * The write is guarded three ways (B1, C18). The file is read back first and must equal
   * `baseline`, the text this page was opened from or last wrote; otherwise something else
   * edited it and the user chooses between keeping theirs and reloading. A file that is no
   * longer there is never recreated from the buffer: the page turns read-only. And the whole
   * check-then-write runs inside one `saving` promise, so a blur and a debounce firing together
   * ask one question and write once; edits made while the write was in flight reschedule it
   * instead of being marked clean by mistake (`rev`).
   */
  async function saveDoc(p, o = {}) {
    if (!p || (!p.crepe && !p.source)) return true;
    clearTimeout(p.saveTimer);
    // Never write a file the user has not touched, whatever the editor thinks it changed while
    // mounting node views.
    if (!p.dirty || !p.touched) return true;
    if (p.readOnly) { setStatus('save', 'not saved · file is gone'); return true; }
    if (p.saving) {
      // A question already on screen cannot be answered by a window that is closing: veto now.
      if (o.closing && p.asking) return false;
      await p.saving;
      // Typed during that write, or the question was cancelled: a deliberate save goes again.
      if (p.dirty && o.explicit && !p.saving) return saveDoc(p, o);
      return !p.hold;
    }
    // "Cancel" at the question means "let me keep working": autosave stays quiet, the status
    // bar keeps saying so, and only a deliberate save (Ctrl+S, leaving, closing) asks again.
    if (p.hold && !o.explicit) return true;
    p.hold = false;

    const rev = p.rev;
    let text;
    try {
      text = compose(p);
    } catch (e) {
      console.error('[editor] serialise', e);
      setStatus('save', 'serialise failed, not saved');
      toast('could not serialise the page, nothing was written: ' + (e.message || e), 'err');
      return true;
    }
    if (text === p.baseline) { clean(p); return true; }

    let outcome = true;
    p.saving = (async () => {
      let onDisk = null;
      try {
        onDisk = await bridge.readText(p.path);
      } catch (e) {
        // Gone, or unreadable for the moment (a sync client holding it). Only "gone" is final.
        let there = true;
        try { there = await bridge.exists(p.path); } catch { /* assume it is */ }
        if (!there) { fileGone(p); return; }
        throw e;
      }
      if (onDisk !== p.baseline) {
        if (o.closing) {
          // The window is on its way out and a modal cannot be awaited into it. Refuse the
          // close (the bridge reads `false`), show the question, and let the user close again.
          outcome = false;
          void resolveConflict(p, text, rev, onDisk);
          return;
        }
        outcome = await resolveConflict(p, text, rev, onDisk);
        return;
      }
      await writeOut(p, text, rev);
    })();
    try {
      await p.saving;
    } catch (e) {
      saveFailed(p, e);
    } finally {
      p.saving = null;
    }
    return outcome;
  }

  /** A write or read-back threw. The buffer stays dirty, so the next autosave tries again. */
  function saveFailed(p, e) {
    console.error('[editor] save', e);
    setStatus('save', 'save failed');
    toast(`save failed for ${p.path}: ${e && e.message ? e.message : e}`, 'err');
  }

  /** The write itself. `rev` is the edit count `text` was composed at. */
  async function writeOut(p, text, rev) {
    // Batch 12 (P5): the previous content is kept under .ose/versions before it is replaced.
    // A failure to keep a version never blocks the save; it is logged by versions.js.
    await keepVersion(p.path, p.baseline, text);
    p.selfWriteAt = Date.now();
    await bridge.writeText(p.path, text);
    p.baseline = text;
    p.warnedDisk = null;
    p.doc = p.plain ? plainDoc(text) : parseDoc(text);
    p.title = p.doc.titleLine !== null ? p.doc.title : p.title;
    publishTitle(p);
    // In source mode the title strip is a label over text the user just edited: it follows.
    if (p.source && p.titleEl && p.titleEl.textContent !== p.title) p.titleEl.textContent = p.title;
    p.savedAt = P.hhmm();
    void readMtime(p);
    if (isActive()) bus.emit('doc:saved', { path: p.path });
    emit('saved', { path: p.path, text });
    if (p.rev === rev) {
      clean(p);
    } else if (p === page) {
      // Typed during the write: still dirty, and the debounce runs again.
      clearTimeout(p.saveTimer);
      p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
    }
  }

  /**
   * The file on disk is not the file this page was opened from. Ask. "Keep mine" writes the
   * buffer over it; "Reload from disk" drops the buffer and reopens the page (or, when the page
   * is already being closed, just drops it); "Cancel" keeps both as they are and holds
   * autosave. Resolves `true` unless the user cancelled.
   */
  async function resolveConflict(p, text, rev, onDisk) {
    p.asking = true;
    let choice;
    try {
      choice = await choose({
        title: 'Changed on disk',
        body: `${p.path} was modified by something else since this page was opened. `
          + 'Keep your version and overwrite the file, or reload the file and lose your edits?',
        options: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Reload from disk', value: 'reload' },
          { label: 'Keep mine', value: 'keep', kind: 'primary' },
        ],
        cancel: 'cancel',
      });
    } finally {
      p.asking = false;
    }
    emit('conflict', { path: p.path, choice: choice || 'cancel' });
    if (choice === 'keep') {
      // The one write that destroys text this editor has never seen. The disk's version is kept
      // first, whatever the five-minute rule says, so `page.versions` can undo the decision.
      await keepDiskVersion(p.path, onDisk);
      try {
        await writeOut(p, text, rev);
      } catch (e) {
        saveFailed(p, e);
      }
      return true;
    }
    if (choice === 'reload') {
      p.dirty = false;
      p.hold = false;
      if (isActive()) bus.emit('doc:dirty', { path: p.path, dirty: false });
      emit('dirty', { path: p.path, dirty: false });
      // An open page is reopened from disk; a page already being closed just lets go of its
      // buffer (the disk text is what the next open reads anyway).
      if (p === page) await reopenInPlace(p); else p.baseline = onDisk;
      return true;
    }
    p.hold = true;
    p.warnedDisk = onDisk;
    setStatus('save', 'unsaved · changed on disk');
    return false;
  }

  /**
   * The file has left the disk (deleted, or moved somewhere the watcher did not tell us).
   * Nothing is written again: `writeText` creates parent folders, so a save from the stale
   * buffer would silently put the file back where the user just removed it (C18). The text is
   * still on screen; `page.copy-markdown` gets it out.
   */
  function fileGone(p) {
    if (p.readOnly) return;
    p.readOnly = true;
    clearTimeout(p.saveTimer);
    try { if (p.crepe) p.crepe.setReadonly(true); } catch (e) { console.error('[editor] readonly', e); }
    if (p.source) p.source.setReadOnly(true);
    if (p.titleEl) p.titleEl.contentEditable = 'false';
    for (const v of (p.el ? p.el.querySelectorAll('.ed-prop-val.editable') : [])) v.contentEditable = 'false';
    setStatus('save', 'file is gone · read-only');
    toast(`${p.path} was deleted or moved on disk. The page is read-only and nothing was written; copy as markdown keeps your text.`, 'err', 9000);
  }

  /** The file is back under its name (recreated, moved back): editing may resume. */
  function fileBack(p) {
    if (!p.readOnly) return;
    p.readOnly = false;
    try { if (p.crepe) p.crepe.setReadonly(false); } catch (e) { console.error('[editor] readonly', e); }
    if (p.source) p.source.setReadOnly(false);
    // In source mode the title strip stays a label: the text below is where the title is edited.
    if (p.titleEl && !p.source) p.titleEl.contentEditable = 'plaintext-only';
    for (const v of (p.el ? p.el.querySelectorAll('.ed-prop-val.editable') : [])) v.contentEditable = 'plaintext-only';
    setStatus('save', p.dirty ? 'unsaved' : null);
  }

  /**
   * S32: the meta line used to serialise the whole document on every keystroke — `getMarkdown()`
   * plus eight regex passes over the result, per key. The count comes from the ProseMirror
   * document now, and only when `recount` says so: markDirty repaints the line immediately with
   * the number it already has and schedules the recount on the same debounce as the save.
   */
  function updateMeta(p, recount = false) {
    if (!p.metaEl) return;
    if (recount) {
      const text = pageText(p);
      p.words = countWords(text);
      p.chars = text.length;
    }
    const n = (v) => v.toLocaleString();
    const bits = [];
    // A file with no title of its own says its name; a page's folder is in the breadcrumb.
    if (p.plain) bits.push(P.basename(p.path));
    bits.push(`${n(p.words)} word${p.words === 1 ? '' : 's'}`);
    bits.push(`${n(p.chars)} character${p.chars === 1 ? '' : 's'}`);
    const when = modifiedLabel(p.mtime);
    if (when) bits.push(when);
    const linked = backlinkCount(p.path);
    if (linked) bits.push(`${linked} linked`);
    if (p.mode === 'source' && !p.plain) bits.push('source');
    if (p.dirty) bits.push('unsaved');
    else if (p.savedAt) bits.push('saved ' + p.savedAt);
    p.metaEl.textContent = bits.join('  ·  ');
    setStatus('doc', `${n(p.words)} words`);
  }

  /**
   * The file's mtime, read once per open and once per save — never on the keystroke path (S32).
   * A file that is not on disk yet simply has none and the meta line drops that part.
   */
  async function readMtime(p) {
    try {
      const st = await bridge.stat(p.path);
      if (p !== page) return;
      p.mtime = st && st.exists ? Number(st.mtime) || 0 : 0;
    } catch { p.mtime = 0; }
    if (p === page) updateMeta(p);
  }

  /**
   * The text the counts are taken from: the title and the body, never the frontmatter. From the
   * ProseMirror document itself (never a serialisation) in block mode, from the buffer in source
   * mode, from the file before either is mounted.
   */
  function pageText(p) {
    try {
      if (p.source) return p.source.getText();
      const view = p.crepe ? editorView(p.crepe) : null;
      if (view) {
        const doc = view.state.doc;
        return `${p.title || ''} ${doc.textBetween(0, doc.content.size, '\n', ' ')}`;
      }
    } catch (e) { console.error('[editor] word count', e); }
    return `${p.title || ''} ${p.doc ? p.doc.body : ''}`;
  }

  // -------------------------------------------------------------------------
  // external changes

  /**
   * Something touched the open file from outside (the watcher, CONTRACT.md `fs`). Renames of
   * our own making never arrive here: renamePage and the title rename move `p.path` to the new
   * name before the event can, so the old path no longer matches (C18).
   */
  function onFsChange(payload) {
    const p = page;
    if (!p || !payload || !Array.isArray(payload.changes)) return;
    const hit = payload.changes.find((c) => c && c.path === p.path);
    if (!hit) return;
    if (hit.kind === 'rename') {
      if (hit.to) void followRename(p, hit.to);
      else fileGone(p);                 // renamed to somewhere the watcher could not pair
      return;
    }
    if (hit.kind === 'delete') { fileGone(p); return; }
    // create or modify
    if (p.readOnly) fileBack(p);
    if (Date.now() - p.selfWriteAt < 2500) return;   // our own write coming back
    if (p.dirty) { void warnChanged(p); return; }
    void reloadSilently(p);
  }

  /**
   * The file was renamed or moved under us. The page follows: every later save goes to the new
   * name (the old one must never be recreated), and the route is replaced so the breadcrumb,
   * the sidebar and back/forward agree. The router remounts, which flushes a dirty buffer to
   * the new path first — the text survives, the undo history does not.
   */
  async function followRename(p, to) {
    // Every file the editor can open follows its own rename, not just markdown: batch 12 opens
    // `TEXT_EXTS` in source mode, and treating `notes.txt -> notes2.txt` as a disappearance
    // turned the page read-only with the buffer stranded (QA F4). Same predicate openPage uses.
    if (!(P.isMarkdown(to) || P.isTextFile(to))) { fileGone(p); return; }
    const from = p.path;
    p.path = to;
    void renameRemembered(from, to);
    setStatus('path', to);
    updateMeta(p);
    toast(`moved on disk: ${from} → ${to}`);
    await navigate({ type: 'page', path: to }, { replace: true });
  }

  /**
   * Modified on disk while the buffer is dirty: the user's version stays, and the next save
   * will ask (B1). Read first, because a late echo of our own write is not a change at all,
   * and toast once per distinct disk text rather than once per event.
   */
  async function warnChanged(p) {
    let onDisk;
    try { onDisk = await bridge.readText(p.path); } catch { return; }
    if (p !== page || onDisk === p.baseline || onDisk === p.warnedDisk) return;
    p.warnedDisk = onDisk;
    setStatus('save', 'unsaved · changed on disk');
    toast(`${p.path} changed on disk — your next save will ask what to keep`, 'warn', 6000);
  }

  async function reloadSilently(p) {
    let text;
    try { text = await bridge.readText(p.path); } catch { return; }
    if (p !== page || text === p.baseline) return;
    await reopenInPlace(p);
  }

  /**
   * Reopen the page from disk in the same host, keeping the scroll position and the caret (E39).
   * The undo history does not survive: the document the editor is rebuilt from is a different
   * one, and a history over it would let Ctrl+Z type the old file back over the new.
   */
  async function reopenInPlace(p) {
    if (p !== page || !p.el) return;
    const scroller = scrollerOf(el);
    const top = scroller ? scroller.scrollTop : 0;
    const sel = currentSelection();
    const line = p.source ? p.source.view.state.doc.lineAt(p.source.view.state.selection.main.head).number : 0;
    await run(p.path, sel ? { selection: sel } : {});
    if (scroller) scroller.scrollTop = top;
    if (line && page && page.source) page.source.goToLine(line);
  }

  // -------------------------------------------------------------------------
  // what the commands do to this page

  /** The heading picker (C2). The title row scrolls to the top; a body heading takes the caret. */
  async function outlinePage() {
    const p = page;
    if (!p || !p.crepe) return;
    const view = editorView(p.crepe);
    if (!view) return;
    await pickHeading({
      view,
      title: p.doc.titleLine !== null ? p.title : null,
      onTitle: () => { if (p === page) focusTitle(p); },
    });
  }

  /**
   * Insert a link to another page at the caret (CONTRACT.md batch 5). The palette has just
   * closed, so the editor is focused first: the link goes where the caret was left.
   */
  async function linkPage() {
    const p = page;
    if (!p || !p.crepe) return;
    const view = editorView(p.crepe);
    if (!view) return;
    view.focus();
    await insertPageLink(view);
  }

  /**
   * Move the open page's file to `to` and follow it. The buffer is flushed first; if that
   * cannot happen (the changed-on-disk question was cancelled) the rename is off, because the
   * remount would show the disk's text and lose the buffer. `p.path` moves before the watcher
   * can report the rename, so onFsChange never mistakes our own move for an external one.
   */
  async function moveOpenPage(p, to) {
    // NTFS is case-insensitive, so `Chapter.md` -> `chapter.md` "exists" already; the host does
    // that rename through a temporary name (N17, P7) and only this guard was in the way.
    const caseOnly = to.toLowerCase() === p.path.toLowerCase();
    if (!caseOnly && await bridge.exists(to)) { toast(`${P.basename(to)} already exists`, 'err'); return false; }
    await saveNow({ explicit: true });
    if (p !== page) return false;
    if (p.dirty) { toast('not renamed: the page could not be saved first', 'warn'); return false; }
    const from = p.path;
    try {
      await bridge.rename(from, to);
    } catch (e) { toast('rename failed: ' + (e.message || e), 'err'); return false; }
    p.path = to;
    void renameRemembered(from, to);
    await navigate({ type: 'page', path: to }, { replace: true });
    void rewriteLinks(from, to);
    return true;
  }

  async function renamePage() {
    const p = page;
    if (!p || p.readOnly) return;
    const name = await prompt({ title: 'Rename page', value: P.basename(p.path), ok: 'Rename' });
    if (!name) return;
    const to = P.joinPath(P.dirname(p.path), cleanFileName(name));
    if (to === p.path || p !== page) return;
    await moveOpenPage(p, to);
  }

  /**
   * A new page is `Untitled.md` until it has a title (C12): once the H1 is edited and left,
   * the file takes the sanitised title as its name. Only files still named `Untitled*` —
   * a page with a real name keeps it; renaming that is the explicit Rename command's job.
   */
  async function renameUntitledFromTitle(p) {
    if (p !== page || p.readOnly || p.doc.titleLine === null) return false;
    if (!UNTITLED.test(P.stem(p.path))) return false;
    const title = String(p.title || '').trim();
    if (!title || UNTITLED.test(title)) return false;
    const to = P.joinPath(P.dirname(p.path), cleanFileName(title));
    if (to === p.path) return false;
    // The title stays as typed either way; only the file name is at stake, so a taken name is
    // a warning, not an error, and the file keeps its `Untitled` name until Rename.
    if (to.toLowerCase() !== p.path.toLowerCase() && await bridge.exists(to)) { toast(`${P.basename(to)} already exists; the file keeps its name`, 'warn'); return false; }
    if (p !== page) return false;
    return moveOpenPage(p, to);
  }

  /** `Name 2.md` beside the open page, with the file exactly as it would be saved (C11). */
  async function duplicatePage() {
    const p = page;
    if (!p) return;
    const from = p.path;
    await saveNow({ explicit: true });
    if (p !== page) return;
    let text;
    try {
      text = await bridge.readText(from);
    } catch (e) { toast('could not read the page: ' + (e.message || e), 'err'); return; }
    const to = await freePath(P.dirname(from), P.stem(from));
    try {
      await bridge.writeText(to, text);
    } catch (e) { toast('could not duplicate the page: ' + (e.message || e), 'err'); return; }
    navigate({ type: 'page', path: to });
  }

  /** The file text as a save would write it, on the clipboard (C14). */
  async function copyMarkdown() {
    const p = page;
    // Source mode included: `compose` hands the CodeMirror text back as the file, so the only
    // thing the old `!p.crepe` guard did was make the palette row do nothing there (QA F5).
    if (!p) return;
    let text;
    try {
      text = compose(p);
    } catch (e) { toast('could not serialise the page: ' + (e.message || e), 'err'); return; }
    const ok = await copyText(text);
    toast(ok ? 'copied' : 'copy failed', ok ? 'info' : 'err');
  }

  async function trashPage() {
    const p = page;
    if (!p) return;
    const ok = await confirm({
      title: `Move “${P.basename(p.path)}” to trash?`,
      body: `It goes to ${trashDestination()}. Nothing is deleted permanently.`,
      ok: 'Move to trash', danger: true,
    });
    if (!ok) return;
    const folder = P.dirname(p.path);
    p.dirty = false;              // do not resurrect the file by saving it on close
    await closePage({ keepAlive: true });
    // Where it goes is the user's setting, applied by the kernel (S37, P8).
    await bridge.trash(p.path);
    const next = await firstPageIn(folder);
    if (next) navigate({ type: 'page', path: next }); else clearRoute();
  }

  function focusPage() {
    const p = page;
    if (!p) return;
    if (p.source) { p.source.focus(); return; }
    if (p.crepe) { const view = editorView(p.crepe); if (view) { view.focus(); return; } }
    if (p.titleEl) p.titleEl.focus();
  }

  // -------------------------------------------------------------------------
  // the api the extension modules and the commands act through

  const api = {
    hasPage: () => !!page,
    getPage: () => page,
    getView: () => (page && page.crepe ? editorView(page.crepe) : null),
    getCrepe: () => (page ? page.crepe : null),
    getPath: () => (page ? page.path : null),
    getDoc: () => (page ? page.doc : null),
    focusTitle: () => { if (page) focusTitle(page); },
    focusBody: () => focusBody(),
    markDirty: () => { if (page) markDirty(page); },
    // A module that changed the document through a transaction the user asked for: the page has
    // been interacted with, so the change is allowed to reach the disk (see markDirty).
    touch: () => { if (page) { page.touched = true; markDirty(page); } },
    saveNow: (o) => saveNow(o),
    // The router saves this when a page is left and hands it back at the next open (N44, P7);
    // backlinks.js asks for a repaint when its count changes (N6).
    getSelection: () => currentSelection(),
    updateMeta: () => { if (page) updateMeta(page); },
    reopenInPlace: () => (page ? reopenInPlace(page) : Promise.resolve()),
    attachFile: (file) => (page ? attachFile(page, file) : Promise.reject(new Error('no page'))),
    // The find bar of the open page, whichever kind it is: the block editor's own bar, or
    // CodeMirror's panel in source mode. `page.replace` (commands.js) asks through this rather
    // than through find.js's `currentFind`, which only ever knows about the block editor's bar.
    openFind: (o) => { if (page && page.find) page.find.open(o || {}); },
    // Batch 12 (P5), source mode. `toggleSource` answers for itself when the file is not
    // markdown — one mode, and it says so — so there is no `canToggleSource` guard to ask (F20).
    isSource: () => !!(page && page.source),
    toggleSource: () => toggleSource(),
    // K1c: what the page-level commands do, so they can live at module level and act on
    // whichever page has the focus.
    hasCrepe: () => !!(page && page.crepe),
    isReadOnly: () => !!(page && page.readOnly),
    folder: () => (page ? P.dirname(page.path) : null),
    rename: () => renamePage(),
    trash: () => trashPage(),
    duplicate: () => duplicatePage(),
    copyMarkdown: () => copyMarkdown(),
    link: () => linkPage(),
    outline: () => outlinePage(),
    find: (o) => { if (page && page.find) page.find.open(o || {}); },
    reveal: () => { if (page) void bridge.reveal(page.path); },
  };
  inst.api = api;

  // -------------------------------------------------------------------------
  // the instance itself

  /** Become the page the commands and the status bar belong to. */
  function take() {
    if (active === inst) return;
    active = inst;
    if (page) { publishTitle(page); status.set('path', page.path); }
  }

  /** Hand the bar and the commands to whatever else is mounted, if anything is. */
  function release() {
    if (active !== inst) return;
    active = null;
    for (const other of instances) { if (other !== inst) { active = other; break; } }
  }

  /**
   * One open at a time, in order: a second call waits for the first rather than racing it.
   * The queue itself never holds a rejection — an open that throws is reported and the next
   * one still runs — but the caller's promise keeps it, so a router can say what failed.
   */
  function run(nextPath, options) {
    const next = opening.catch(() => {}).then(() => open(nextPath, options));
    opening = next.catch((e) => { console.error('[editor] open', e); });
    return next;
  }

  const handle = {
    get el() { return el; },
    get path() { return page ? page.path : null; },
    get dirty() { return !!(page && page.dirty); },
    get mode() { return page ? page.mode : 'block'; },
    get readOnly() { return !!(page && page.readOnly); },
    get ready() { return opening; },
    open: (nextPath, options = {}) => run(nextPath, options),
    close: async () => {
      if (closed) return;
      closed = true;
      try { await opening; } catch { /* the open already said so */ }
      instances.delete(inst);
      await closePage();
      releaseCommands();
    },
    save: (o) => saveNow(o),
    focus: () => focusPage(),
    find: (query) => { if (page && page.find) page.find.open(query ? { query } : {}); },
    goToLine: (line, col) => scrollToLine(line, col),
    selection: () => currentSelection(),
    on,
  };
  inst.handle = handle;

  instances.add(inst);
  take();
  acquireCommands();
  wireGlobals();
  void run(path, opts);
  return handle;
}

// ---------------------------------------------------------------------------
// module level: the things one document has one of

const anchorAt = (e) => (e.target instanceof Element ? e.target.closest('a[href], a.link-display') : null);
const inTooltip = (a) => !!a.closest('.milkdown-link-preview, .milkdown-link-edit');

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(fr.error || new Error('read failed'));
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.readAsDataURL(file);
});

/** A file name from free text: no path separators or Windows-reserved characters, one `.md`. */
const cleanFileName = (name) =>
  String(name).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.md$/i, '').replace(/[. ]+$/, '') + '.md';

/** Free `<folder>/<base>.md`, numbered if taken. */
async function freePath(folder, base) {
  const dir = folder ? folder + '/' : '';
  let candidate = `${dir}${base}.md`;
  for (let n = 2; await bridge.exists(candidate); n++) candidate = `${dir}${base} ${n}.md`;
  return candidate;
}

async function firstPageIn(folder) {
  try {
    const list = await bridge.list(folder);
    const md = list.find((n) => n.kind === 'file' && n.ext === 'md');
    return md ? md.path : null;
  } catch { return null; }
}

/** `modified today` / `modified yesterday` / `modified 9 Sep 2026`. Empty for a file with no mtime. */
function modifiedLabel(mtime) {
  const ms = Number(mtime) || 0;
  if (!ms) return '';
  const d = new Date(ms);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = day(new Date());
  if (day(d) === today) return 'modified today';
  if (day(d) === today - 86_400_000) return 'modified yesterday';
  return 'modified ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Links in other pages that pointed at the old name follow it (C13). The rewrite is
 * `ose.links.rewriteMoved(from, to) -> {files, links, failed}`. A page whose write failed is
 * named, one toast each, exactly as the sidebar's rename does: a count that silently leaves a
 * broken link out is worse than no count (QA F21).
 */
async function rewriteLinks(from, to) {
  try {
    const r = await rewriteInbound(from, to);
    const links = Number(r && r.links) || 0;
    const files = Number(r && r.files) || 0;
    if (links > 0) toast(`renamed · ${links} link${links === 1 ? '' : 's'} in ${files} page${files === 1 ? '' : 's'} updated`);
    for (const p of (r && r.failed) || []) toast('could not update links in ' + p, 'err');
  } catch (e) {
    toast('renamed, but the links to it could not be updated: ' + (e.message || e), 'warn');
  }
}

/**
 * Two frames, or 80ms, whichever comes first — and exactly once.
 *
 * A window that is hidden (minimised, another virtual desktop, a background tab) fires no
 * animation frames at all, so a bare `requestAnimationFrame` chain never runs and the caret
 * never leaves the top of the page. `ready` in `open` has had the same fallback since batch 9;
 * the jump needs it for the same reason.
 */
function afterLayout(fn) {
  let done = false;
  const once = () => { if (done) return; done = true; fn(); };
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, 80);
}

// ---------------------------------------------------------------------------
// the listeners one document has one of

let globalsWired = false;

function wireGlobals() {
  if (globalsWired) return;
  globalsWired = true;
  // link.js turns a picked page into an href relative to the page being edited.
  bindPagePath(() => (active ? active.path() : null));
  // The bridge facade already re-emits 'fs' onto the bus; listening to both would reload twice.
  bus.on('fs', (payload) => { for (const i of [...instances]) i.onFsChange(payload); });
  // Spellcheck is a setting now (L12/E43): a page already open follows a change to it.
  bus.on('settings', () => { for (const i of [...instances]) i.applySpellcheck(); });
  // The returned promise is what the Tauri adapter waits on before destroying the window
  // (B2). It resolves `false` when the save needs the user (the file changed on disk): the
  // adapter then keeps the window, the question is on screen, and closing again retries.
  onWindowClose(() => saveAll({ explicit: true, closing: true }));
  window.addEventListener('beforeunload', () => {
    for (const i of [...instances]) if (i.isDirty()) void i.save({ explicit: true });
  });
}

async function saveAll(opts) {
  let ok = true;
  for (const i of [...instances]) {
    let answer = true;
    try { answer = await i.save(opts); } catch (e) { console.error('[editor] save on close', e); }
    if (answer === false) ok = false;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// the commands
//
// Registered when the first page mounts and removed when the last one closes, plus one
// reference `initEditor()` holds for the rice, so `page.new` is there with no page open.

let cmdRefs = 0;
let dropCommands = null;

const hasPage = () => !!(active && active.api.hasPage());

/**
 * What the batch-12 modules (extensions.js) get of the open page. Accessors, never the object
 * itself, because the page is replaced on every open and the *instance* is replaced when the
 * focus moves. Modules go through this and do not import page.js, so the graph stays a tree
 * (docs/CONTRACT.md batch 12).
 */
const editorApi = {};
for (const name of [
  'hasPage', 'getPage', 'getView', 'getCrepe', 'getPath', 'getDoc', 'focusTitle', 'focusBody',
  'markDirty', 'touch', 'saveNow', 'getSelection', 'updateMeta', 'reopenInPlace', 'attachFile',
  'openFind', 'isSource', 'toggleSource', 'hasCrepe', 'isReadOnly', 'folder', 'rename', 'trash',
  'duplicate', 'copyMarkdown', 'link', 'outline', 'find', 'reveal',
]) {
  editorApi[name] = (...args) => {
    const a = activeApi();
    if (!a) return name === 'hasPage' || name === 'isSource' || name === 'hasCrepe' ? false : undefined;
    return a[name](...args);
  };
}

export function acquireCommands() {
  if (cmdRefs++ > 0) return releaseCommands;
  dropCommands = collectCommands(() => registerCommands());
  return releaseCommands;
}

export function releaseCommands() {
  if (cmdRefs === 0) return;
  if (--cmdRefs > 0) return;
  if (dropCommands) dropCommands();
  dropCommands = null;
}

function registerCommands() {
  registerExtensionCommands(editorApi);
  commands.register({
    id: 'page.new', title: 'New page', group: 'page', shortcut: 'Ctrl+N',
    run: () => void newPage(),
  });
  commands.register({
    id: 'page.save', title: 'Save page', group: 'page', shortcut: 'Ctrl+S',
    when: hasPage, run: () => void editorApi.saveNow({ explicit: true }),
  });
  commands.register({
    id: 'page.rename', title: 'Rename page', group: 'page',
    when: hasPage, run: () => void editorApi.rename(),
  });
  commands.register({
    id: 'page.trash', title: 'Move page to trash', group: 'page',
    when: hasPage, run: () => void editorApi.trash(),
  });
  commands.register({
    id: 'page.reveal', title: 'Reveal in Explorer', group: 'page',
    when: hasPage, run: () => editorApi.reveal(),
  });
  commands.register({
    id: 'page.link', title: 'Link a page', group: 'page',
    when: hasPage, run: () => void editorApi.link(),
  });
  commands.register({
    id: 'page.duplicate', title: 'Duplicate page', group: 'page',
    when: hasPage, run: () => void editorApi.duplicate(),
  });
  commands.register({
    id: 'page.copy-markdown', title: 'Copy as markdown', group: 'page',
    when: hasPage, run: () => void editorApi.copyMarkdown(),
  });
  commands.register({
    id: 'page.print', title: 'Print page', group: 'page',
    when: hasPage, run: () => printPage(),
  });
  // The chords are the kernel's (keys.js): Ctrl+F for find, the outline's is its choice.
  commands.register({
    id: 'page.find', title: 'Find in page', group: 'page',
    when: hasPage, run: () => editorApi.find(),
  });
  // The heading picker reads the ProseMirror document, so it is the block editor's alone: in
  // source mode it is not offered rather than offered and silent (QA F5).
  commands.register({
    id: 'page.outline', title: 'Go to heading', group: 'page',
    when: () => !!(active && active.api.hasCrepe()), run: () => void editorApi.outline(),
  });
}

async function newPage() {
  // In focus mode a new page belongs to the focus folder; otherwise beside the open page, or
  // in Scratchpad when a view is open (CONTRACT.md batch 4).
  const focused = defaultNewFolder();
  const folder = focused || (hasPage() ? editorApi.folder() : scratchFolder());
  const path = await freePath(folder, 'Untitled');
  try {
    await bridge.writeText(path, '# Untitled\n');
  } catch (e) { toast('could not create the page: ' + (e.message || e), 'err'); return; }
  navigate({ type: 'page', path });
  // The router mounts asynchronously; select the title once it is there.
  const selectNewTitle = () => {
    const inst = activeInst();
    const titleEl = inst && inst.path() === path ? inst.titleEl() : null;
    if (!titleEl) return void setTimeout(selectNewTitle, 40);
    titleEl.focus();
    const r = document.createRange();
    r.selectNodeContents(titleEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  };
  setTimeout(selectNewTitle, 40);
}

/**
 * Print the page column (C14). Paper is white, so the dark palette would print pale text on
 * it: the light tokens are borrowed for the dialog. `window.print()` blocks until the dialog
 * closes in Chromium; `afterprint` covers a host where it does not. The theme attribute is
 * put back exactly as it was (the shell owns it and is not told).
 */
function printPage() {
  if (!hasPage()) return;
  const root = document.documentElement;
  const was = root.dataset.theme;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    window.removeEventListener('afterprint', restore);
    if (was === undefined) delete root.dataset.theme; else root.dataset.theme = was;
  };
  window.addEventListener('afterprint', restore);
  root.dataset.theme = 'light';
  try { window.print(); } finally { setTimeout(restore, 0); }
}

/** The page the commands act on, for whoever needs to ask (the compatibility layer). */
export function activePage() { return active ? active.handle : null; }
