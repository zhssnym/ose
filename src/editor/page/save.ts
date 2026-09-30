// Part of the markdown page (../page.ts). Saving. The text is composed, checked and written; a
// write that fails leaves a draft or a copy.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installSave(ctx)`, and reaches the rest through `ctx`.

import { bus, log, pageFiles } from '../host.ts';
import { toast } from '../deps.ts';
import { composeDoc, parseDoc } from '../doc.ts';
import * as P from '../paths.ts';
import {
  checkedBody, editorView, errCode, errText, hasEditor, isUtf8, KEPT_COPIES_MAX, nextRev,
  RETRY_MAX, SAVE_DEBOUNCE,
} from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installSave(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // saving

  /**
   * An edit. The page is dirty until a save finds that the composed text is the baseline
   * again (M5), and the save waits for the typing to pause. Where autosave does not run — a
   * conflict waiting on the user, a deleted file, a page the rich view could not write — and
   * while a refused write is waiting for its next try, a draft keeps the text instead (C4).
   */
  function markDirty(p) {
    // A text put in from outside (the disk, a merge, H7) is not an edit of the user's.
    if (p !== ctx.page || !p.ready || p.applying) return;
    p.rev = nextRev();
    ctx.setDirty(p, true);
    clearTimeout(p.wordTimer);
    p.wordTimer = setTimeout(() => { if (p === ctx.page) ctx.updateMeta(p, true); }, SAVE_DEBOUNCE);
    if (autosaveHeld(p) || (p.problem && p.problem.status === 'not-saved')) {
      ctx.scheduleDraft(p);
      // A write that left a copy beside the file is not retried on a timer (`saveFailed`); an
      // edit tries once more, no sooner than the backoff allows, and only a few times.
      if (p.problem && p.problem.copy && !p.saveTimer && p.keptCopies < KEPT_COPIES_MAX) {
        const wait = Math.max(SAVE_DEBOUNCE, p.retry * 1000 - (Date.now() - p.failedAt));
        p.saveTimer = setTimeout(() => { p.saveTimer = 0; void saveDoc(p); }, wait);
      }
      // A text the encoding could not hold (X10) may hold it after this edit: try once more.
      if (p.problem && p.problem.reason === 'unencodable') {
        clearTimeout(p.saveTimer);
        p.saveTimer = setTimeout(() => { p.saveTimer = 0; void saveDoc(p); }, SAVE_DEBOUNCE);
      }
    } else {
      clearTimeout(p.saveTimer);
      p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
    }
    ctx.publishState(p);
  }

  /**
   * What a save tells the host about the bytes (X10): the file's own encoding, when it is not
   * UTF-8, so the text goes back in it. Left out, the host writes UTF-8.
   */
  const encodingOpts = (p) => (isUtf8(p.encoding) ? {} : { encoding: p.encoding });

  /** How the page reads its file again: in the encoding the user chose, when they chose one. */
  const readOpts = (p) => (p.forcedEncoding ? { encoding: p.forcedEncoding } : undefined);

  /**
   * A read of the page's file that did not decode the way the page did: another encoding was
   * detected, or the decoding went lossy (or stopped being lossy). Its text is not a later
   * state of the page's text but the bytes read another way, and merging it would write the
   * misreading back over every untouched line (a UTF-8 page, one Latin-1 line appended on
   * disk, reads as windows-1252 mojibake). The page reopens instead, or holds the conflict.
   */
  const readsOtherwise = (p, file: { encoding?: string | null; lossy?: boolean | null; }) => {
    const enc = String((file && file.encoding) || 'UTF-8');
    const same = isUtf8(enc) ? isUtf8(p.encoding) : enc.toLowerCase() === String(p.encoding || '').toLowerCase();
    return !same || (file && file.lossy === true) !== !!p.lossy;
  };

  /** How a read that `readsOtherwise` is named to the user. */
  const readAs = (file) => `${String((file && file.encoding) || 'UTF-8')}${file && file.lossy ? ', which cannot be written back exactly' : ''}`;

  /**
   * The disk reads otherwise than the page (`readsOtherwise`). A clean page opens the file again
   * in place, as it is read now; a dirty one holds the conflict with no text of theirs, the
   * way a file that is no longer text does. Nothing is merged.
   */
  async function readOtherwise(p, file) {
    // A page still opening reads the file itself, with its encoding, a moment from now.
    if (!p.el || !hasEditor(p)) return;
    const hash = file.hash ?? null;
    log(`${p.path} now reads as ${readAs(file)} (the page read it as ${p.encoding}${p.lossy ? ', lossy' : ''})`, 'warn');
    if (!p.dirty && !p.conflict) {
      if (Number(file.mtime)) p.mtime = Number(file.mtime);
      toast(`${P.basename(p.path)} changed on disk and now reads as ${readAs(file)}: opened again`, 'warn');
      await ctx.reopenInPlace(p);
      return;
    }
    if (p.conflict && hash !== null && p.conflict.hash === hash && typeof p.conflict.theirs !== 'string') return;
    ctx.holdConflict(p, { theirs: null, hash, count: 0, base: p.baseline, encoding: String(file.encoding || 'UTF-8'), lossy: file.lossy === true });
  }

  /** Autosave never runs on a deleted page, a conflict or a page the rich view could not write. */
  const autosaveHeld = (p) => p.deleted || (p.problem && (p.problem.status === 'conflict' || p.problem.reason === 'unsafe'));

  /**
   * The file exactly as a save would write it, with the guard's verdict (C8, §7.1). In source
   * mode the text in CodeMirror *is* the file — frontmatter, title and body — and it is handed
   * back untouched, with the file's own line endings (M3).
   */
  function composeChecked(p): { status: 'ok' | 'fellBack' | 'unsafe'; text: string | null; reason?: string; } {
    if (p.source) return { status: 'ok', text: p.source.getText() };
    // Live holds the file itself (X2): its text is the save, with no serializer and no guard.
    if (p.live) return { status: 'ok', text: p.live.getText() };
    // No editor could be built (`mountFallback`): the text that was to go in is all there is.
    // Nothing saves it over the file (`saveDoc` needs an editor); Save as and Copy text may.
    if (!p.crepe) {
      return typeof p.orphan === 'string'
        ? { status: 'ok', text: p.orphan }
        : { status: 'unsafe', text: null, reason: 'the page has no editor' };
    }
    const r = checkedBody(p.crepe, p.doc.body);
    if (r.status === 'unsafe') {
      let text: any = null;
      if (typeof r.text === 'string') { try { text = composeDoc(p.doc, { title: p.title, body: r.text }); } catch { text = null; } }
      return { status: 'unsafe', text, reason: r.reason || 'the rich view could not write this page' };
    }
    return { ...r, text: composeDoc(p.doc, { title: p.title, body: r.text }) };
  }

  /**
   * The plainest text the page can still give when the guard has nothing: Crepe's own
   * serialiser, then the document's bare text, under the title.
   */
  function bestEffort(p) {
    if (p.source) return p.source.getText();
    if (p.live) return p.live.getText();
    if (!p.crepe && typeof p.orphan === 'string') return p.orphan;
    let body: any = null;
    try { body = p.crepe ? p.crepe.getMarkdown() : null; } catch { /* next */ }
    if (!body) {
      try {
        const view = p.crepe ? editorView(p.crepe) : null;
        const d = view ? view.state.doc : null;
        body = d ? d.textBetween(0, d.content.size, '\n\n', '\n') : null;
      } catch { /* nothing left */ }
    }
    body = body || (p.doc ? p.doc.body : '');
    try { return composeDoc(p.doc, { title: p.title, body }); } catch {
      return (p.title ? '# ' + p.title + '\n\n' : '') + body;
    }
  }

  /**
   * Save the page. Answers `true` only when the disk holds the buffer afterwards (written, or
   * nothing to write), and `false` on every other outcome: a text the guard called unsafe, a
   * host error (a locked file, a full disk, a vault that changed), a conflict not resolved, a
   * deleted page, a read-only one (C2).
   *
   * One host call compares and writes (M2): it carries the hash of the baseline and writes
   * nothing when the disk holds something else. The whole thing runs inside one `saving`
   * promise, so a blur and a debounce firing together write once; edits made while the write
   * was in flight leave the page dirty and reschedule it (`rev`).
   *
   * `o.explicit`: a user gesture — asks the changed-on-disk question and lifts a held
   * autosave. `o.leaving`: the page is being left — a deleted page is not recreated behind the
   * user's back, the leave is refused instead. `o.closing`: the window is going and no
   * question can be awaited.
   */
  async function saveDoc(p, o: any = {}) {
    if (!p) return true;
    if (!hasEditor(p)) return !p.dirty;
    clearTimeout(p.saveTimer);
    p.saveTimer = 0;
    if (p.trashed) return true;
    if (p.saving) {
      // A question already on screen cannot be answered by a window that is closing: veto now.
      if (o.closing && p.asking) return false;
      try { await p.saving; } catch { /* reported by the save itself */ }
      if (p.dirty && (o.explicit || o.closing) && !p.saving) return saveDoc(p, o);
      return !p.dirty;
    }
    // A rename or a move of this page is in flight: nothing goes to a name that is going away.
    if (p.moving) {
      if (!o.explicit && !o.closing) { p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE); return false; }
      await Promise.race([p.movingDone, new Promise<any>((r) => setTimeout(r, 10000))]);
      if (p.moving) return false;
      return saveDoc(p, o);
    }
    const deliberate = o.explicit || o.closing;
    // "Save again here" on a deleted page is a deliberate save, even of a clean buffer.
    const recreate = p.deleted && o.explicit && !o.leaving && !o.closing;
    // `o.recode`: `page.save-utf8` writes the same text in another encoding, dirty or not.
    if (!p.dirty && !recreate && !o.recode) return true;
    if (p.readOnly && !o.recode) return false;
    // H7: the disk and the buffer overlap. Ctrl+S (a save the user asked for, not a leave, a
    // close or a path change) opens the resolve view; everything else goes to the host as
    // usual, where the stale hash keeps it from writing over the disk's text.
    if (p.conflict && o.explicit && !o.leaving && !o.closing && !o.pathChange && !o.noResolve) return ctx.resolveMerge(p);
    // A recovered draft nobody has edited yet waits for a deliberate save (see open): not a
    // blur, not a debounce, not the window being hidden before the user has compared it.
    if (!deliberate && ((p.recovered && p.recovered.applied && p.recovered.rev === p.rev) || ctx.unchecked(p))) return false;
    if (!deliberate && autosaveHeld(p)) { ctx.scheduleDraft(p); return false; }
    if (p.deleted && !recreate) { void ctx.writeDraft(p); return false; }

    const rev = p.rev;
    const r = composeChecked(p);
    if (r.status === 'unsafe') { await refuseUnsafe(p, r); return false; }
    if (r.status === 'fellBack') {
      log(`guard fellBack ${p.path}: ${r.reason}`, 'warn');
      ctx.emit('guard', { status: r.status, reason: r.reason });
    }
    const text = r.text;
    // M5: a buffer that composes back to the baseline is not dirty, whatever changed in it.
    if (text === p.baseline && !recreate && !o.recode) { settleClean(p, rev); return true; }

    // `writeOut` answers true, false or 'again', from inside the closure below.
    let outcome = (false as boolean | string);
    p.saving = (async () => {
      outcome = await writeOut(p, text, rev, { expectedHash: p.deleted ? null : p.baselineHash, ...encodingOpts(p) });
    })();
    ctx.publishState(p);
    try {
      await p.saving;
    } catch (e) {
      saveFailed(p, e);
      outcome = false;
    } finally {
      p.saving = null;
      ctx.publishState(p);
    }
    // The disk had moved on and its change was merged into the buffer (H7): a deliberate save
    // writes the merged text now; otherwise the autosave the merge scheduled does.
    if (outcome === 'again') {
      const round = (o.round || 0) + 1;
      return deliberate && round <= 3 ? saveDoc(p, { ...o, round }) : !p.dirty;
    }
    if (outcome && p.dirty && deliberate && p.rev !== rev) return saveDoc(p, o);
    return outcome && !p.dirty;
  }

  /**
   * The write itself, through the host's compare-and-write (§3.2 `saveFile`). Answers true when
   * the text is on disk, and `'again'` when the disk held another text that was merged into the
   * buffer (H7): the buffer is dirty over the disk's hash now and a save may write it.
   */
  async function writeOut(p, text, rev, opts) {
    const path = p.path;
    let res;
    try {
      res = await pageFiles.save(path, text, opts);
    } catch (e) {
      saveFailed(p, e);
      return false;
    }
    if (res && res.status === 'saved') { saved(p, text, res, rev); return true; }
    if (res && res.status === 'conflict') {
      const disk = res.disk || { exists: false, text: null, hash: null };
      log(`save conflict ${path}`, 'warn');
      // Expected to be there and it is not: the file left the disk under the page (C7).
      if (!disk.exists && opts.expectedHash !== null) { ctx.markDeleted(p); return false; }
      // No question here any more: the disk's change is merged into the buffer, and only when
      // both touched the same lines does the page hold a conflict and say so (H7, §5.3).
      const m = await ctx.mergeExternal(p, { text: disk.text, hash: disk.hash });
      return m === 'conflict' ? false : 'again';
    }
    saveFailed(p, Object.assign(new Error('the host gave no answer to the save'), { code: 'unknown_command' }));
    return false;
  }

  /** The text is on disk: it is the baseline now, and the page is clean if nothing moved on. */
  function saved(p, text, res, rev) {
    p.baseline = text;
    p.baselineHash = res.hash ?? null;
    p.deleted = false;
    p.problem = null;
    p.conflict = null;
    p.retry = 0;
    // A page the rich view could not write was opened as text for the user to check; saved,
    // it is an ordinary page in source mode. An open-time notice (lossy-open) stays.
    p.keptCopies = 0;
    p.uncheckedRev = -1;
    p.reloadPending = false;
    if (p.forced === 'unsafe') { p.forced = null; p.notice = null; ctx.publishMode(p); }
    else if (!p.forced) p.notice = null;
    if (p.recovered && p.recovered.applied) p.recovered = null;
    // The next reconcile compares against what was written, and in source mode the title strip
    // (a label over text the user just edited) follows it.
    p.doc = p.plain ? ctx.plainDoc(text) : parseDoc(text);
    p.title = p.doc.titleLine !== null ? p.doc.title : p.title;
    ctx.publishTitle(p);
    if (p.source && p.titleEl && p.titleEl.textContent !== p.title) p.titleEl.textContent = p.title;
    p.savedAt = P.hhmm();
    p.savedAtMs = Date.now();
    if (Number(res.mtime)) p.mtime = Number(res.mtime);
    log(`save ok ${p.path}${res.unchanged ? ' (unchanged)' : ''}`, 'info');
    bus.emit('doc:saved', { path: p.path });
    ctx.emit('saved', { path: p.path, text });
    if (p.rev === rev) {
      settleClean(p, rev);
    } else if (p === ctx.page) {
      // Typed during the write: still dirty, and the debounce runs again.
      clearTimeout(p.saveTimer);
      p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
      ctx.publishState(p);
    }
  }

  /** Clean: the disk holds the buffer. The draft goes, and so does any problem. */
  function settleClean(p, rev) {
    const conflict = p.conflict;
    if (!p.deleted) { p.problem = null; p.conflict = null; }
    p.retry = 0;
    ctx.setDirty(p, false);
    void ctx.dropDraft(p, rev);
    ctx.publishState(p);
    ctx.updateMeta(p);
    // The buffer went back to the text it was opened from while the disk moved on: nothing of
    // the user's is left to keep, so the page shows the disk, in place (H7).
    if (conflict && !p.deleted && p === ctx.page) {
      if (typeof conflict.theirs === 'string') void ctx.reloadClean(p, conflict.theirs, conflict.hash);
      else void ctx.reopenInPlace(p);
    }
  }

  /** A write threw. The buffer stays dirty and on this machine; a later try may still land. */
  function saveFailed(p, e) {
    const code = errCode(e);
    log(`save failed ${p.path}: ${code} ${errText(e)}`, 'error');
    // `[write_failed] …; your text is in <where>`: the host could not put the file in place and
    // set the new text aside in a visible copy beside it (vault.rs `keep_unsaved`).
    const copy = code === 'write_failed' && /;\s*your text is in\s/.test(errText(e));
    // X10: the text holds a character the file's encoding cannot, and nothing was written. It
    // stays so until the text changes or the user converts the file (`page.save-utf8`).
    const unencodable = code === 'unencodable';
    p.problem = {
      status: 'not-saved',
      reason: code === 'stale_vault' ? 'stale-vault' : unencodable ? 'unencodable' : 'write-failed',
      message: code === 'stale_vault'
        ? 'the vault changed since this page was opened'
        : unencodable ? `the text holds characters ${p.encoding} cannot hold` : errText(e),
      copy,
    };
    p.failedAt = Date.now();
    if (copy) p.keptCopies++;
    void ctx.writeDraft(p);
    ctx.publishState(p);
    // A write the host refused is tried again, further apart each time (2, 4, 8 … 30 s). A page
    // of another vault is not: it would land in the wrong place, which is what the epoch stops.
    // Nor is a write that left a copy beside the file: every try would leave one more in the
    // user's folder. That one is tried again on the next edit (`markDirty`) or by a deliberate
    // save, which the banner offers. Nor is a text the encoding cannot hold: the next edit or a
    // deliberate save tries again.
    if (code !== 'stale_vault' && p === ctx.page) {
      p.retry = Math.min(RETRY_MAX, p.retry ? p.retry * 2 : 2);
      clearTimeout(p.saveTimer);
      p.saveTimer = 0;
      if (!copy && !unencodable) p.saveTimer = setTimeout(() => { void saveDoc(p); }, p.retry * 1000);
    }
  }

  /**
   * The guard found no text that reads back as the page (§7.1): nothing is written. The best
   * effort goes to a draft, and the page opens as text over it, dirty, for the user to check
   * and save — saving then writes exactly what CodeMirror holds.
   */
  async function refuseUnsafe(p, r) {
    log(`guard unsafe ${p.path}: ${r.reason}`, 'error');
    ctx.emit('guard', { status: 'unsafe', reason: r.reason });
    const text = typeof r.text === 'string' ? r.text : bestEffort(p);
    p.problem = { status: 'not-saved', reason: 'unsafe', message: 'the rich view could not write this page exactly' };
    await ctx.writeDraftText(p, text, false);
    if (p !== ctx.page) return;
    await ctx.forceSource(p, text, 'unsafe', r.reason);
    // Until the user edits it or saves it deliberately, this text is not written by a leave.
    if (p === ctx.page) p.uncheckedRev = p.rev;
  }

  return {
    markDirty,
    encodingOpts,
    readOpts,
    readsOtherwise,
    readAs,
    readOtherwise,
    autosaveHeld,
    composeChecked,
    bestEffort,
    saveDoc,
    writeOut,
    saved,
    settleClean,
    saveFailed,
    refuseUnsafe,
  };
}
