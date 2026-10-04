// Part of the markdown page (../page.ts). A page whose file changed, moved or went away while it
// was open.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installWatch(ctx)`, and reaches the rest through `ctx`.

import { bridge, log, pageFiles, repointRoute } from '../host.ts';
import { toast } from '../deps.ts';
import { scrollerOf } from '../reveal.ts';
import { renameMode } from '../modes.ts';
import * as P from '../paths.ts';
import { covers, errCode, GONE_RECHECK, mapPath } from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installWatch(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // external changes (C7, H9)

  /**
   * Something touched the open file from outside (the watcher). The whole batch is read, and
   * the last change about this page wins; a rename onto the page's path is a modify. Renames
   * and trashes of our own making are ignored while they are in flight (`moving`); after
   * them the page already has its new path and the echo reads back the same hash.
   */
  function onFsChange(payload) {
    const p = ctx.page;
    if (!p || !payload || p.trashed || !p.path) return;
    let hit: { kind: string, to?: string | null } | null = null;
    for (const c of Array.isArray(payload.changes) ? payload.changes : []) {
      if (!c || !c.path) continue;
      const path = String(c.path);
      const to = c.to ? String(c.to) : null;
      if (p.moving && (covers(path, p.moving.from) || (p.moving.to && covers(path, p.moving.to)))) continue;
      if (c.kind === 'rename' && to === p.path) { hit = { kind: 'modify' }; continue; }
      if (path === p.path) { hit = { kind: c.kind, to }; continue; }
      // A folder above the page renamed or deleted.
      if ((c.kind === 'rename' || c.kind === 'delete') && covers(p.path, path)) {
        hit = { kind: c.kind, to: c.kind === 'rename' && to ? mapPath(p.path, path, to) : null };
      }
    }
    if (!hit) {
      // The watcher may have missed events: read what is shown again.
      if (payload.rescan) void checkDisk(p);
      return;
    }
    if (hit.kind === 'rename' && hit.to && opensAs(p.path, hit.to)) { followRename(p, hit.to); return; }
    if (hit.kind === 'rename' || hit.kind === 'delete') { goneCheck(p); return; }
    void checkDisk(p);
  }

  /**
   * `to` is a file the editor would open the way it has `from` open: every text file opens now
   * (H17), so only a change between markdown and the rest changes the editor.
   */
  const opensAs = (from, to) => P.isMarkdown(from) === P.isMarkdown(to);

  /**
   * Read the file again and decide. The same hash is our own write coming back, or nothing
   * new (this replaces the old 2.5 s echo window). A clean page follows the disk in place; a
   * dirty one merges the disk's change into the buffer, and holds a conflict only where the two
   * touched the same lines (H7).
   */
  async function checkDisk(p, depth = 0) {
    if (p !== ctx.page || p.trashed) return;
    if (p.saving) { try { await p.saving; } catch { /* reported */ } }
    const before = p.baselineHash;
    let file;
    try {
      file = await pageFiles.readFile(p.path, ctx.readOpts(p));
    } catch (e) {
      if (errCode(e) === 'not_found') goneCheck(p);
      return;
    }
    if (p !== ctx.page || p.trashed) return;
    // A save landed while the read was out: the answer is about the old baseline. Ask again.
    if (p.saving || p.baselineHash !== before) { if (depth < 3) void checkDisk(p, depth + 1); return; }
    if (p.deleted) { p.deleted = false; ctx.publishState(p); ctx.updateMeta(p); }
    if (!file || typeof file.text !== 'string') return;
    if ((file.hash != null && file.hash === p.baselineHash) || file.text === p.baseline) {
      if (file.hash != null) p.baselineHash = file.hash;
      return;
    }
    // The overlap the banner already shows: nothing new to merge.
    if (p.conflict && file.hash != null && file.hash === p.conflict.hash) return;
    // The bytes read another way than the page read them: reopen or hold, never merge (X10).
    if (ctx.readsOtherwise(p, file)) { await ctx.readOtherwise(p, file); return; }
    if (Number(file.mtime)) p.mtime = Number(file.mtime);
    // H7: a clean page takes the disk in place; a dirty one merges it (`mergeExternal`).
    await ctx.mergeExternal(p, { text: file.text, hash: file.hash ?? null });
  }

  /**
   * The file is not where the page says. A sync client replacing it, or a folder blinking, is
   * not a deletion: look again in a moment, and only then say so (C7).
   */
  function goneCheck(p) {
    if (p.goneTimer || p.trashed) return;
    p.goneTimer = setTimeout(async () => {
      p.goneTimer = 0;
      if (p !== ctx.page || p.trashed) return;
      let there = true;
      try { there = !!(await bridge.exists(p.path)); } catch { there = true; }
      if (p !== ctx.page) return;
      if (there) void checkDisk(p); else markDeleted(p);
    }, GONE_RECHECK);
  }

  /**
   * The file has left the disk. The page stays editable and says so: a clean one may simply be
   * closed; a dirty one refuses to be left until the user saves it again here, saves it
   * elsewhere, or discards it. Autosave stops, and a draft is written at once.
   */
  function markDeleted(p) {
    if (p.deleted || p.trashed) return;
    p.deleted = true;
    clearTimeout(p.saveTimer);
    log(`page deleted on disk ${p.path}${p.dirty ? ' with unsaved changes' : ''}`, 'warn');
    if (p.dirty) void ctx.writeDraft(p);
    ctx.updateMeta(p);
    ctx.publishState(p);
  }

  /**
   * The file was renamed or moved under us, to a name the editor opens the same way. The page
   * follows: every later save goes to the new name (the old one must never be recreated), and
   * the router is re-pointed, so the tab, the breadcrumb and back/forward agree. No remount:
   * the buffer and the undo history stay.
   */
  function followRename(p, to) {
    const from = p.path;
    p.path = to;
    void renameMode(from, to);
    ctx.publishTitle(p);
    ctx.updateMeta(p);
    ctx.publishState(p);
    if (!ctx.parked) toast(`moved on disk: ${from} → ${to}`);
    repointRoute([{ from, to }]);
  }

  /**
   * Reopen the page from disk in the same host, keeping the scroll position and the caret (E39).
   * The undo history does not survive: the document the editor is rebuilt from is a different
   * one. The page must be clean: a dirty one is not replaced.
   */
  async function reopenInPlace(p) {
    if (p !== ctx.page || !p.el) return;
    const scroller = scrollerOf(ctx.el);
    const top = scroller ? scroller.scrollTop : 0;
    const sel = ctx.currentSelection();
    const line = p.source ? p.source.view.state.doc.lineAt(p.source.view.state.selection.main.head).number : 0;
    // The encoding the user chose for this page is kept across the reopen (X10).
    await ctx.run(p.path, { ...(sel ? { selection: sel } : {}), ...(p.forcedEncoding ? { encoding: p.forcedEncoding } : {}) });
    if (scroller) scroller.scrollTop = top;
    if (line && ctx.page && ctx.page.source) ctx.page.source.goToLine(line);
  }

  return {
    onFsChange,
    opensAs,
    checkDisk,
    goneCheck,
    markDeleted,
    followRename,
    reopenInPlace,
  };
}
