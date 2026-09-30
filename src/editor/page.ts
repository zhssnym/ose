// The page editor as an instance: a markdown file rendered as a Notion-style column.
//
//   banner             sticky, only while something needs the user: not saved, changed or
//                      deleted on disk, recovered changes, opened as text (wave 1, H8)
//   properties strip   only when the file has YAML frontmatter; raw text preserved, simple
//                      `key: value` lines editable in place, everything else read-only
//   title              the file's first H1, editable; the file name when there is no H1
//   meta               word count, last save, the Rich | Live | Source switch (H14, X1) and
//                      the Read toggle (X3)
//   body               Crepe (Milkdown) over everything after the title, or in Live and in
//                      Source, CodeMirror over the whole file (the title and properties strips
//                      are hidden in Live: the text holds both)
//
// Markdown is the source of truth. Nothing is written on open; a save happens only when the
// composed text differs from what is on disk (M5: that difference is what "dirty" means).
// Every write is one host call that compares and writes under one lock (`saveFile`, M2): it
// carries the hash of the text this page was opened from or last wrote, and when the disk
// holds something else nothing is written and the user decides, never the editor. The host
// keeps the replaced bytes as a version, so the page no longer does.
//
// A buffer that is not on disk is never only in memory: a draft of it goes to the machine's
// own app-data folder (C4, `ose.files.drafts`), and the next open of the page offers it back.
// A save that did not happen answers false, all the way up: the router, the window and the
// file operations ask the page first and do not go when it says no (C1, C2, C5, C6).
//
// Everything above is per instance. `markdownPage(el, path, opts)` builds one and hands back a
// handle; the state that used to be this file's `page` singleton is the closure of that call,
// so two pages can stand side by side in one document. What stays at module level is what is
// genuinely shared: the command registry (registered when the first page mounts, removed when
// the last one closes), the watcher and window listeners, and the pointer to the **active**
// page — the one holding the focus — which is the page the commands and the extension modules
// act on.
//
// Wave 2 (M12, M24): an instance outlives its tab being in the background. `handle.park()`
// takes the column out of the document and keeps the editor alive; the next `markdownPage` for
// the same path puts that very instance back, buffer, undo history, mode, caret and scroll
// included (instances.ts is the register). A change made on disk while a page is dirty is
// merged into it line by line (H7, merge.ts), and only lines both sides touched are a question.
//
// Wave 3 (X1, X2, X3, X7, X10). Live is a third mode: CodeMirror over the whole file with the
// markup drawn off the caret line (live/). Its text is the file's text, so a save writes
// `live.getText()` and nothing composes it, exactly as in Source. The Reading view shows the
// buffer rendered, read-only, over the editor, which stays mounted underneath. A file outside
// the vault (`abs:`) opens here too, with no versions, links or attachments; a file that is not
// UTF-8 keeps its own encoding, and one that cannot be decoded exactly opens read-only.
//
// The page is cut into parts, in ./page/: one file per concern (open, modes, save, merge, drafts,
// ...), each adding its functions to the instance's `ctx` (./page/ctx.ts). This file builds an
// instance and says what the editor exports.

import { bridge } from './host.ts';
import { findParked, instances } from './instances.ts';
import * as P from './paths.ts';
import { covers, editorView, mapPath } from './page/shared.ts';
import { acquireCommands, releaseCommands } from './page/commands.ts';
import { wireGlobals } from './page/globals.ts';
import { installEvents } from './page/events.ts';
import { installOpen } from './page/open.ts';
import { installModes } from './page/modes.ts';
import { installLeave } from './page/leave.ts';
import { installDom } from './page/dom.ts';
import { installStatus } from './page/status.ts';
import { installSave } from './page/save.ts';
import { installMerge } from './page/merge.ts';
import { installDrafts } from './page/drafts.ts';
import { installWatch } from './page/watch.ts';
import { installActions } from './page/actions.ts';
import { installReading } from './page/reading.ts';
import { installPark } from './page/park.ts';
import { installLinks } from './page/links.ts';
import type { PageCtx } from './page/ctx.ts';
import './editor.css';
// The sheet: `@page` and every `@media print` rule of the app, in one file. It rides in with
// the editor's stylesheet because that is the last one the core serves.
import './print.css';
import './sheets.css';

