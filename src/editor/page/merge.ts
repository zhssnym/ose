// Part of the markdown page (../page.ts). Changes made on disk while the page is open: the 3-way
// merge, and the conflict it can leave.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installMerge(ctx)`, and reaches the rest through `ctx`.

import { copyText, log, pageFiles } from '../host.ts';
import { choose, confirm, toast } from '../deps.ts';
import { keepBoth, merge3 } from '../merge.ts';
import { docWithoutPad } from '../space.ts';
import * as serializer from '../crepe.ts';
import { compareTexts } from '../compare.ts';
import { closeHistory } from '@milkdown/kit/prose/history';
import { parseDoc } from '../doc.ts';
import {
  checkOpened, editorView, errCode, errText, hasEditor, MERGE_NOTE_MS, nextRev, SAVE_DEBOUNCE,
} from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installMerge(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // changes made on disk (H7, §5.3)
  //
  // The page was based on `p.baseline` (hash `p.baselineHash`); the disk holds another text.
  // A clean page takes it in place, as one transaction, so the undo history survives and the
  // caret stays where the text allows. A dirty page merges it line by line: the buffer's
  // changes and the disk's, both made against the baseline, laid over each other (merge.ts).
  // Only where both touched the same lines does the page hold a conflict; the buffer is then
  // left exactly as it is, autosave stops, leaving is refused, and the banner offers the
  // resolve view. There is no blind "Changed on disk" question any more.

  /**
   * The disk holds `disk.text` (`null` when it is not text this editor can read) under
   * `disk.hash`. Answers what came of it: `'same'` (nothing new), `'reloaded'` (a clean page
   * took the disk), `'merged'` (the disk's change is in the buffer, which is dirty over the
   * disk's hash now, or clean when the two agree) or `'conflict'`.
   */
  async function mergeExternal(p, disk): Promise<'same' | 'reloaded' | 'merged' | 'conflict'> {
    if (p !== ctx.page || p.trashed) return 'same';
    const hash = disk.hash ?? null;
    if (hash !== null && hash === p.baselineHash) return 'same';
    if (typeof disk.text !== 'string') {
      holdConflict(p, { theirs: null, hash, count: 0, base: p.baseline });
      return 'conflict';
    }
    if (disk.text === p.baseline) { if (hash !== null) p.baselineHash = hash; return 'same'; }
    // Belt and braces: the disk's text is a version before it goes into the buffer, so whatever
    // later writes over it, the other program's change can be had back from Versions.
    await keepDisk(p, disk.text);
    if (p !== ctx.page || p.trashed) return 'same';
    // A save may have landed while the version was kept.
    if (hash !== null && hash === p.baselineHash) return 'same';
    if (disk.text === p.baseline) { if (hash !== null) p.baselineHash = hash; return 'same'; }
    if (!p.dirty) {
      await reloadClean(p, disk.text, hash);
      return 'reloaded';
    }
    // `ours` has to be exactly what a save would write, or the merge would write something the
    // user never had: a rich page the guard cannot compose exactly goes straight to the question.
    let r0;
    try { r0 = ctx.composeChecked(p); } catch (e) { r0 = { status: 'unsafe', text: null, reason: errText(e) }; }
    if (r0.status === 'unsafe' || typeof r0.text !== 'string') {
      holdConflict(p, { theirs: disk.text, hash, count: 0, base: p.baseline });
      return 'conflict';
    }
    const ours = r0.text;
    const r = merge3(p.baseline, ours, disk.text);
    if (!r.clean) {
      holdConflict(p, { theirs: disk.text, hash, count: r.conflicts.length, base: p.baseline });
      return 'conflict';
    }
    const merged = r.text;
    const wasUnchecked = ctx.unchecked(p);
    if (merged !== ours) await applyText(p, merged);
    if (p !== ctx.page) return 'merged';
    p.baseline = disk.text;
    p.baselineHash = hash;
    p.conflict = null;
    if (p.problem && p.problem.status === 'conflict') p.problem = null;
    log(`merged changes made on disk ${p.path}`, 'info');
    if (merged === disk.text) {
      // Both sides made the same change: nothing of the user's is left unwritten.
      p.merged = null;
      ctx.settleClean(p, p.rev);
      return 'merged';
    }
    p.rev = nextRev();
    if (wasUnchecked) p.uncheckedRev = p.rev;
    ctx.setDirty(p, true);
    if (merged !== ours) {
      p.merged = { ours, theirs: disk.text, text: merged, at: Date.now(), rev: p.rev };
      showMergeNote(p);
    }
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void ctx.saveDoc(p); }, SAVE_DEBOUNCE);
    ctx.publishState(p);
    return 'merged';
  }

  /** A clean page takes the disk's text in place (`applyText`); it is the baseline now. */
  async function reloadClean(p, text, hash) {
    await applyText(p, text);
    if (p !== ctx.page) return;
    p.baseline = text;
    p.baselineHash = hash ?? p.baselineHash;
    p.conflict = null;
    if (p.problem && p.problem.status === 'conflict') p.problem = null;
    clearTimeout(p.saveTimer);
    ctx.setDirty(p, false);
    ctx.publishState(p);
    ctx.updateMeta(p, true);
  }

  /**
   * Put `text` (the whole file) in the editor as one change, not an edit of the user's: the
   * dirty flag, the baseline and the draft are the caller's business. Source: the smallest
   * CodeMirror change. Rich: only the top-level blocks that differ are replaced, in one
   * ProseMirror transaction. Either way the change stays out of the undo history, so Ctrl+Z
   * never reverts it (only `page.merge-undo` drops a merge); the title and the properties above
   * the body follow. Answers true when it went in place; false when the page had to be rebuilt
   * around the text instead (the shape above the body changed, or the editor could not take
   * it), which keeps the text but not the undo history.
   */
  async function applyText(p, text) {
    // The Reading view shows the buffer: it follows a text put in from outside (X3).
    if (p.reading) { try { p.reading.view.setText(text); } catch (e) { console.error('[editor] reading', e); } }
    if (p.source || p.live) {
      p.applying = true;
      try {
        if (p.source) p.source.replaceText(text);
        else if (p.live) p.live.replaceMinimal(text);
      } finally { p.applying = false; }
      p.doc = p.plain ? ctx.plainDoc(text) : parseDoc(text);
      if (p.doc.titleLine !== null) p.title = p.doc.title;
      if (p.titleEl && p.titleEl.textContent !== p.title) p.titleEl.textContent = p.title;
      ctx.publishTitle(p);
      ctx.updateMeta(p, true);
      return true;
    }
    let inPlace = false;
    try { inPlace = !!(p.crepe && applyRich(p, text)); } catch (e) {
      console.error('[editor] apply in place', e);
      inPlace = false;
    }
    if (inPlace) {
      // C10 again: what the rich view could not hold of the new text is not in it.
      const check = checkOpened(p.crepe, p.doc.body);
      if (!check.ok) await ctx.forceSource(p, text, 'lossy-open', check.reason);
      ctx.updateMeta(p, true);
      return !!p.crepe;
    }
    if (!hasEditor(p)) { p.orphan = text; return false; }
    const wasFrozen = p.frozen;
    ctx.freeze(p);
    try {
      await ctx.remount(p, p.mode, text);
      if (p === ctx.page && p.crepe) {
        const check = checkOpened(p.crepe, p.doc.body);
        if (!check.ok) await ctx.forceSource(p, text, 'lossy-open', check.reason);
      }
    } catch (e) {
      console.error('[editor] apply', e);
      if (p === ctx.page) await ctx.mountFallback(p, text);
    }
    if (p === ctx.page && !wasFrozen) ctx.unfreeze(p);
    return false;
  }

  /**
   * The rich half of `applyText`: the new body parsed with this editor's own parser, compared
   * block by block with the document (the landing pad aside), and the run of blocks that
   * differ replaced. False, having changed nothing, when the part above the body changed shape.
   */
  function applyRich(p, text) {
    const next = parseDoc(text);
    const cur = p.doc;
    if (!cur || (cur.titleLine === null) !== (next.titleLine === null)) return false;
    if (!!cur.frontmatterRaw !== !!next.frontmatterRaw) return false;
    const view = editorView(p.crepe);
    if (!view) return false;
    const body = serializer.engineOf(p.crepe).parse(next.body);
    if (!body || body.type !== view.state.doc.type) return false;
    const { state } = view;
    const doc = docWithoutPad(state) || state.doc;
    const max = Math.min(doc.childCount, body.childCount);
    let start = 0;
    while (start < max && doc.child(start).eq(body.child(start))) start++;
    let endA = doc.childCount;
    let endB = body.childCount;
    while (endA > start && endB > start && doc.child(endA - 1).eq(body.child(endB - 1))) { endA--; endB--; }
    if (start < endA || start < endB) {
      let from = 0;
      for (let i = 0; i < start; i++) from += doc.child(i).nodeSize;
      let to = from;
      for (let i = start; i < endA; i++) to += doc.child(i).nodeSize;
      const nodes: any[] = [];
      for (let i = start; i < endB; i++) nodes.push(body.child(i));
      // Outside the undo history: Ctrl+Z must never revert a change made on disk and autosave
      // the old text over it. The user's earlier steps map through this one.
      const tr = closeHistory(nodes.length ? state.tr.replaceWith(from, to, nodes) : state.tr.delete(from, to))
        .setMeta('addToHistory', false);
      p.applying = true;
      try { view.dispatch(tr); } finally {
        // The document watcher reports on a microtask (crepe.ts `watchDoc`); this one is queued
        // after it, so the report is still read as ours.
        queueMicrotask(() => { p.applying = false; });
      }
    }
    const frontChanged = cur.frontmatterRaw !== next.frontmatterRaw;
    p.doc = next;
    if (next.titleLine !== null && p.title !== next.title) {
      p.title = next.title;
      if (p.titleEl) p.titleEl.textContent = next.title;
    }
    ctx.publishTitle(p);
    if (frontChanged && p.el) {
      const old = p.el.querySelector('.ed-props');
      if (old) old.replaceWith(ctx.propertiesStrip(p));
    }
    return true;
  }

  /**
   * The disk and the buffer overlap: the buffer is left as it is, autosave stops, leaving is
   * refused, a draft keeps the text, and the banner offers the resolve view. `info` is
   * `{theirs, hash, count, base}`: the disk's text (null when it is not text), its hash, how many
   * regions overlap (0 when unknown) and the text both were edited from; with `encoding` (and
   * `lossy`) when the disk is text read another way than the page's (`readsOtherwise`).
   */
  function holdConflict(p, info) {
    const first = !p.conflict;
    clearTimeout(p.saveTimer);
    p.saveTimer = 0;
    p.conflict = info;
    p.problem = {
      status: 'conflict', reason: 'overlap',
      message: info.count
        ? `${p.path} changed on disk while you were editing: ${info.count} part${info.count === 1 ? ' overlaps' : 's overlap'}`
        : `${p.path} changed on disk while you were editing`,
    };
    if (first) log(`save conflict ${p.path}: ${info.count || 'unknown'} overlapping parts`, 'warn');
    ctx.emit('conflict', { path: p.path, count: info.count });
    void ctx.writeDraft(p);
    ctx.publishState(p);
  }

  /** The disk as it is now, `{text, hash}`, or null when it cannot be read (a gone file is looked for). */
  async function readDisk(p) {
    try {
      const f = await pageFiles.readFile(p.path, ctx.readOpts(p));
      // Read another way than the page's (another encoding, or lossy): no text to merge.
      if (ctx.readsOtherwise(p, f)) return { text: null, hash: f.hash ?? null, file: f };
      return { text: typeof f.text === 'string' ? f.text : null, hash: f.hash ?? null };
    } catch (e) {
      if (errCode(e) === 'not_found') { ctx.goneCheck(p); return null; }
      if (errCode(e) === 'not_utf8') return { text: null, hash: null };
      toast(`could not read ${p.path}: ${errText(e)}`, 'err');
      return null;
    }
  }

  /**
   * `page.merge-resolve`: the buffer against the disk in the compare view, with the four ways
   * out. Keep both (the default) puts the disk's lines after the buffer's wherever they overlap,
   * for the user to tidy; Keep mine writes the buffer and keeps the disk's text as a version;
   * Take theirs keeps the buffer as a version and shows the disk; Cancel leaves the banner up.
   * Answers true when the disk holds what the page shows afterwards.
   */
  async function resolveMerge(p) {
    if (!p || p !== ctx.page || !p.conflict) return false;
    // The disk may have moved again since the banner went up: merge that first.
    const disk = await readDisk(p);
    if (p !== ctx.page || !p.conflict) return false;
    if (disk && disk.hash !== null && disk.hash !== p.conflict.hash) {
      if (disk.file) await ctx.readOtherwise(p, disk.file);
      else {
        const m = await mergeExternal(p, disk);
        if (m !== 'conflict') return ctx.saveDoc(p, { explicit: true, noResolve: true });
      }
      if (p !== ctx.page || !p.conflict) return false;
    }
    const c = p.conflict;
    if (!c) return false;
    let r0;
    try { r0 = ctx.composeChecked(p); } catch (e) { r0 = { status: 'unsafe', text: null, reason: errText(e) }; }
    const exact = r0.status !== 'unsafe' && typeof r0.text === 'string';
    const ours = exact ? r0.text : ctx.bestEffort(p);
    if (typeof c.theirs !== 'string') {
      const what = c.encoding
        ? `${p.path} changed on disk and now reads as ${ctx.readAs(c)}.`
        : `${p.path} was replaced by something this editor cannot show as text.`;
      // A file outside the vault keeps no Versions (X7): overwriting it loses the other text.
      const kept = p.outside
        ? ' This file is outside the vault and has no Versions: what is on disk now is lost.'
        : ' The file on disk is kept in Versions….';
      const ok = await confirm({
        title: 'Changed on disk',
        body: `${what} Keep your version and overwrite it?${kept}`,
        ok: 'Keep mine', danger: !!p.outside,
      });
      return ok && p === ctx.page ? keepMine(p, { asked: true }) : false;
    }
    const actions: { label: string; value: string; kind?: 'danger' | 'primary'; }[] = [
      { label: 'Keep both', value: 'both', kind: 'primary' },
      ...(exact ? [{ label: 'Keep mine', value: 'mine' }] : []),
      { label: 'Take theirs', value: 'theirs' },
    ];
    const choice = await compareTexts({
      title: 'Changed on disk',
      a: ours,
      b: c.theirs,
      aLabel: 'yours, in this page',
      bLabel: 'on disk now',
      note: (c.count
        ? `${c.count} part${c.count === 1 ? '' : 's'} changed on both sides. Keep both puts the lines on disk after yours where they overlap.`
        : 'Keep both puts the lines on disk after yours where they differ.')
        + (p.outside ? ' This file is outside the vault and has no Versions: Keep mine and Take theirs lose the other side.' : ''),
      actions,
    });
    if (p !== ctx.page || p.conflict !== c) return false;
    if (choice === 'both') return keepBothIn(p, ours, c);
    if (choice === 'mine') return keepMine(p, { asked: true });
    // The note above said what an outside page loses: no second question.
    if (choice === 'theirs') return takeTheirs(p, { asked: true });
    return false;
  }

  /** Keep both: every overlap becomes the buffer's lines, then the disk's; dirty, over the disk's hash. */
  async function keepBothIn(p, ours, c) {
    const text = keepBoth(typeof c.base === 'string' ? c.base : '', ours, c.theirs);
    await applyText(p, text);
    if (p !== ctx.page) return false;
    p.baseline = c.theirs;
    p.baselineHash = c.hash;
    p.conflict = null;
    p.problem = null;
    p.merged = null;
    p.rev = nextRev();
    ctx.setDirty(p, true);
    log(`kept both versions ${p.path}`, 'info');
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void ctx.saveDoc(p); }, SAVE_DEBOUNCE);
    ctx.publishState(p);
    return false;
  }

  /**
   * Keep mine: the buffer over the disk, against the hash of the text the conflict showed, so a
   * write that lands meanwhile is merged again rather than lost. The host keeps the disk's text
   * as a `conflict` version. Outside the vault there is none (X7): the user is asked first,
   * and may copy the disk's text, unless the question was already asked (`o.asked`).
   */
  async function keepMine(p, o: any = {}) {
    if (!p || p !== ctx.page) return false;
    const c = p.conflict;
    if (!c) return ctx.saveNow({ explicit: true });
    if (p.outside && !o.asked && typeof c.theirs === 'string') {
      const go = await confirmLoss(p, {
        title: 'Keep your version?',
        body: 'Your text is written over the file on disk. This file is outside the vault and has no Versions: the text on disk now is lost.',
        ok: 'Keep mine', text: c.theirs,
      });
      if (!go || p !== ctx.page || p.conflict !== c) return false;
    } else if (p.outside && !o.asked) {
      const go = await confirm({
        title: 'Keep your version?',
        body: 'Your text is written over the file on disk. This file is outside the vault and has no Versions: what is on disk now is lost.',
        ok: 'Keep mine', danger: true,
      });
      if (!go || p !== ctx.page || p.conflict !== c) return false;
    }
    let r0;
    try { r0 = ctx.composeChecked(p); } catch (e) { r0 = { status: 'unsafe', text: null, reason: errText(e) }; }
    if (r0.status === 'unsafe' || typeof r0.text !== 'string') {
      toast('Not saved: the rich view could not write this page exactly. Switch to Source, check it, then keep yours.', 'err', 0);
      return false;
    }
    const rev = p.rev;
    let res;
    try {
      res = await pageFiles.save(p.path, r0.text, { expectedHash: c.hash, version: 'conflict', ...ctx.encodingOpts(p) });
    } catch (e) {
      ctx.saveFailed(p, e);
      return false;
    }
    if (p !== ctx.page) return false;
    if (res && res.status === 'saved') { ctx.saved(p, r0.text, res, rev); return !p.dirty; }
    if (res && res.status === 'conflict') {
      const d = res.disk || { exists: false, text: null, hash: null };
      if (!d.exists) { p.conflict = null; p.problem = null; ctx.markDeleted(p); return false; }
      const m = await mergeExternal(p, { text: d.text, hash: d.hash });
      return m === 'conflict' ? false : ctx.saveDoc(p, { explicit: true, noResolve: true });
    }
    ctx.saveFailed(p, Object.assign(new Error('the host gave no answer to the save'), { code: 'unknown_command' }));
    return false;
  }

  /**
   * Take theirs: the buffer goes to Versions (reason `reload`), and the page shows the disk. A
   * disk that reads in another encoding than the page's opens again as it reads now (X10).
   * Outside the vault there are no Versions (X7): the user is asked first, and may copy the
   * text, unless the compare view already said so (`o.asked`).
   */
  async function takeTheirs(p, o: any = {}) {
    if (!p || p !== ctx.page) return false;
    const disk = await readDisk(p);
    const other = !!(disk && disk.file);
    if (!disk || (!other && typeof disk.text !== 'string') || p !== ctx.page) {
      if (disk) toast(`${p.path} is not text this editor can show; keep yours, or discard your changes`, 'warn');
      return false;
    }
    let d: { text: any; exact: boolean; } | null = null;
    try { d = ctx.draftText(p); } catch { d = null; }
    const mine = d && typeof d.text === 'string' ? d.text : null;
    if (p.outside && !o.asked && mine !== null && mine !== disk.text && mine !== p.baseline) {
      const go = await confirmLoss(p, {
        title: 'Take the version on disk?',
        body: 'The page shows the file on disk. This file is outside the vault and has no Versions: your text in this page is lost.',
        ok: 'Take theirs', text: mine,
      });
      if (!go || p !== ctx.page) return false;
    }
    if (mine !== null) await keepBuffer(p, mine);
    if (p !== ctx.page) return false;
    p.conflict = null;
    p.problem = null;
    p.recovered = null;
    p.merged = null;
    clearTimeout(p.saveTimer);
    if (other) {
      ctx.setDirty(p, false);
      await ctx.dropDraft(p);
      log(`took the version on disk ${p.path}, read as ${ctx.readAs(disk.file)}`, 'info');
      await ctx.reopenInPlace(p);
      return true;
    }
    await reloadClean(p, disk.text, disk.hash);
    await ctx.dropDraft(p);
    log(`took the version on disk ${p.path}`, 'info');
    return true;
  }

  /**
   * The question in front of a gesture that loses `text` for good, asked only on a page outside
   * the vault (no Versions, X7). "Copy, then …" puts the text on the clipboard first, and goes
   * on only when the copy worked. Cancel comes first, so it has the focus.
   */
  async function confirmLoss(p: any, o: { title: string; body: string; ok: string; text: string; }): Promise<boolean> {
    const choice = await choose({
      title: o.title,
      body: o.body,
      options: [
        { label: 'Cancel', value: null },
        { label: `Copy, then ${o.ok.toLowerCase()}`, value: 'copy', kind: 'primary' },
        { label: o.ok, value: 'go', kind: 'danger' },
      ],
    });
    if (choice === 'copy') {
      const ok = await copyText(o.text);
      if (!ok) { toast('could not copy the text: nothing was changed', 'err'); return false; }
      toast('copied', 'info');
      return p === ctx.page;
    }
    return choice === 'go' && p === ctx.page;
  }

  /** The banner that says a merge happened: up for `MERGE_NOTE_MS`, or until Esc. */
  function showMergeNote(p) {
    clearTimeout(p.mergeNote);
    p.mergeNote = setTimeout(() => { p.mergeNote = 0; if (p === ctx.page) ctx.publishState(p); }, MERGE_NOTE_MS);
  }

  function clearMergeNote(p) {
    if (!p || !p.mergeNote) return;
    clearTimeout(p.mergeNote);
    p.mergeNote = 0;
    ctx.publishState(p);
  }

  /** Undo merge is one step: offered while nothing was typed after the merge. */
  const canUndoMerge = (p) => !!(p && p.merged && p.merged.rev === p.rev);

  /**
   * `page.merge-undo`: the buffer goes back to what it held before the merge. The disk's text
   * is kept as a version first, because the next save writes the buffer over it.
   */
  async function undoMerge(p) {
    if (!canUndoMerge(p) || p !== ctx.page) return false;
    const m = p.merged;
    if (p.outside) {
      // No Versions outside the vault (X7): the next save writes over the disk's change.
      const go = await confirmLoss(p, {
        title: 'Undo the merge?',
        body: 'The page goes back to your text, and the next save writes it over the change made on disk. This file is outside the vault and has no Versions: that change is lost.',
        ok: 'Undo merge', text: m.theirs,
      });
      if (!go || p !== ctx.page || p.merged !== m || !canUndoMerge(p)) return false;
    }
    clearMergeNote(p);
    if (!p.outside) {
      try {
        await pageFiles.keepVersion(p.path, m.theirs, { force: true, reason: 'conflict' });
      } catch (e) {
        log(`version not kept ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
      }
    }
    if (p !== ctx.page) return false;
    await applyText(p, m.ours);
    if (p !== ctx.page) return false;
    p.merged = null;
    p.rev = nextRev();
    ctx.setDirty(p, true);
    log(`merge undone ${p.path}`, 'info');
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void ctx.saveDoc(p); }, SAVE_DEBOUNCE);
    ctx.publishState(p);
    return true;
  }

  /** `page.merge-show`: the buffer before the merge against the buffer after it. */
  async function showMerge(p) {
    const m = p && p.merged;
    if (!m) return;
    await compareTexts({
      title: 'Merged changes',
      a: m.ours,
      b: m.text,
      aLabel: 'yours, before the merge',
      bLabel: 'after the merge',
      note: 'the changes on the right came from the file on disk',
    });
  }

  /** The disk's text, kept as a version before it is put in the buffer (reason `reload`). Never throws. */
  async function keepDisk(p, text) {
    if (typeof text !== 'string' || p.outside) return;
    try {
      await pageFiles.keepVersion(p.path, text, { force: true, reason: 'reload' });
    } catch (e) {
      log(`version not kept ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
    }
  }

  /** The buffer, kept as a version before the page lets it go (reason `reload`). Never throws. */
  async function keepBuffer(p, text) {
    if (typeof text !== 'string' || text === p.baseline || p.outside) return;
    try {
      await pageFiles.keepVersion(p.path, text, { force: true, reason: 'reload' });
    } catch (e) {
      log(`version not kept ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
    }
  }

  return {
    mergeExternal,
    reloadClean,
    applyText,
    applyRich,
    holdConflict,
    readDisk,
    resolveMerge,
    keepBothIn,
    keepMine,
    takeTheirs,
    confirmLoss,
    showMergeNote,
    clearMergeNote,
    canUndoMerge,
    undoMerge,
    showMerge,
    keepDisk,
    keepBuffer,
  };
}
