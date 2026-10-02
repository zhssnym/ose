// Part of the markdown page (../page.ts). What the commands do to this page, and its encoding.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installActions(ctx)`, and reaches the rest through `ctx`.

import {
  copyText, log, names, navigate, pageFiles, repointRoute,
} from '../host.ts';
import { confirm, prompt, toast } from '../deps.ts';
import { insertPageLink } from '../link.ts';
import { pickHeading } from '../outline.ts';
import { rememberMode } from '../modes.ts';
import { compareTexts } from '../compare.ts';
import * as P from '../paths.ts';
import {
  editorView, errCode, errText, isUtf8, nextRev, PUBLIC, recoveredModeOf,
  whenLabel,
} from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installActions(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // what the commands do to this page

  /** The heading picker (C2). The title row scrolls to the top; a body heading takes the caret. */
  async function outlinePage() {
    const p = ctx.page;
    if (!p || !p.crepe || !p.doc) return;
    const view = editorView(p.crepe);
    if (!view) return;
    await pickHeading({
      view,
      title: p.doc.titleLine !== null ? p.title : null,
      onTitle: () => { if (p === ctx.page) ctx.focusTitle(p); },
    });
  }

  /**
   * Insert a link to another page at the caret. The palette has just closed, so the editor is
   * focused first: the link goes where the caret was left.
   */
  async function linkPage() {
    const p = ctx.page;
    if (!p || !p.crepe) return;
    const view = editorView(p.crepe);
    if (!view) return;
    view.focus();
    await insertPageLink(view);
  }

  /** The file text as a save would write it, on the clipboard (C14). */
  async function copyMarkdown() {
    const p = ctx.page;
    if (!p) return;
    let r;
    try { r = ctx.composeChecked(p); } catch (e) { r = { status: 'unsafe', text: null, reason: errText(e) }; }
    const text = typeof r.text === 'string' ? r.text : ctx.bestEffort(p);
    const ok = await copyText(text);
    if (!ok) { toast('could not copy', 'err'); return; }
    toast(r.status === 'unsafe' ? 'copied — the rich view could not write this page exactly: check it' : 'copied',
      r.status === 'unsafe' ? 'warn' : 'info');
  }

  /**
   * `page.save-as`: the buffer into a new file, which must not exist yet. The page then is that
   * file; the old one is not touched (§6.5).
   */
  async function saveAs() {
    const p = ctx.page;
    if (!p) return false;
    const base = P.basename(p.path);
    const dot = base.lastIndexOf('.');
    const start = p.path.length - base.length;
    const answer = await prompt({
      title: 'Save as', value: p.path, ok: 'Save',
      body: 'A path in the vault. The file there must not exist yet; the old one is left as it is.',
      select: [start, start + (dot > 0 ? dot : base.length)],
    });
    if (!answer || p !== ctx.page) return false;
    let to = P.normalize(String(answer).replace(/\\/g, '/'));
    const n = names();
    if (n && typeof n.check === 'function') {
      const c = n.check(to, { folders: true });
      if (!c.ok) { toast(`not saved: ${c.reason}`, 'err'); return false; }
      to = c.name;
    }
    if (!to) return false;
    const rev = p.rev;
    let r;
    try { r = ctx.composeChecked(p); } catch (e) { r = { status: 'unsafe', text: null, reason: errText(e) }; }
    if (typeof r.text !== 'string' || r.status === 'unsafe') {
      toast('not saved: the rich view could not write this page exactly. Switch to Source, check it, and save.', 'err', 0);
      return false;
    }
    const text = r.text;
    let res;
    try {
      res = await pageFiles.createNew(to, text);
    } catch (e) {
      log(`save as failed ${to}: ${errCode(e)} ${errText(e)}`, 'warn');
      toast(errCode(e) === 'exists' ? `not saved: ${to} already exists` : `not saved: ${errText(e)}`, 'err');
      return false;
    }
    if (p !== ctx.page) return false;
    const from = p.path;
    const dest = String((res && res.path) || to);
    await ctx.dropDraft(p);
    p.path = dest;
    p.deleted = false;
    p.problem = null;
    p.recovered = null;
    p.baseline = text;
    p.baselineHash = (res && res.hash) ?? null;
    // The copy is a new file, written as UTF-8, and it may be inside the vault where the old one
    // was not (X7, X10).
    p.outside = P.isOutside(dest);
    p.encoding = 'UTF-8';
    p.forcedEncoding = null;
    if (p.lossy) { p.lossy = false; p.readOnly = false; if (!p.frozen) ctx.setEditable(p, true); }
    p.savedAt = P.hhmm();
    p.savedAtMs = Date.now();
    if (!p.forced) void rememberMode(dest, ctx.publicMode(p));
    log(`save ok ${dest} (save as, from ${from})`, 'info');
    repointRoute([{ from, to: dest }]);
    ctx.publishTitle(p);
    if (p.rev === rev) ctx.settleClean(p, rev); else ctx.publishState(p);
    toast(`saved as ${dest}`);
    if (!ctx.parked && P.isMarkdown(from) !== P.isMarkdown(dest)) {
      void navigate({ type: 'page', path: dest }, { replace: true, force: true });
    }
    return true;
  }

  /**
   * `page.discard-changes`: back to the file on disk. The buffer is kept as a version first
   * (reason `reload`), and the draft goes. A deleted page is only marked clean; a page with an
   * offered draft and no edits of its own only lets the draft go.
   */
  async function discardChanges() {
    const p = ctx.page;
    if (!p) return false;
    if (!p.dirty) {
      if (p.recovered) {
        // The offered draft went to Versions at open; when that failed, it is tried once more,
        // and the question says plainly whether the text survives the discard.
        const kept = await ctx.keepRecovered(p);
        if (p !== ctx.page || !p.recovered) return true;
        const ok = p.outside
          ? await ctx.confirmLoss(p, {
            title: 'Discard recovered changes?',
            body: 'The page stays as the file on disk. This file is outside the vault and has no Versions: the recovered text is lost.',
            ok: 'Discard', text: p.recovered.text,
          })
          : await confirm({
            title: 'Discard recovered changes?',
            body: kept
              ? 'The page stays as the file on disk. The recovered text is kept in Versions….'
              : 'The page stays as the file on disk. The recovered text could not be kept in Versions and will be lost.',
            ok: 'Discard', danger: true,
          });
        if (!ok || p !== ctx.page || !p.recovered) return false;
        // The slot may hold the draft only while it is not in Versions: a failed keep leaves
        // it, and the user said to let it go, so it goes without the check.
        if (!kept) p.recovered.kept = true;
        await ctx.dropDraft(p);
        p.recovered = null;
        ctx.publishState(p);
        toast('recovered changes discarded');
      }
      return true;
    }
    let ok;
    if (p.outside && !p.deleted) {
      // No Versions outside the vault (X7): the question says so, and offers a copy.
      let mine: string | null = null;
      try { const d = ctx.draftText(p); mine = d && typeof d.text === 'string' ? d.text : null; } catch { mine = null; }
      ok = await ctx.confirmLoss(p, {
        title: 'Discard unsaved changes?',
        body: 'The page goes back to the file on disk. This file is outside the vault and has no Versions: what you discard is lost.',
        ok: 'Discard', text: mine ?? ctx.bestEffort(p),
      });
    } else {
      ok = await confirm({
        title: 'Discard unsaved changes?',
        body: p.deleted
          ? 'The file is gone from disk; the text on screen goes too.'
          : 'The page goes back to the file on disk. What you discard is kept in Versions….',
        ok: 'Discard', danger: true,
      });
    }
    if (!ok || p !== ctx.page) return false;
    if (!p.deleted) {
      let d: { text: any; exact: boolean; } | null = null;
      try { d = ctx.draftText(p); } catch { d = null; }
      if (d && typeof d.text === 'string') await ctx.keepBuffer(p, d.text);
    }
    await ctx.dropDraft(p);
    clearTimeout(p.saveTimer);
    p.problem = null;
    p.conflict = null;
    p.merged = null;
    p.recovered = null;
    ctx.setDirty(p, false);
    log(`discarded changes ${p.path}`, 'info');
    if (p.deleted || p !== ctx.page) { ctx.publishState(p); return true; }
    await ctx.reopenInPlace(p);
    return true;
  }

  /** `page.recovered-compare`: the disk against the recovered draft, side by side. */
  async function recoveredCompare() {
    const p = ctx.page;
    const r = p && p.recovered;
    if (!r) return;
    await compareTexts({
      title: 'Recovered changes',
      a: p.baseline,
      b: r.text,
      aLabel: 'on disk',
      bLabel: `recovered ${whenLabel(r.at)}`,
      note: r.applied ? 'the recovered text is what the page shows now' : 'the page shows the disk; Restore mine puts the recovered text in',
    });
  }

  /**
   * `page.recovered-restore`: a draft that could not be applied, put in anyway. It is based on
   * an older text than the disk holds, so it goes in as an overlap with the disk, and the
   * resolve view asks what to keep.
   */
  async function recoveredRestore() {
    const p = ctx.page;
    const r = p && p.recovered;
    if (!r || r.applied) return false;
    const mode = PUBLIC[recoveredModeOf(p, r)] || 'source';
    r.applied = true;
    const ok = await ctx.setMode(mode, { text: r.text, quiet: true });
    if (p !== ctx.page) return false;
    if (!ok && !p.source) { r.applied = false; ctx.publishState(p); return false; }
    p.rev = nextRev();
    ctx.setDirty(p, true);
    // The draft was typed over an older text than the disk holds, and that text is gone: there
    // is nothing to merge against. The page holds it as an overlap with the disk, and the
    // resolve view (Keep both, Keep mine, Take theirs) decides.
    ctx.holdConflict(p, { theirs: p.baseline, hash: p.baselineHash, count: 0, base: null });
    return true;
  }

  function focusPage() {
    const p = ctx.page;
    if (!p) return;
    if (p.source) { p.source.focus(); return; }
    if (p.crepe) { const view = editorView(p.crepe); if (view) { view.focus(); return; } }
    if (p.titleEl) p.titleEl.focus();
  }

  // -------------------------------------------------------------------------
  // encodings (X10)

  /**
   * `page.save-utf8`: the text written back as UTF-8, from now on. Converting is never done
   * behind the user's back (F7): it is this command, asked for, with the question saying what
   * it means. A page that could not be decoded exactly says that the characters it shows are
   * what will be written.
   */
  async function saveUtf8() {
    const p = ctx.page;
    if (!p) return false;
    const name = P.basename(p.path);
    if (isUtf8(p.encoding)) { toast(`${name} is already UTF-8`, 'info'); return true; }
    const kept = p.outside ? '' : ' The file as it is now is kept in Versions….';
    const ok = await confirm({
      title: 'Save as UTF-8?',
      body: p.lossy
        ? `${name} is not exact as ${p.encoding}. What the page shows is written as UTF-8, and the bytes it could not show are lost.${kept}`
        : `${name} is written as UTF-8 from now on, instead of ${p.encoding}.${kept}`,
      ok: 'Save as UTF-8', danger: p.lossy,
    });
    if (!ok || p !== ctx.page) return false;
    const was = p.encoding;
    p.encoding = 'UTF-8';
    p.forcedEncoding = null;
    if (p.lossy) { p.lossy = false; p.readOnly = false; if (!p.frozen) ctx.setEditable(p, true); }
    if (p.problem && p.problem.reason === 'unencodable') p.problem = null;
    const done = await ctx.saveNow({ explicit: true, recode: true });
    if (p !== ctx.page) return done;
    log(`${done ? 'converted' : 'not converted'} to UTF-8 ${p.path} (was ${was})`, done ? 'info' : 'warn');
    ctx.updateMeta(p);
    ctx.publishState(p);
    if (done) toast(`${name} saved as UTF-8`);
    return done;
  }

  /**
   * `page.reopen-encoding`: the file read again in the encoding the user names, which then
   * holds for every read and save of the page (F7: the override of a misdetection). A page
   * with unsaved changes is not reopened: its text would be read again from under it.
   */
  async function reopenEncoding() {
    const p = ctx.page;
    if (!p) return false;
    if (p.dirty) { toast('Save or discard your changes first: reopening reads the file again', 'warn'); return false; }
    const answer = await prompt({
      title: 'Reopen with encoding',
      value: p.encoding,
      ok: 'Reopen',
      body: 'An encoding name, such as UTF-8, windows-1252, ISO-8859-15, UTF-16LE, Shift_JIS, GBK or windows-1251.',
    });
    if (!answer || p !== ctx.page) return false;
    let label;
    try { label = new TextDecoder(String(answer).trim()).encoding; } catch { label = null; }
    if (!label) { toast(`${String(answer).trim()} is not an encoding this app knows`, 'err'); return false; }
    if (p.dirty) { toast('Save or discard your changes first: reopening reads the file again', 'warn'); return false; }
    // Tried first, so a file that is not text in that encoding leaves the page as it was.
    try {
      await pageFiles.readFile(p.path, { encoding: label });
    } catch (e) {
      toast(`${P.basename(p.path)} cannot be read as ${label}: ${errText(e)}`, 'err');
      return false;
    }
    if (p !== ctx.page || p.dirty) return false;
    await ctx.run(p.path, { encoding: label });
    return true;
  }

  return {
    outlinePage,
    linkPage,
    copyMarkdown,
    saveAs,
    discardChanges,
    recoveredCompare,
    recoveredRestore,
    focusPage,
    saveUtf8,
    reopenEncoding,
  };
}