export type { PlainDoc, PageDoc, Timer, FindBar, Reading, Problem, Recovered, Conflict, Merged, Moving, PageState, PageInstance, DocState } from './page/shared.ts';
export { saveAll, beforePathChange, afterPathChange, releasePage, parkedPaths, problemPages, rewriteLinksIn } from './page/globals.ts';
export { acquireCommands, releaseCommands, activePage } from './page/commands.ts';


/**
 * Mount the file at `path` into `el` and answer the handle (docs/CORE.md `ose:editor`).
 * The handle comes back at once; `handle.ready` is the open in flight.
 *
 * `opts.line` (1-based, a line of the file as the search overlay counts them) puts the caret in
 * the block that holds that line once the editor is up (C7); `opts.selection` is a `{from,to}`
 * a router remembered (in Live, the view's snapshot, `mode: 'live'`); `opts.query` seeds the
 * find bar; `opts.encoding` reads the file in that encoding (X10, `page.reopen-encoding`).
 *
 * Wave 2 (M12, M24): when an instance of `path` is parked (`handle.park()`, a tab gone to the
 * background), that instance is put back into `el` instead — the same buffer, undo history and
 * mode, its caret and scroll — and the same handle is answered.
 */
export function markdownPage(el, path, opts: any = {}) {
  const again = findParked(P.pagePath(String(path ?? '')));
  if (again) { again.reattach(el, opts); return again.handle; }
  return buildPage(el, path, opts);
}


