// Part of the markdown page (../page.ts). Leaving a page, and the file operations that move or
// delete the file it shows.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installLeave(ctx)`, and reaches the rest through `ctx`.

import { log, navigate } from '../host.ts';
import { renameMode } from '../modes.ts';
import * as P from '../paths.ts';
import { covers, mapPath } from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installLeave(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // leaving (C1, C5)

  /**
   * May the page be left? A clean page freezes and says yes; a dirty one is saved first, and
   * a conflict question may be awaited here. When the save does not land the page stays
   * editable, the banner says why and takes the focus, and the answer is no. Re-entrant: a
   * second call while one is in flight awaits the same answer. `stay()` undoes the freeze of a
   * yes the caller did not use.
   * @param _reason why the page is being left (a caller's word; not used)
   */
  function canLeave(_reason: string) {
    if (ctx.leaving) return ctx.leaving;
    const p = ctx.page;
    if (!p) return Promise.resolve(true);
    ctx.leaving = (async () => {
      try {
        freeze(p);
        if (!p.dirty || p.trashed) return true;
        if (unchecked(p) && await leaveAsDraft(p)) return true;
        let ok = false;
        if (!unchecked(p)) {
          try { ok = await ctx.saveNow({ explicit: true, leaving: true, teardown: true }); } catch (e) { console.error('[editor] leave', e); }
        }
        if (ok && !p.dirty) return true;
        if (p === ctx.page) { unfreeze(p); void ctx.writeDraft(p); ctx.focusBanner(p); }
        return false;
      } finally {
        ctx.leaving = null;
      }
    })();
    return ctx.leaving;
  }

  /**
   * The window is going (closed, reloaded, switched to another vault). The same as `canLeave`,
   * except that a question cannot be awaited into a window on its way out: it is shown, and
   * the answer is no. A yes stays frozen until the core says the window stays after all.
   */
  async function leaveWindow() {
    const p = ctx.page;
    if (!p) return true;
    freeze(p);
    if (!p.dirty || p.trashed) return true;
    if (unchecked(p) && await leaveAsDraft(p)) return true;
    let ok = false;
    if (!unchecked(p)) {
      try { ok = await ctx.saveNow({ explicit: true, closing: true }); } catch (e) { console.error('[editor] leave window', e); }
    }
    if (ok && !p.dirty) return true;
    if (p === ctx.page) { unfreeze(p); void ctx.writeDraft(p); ctx.focusBanner(p); }
    return false;
  }

  /**
   * H1: every input path read-only while the page is being composed for a leave, a mode switch
   * or a path change. `unfreeze` puts back what the page's own state allows.
   */
  /**
   * Text the user has not checked yet is on screen and untouched since: the guard's best effort
   * after a refusal (§7.1), or a recovered draft that was not what a save would write. Such a
   * buffer is never written by a leave, a close or a path change; only Ctrl+S or Save writes it.
   */
  const unchecked = (p) => !!(p && p.dirty && p.uncheckedRev === p.rev);

  /**
   * Let an unchecked buffer go as a draft: the file is left as it is, and the next open finds
   * the draft over the same text and shows it again. True when the draft is on this machine.
   */
  async function leaveAsDraft(p) {
    await ctx.writeDraft(p);
    await (p.draftChain || Promise.resolve());
    if (p.draft === 'written') log(`left as a draft ${p.path}: not checked yet`, 'warn');
    return p.draft === 'written';
  }

  /**
   * The leave did not happen after all (`stay`, `window:stay`). A page that took "Reload from
   * disk" while it could not be rebuilt is rebuilt now, from the disk.
   */
  function stay() {
    const p = ctx.page;
    if (!p) return;
    unfreeze(p);
    if (p.reloadPending) { p.reloadPending = false; void ctx.reopenInPlace(p); }
  }

  function freeze(p) {
    if (!p || p.frozen) return;
    p.frozen = true;
    setEditable(p, false);
  }

  function unfreeze(p) {
    if (!p || !p.frozen) return;
    p.frozen = false;
    setEditable(p, !p.readOnly);
  }

  function setEditable(p, on) {
    try { if (p.crepe) p.crepe.setReadonly(!on); } catch (e) { console.error('[editor] readonly', e); }
    try { if (p.source) p.source.setReadOnly(!on); } catch (e) { console.error('[editor] readonly', e); }
    try { if (p.live) p.live.setReadOnly(!on); } catch (e) { console.error('[editor] readonly', e); }
    // In source mode the title strip stays a label: the text below is where the title is edited.
    if (p.titleEl && p.titleEl.tagName === 'H1') p.titleEl.contentEditable = on && !p.source && !p.live ? 'plaintext-only' : 'false';
    for (const v of (p.el ? p.el.querySelectorAll('.ed-prop-val.editable') : [])) v.contentEditable = on ? 'plaintext-only' : 'false';
    if (p.el) p.el.classList.toggle('ed-frozen', !on);
  }

  // -------------------------------------------------------------------------
  // path changes (C6): the core's file operations ask the page first

  /**
   * Before a rename, move, trash or copy of `change.from` (a file, or a folder above the page).
   * The page is flushed with the view frozen; a flush that does not land refuses the change,
   * and nothing on disk is touched. A copy only flushes. Afterwards, saves wait for
   * `afterPathChange` (`moving`), so nothing is written to a name that is going away.
   */
  async function beforePathChange(change) {
    const p = ctx.page;
    if (!p || !change || !covers(p.path, change.from)) return { ok: true };
    const refuse = () => {
      if (p === ctx.page) { void ctx.writeDraft(p); ctx.focusBanner(p); }
      return { ok: false, reason: `${P.basename(p.path)} has unsaved changes that could not be saved` };
    };
    // Text nobody has checked yet is not written for a path change (see `unchecked`). A copy
    // takes the file as it is on disk and a rename carries the draft along (the host re-keys
    // it); a trash would throw the buffer away with the page, so it waits for a save.
    if (unchecked(p)) {
      if (change.kind === 'trash') {
        if (p === ctx.page) ctx.focusBanner(p);
        return { ok: false, reason: `${P.basename(p.path)} has changes to check and save first` };
      }
      if (!await leaveAsDraft(p)) return refuse();
      if (change.kind === 'copy') return { ok: true };
    }
    const flush = () => ctx.saveNow({ explicit: true, leaving: true, pathChange: true });
    if (change.kind === 'copy') {
      if (!p.dirty) return { ok: true };
      let ok = false;
      try { ok = await flush(); } catch { ok = false; }
      if (!(ok && !p.dirty)) return refuse();
      // "Reload from disk" was the answer: the copy takes the disk, and so does the page.
      if (p.reloadPending) { p.reloadPending = false; void ctx.reopenInPlace(p); }
      return { ok: true };
    }
    freeze(p);
    if (p.dirty && !unchecked(p)) {
      let ok = false;
      try { ok = await flush(); } catch { ok = false; }
      if (!ok || p.dirty) { unfreeze(p); return refuse(); }
    }
    let done: (v?: unknown) => void = (): void => {};
    p.movingDone = new Promise<any>((r) => { done = r; });
    p.moving = { kind: change.kind, from: change.from, to: change.to || null, done };
    // A trashed page is left frozen for the caller to navigate away from; a rename or a move
    // hands the keyboard back at once, because the buffer and its undo history survive it. A
    // page waiting to be rebuilt from the disk stays frozen until `afterPathChange` does it.
    if (change.kind !== 'trash' && !p.reloadPending) unfreeze(p);
    return { ok: true };
  }

  /**
   * After the host call, whether it succeeded or not. A rename or a move re-points the page:
   * `p.path` follows, and the buffer, the caret and the undo history stay where they are (the
   * router was already re-pointed by the core). A trash leaves the page clean for the caller.
   */
  async function afterPathChange(change) {
    const p = ctx.page;
    if (!p || !p.moving || !change || p.moving.from !== change.from) return;
    const m = p.moving;
    p.moving = null;
    const settle = () => { try { m.done(); } catch { /* nothing waits */ } p.movingDone = null; };
    // "Reload from disk" was chosen in `beforePathChange`: the buffer on screen is not the
    // user's any more. Once the path is settled the page is rebuilt from the disk, where it is.
    const reload = () => {
      if (!p.reloadPending) return;
      p.reloadPending = false;
      if (p === ctx.page && !p.dirty) void ctx.reopenInPlace(p);
    };
    if (!change.ok) { unfreeze(p); settle(); ctx.publishState(p); reload(); return; }
    if (change.kind === 'trash') {
      p.reloadPending = false;
      p.trashed = true;
      clearTimeout(p.saveTimer);
      ctx.setDirty(p, false);
      void ctx.dropDraft(p);
      settle();
      ctx.publishState(p);
      // A parked page of a trashed file has no tab to come back to: it goes now, not when the
      // cap reaches it.
      if (ctx.parked) void ctx.letGo();
      return;
    }
    if (change.to && (change.kind === 'rename' || change.kind === 'move')) {
      const from = p.path;
      const to = mapPath(p.path, change.from, change.to);
      const kindChanged = P.isMarkdown(from) !== P.isMarkdown(to);
      p.path = to;
      void renameMode(from, to);
      ctx.publishTitle(p);
      ctx.updateMeta(p);
      unfreeze(p);
      settle();
      ctx.publishState(p);
      // A page that stopped (or started) being markdown is shown by a different editor. It was
      // saved in `beforePathChange`, so a remount loses nothing.
      // A parked one is simply let go: the next open builds the right editor.
      if (kindChanged && !p.dirty) {
        p.reloadPending = false;
        if (ctx.parked) void ctx.letGo();
        else void navigate({ type: 'page', path: to }, { replace: true, force: true });
        return;
      }
      reload();
      return;
    }
    unfreeze(p);
    settle();
    reload();
  }

  return {
    canLeave,
    leaveWindow,
    unchecked,
    leaveAsDraft,
    stay,
    freeze,
    unfreeze,
    setEditable,
    beforePathChange,
    afterPathChange,
  };
}
