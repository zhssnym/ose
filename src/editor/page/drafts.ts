// Part of the markdown page (../page.ts). Drafts of the text not yet saved, and the meta line.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installDrafts(ctx)`, and reaches the rest through `ctx`.

import { log, pageFiles } from '../host.ts';
import { backlinkCount } from '../backlinks.ts';
import { countWords } from '../doc.ts';
import * as P from '../paths.ts';
import {
  DRAFT_DELAY, DRAFT_EVERY, editorView, errCode, errText, hasEditor, isUtf8, savedLabel,
  shownText,
} from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installDrafts(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // drafts (C4, M1)

  /** The text a draft of the page holds, and whether it is what a save would write. */
  function draftText(p) {
    // Text the user has not checked yet stays marked as such, whichever editor holds it.
    const exact = !ctx.unchecked(p);
    if (p.source) return { text: p.source.getText(), exact };
    if (!p.crepe) return { text: typeof p.orphan === 'string' ? p.orphan : null, exact: false };
    const r = ctx.composeChecked(p);
    if (r.status !== 'unsafe' && typeof r.text === 'string') return { text: r.text, exact };
    return { text: typeof r.text === 'string' ? r.text : ctx.bestEffort(p), exact: false };
  }

  /** A draft soon: `DRAFT_DELAY` after this edit, and at most every `DRAFT_EVERY` while typing. */
  function scheduleDraft(p) {
    if (p.draftTimer) return;
    const wait = Math.max(DRAFT_DELAY, DRAFT_EVERY - (Date.now() - p.draftAt));
    p.draftTimer = setTimeout(() => { p.draftTimer = 0; if (p === ctx.page && p.dirty) void writeDraft(p); }, wait);
  }

  /** Write the draft of a dirty buffer now. Never throws; the state says how it went. */
  async function writeDraft(p) {
    if (!p || !p.path || !p.dirty || p.trashed) return;
    if (!hasEditor(p) && typeof p.orphan !== 'string') return;
    clearTimeout(p.draftTimer);
    p.draftTimer = 0;
    let d;
    try { d = draftText(p); } catch (e) { d = { text: null }; console.error('[editor] draft text', e); }
    if (typeof d.text !== 'string') { p.draft = 'failed'; ctx.publishState(p); return; }
    await writeDraftText(p, d.text, d.exact);
  }

  /**
   * The draft writes and drops of one page run one after the other (M1): a drop issued after a
   * write can never reach the host first and leave the write standing after its save. `fn`
   * runs whether the one before it succeeded or not.
   */
  function draftOp(p, fn) {
    const next = (p.draftChain || Promise.resolve()).then(fn, fn);
    p.draftChain = next.catch(() => {});
    return next;
  }

  /**
   * An offered draft (not applied at open) into Versions, so the slot it shares with this
   * page's own drafts may be written or dropped. True when it is kept, or there is none to keep;
   * false leaves the slot alone, and the draft in it, until a later try succeeds.
   */
  async function keepRecovered(p) {
    const r = p.recovered;
    if (!r || r.applied || r.kept) return true;
    // A file outside the vault has no Versions (X7). Its offered draft stays offered, and the
    // slot is not written over while it is there: the page's own drafts wait (`writeDraftText`).
    if (p.outside) return false;
    try {
      await pageFiles.keepVersion(p.path, r.text, { force: true, reason: 'conflict' });
      r.kept = true;
      log(`recovered draft kept as a version ${p.path}`, 'info');
    } catch (e) {
      log(`recovered draft not kept ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
    }
    return !!r.kept;
  }

  function writeDraftText(p, text, exact) {
    // Captured now: the buffer as it is at this call. The path is read when the write runs, so a
    // rename in between (the host re-keys drafts) is followed.
    const draft = { text, baselineHash: p.baselineHash ?? null, mode: ctx.publicMode(p), exact: !!exact, rev: p.rev };
    // Set before the write, so a drop issued meanwhile is not skipped for a draft that is on
    // its way (the chain puts that drop after this write). Cleared only by a confirmed drop.
    p.hasDraft = true;
    return draftOp(p, async () => {
      const path = p.path;
      if (!await keepRecovered(p)) {
        p.draft = 'failed';
        log(`draft not written ${path}: the recovered draft in its place is not in Versions`, 'warn');
        ctx.publishState(p);
        return;
      }
      try {
        const at = await pageFiles.drafts.write(path, { path, ...draft });
        p.draftAt = Date.now();
        p.draftStamp = at && Number(at.at) ? Number(at.at) : null;
        p.draft = 'written';
      } catch (e) {
        p.draft = 'failed';
        log(`draft failed ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
      }
      ctx.publishState(p);
    });
  }

  /**
   * Drop the page's draft: after a save that left it clean (`rev`, so a newer draft written
   * meanwhile stays), after Discard and after Reload from disk (no `rev`: always). Queued behind
   * any draft write already issued.
   */
  function dropDraft(p, rev?) {
    clearTimeout(p.draftTimer);
    p.draftTimer = 0;
    return draftOp(p, async () => {
      if (!p.hasDraft) return;
      if (!await keepRecovered(p)) return;
      try {
        // The draft of a file outside the vault is one slot for every window that has the file
        // open: only the draft this page wrote (or recovered) is its to drop.
        if (p.outside && !await ownsDraft(p)) {
          p.hasDraft = false;
          p.draft = null;
          ctx.publishState(p);
          return;
        }
        const r = await pageFiles.drafts.drop(p.path, rev === undefined ? undefined : { ifRev: rev });
        // A newer draft than this save stays, and so does the flag that says there is one.
        if (r && r.dropped === false && rev !== undefined) return;
        p.hasDraft = false;
        p.draft = null;
      } catch (e) {
        log(`draft not dropped ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
        return;
      }
      ctx.publishState(p);
    });
  }

  /**
   * Is the draft in the page's slot the one this page wrote or recovered? By the `at` the host
   * stamped it with. No draft there is not ours either. Throws what the read throws.
   */
  async function ownsDraft(p) {
    const d = await pageFiles.drafts.read(p.path);
    return !!d && p.draftStamp != null && Number(d.at) === p.draftStamp;
  }

  // -------------------------------------------------------------------------
  // the meta line

  /**
   * S32: the count comes from the ProseMirror document, and only when `recount` says so:
   * markDirty repaints the line immediately with the number it already has and schedules the
   * recount on the same debounce as the save.
   */
  function updateMeta(p, recount = false) {
    if (!p) return;
    if (recount) {
      const text = pageText(p);
      p.words = countWords(text);
      p.chars = text.length;
    }
    const n = (v) => v.toLocaleString('en');
    const bits: any[] = [];
    // A file outside the vault says so, and where it is (X7): the breadcrumb has no folder of
    // the vault to show for it.
    if (p.outside) bits.push(`Outside the vault: ${P.outsideLabel(p.path)}`);
    // A file with no title of its own says its name; a page's folder is in the breadcrumb.
    else if (p.plain) bits.push(P.basename(p.path));
    // The encoding, when it is not the usual one (X10).
    if (!isUtf8(p.encoding)) bits.push(p.lossy ? `${p.encoding}, read-only` : p.encoding);
    bits.push(`${n(p.words)} word${p.words === 1 ? '' : 's'}`);
    bits.push(`${n(p.chars)} character${p.chars === 1 ? '' : 's'}`);
    // One fact about saving: unsaved, or when the file was last saved.
    if (p.dirty) bits.push('unsaved');
    else { const when = savedLabel(p.mtime); if (when) bits.push(when); }
    const linked = p.outside ? 0 : backlinkCount(p.path);
    if (linked) bits.push(`${linked} linked`);
    if (p.deleted) bits.push('(deleted)');
    if (p.metaText) p.metaText.textContent = bits.join('  ·  ');
    ctx.setStatus('doc', bits.join('  ·  '));
  }

  /**
   * The text the counts are taken from: the title and the body, never the frontmatter. From the
   * ProseMirror document itself (never a serialisation) in block mode, from the buffer in source
   * mode, from the file before either is mounted.
   */
  function pageText(p) {
    try {
      // Source holds the whole file: the count is of what Rich would show of it, so a
      // mode switch never changes the size of the note. A plain file counts as it is.
      if (p.source) return p.plain ? p.source.viewText() : shownText(p.source.viewText());
      const view = p.crepe ? editorView(p.crepe) : null;
      if (view) {
        const doc = view.state.doc;
        return `${p.title || ''} ${doc.textBetween(0, doc.content.size, '\n', ' ')}`;
      }
    } catch (e) { console.error('[editor] word count', e); }
    return `${p.title || ''} ${p.doc ? p.doc.body : ''}`;
  }

  return {
    draftText,
    scheduleDraft,
    writeDraft,
    draftOp,
    keepRecovered,
    writeDraftText,
    dropDraft,
    ownsDraft,
    updateMeta,
    pageText,
  };
}