function buildPage(el, path, opts) {
  const ctx = { el, path, opts } as PageCtx;
  // every part's functions first, then the state, in the order the closure declared it
  Object.assign(ctx,
    installEvents(ctx),
    installOpen(ctx),
    installModes(ctx),
    installLeave(ctx),
    installDom(ctx),
    installStatus(ctx),
    installSave(ctx),
    installMerge(ctx),
    installDrafts(ctx),
    installWatch(ctx),
    installActions(ctx),
    installReading(ctx),
    installPark(ctx),
    installLinks(ctx),
  );

  ctx.page = null;
  ctx.openToken = 0;
  ctx.opening = Promise.resolve();
  ctx.closed = false;
  /** The leave in flight: a second `canLeave` awaits the same save. */
  ctx.leaving = null;
  // Parking (M12): the column is out of the document, in `el`, which is then a holder of the
  // instance's own. `parkScroll` and `parkFocus` are how it was left.
  ctx.parked = false;
  ctx.parkScroll = 0;
  ctx.parkFocus = false;

  ctx.listeners = new Map();
  ctx.inst = {
    get el() { return ctx.el; },
    api: null,
    handle: null,
    get parked() { return ctx.parked; },
    usedAt: Date.now(),
    /** Parked, clean, and nothing standing between the buffer and the disk: may be let go. */
    evictable: () => ctx.parked && !ctx.closed && (!ctx.page || (!ctx.page.dirty && !ctx.page.problem && !ctx.page.deleted && !ctx.page.saving && !ctx.page.hasDraft)),
    reattach: (host, o) => ctx.reattach(host, o),
    rewriteLinks: (target, pairs, o) => ctx.rewriteLinks(target, pairs, o),
    path: () => (ctx.page ? ctx.page.path : null),
    isDirty: () => !!(ctx.page && ctx.page.dirty),
    titleEl: () => (ctx.page ? ctx.page.titleEl : null),
    onFsChange: (payload) => ctx.onFsChange(payload),
    applySpellcheck: () => { if (ctx.page) ctx.applySpellcheck(ctx.page); },
    save: (o) => ctx.saveNow(o),
    stay: () => ctx.stay(),
    leaveWindow: () => ctx.leaveWindow(),
    writeDraft: () => (ctx.page && ctx.page.dirty ? ctx.writeDraft(ctx.page) : Promise.resolve()),
    covers: (from) => !!(ctx.page && covers(ctx.page.path, from)),
    /**
     * The page holds `target`: its path, or where a rename or a move in flight is taking it
     * (the core may rewrite the moved files' links before `afterPathChange` re-points them).
     */
    holds: (target) => !!(ctx.page && (ctx.page.path === target
      || (ctx.page.moving && ctx.page.moving.to && covers(ctx.page.path, ctx.page.moving.from)
        && mapPath(ctx.page.path, ctx.page.moving.from, ctx.page.moving.to) === target))),
    beforePathChange: (change) => ctx.beforePathChange(change),
    afterPathChange: (change) => ctx.afterPathChange(change),
  };

  // -------------------------------------------------------------------------
  // the api the extension modules and the commands act through

  ctx.api = {
    hasPage: () => !!ctx.page,
    getPage: () => ctx.page,
    // No editable view while the Reading view is up (X3): the editor is hidden under it, and a
    // command that reached it would change bytes the user cannot see.
    getView: () => (ctx.page && ctx.page.crepe && !ctx.page.reading ? editorView(ctx.page.crepe) : null),
    getCrepe: () => (ctx.page && !ctx.page.reading ? ctx.page.crepe : null),
    getPath: () => (ctx.page ? ctx.page.path : null),
    getDoc: () => (ctx.page ? ctx.page.doc : null),
    focusTitle: () => { if (ctx.page) ctx.focusTitle(ctx.page); },
    focusBody: () => ctx.focusBody(),
    markDirty: () => { if (ctx.page) ctx.markDirty(ctx.page); },
    // A module that changed the document through a transaction the user asked for. There is
    // no "touched" gate any more (M5): it is the same as markDirty, kept for the modules.
    touch: () => { if (ctx.page) ctx.markDirty(ctx.page); },
    saveNow: (o) => ctx.saveNow(o),
    // The router saves this when a page is left and hands it back at the next open (N44, P7);
    // backlinks.ts asks for a repaint when its count changes (N6).
    getSelection: () => ctx.currentSelection(),
    updateMeta: () => { if (ctx.page) ctx.updateMeta(ctx.page); },
    reopenInPlace: () => (ctx.page ? ctx.reopenInPlace(ctx.page) : Promise.resolve()),
    attachFile: (file) => (ctx.page ? ctx.attachFile(ctx.page, file) : Promise.reject(new Error('no page'))),
    // The find bar of the open page, whichever kind it is.
    openFind: (o) => { if (ctx.page && ctx.page.find) ctx.page.find.open(o || {}); },
    // Batch 12 (P5), H14 and X1: the three modes.
    isSource: () => !!(ctx.page && ctx.page.source),
    isLive: () => !!(ctx.page && ctx.page.live),
    isMarkdown: () => !!(ctx.page && !ctx.page.plain),
    toggleSource: () => ctx.toggleSource(),
    setMode: (mode) => ctx.setMode(mode),
    nextMode: () => ctx.nextMode(),
    mode: () => (ctx.page ? ctx.publicMode(ctx.page) : null),
    /**
     * A body command in Live (§3.3): the Live view runs the ids of LIVE_COMMANDS; any other
     * says it is not available there. Answers what the view answered.
     */
    liveRun: (id) => ctx.liveRun(id),
    // X3: the Reading view.
    isReading: () => !!(ctx.page && ctx.page.reading),
    toggleReading: () => ctx.toggleReading(),
    // X7, X10: outside the vault, and the file's encoding.
    isOutside: () => !!(ctx.page && ctx.page.outside),
    encoding: () => (ctx.page ? ctx.page.encoding : null),
    saveUtf8: () => ctx.saveUtf8(),
    reopenEncoding: () => ctx.reopenEncoding(),
    // K1c: what the page-level commands do, so they can live at module level and act on
    // whichever page has the focus.
    hasCrepe: () => !!(ctx.page && ctx.page.crepe),
    isReadOnly: () => !!(ctx.page && (ctx.page.readOnly || ctx.page.frozen)),
    folder: () => (ctx.page ? P.dirname(ctx.page.path) : null),
    copyMarkdown: () => ctx.copyMarkdown(),
    link: () => ctx.linkPage(),
    outline: () => ctx.outlinePage(),
    find: (o) => { if (ctx.page && ctx.page.find) ctx.page.find.open(o || {}); },
    reveal: () => { if (ctx.page) void bridge.reveal(ctx.page.path); },
    isReadOnlyFile: () => !!(ctx.page && ctx.page.readOnly),
    // Wave 1 (H8, C4, C7): the save state and what the banner's buttons do.
    status: () => ctx.statusOf(ctx.page),
    isDirty: () => !!(ctx.page && ctx.page.dirty),
    hasRecovered: () => !!(ctx.page && ctx.page.recovered),
    recoveredApplied: () => !!(ctx.page && ctx.page.recovered && ctx.page.recovered.applied),
    saveAs: () => ctx.saveAs(),
    discardChanges: () => ctx.discardChanges(),
    showProblem: () => ctx.focusBanner(ctx.page),
    recoveredCompare: () => ctx.recoveredCompare(),
    recoveredRestore: () => ctx.recoveredRestore(),
    // Wave 2 (H7): an overlap with the disk, and a merge that happened.
    hasConflict: () => !!(ctx.page && ctx.page.conflict),
    conflictIsText: () => !!(ctx.page && ctx.page.conflict && typeof ctx.page.conflict.theirs === 'string'),
    // Take theirs also opens a disk that reads in another encoding again (X10).
    conflictCanTake: () => !!(ctx.page && ctx.page.conflict && (typeof ctx.page.conflict.theirs === 'string' || ctx.page.conflict.encoding)),
    hasMerge: () => !!(ctx.page && ctx.page.merged),
    canUndoMerge: () => ctx.canUndoMerge(ctx.page),
    mergeResolve: () => ctx.resolveMerge(ctx.page),
    mergeKeepMine: () => ctx.keepMine(ctx.page),
    mergeTakeTheirs: () => ctx.takeTheirs(ctx.page),
    mergeUndo: () => ctx.undoMerge(ctx.page),
    mergeShow: () => ctx.showMerge(ctx.page),
  };
  ctx.inst.api = ctx.api;
  ctx.inst.repaint = ctx.repaint;

  ctx.handle = {
    get el() { return ctx.el; },
    get path() { return ctx.page ? ctx.page.path : null; },
    get dirty() { return !!(ctx.page && ctx.page.dirty); },
    /** 'rich' | 'live' | 'source': the public words; the internal 'block' stays internal. */
    get mode() { return ctx.publicMode(ctx.page); },
    get state() { return ctx.page ? ctx.stateOf(ctx.page) : null; },
    get readOnly() { return !!(ctx.page && ctx.page.readOnly); },
    get ready() { return ctx.opening; },
    open: (nextPath, options: any = {}) => ctx.run(nextPath, options),
    /** May the page be left? A dirty page saves first; false keeps it, with its banner (§6.2). */
    canLeave: (reason) => ctx.canLeave(reason),
    /** A yes from `canLeave` froze the page; the leave did not happen after all. */
    stay: () => ctx.stay(),
    /** `canLeave`, then the teardown. False: the page is kept and nothing was torn down. */
    close: async () => {
      if (ctx.closed) return true;
      try { await ctx.opening; } catch { /* the open already said so */ }
      if (!await ctx.canLeave('close')) return false;
      if (ctx.closed) return true;
      if (!await ctx.closePage()) return false;
      ctx.closed = true;
      instances.delete(ctx.inst);
      releaseCommands();
      return true;
    },
    /**
     * The tab went to the background (M12): the column leaves the document and the editor stays
     * alive, to be put back by the next `markdownPage` of this path. Always true.
     */
    park: () => ctx.park(),
    get parked() { return ctx.parked; },
    /** True only when the disk holds the buffer afterwards. */
    save: (o) => ctx.saveNow(o),
    focus: () => ctx.focusPage(),
    find: (query) => { if (ctx.page && ctx.page.find) ctx.page.find.open(query ? { query } : {}); },
    goToLine: (line, col) => ctx.scrollToLine(line, col),
    selection: () => ctx.currentSelection(),
    on: ctx.on,
  };
  ctx.inst.handle = ctx.handle;

  instances.add(ctx.inst);
  ctx.take();
  acquireCommands();
  wireGlobals();
  void ctx.run(ctx.path, ctx.opts);
  return ctx.handle;
}
