// Part of the markdown page (../page.ts). The instance: the active page, parked in the background,
// and back on screen.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installPark(ctx)`, and reaches the rest through `ctx`.

import { status, store } from '../host.ts';
import { activeInstance, instances, overCap, setActive } from '../instances.ts';
import { scrollerOf } from '../reveal.ts';
import { afterLayout } from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installPark(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // the instance itself

  /** Say everything the status bar and the window title want, as the active page. */
  function repaint() {
    if (!ctx.page) return;
    ctx.publishTitle(ctx.page);
    ctx.page.lastSave = '';
    ctx.paintSave(ctx.page);
    ctx.paintMode(ctx.page);
    ctx.updateMeta(ctx.page);
  }

  /** Become the page the commands and the status bar belong to. */
  function take() {
    if (activeInstance() === ctx.inst) return;
    setActive(ctx.inst);
    repaint();
  }

  /** Hand the bar and the commands to whatever else is on screen, if anything is. */
  function release() {
    if (activeInstance() !== ctx.inst) return;
    let next: any = null;
    for (const other of instances) { if (other !== ctx.inst && !other.parked) { next = other; break; } }
    setActive(next);
    if (next) next.repaint();
  }

  // -------------------------------------------------------------------------
  // parking (M12, M24)

  /**
   * The tab this page is in went to the background: the column leaves the document, the
   * editor stays alive in a holder of its own. Nothing is asked and nothing is refused — the
   * buffer is kept, not let go — so this always answers true. A dirty page is saved in the
   * background, and a save that does not land shows through `doc:state` as it always does:
   * autosave, drafts, the watcher, the leave gate and the path changes all keep covering a
   * parked page. The status bar and the title go to whatever is on screen next.
   */
  function park() {
    if (ctx.closed || ctx.parked) return true;
    const scroller = scrollerOf(ctx.el);
    ctx.parkScroll = scroller ? scroller.scrollTop : 0;
    ctx.parkFocus = !!(document.activeElement && ctx.el.contains(document.activeElement));
    const holder = document.createElement('div');
    holder.className = 'ed-parked';
    while (ctx.el.firstChild) holder.append(ctx.el.firstChild);
    ctx.el = holder;
    ctx.parked = true;
    ctx.inst.usedAt = Date.now();
    const p = ctx.page;
    if (p && p.bindParent) p.bindParent();
    if (activeInstance() === ctx.inst) {
      status.set('doc', null);
      status.set('save', null);
      status.set('mode', null);
      store.set('pageTitle', null);
    }
    release();
    if (p && p.dirty && !p.saving) {
      clearTimeout(p.saveTimer);
      p.saveTimer = 0;
      void ctx.saveDoc(p).then((ok) => { if (!ok && p === ctx.page && p.dirty) void ctx.writeDraft(p); });
    }
    // The cap is a memory budget: the least recently used clean pages past it are let go.
    for (const other of overCap()) { if (other !== ctx.inst) void other.handle.close(); }
    return true;
  }

  /**
   * Back on screen, in `host`: the same column, buffer, undo history and mode. The scroll it
   * was left at comes back, and the focus when it had it; a `line` or a `query` the router
   * hands over wins over the old scroll, as it does at an open.
   */
  function reattach(host, o: any = {}) {
    if (ctx.closed || !ctx.parked) return;
    const holder = ctx.el;
    host.innerHTML = '';
    while (holder.firstChild) host.append(holder.firstChild);
    ctx.el = host;
    ctx.parked = false;
    ctx.inst.usedAt = Date.now();
    const p = ctx.page;
    if (p && p.bindParent) p.bindParent();
    take();
    if (p) {
      // A page frozen by a leave that is no longer in flight — a navigation superseded while its
      // wait timed out (wave 2, open) — would stay read-only for good: nothing else unfreezes a
      // page that is shown again. A leave or a switch in flight, a rename or a trash, keep theirs.
      if (p.frozen && !ctx.leaving && !p.switching && !p.moving && !p.trashed) ctx.stay();
      p.lastBanner = '';
      ctx.publishState(p);
      if (p.source) { try { p.source.view.requestMeasure(); } catch { /* not laid out yet */ } }
      if (p.live) { try { p.live.refresh(); } catch { /* not laid out yet */ } }
    }
    const scroll = ctx.parkScroll;
    const focus = ctx.parkFocus;
    afterLayout(() => {
      if (ctx.parked || ctx.closed || p !== ctx.page) return;
      if (p && o.line) { ctx.scrollToLine(o.line, o.col); ctx.openFindWith(p, o.query); return; }
      if (focus) ctx.focusPage();
      const scroller = scrollerOf(ctx.el);
      if (scroller) scroller.scrollTop = scroll;
      if (p) ctx.openFindWith(p, o.query);
    });
  }

  /** Destroy this instance, saving first. False when its text could not be saved. */
  function letGo() {
    return ctx.handle.close();
  }

  return {
    repaint,
    take,
    release,
    park,
    reattach,
    letGo,
  };
}
