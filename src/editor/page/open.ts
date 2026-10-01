// Part of the markdown page (../page.ts). Opening a file into the page, mounting its body, and
// closing it.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installOpen(ctx)`, and reaches the rest through `ctx`.

import { bus, log, pageFiles } from '../host.ts';
import { patchState } from '../deps.ts';
import { createFind } from '../find.ts';
import { createSourceView } from '../source.ts';
import { modeFor } from '../modes.ts';
import { describe, indentFor, loadLanguage } from '../highlight.ts';
import { parseDoc } from '../doc.ts';
import * as P from '../paths.ts';
import { attachSheets } from '../sheets.ts';
import {
  afterLayout, blankPage, checkOpened, editorView, errCode, errText, hasEditor, INTERNAL,
  makeCrepe, nextRev, PlainDoc, recoveredModeOf, seenRev,
} from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installOpen(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // open and close

  async function open(nextPath, options: any = {}) {
    if (ctx.closed) return;
    if (options.line && ctx.page && ctx.page.path === nextPath && hasEditor(ctx.page) && ctx.page.el && ctx.page.el.parentNode === ctx.el) {
      ctx.scrollToLine(options.line, options.col);
      ctx.openFindWith(ctx.page, options.query);
      return;
    }
    const token = ++ctx.openToken;
    // A page that cannot be saved is not replaced: it stays, with its banner (C1).
    if (!await closePage({ keepAlive: true })) return;
    if (token !== ctx.openToken) return;

    const p = blankPage();
    p.path = nextPath;
    ctx.page = p;
    // A parked instance reopening itself (a reload from disk in the background) does not take
    // the status bar from the page on screen.
    if (!ctx.parked) ctx.take();

    let file;
    // `page.reopen-encoding` hands a decoding over (X10); it holds for this open and every read
    // of the file after it, until the page is opened again without one.
    p.forcedEncoding = typeof options.encoding === 'string' && options.encoding ? options.encoding : null;
    try {
      file = await pageFiles.readFile(nextPath, p.forcedEncoding ? { encoding: p.forcedEncoding } : undefined);
      if (!file || typeof file.text !== 'string') throw Object.assign(new Error('the host answered no text'), { code: 'io' });
    } catch (e) {
      if (token !== ctx.openToken) return;
      ctx.page = null;
      ctx.el.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `cannot open ${nextPath}: ${errText(e)}`;
      ctx.el.append(empty);
      log(`open failed ${nextPath}: ${errCode(e)} ${errText(e)}`, 'warn');
      ctx.setStatus('doc', null);
      ctx.setStatus('save', null);
      ctx.setStatus('mode', null);
      return;
    }
    if (token !== ctx.openToken) return;
    const text = file.text;

    // A file that is not markdown is never parsed as one (batch 12): it opens in source mode,
    // with no title strip, and what is written back is exactly what CodeMirror holds.
    p.plain = !P.isMarkdown(nextPath);
    p.outside = P.isOutside(nextPath);
    p.baseline = text;
    p.baselineHash = file.hash ?? null;
    p.mtime = Number(file.mtime) || 0;
    // X10: the file keeps its own encoding, and a save writes it back in it. A decode that does
    // not give the same bytes back is shown, never saved: the page is read-only until the user
    // reopens it with another encoding or converts it on purpose.
    p.encoding = typeof file.encoding === 'string' && file.encoding ? file.encoding : 'UTF-8';
    p.lossy = file.lossy === true;
    if (p.lossy) {
      p.readOnly = true;
      log(`opened read-only ${nextPath}: not exact as ${p.encoding}`, 'warn');
    }

    // A draft this machine kept of the page (C4, §6.6): a crash, a forced quit, a save that
    // failed. Applied when it was written over the text on disk now; offered when not.
    let bodyText = text;
    let recoveredMode: string | null = null;
    const draft = await readDraft(nextPath);
    if (token !== ctx.openToken) return;
    if (draft) {
      if (draft.text === text) {
        void ctx.draftOp(p, () => pageFiles.drafts.drop(nextPath).catch(() => {}));
      } else {
        // Applied only when it was written over the text on disk now, and the file has not been
        // written since: a file that went back to that text later (a git checkout, a sync client
        // restoring it) is not the text the draft was typed over, so the draft is only offered.
        const at = Number(draft.at) || 0;
        const since = p.mtime > 0 && at > 0 && p.mtime > at;
        const applied = !since && (draft.baselineHash ?? null) === p.baselineHash;
        p.hasDraft = true;
        p.draftStamp = Number(draft.at) || null;
        p.recovered = {
          at: Number(draft.at) || Date.now(), text: draft.text, applied,
          baselineHash: draft.baselineHash ?? null, exact: draft.exact !== false,
          mode: draft.mode === 'source' ? 'source' : 'rich',
        };
        seenRev(Number(draft.rev));
        if (applied) {
          bodyText = draft.text;
          // It reopens in the mode it was typed in (L5). A draft that is not exactly what a save
          // would write is shown as text, whatever it was typed in.
          recoveredMode = recoveredModeOf(p, p.recovered);
        }
        log(`draft found ${nextPath}: ${applied ? 'applied' : 'offered, the file changed since'}`, 'warn');
        // An offered draft shares its slot with every draft this page will write, and the next
        // one would replace it. It goes to Versions first; until it is there, the slot is not
        // touched (`keepRecovered`).
        if (!applied) {
          await ctx.keepRecovered(p);
          if (token !== ctx.openToken) return;
        }
        const info = { path: nextPath, at: p.recovered.at, applied };
        bus.emit('doc:recovered', info);
        ctx.emit('recovered', info);
      }
    }

    p.doc = p.plain ? plainDoc(bodyText) : parseDoc(bodyText);
    p.title = p.doc.title;
    ctx.publishTitle(p);
    // X1: what the file remembers, else the machine's `editorMode`; a plain file has Source only.
    p.mode = recoveredMode || INTERNAL[await modeFor(nextPath, { plain: p.plain, outside: p.outside })] || 'block';
    p.forced = p.plain ? 'plain' : null;
    if (token !== ctx.openToken) return;

    ctx.buildDom(p, ctx.el);
    ctx.updateMeta(p, true);

    if (!await mountBody(p, bodyText, token)) return;
    // C10: what the parser could not hold is not in the rich view, and the next save would
    // delete it from the file. Such a page opens as text instead, and says why.
    if (p.crepe) {
      const check = checkOpened(p.crepe, p.doc.body);
      if (!check.ok) {
        await ctx.forceSource(p, bodyText, 'lossy-open', check.reason);
        if (p !== ctx.page) return;
      }
    }
    if (bodyText !== text) {
      // The recovered buffer is the user's and it is not on disk: dirty, but not saved behind
      // their back before they have seen the banner. Leaving saves it; so does Ctrl+S; so does
      // the first edit. A blur alone does not (onEditorBlur), or clicking Compare would write
      // the draft before the user compared it.
      p.rev = nextRev();
      if (p.recovered && p.recovered.applied) {
        p.recovered.rev = p.rev;
        // A draft that was not what a save would write (the guard's best effort): leaving
        // keeps it as a draft and never writes it until the user has looked (`unchecked`).
        if (!p.recovered.exact) p.uncheckedRev = p.rev;
      }
      ctx.setDirty(p, true);
    }

    ctx.publishState(p);
    ctx.publishMode(p);

    // The jump waits for the layout: node views have to be laid out before a block has a height
    // to scroll to, and the router puts a remembered scroll back one frame after the mount — the
    // jump must come after that, not be undone by it. `selection` is the router handing back
    // where the caret was when the page was last left (N44); a line wins over it.
    if (options.line || options.selection || options.query) {
      afterLayout(() => {
        if (p !== ctx.page) return;
        if (options.line) ctx.scrollToLine(options.line, options.col);
        else if (options.selection) ctx.restoreSelection(p, options.selection);
        ctx.openFindWith(p, options.query);
      });
    }

    void patchState({ last: nextPath });
  }

  /** The draft stored for `path`, or null. Never throws: no draft store is no draft. */
  async function readDraft(path) {
    try {
      const d = await pageFiles.drafts.read(path);
      return d && typeof d.text === 'string' ? d : null;
    } catch (e) {
      log(`draft read failed ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
      return null;
    }
  }

  /**
   * Put the body in: Crepe in block mode, CodeMirror over the whole file in Source.
   * `text` is the whole file. Answers false when the open was superseded while the editor was
   * building.
   */
  async function mountBody(p, text, token?) {
    p.ready = false;
    if (p.mode === 'source') {
      p.bodyEl.classList.add('ed-source');
      p.el.classList.add('ed-source-on');
      // The title line is inside the text now; a strip that could also edit it would be a second
      // source of truth for the same bytes. It stays as a label until the mode goes back.
      if (p.titleEl) p.titleEl.contentEditable = 'false';
      // A file the language pack knows by its name is a file of code, and opens as the small
      // editor for one: the grammar, the token colours and the comforts of a program, exactly
      // the set a standalone `codeEditor` gets (`ide()` in source.ts). A markdown page keeps its
      // own prose palette, and a `.txt` or a `.log` stays the plain text it is.
      const named = p.plain ? describe(null, p.path) : null;
      p.source = createSourceView({
        host: p.bodyEl,
        text,
        markdown: !p.plain,
        code: !!named,
        indent: named ? indentFor(named) : undefined,
        gutter: p.plain,
        // M3: the file's own line endings and byte-order mark come back out of `getText`.
        exact: true,
        readOnly: p.frozen || p.readOnly,
        onChange: () => ctx.markDirty(p),
        onEscape: () => { try { p.source.view.contentDOM.blur(); } catch { /* nothing to blur */ } },
      });
      // The pack fetches a grammar in a chunk of its own, so the file is on screen first and
      // gains its colours a moment later. Never awaited and never able to reject.
      if (named) {
        const mine = p.source;
        void loadLanguage(named).then((support) => {
          if (support && p.source === mine) mine.setLanguage(support);
        });
      }
      // The same three methods `createFind` gives the block editor, over CodeMirror's own panel:
      // the options go through, so a seeded query highlights and Ctrl+H reaches replace (QA F5).
      p.find = {
        open: (o) => { if (p.source) p.source.openFind(o || {}); },
        close: () => { if (p.source) p.source.closeFind(); },
        isOpen: () => !!(p.source && p.source.findOpen()),
        destroy: () => {},
      };
      const dom = p.source.view.contentDOM;
      const onBlur = () => ctx.onEditorBlur(p);
      dom.addEventListener('blur', onBlur);
      p.cleanups.push(() => dom.removeEventListener('blur', onBlur));
      p.ready = true;
    } else {
      // `onChange` and `on` are makeCrepe's too; its JSDoc does not list them yet.
      const crepeOpts = {
        root: p.bodyEl,
        markdown: p.doc.body,
        resolveImage: (src) => ctx.resolveImage(p, src),
        uploadImage: (file) => ctx.uploadImage(p, file),
        attachFile: (file) => ctx.attachFile(p, file),
        pagePath: () => p.path,
        onChange: () => { if (p.ready) ctx.markDirty(p); },
        // The two keys at the top edge of the body (L10, L19); source.ts holds the keymap.
        onLeaveTop: () => ctx.focusTitleEnd(p),
        onSelectAll: () => ctx.selectAllWithTitle(p),
        on: (crepeApi) => {
          crepeApi.blur(() => ctx.onEditorBlur(p));
        },
      };
      p.crepe = await makeCrepe(crepeOpts);
      if (token !== undefined && token !== ctx.openToken) { await p.crepe.destroy().catch(() => {}); return false; }
      ctx.wireDrops(p);
      // The third argument is what a replacement calls: an edit like any other (M5).
      p.find = createFind(p.el, () => (p.crepe ? editorView(p.crepe) : null), () => ctx.markDirty(p));
      // Page view: the rules where each A4 sheet ends (sheets.ts). Idle unless the layout is `pages`.
      p.cleanups.push(attachSheets(p.el, () => p.bodyEl.querySelector('.ProseMirror')));
      // Anything the editor does to the document while it is settling (the trailing plugin adds
      // an empty paragraph, node views mount) must not count as a user edit. Two frames is the
      // normal path; the timer is the fallback, because a hidden window fires no frames at all.
      const ready = () => { p.ready = true; };
      requestAnimationFrame(() => requestAnimationFrame(ready));
      setTimeout(ready, 80);
      if (p.frozen || p.readOnly) { try { p.crepe.setReadonly(true); } catch { /* not ready */ } }
    }
    ctx.wireEditorEvents(p);
    ctx.applySpellcheck(p);
    ctx.updateMeta(p, true);
    p.cleanups.push(() => { if (p.find) p.find.destroy(); p.find = null; });
    return true;
  }

  /** Tear the body down, whichever kind it is, and forget everything wired around it. */
  async function unmountBody(p) {
    clearTimeout(p.wordTimer);
    for (const fn of p.cleanups) { try { fn(); } catch (e) { console.error(e); } }
    p.cleanups.length = 0;
    if (p.crepe) { try { await p.crepe.destroy(); } catch (e) { console.error('[editor] destroy', e); } }
    if (p.source) p.source.destroy();
    p.crepe = null;
    p.source = null;
  }

  /**
   * Take the page down. A dirty page is saved first, with the view frozen so nothing typed
   * falls between the compose and the teardown (H1); when that save does not land, nothing is
   * torn down, the banner says why, and the answer is false (C1).
   */
  async function closePage({ keepAlive = false } = {}) {
    const p = ctx.page;
    if (!p) { if (!keepAlive) ctx.release(); return true; }
    clearTimeout(p.saveTimer);
    // Frozen before anything else, clean or dirty (H1): a key typed while the old editor is
    // torn down would land in a page that is already gone. Dirty is looked at after the freeze.
    ctx.freeze(p);
    const refuse = () => {
      if (p === ctx.page) { ctx.unfreeze(p); void ctx.writeDraft(p); ctx.focusBanner(p); }
      return false;
    };
    if (p.dirty && !p.trashed) {
      if (ctx.unchecked(p)) {
        if (!await ctx.leaveAsDraft(p)) return refuse();
      } else {
        let ok = false;
        try { ok = await ctx.saveDoc(p, { explicit: true, leaving: true, teardown: true }); } catch (e) { console.error('[editor] close', e); }
        if (!ok || p.dirty) return refuse();
      }
    }
    if (p !== ctx.page) return true;
    ctx.page = null;
    clearTimeout(p.saveTimer);
    clearTimeout(p.draftTimer);
    clearTimeout(p.goneTimer);
    await unmountBody(p);
    if (p.el && p.el.parentNode) p.el.remove();
    const gone = p.path;
    p.el = p.host = p.titleEl = p.metaEl = p.bodyEl = p.bannerEl = null;
    ctx.publishTitle(null);
    ctx.setStatus('doc', null);
    ctx.setStatus('save', null);
    ctx.setStatus('mode', null);
    if (keepAlive) return true;
    ctx.release();
    ctx.emit('closed', { path: gone });
    return true;
  }

  /**
   * The document shape of a file that is not markdown (`.txt`, `.csv`, `.py`, a log). Every
   * field is empty but `body`, so nothing above the body is drawn and `compose` never rewrites
   * a byte: source mode hands the file back exactly as it holds it.
   */
  function plainDoc(text): PlainDoc {
    return {
      eol: '\n', eols: null, lines: null, bom: false, endsWithNewline: /\n$/.test(String(text ?? '')),
      frontmatterRaw: '', frontmatter: null, preTitle: '', titleLine: null, title: '', gap: '',
      body: String(text ?? ''), plain: true,
    };
  }

  /**
   * One open at a time, in order: a second call waits for the first rather than racing it.
   * The queue itself never holds a rejection — an open that throws is reported and the next
   * one still runs — but the caller's promise keeps it, so a router can say what failed.
   */
  function run(nextPath, options) {
    const next = ctx.opening.catch(() => {}).then(() => open(nextPath, options));
    ctx.opening = next.catch((e) => { console.error('[editor] open', e); });
    return next;
  }

  return {
    open,
    readDraft,
    mountBody,
    unmountBody,
    closePage,
    plainDoc,
    run,
  };
}
