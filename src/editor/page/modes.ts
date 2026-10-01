// Part of the markdown page (../page.ts). Rich and Source: the mode a page is edited in, and
// moving from one to another.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installModes(ctx)`, and reaches the rest through `ctx`.

import { bus, log } from '../host.ts';
import { toast } from '../deps.ts';
import { bodyStartLine, posForBodyLine, titleLineNo } from '../lines.ts';
import { caretAt, scrollerOf } from '../reveal.ts';
import { rememberMode } from '../modes.ts';
import { parseDoc } from '../doc.ts';
import * as P from '../paths.ts';
import {
  checkOpened, editorView, errText, hasEditor, INTERNAL, MODE_CHOICES, MODE_LABEL, PUBLIC,
} from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installModes(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // rich and source (H14, X1)

  /** Ctrl+E: Source, or back from it to Rich (§4.5). */
  function toggleSource() {
    const p = ctx.page;
    if (!p || !hasEditor(p)) return Promise.resolve(false);
    return setMode(p.source ? 'rich' : 'source');
  }

  /** The status field's click: the other mode. */
  function nextMode() {
    return toggleSource();
  }

  /**
   * Show the page in `want` ('rich' or 'source'). The buffer, not the file, crosses
   * over, and nothing is written: the dirty flag and the baseline are untouched.
   *
   * Rich → Source never refuses (H14). A clean page shows the disk text itself; a dirty one the
   * text a save would write, or when the guard says that text is not safe, its best effort —
   * the page stays dirty and the user checks it there. Source → Rich parses the text and asks
   * the open check; when the rich view cannot hold all of it, the page stays where it was
   * and the banner says why. The undo history of the editor being left does not survive.
   *
   * `o.text` puts that text in instead of the buffer's (a recovered draft); `o.forced` is the
   * reason the mode was not the user's choice, and a forced mode is never remembered.
   */
  async function setMode(want, o: any = {}) {
    const p = ctx.page;
    if (!p || !hasEditor(p)) return false;
    if (!INTERNAL[want]) return false;
    if (p.plain && want !== 'source') {
      toast(`${P.basename(p.path)} is not markdown: source is its only mode`, 'info');
      return false;
    }
    const now = publicMode(p);
    if (want === now && typeof o.text !== 'string') return true;
    if (p.switching) { await p.switching; return setMode(want, o); }
    let done: (v?: unknown) => void = (): void => {};
    p.switching = new Promise<any>((r) => { done = r; });
    try {
      return await switchTo(p, want, o);
    } finally {
      p.switching = null;
      done();
    }
  }

  async function switchTo(p, want, o) {
    const host = p.el ? p.el.parentNode : null;
    if (!host) return false;
    const from = publicMode(p);
    // H1: nothing typed may land between the compose and the teardown.
    const wasFrozen = p.frozen;
    ctx.freeze(p);
    let text;
    let exact = true;
    if (typeof o.text === 'string') text = o.text;
    else if (p.source) text = p.source.getText();
    else if (!p.dirty) text = p.baseline;
    else {
      const r = ctx.composeChecked(p);
      text = r.text ?? ctx.bestEffort(p);
      exact = r.status !== 'unsafe';
      if (r.status === 'unsafe') log(`guard unsafe ${p.path}: ${r.reason}`, 'warn');
    }
    const scroller = scrollerOf(host);
    const top = scroller ? scroller.scrollTop : 0;

    // Between the teardown and the new mount the buffer lives only in `text`: it goes to a draft
    // first, so a mount that throws cannot take it with it. Text handed in (`o.text`, a recovered
    // draft) is not the buffer and is already kept: its caller writes the draft over its own hash.
    if (p.dirty && typeof o.text !== 'string') await ctx.writeDraftText(p, text, exact && !ctx.unchecked(p));
    if (p !== ctx.page) return false;

    let refused: string | null = null;
    try {
      await remount(p, INTERNAL[want], text);
      if (p !== ctx.page) return false;
      if (p.crepe) {
        const check = checkOpened(p.crepe, p.doc.body);
        if (!check.ok) {
          refused = check.reason;
          await remount(p, 'source', text);
          if (p !== ctx.page) return false;
        }
      }
    } catch (e) {
      if (p !== ctx.page) return false;
      console.error('[editor] mode switch', e);
      log(`mode switch failed ${p.path}: ${errText(e)}`, 'error');
      refused = `the editor could not be built: ${errText(e)}`;
      if (!await mountFallback(p, text)) {
        if (!wasFrozen) ctx.unfreeze(p);
        ctx.publishState(p);
        return false;
      }
    }
    if (scroller) scroller.scrollTop = top;
    if (!wasFrozen) ctx.unfreeze(p);

    if (refused) {
      p.notice = want === 'rich'
        ? `Staying in source: the rich view cannot show part of this page (${refused}).`
        : `Staying in source: ${refused}.`;
      log(`${from} to ${want} refused ${p.path}: ${refused}`, 'warn');
      ctx.publishState(p);
      publishMode(p);
      return false;
    }
    p.forced = o.forced || (p.plain ? 'plain' : null);
    if (!p.forced) {
      p.notice = null;
      void rememberMode(p.path, publicMode(p));
    }
    ctx.publishState(p);
    publishMode(p);
    if (!o.quiet) ctx.focusPage();
    return true;
  }

  /**
   * A mount that threw: the text again in source mode, which parses nothing and cannot fail on
   * it. When even that throws, the text stays on the page (`orphan`), where the draft, Copy
   * text and Save as still find it. True when the source view is up.
   */
  async function mountFallback(p, text) {
    try {
      await remount(p, 'source', text);
      if (p === ctx.page && p.source) { p.orphan = null; return true; }
    } catch (e) {
      console.error('[editor] source fallback', e);
    }
    if (p !== ctx.page) return false;
    p.orphan = text;
    p.notice = 'The editor could not be built. Copy your text, or save it as a new file.';
    return false;
  }

  /** Unmount the body and mount `text` in `mode`; the column is rebuilt, the flags are kept. */
  async function remount(p, mode, text) {
    const host = p.el ? p.el.parentNode : ctx.el;
    await ctx.unmountBody(p);
    if (p !== ctx.page) return false;
    p.orphan = null;
    p.mode = mode;
    p.doc = p.plain ? ctx.plainDoc(text) : parseDoc(text);
    p.title = p.doc.title;
    ctx.publishTitle(p);
    p.titleSelected = false;
    ctx.buildDom(p, host);
    return ctx.mountBody(p, text);
  }

  /**
   * Open the page as text, whatever it was: `lossy-open` at open (C10) and `unsafe` after a
   * guard refusal (§7.1). The buffer keeps its dirty flag; the mode is not remembered.
   */
  async function forceSource(p, text, forced, reason) {
    const wasFrozen = p.frozen;
    ctx.freeze(p);
    await remount(p, 'source', text);
    if (p !== ctx.page) return;
    if (!wasFrozen) ctx.unfreeze(p);
    p.forced = forced;
    p.notice = forced === 'lossy-open'
      ? `Opened as text: the rich view cannot show part of this page (${reason}).`
      : 'The rich view could not write this page exactly. It is open as text: check it and save.';
    log(`opened as text ${p.path} (${forced}): ${reason}`, 'warn');
    ctx.publishState(p);
    publishMode(p);
  }

  /** The words the status bar and the handle use for the mode: 'rich' or 'source'. */
  const publicMode = (p) => (p && PUBLIC[p.mode]) || 'rich';

  /** The mode, to the bus, the handle, the status bar and the switch in the meta line. */
  function publishMode(p) {
    if (!p) return;
    const mode = publicMode(p);
    const info = { path: p.path, mode, forced: p.forced || null };
    bus.emit('doc:mode', info);
    ctx.emit('mode', info);
    paintMode(p);
  }

  /**
   * The status bar's mode field (§4.5): a menu of the two modes, the current one checked, or
   * the one word `Text` for a file that is not markdown. The meta line's switch follows.
   */
  function paintMode(p) {
    if (!p) return;
    const mode = publicMode(p);
    if (p.plain) ctx.setStatus('mode', { text: 'Text' });
    else {
      ctx.setStatus('mode', {
        text: MODE_LABEL[mode],
        title: 'Editing mode',
        choices: MODE_CHOICES,
        value: mode,
        onChoose: (value) => { if (p === ctx.page) void setMode(value); },
        onClick: () => { if (p === ctx.page) void nextMode(); },
      });
    }
    if (p.modeEl) {
      for (const b of p.modeEl.querySelectorAll('button[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }
  }

  /**
   * Put the caret in the block holding file line `line` (1-based) and bring it into view. A
   * line above the body — frontmatter, the title — scrolls to the top, with the caret in the
   * title when the line is the title's. True when there was a page to scroll.
   */
  function scrollToLine(line, col) {
    const p = ctx.page;
    const n = Math.floor(Number(line) || 0);
    if (!p || !p.el || n < 1) return false;
    // Source counts the same lines the search overlay counts: the file's own.
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
    if (!p.doc) return false;
    const pos = posForBodyLine(p.crepe, view, p.doc.body, n - start + 1, col);
    caretAt(view, pos, { block: 'start', always: true, focus: true });
    return true;
  }

  /**
   * The find bar, seeded with the term a search hit was found by (N36). Silent when there is no
   * term; loud in the console when there is one and no bar to put it in.
   */
  function openFindWith(p, query) {
    if (!query) return;
    if (p && p.find && typeof p.find.open === 'function') { p.find.open({ query }); return; }
    console.warn('[editor] no find bar to seed with', query);
  }

  /**
   * Put a `{from, to}` the router remembered back on the document (N44). `caretAt` does the
   * dispatch itself, and `always` makes it scroll even when the position is already on screen.
   */
  function restoreSelection(p, sel) {
    if (!p || !sel) return;
    const view = p.crepe ? editorView(p.crepe) : null;
    if (!view) return;
    const size = view.state.doc.content.size;
    const from = Math.max(0, Math.min(Math.floor(Number(sel.from) || 0), size));
    caretAt(view, from, { block: 'center', always: true, focus: true });
  }

  /**
   * Where the caret is, for the router to hand back at the next open (N44, P7).
   */
  function currentSelection() {
    const view = ctx.page && ctx.page.crepe ? editorView(ctx.page.crepe) : null;
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
    const sel = getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }

  /**
   * Flush now. `explicit` is a user gesture (Ctrl+S, leaving the page): it asks the
   * changed-on-disk question. `closing` means the window is about to go, so the question cannot
   * be awaited: it is shown and the save answers false. Answers true only when the disk holds
   * the buffer afterwards (§6.2).
   */
  async function saveNow(o: any = {}) {
    if (!ctx.page) return true;
    clearTimeout(ctx.page.saveTimer);
    return ctx.saveDoc(ctx.page, o);
  }

  return {
    toggleSource,
    nextMode,
    setMode,
    switchTo,
    mountFallback,
    remount,
    forceSource,
    publicMode,
    publishMode,
    paintMode,
    scrollToLine,
    openFindWith,
    restoreSelection,
    currentSelection,
    focusTitle,
    saveNow,
  };
}
