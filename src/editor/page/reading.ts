// Part of the markdown page (../page.ts). The Reading view, and the Live mode's own commands.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installReading(ctx)`, and reaches the rest through `ctx`.

import { log } from '../host.ts';
import { toast } from '../deps.ts';
import { bodyStartLine, posForBodyLine } from '../lines.ts';
import { revealPos, scrollerOf } from '../reveal.ts';
import { EditorView } from '@codemirror/view';
import { LIVE_COMMANDS } from '../live/index.ts';
import { createReadingView } from '../reading/index.ts';
import * as P from '../paths.ts';
import { afterLayout, editorView, errText, hasEditor, READING_REFUSAL } from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installReading(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // the Reading view (X3)

  /** The buffer as a save would write it, for the Reading view: never composed twice for nothing. */
  function readingText(p) {
    if (p.source) return p.source.getText();
    if (p.live) return p.live.getText();
    if (!p.dirty) return p.baseline;
    let r;
    try { r = ctx.composeChecked(p); } catch { r = { text: null }; }
    return typeof r.text === 'string' ? r.text : ctx.bestEffort(p);
  }

  /** The first file line in view (1-based): the editor's own answer, or for Rich, the scroll's. */
  function topLineOf(p) {
    try {
      if (p.source) return p.source.topLine();
      if (p.live) return p.live.topLine();
    } catch { return 1; }
    const scroller = scrollerOf(p.el);
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return 1;
    const lines = String(p.baseline || '').split('\n').length;
    return Math.max(1, Math.round((scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight)) * lines));
  }

  /** `page.reading-toggle`, and the Read button. */
  function toggleReading() {
    const p = ctx.page;
    if (!p) return false;
    if (p.reading) { closeReading(p); return true; }
    return openReading(p);
  }

  /**
   * The buffer, rendered, read-only, in place of the editor (X3). The editor stays mounted and
   * hidden underneath with its buffer, undo history and dirty flag; coming back is to the same
   * mode. Links follow as they do in the page.
   */
  function openReading(p) {
    if (!hasEditor(p) || !p.metaEl) return false;
    if (p.plain) { toast(`${P.basename(p.path)} is not markdown: there is nothing to render`, 'info'); return false; }
    const line = topLineOf(p);
    // Where the editor was, to the pixel: a glance at the Reading view and back, with no
    // scrolling in between, lands exactly there again (`closeReading`).
    const scroller = scrollerOf(p.el);
    const editorTop = scroller ? scroller.scrollTop : 0;
    // A plain container: the view's own element is the document, named, and the one tab stop.
    const holder = document.createElement('div');
    holder.className = 'ed-reading';
    p.metaEl.after(holder);
    let view;
    try {
      view = createReadingView({
        host: holder,
        text: readingText(p),
        path: p.path,
        resolveAsset: (src) => ctx.resolveImage(p, src),
        resolveWikilink: (target) => ctx.resolveWikilink(p, target),
        onOpenLink: (href, o) => { void ctx.openLinkFrom(p, href, o); },
      });
    } catch (e) {
      holder.remove();
      console.error('[editor] reading', e);
      toast(`could not show the reading view: ${errText(e)}`, 'err');
      return false;
    }
    holder.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (p === ctx.page) closeReading(p);
    });
    const r: { view: any; el: HTMLElement; from: string; editorTop: number; startLine: number | null; } = { view, el: holder, from: ctx.publicMode(p), editorTop, startLine: null };
    p.reading = r;
    p.el.classList.add('ed-reading-on');
    ctx.paintMode(p);
    view.el.focus({ preventScroll: true });
    afterLayout(() => {
      if (p.reading !== r) return;
      if (line > 1) view.goToLine(line);
      try { r.startLine = view.topLine(); } catch { r.startLine = null; }
    });
    return true;
  }

  /**
   * Back to the editor. The caret stays where the user left it: reading is not editing. The
   * scroll comes back to the pixel when the Reading view was not scrolled; otherwise the line
   * the Reading view was showing goes to the top of the column, and still the caret stays.
   */
  function closeReading(p, o: any = {}) {
    const r = p && p.reading;
    if (!r) return;
    let line = 1;
    try { line = r.view.topLine(); } catch { line = 1; }
    const moved = r.startLine === null || line !== r.startLine;
    p.reading = null;
    try { r.view.destroy(); } catch (e) { console.error('[editor] reading destroy', e); }
    r.el.remove();
    if (p.el) p.el.classList.remove('ed-reading-on');
    ctx.paintMode(p);
    if (o.focus === false || p !== ctx.page) return;
    const place = () => {
      if (p !== ctx.page || p.reading) return;
      if (moved) scrollLineToTop(p, line);
      else { const s = scrollerOf(p.el); if (s) s.scrollTop = r.editorTop; }
    };
    place();
    ctx.focusPage();
    // The editor was hidden: its height may settle a frame later, and the scroll with it.
    afterLayout(place);
  }

  /**
   * File line `line` (1-based) at the top of the column, with the selection left alone: a
   * CodeMirror scroll effect in Source and Live, a scroll of the column in Rich.
   */
  function scrollLineToTop(p, line) {
    const n = Math.max(1, Math.floor(Number(line) || 1));
    const cm = p.source ? p.source.view : p.live ? p.live.view : null;
    if (cm) {
      const doc = cm.state.doc;
      const at = doc.line(Math.min(n, doc.lines));
      cm.dispatch({ effects: EditorView.scrollIntoView(at.from, { y: 'start' }) });
      return;
    }
    const view = p.crepe ? editorView(p.crepe) : null;
    const scroller = scrollerOf(p.el);
    if (!view || !p.doc) return;
    const start = bodyStartLine(p.doc);
    if (n < start) { if (scroller) scroller.scrollTop = 0; return; }
    revealPos(view, posForBodyLine(p.crepe, view, p.doc.body, n - start + 1), { block: 'start', always: true });
  }

  /**
   * Paste as plain text in Live: the clipboard's text goes in raw, one input.paste edit. The
   * chord already does this inside the view (paste.js lets the browser's plain paste through);
   * this is the palette's and the menu's way to it.
   */
  async function livePastePlain(p) {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { text = ''; }
    if (!text) { toast('nothing to paste · Ctrl+Shift+V pastes plain text', 'info'); return; }
    if (p !== ctx.page || !p.live || p.frozen || p.readOnly) return;
    const v = p.live.view;
    v.dispatch({ ...v.state.replaceSelection(text), userEvent: 'input.paste', scrollIntoView: true });
    p.live.focus();
  }

  /** See `api.liveRun`. */
  function liveRun(id) {
    const p = ctx.page;
    if (!p || !p.live) return false;
    if (id === 'format.paste-plain') { void livePastePlain(p); return true; }
    if (!LIVE_COMMANDS.includes(id)) { toast('Not available in Live', 'info', 2000); return false; }
    // The Live view is hidden under the Reading view: nothing edits it unseen (X3).
    if (p.reading) { toast(READING_REFUSAL, 'info', 2000); return false; }
    if (p.frozen || p.readOnly) {
      if (id !== 'page.follow-link') return false;
    }
    if (!p.live.hasFocus()) p.live.focus();
    try { return p.live.run(id) !== false; } catch (e) {
      console.error('[editor] live command', id, e);
      log(`live command failed ${id}: ${errText(e)}`, 'error');
      return false;
    }
  }

  return {
    readingText,
    topLineOf,
    toggleReading,
    openReading,
    closeReading,
    scrollLineToTop,
    livePastePlain,
    liveRun,
  };
}
