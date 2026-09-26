// The page editor as an instance: a markdown file rendered as a Notion-style column.
//
//   banner             sticky, only while something needs the user: not saved, changed or
//                      deleted on disk, recovered changes, opened as text (wave 1, H8)
//   properties strip   only when the file has YAML frontmatter; raw text preserved, simple
//                      `key: value` lines editable in place, everything else read-only
//   title              the file's first H1, editable; the file name when there is no H1
//   meta               word count, last save, and the Rich | Source switch (H14)
//   body               Crepe (Milkdown) over everything after the title
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
// included (instances.js is the register). A change made on disk while a page is dirty is
// merged into it line by line (H7, merge.js), and only lines both sides touched are a question.

import {
  bus, commands, status, store, bridge, navigate, defaultNewFolder,
  copyText, icon, attachmentFolder, spellcheckOn, titleSyncOn, collectCommands, onWindowLeave, repointRoute,
  fileops, names, log, pageFiles, planRewrite,
} from './host.js';
import { prompt, confirm, patchState, toast } from './deps.js';
import { instances, activeInstance, setActive, findParked, overCap, parkedPaths as parkedList } from './instances.js';
import { merge3, keepBoth } from './merge.js';
import { docWithoutPad } from './space.js';
import * as serializer from './crepe.js';
import { bindPagePath, insertPageLink } from './link.js';
import { DRAG_TYPE, dropInto, payloadOf } from './drop.js';
import { createFind } from './find.js';
import { pickHeading } from './outline.js';
import { bodyStartLine, titleLineNo, posForBodyLine } from './lines.js';
import { caretAt, scrollerOf } from './reveal.js';
import { registerExtensionCommands } from './extensions.js';
import { backlinkCount } from './backlinks.js';
import { followHref } from './linkstate.js';
import { createSourceView, rememberSource, renameRemembered, wasInSource } from './source.js';
import { describe, indentFor, loadLanguage } from './highlight.js';
import { compareTexts } from './compare.js';
import { TextSelection } from '@milkdown/kit/prose/state';
import { closeHistory } from '@milkdown/kit/prose/history';
import { parseDoc, composeDoc, countWords, frontmatterEditable, setFrontmatterValue } from './doc.js';
import * as P from './paths.js';
import './editor.css';
// The sheet: `@page` and every `@media print` rule of the app, in one file. It rides in with
// the editor's stylesheet because that is the last one the kernel serves.
import './print.css';
import './sheets.css';
import { attachSheets } from './sheets.js';
// The print commands are the only thing in the editor that reaches past `host.js`: `ose.print`
// is a hose of its own and the editor's `bridge` is a reading of `ose.files`. Two lines in
// `host.js`'s bridge map would close this door again.
import { ose } from 'ose:kernel';

const { makeCrepe, editorView } = serializer;

const SAVE_DEBOUNCE = 600;
/** A draft follows an edit this long after it, and while typing at most every DRAFT_EVERY. */
const DRAFT_DELAY = 1000;
const DRAFT_EVERY = 5000;
/** A file that vanished is looked for again after this long before the page says it is gone (C7). */
const GONE_RECHECK = 1000;
/** The longest wait between two tries of a save the host refused, in seconds. */
const RETRY_MAX = 30;
/**
 * A write whose rename kept failing leaves the text in a visible `<stem>.unsaved-<stamp>` file
 * beside the note, one per try. After this many, only a deliberate save tries again.
 */
const KEPT_COPIES_MAX = 3;
/** A file still carrying the name `newPage` gave it: the first real title renames it (C12). */
const UNTITLED = /^Untitled( \d+)?$/i;

/**
 * The edit counter. It is one clock for every page and every open, started at the time the
 * bundle loaded, so a later edit always has a higher number than any draft an earlier session
 * or an earlier open left behind: `drafts.drop(path, {ifRev})` then never keeps a stale one.
 */
let revClock = Date.now();

/** A change made on disk and merged into a dirty page is announced for this long (H7). */
const MERGE_NOTE_MS = 8000;

// Every live page, on screen or parked, and the one the commands act on (the focused one, or
// the last mounted) are instances.js's register.
const activeInst = () => activeInstance();
const activeApi = () => (activeInstance() ? activeInstance().api : null);

/** `path` is `from`, or a page inside the folder `from`. */
const covers = (path, from) => !!path && !!from && (path === from || path.startsWith(from + '/'));
/** `path` under `from` moved to `to`. */
const mapPath = (path, from, to) => (path === from ? to : to + path.slice(from.length));
const errText = (e) => String((e && e.message) || e || 'unknown error').split('\n')[0];
const errCode = (e) => (e && e.code) || 'io';

// ---------------------------------------------------------------------------
// the serializer's two checks (docs/KERNEL.md `ose:editor`, "Writing")
//
// `readMarkdownChecked` and `openCheck` are crepe.js's, and neither throws; the try blocks here
// only make sure that a bug in them can never read as a clean write or a clean open.

/** @returns {{status:'ok'|'fellBack'|'unsafe', text:string|null, reason?:string}} */
function checkedBody(crepe, original) {
  try {
    return serializer.readMarkdownChecked(crepe, original);
  } catch (e) {
    return { status: 'unsafe', text: null, reason: `serialising failed: ${errText(e)}` };
  }
}

/** @returns {{ok:true} | {ok:false, reason:string}} */
function checkOpened(crepe, body) {
  try { return serializer.openCheck(crepe, body) || { ok: false, reason: 'the check gave no answer' }; } catch (e) {
    return { ok: false, reason: `the check failed: ${errText(e)}` };
  }
}

// ---------------------------------------------------------------------------
// the instance

const blankPage = () => ({
  path: '', doc: null, title: '',
  // baseline: the text on disk this page was opened from or last wrote; baselineHash: the
  // host's hash of it, which every save carries (M2). Null when the file did not exist.
  baseline: '', baselineHash: null,
  el: null, host: null, titleEl: null, metaEl: null, metaText: null, modeEl: null, bannerEl: null,
  bodyEl: null, crepe: null, find: null,
  // Batch 12 (P5). mode: 'block' (Crepe) or 'source' (the whole file in CodeMirror); the public
  // words are 'rich' and 'source'. plain: a text file that is not markdown — source mode is its
  // only mode and composeDoc is never applied to it. forced: why the page is in source when the
  // user did not ask for it ('plain', 'unsafe', 'lossy-open'); a forced mode is never
  // remembered. words/wordTimer: the meta line's count, taken from the ProseMirror document and
  // debounced with the save rather than serialised per key.
  mode: 'block', plain: false, forced: null, source: null, words: 0, chars: 0, mtime: 0, wordTimer: 0,
  titleSelected: false, dirty: false, ready: false,
  // rev: the edit clock at the last edit, so a write can tell whether the document moved on
  // under it. frozen: every input path is read-only while a leave, a mode switch or a path
  // change composes the page (H1). problem: `{status:'not-saved'|'conflict', reason, message}`,
  // what stands between the buffer and the disk; deleted: the file left the disk under the page
  // (C7), which stays editable; trashed: the page's own file went to the trash through
  // `ose.fileops` and the caller is navigating away. moving: a rename, move or trash in flight.
  rev: 0, frozen: false, problem: null, deleted: false, trashed: false, moving: null, movingDone: null,
  asking: false, titleToBody: false, readOnly: false,
  // Drafts (C4). draft: 'written' | 'failed' | null, what the last try did; hasDraft: one may be
  // stored for this path; recovered: the draft found at open, `{at, text, applied, kept, …}`.
  // draftChain: the draft writes and drops of this page, one after the other, so a drop issued
  // after a write runs after it. uncheckedRev: the edit at which text the user has not checked
  // yet went on screen (a guard refusal, an inexact draft); while `rev` is still that, the page
  // is let go as a draft, never written. reloadPending: "Reload from disk" was chosen while
  // the page could not be rebuilt at once; the next `stay` or path change rebuilds it.
  draft: null, hasDraft: false, draftAt: 0, draftTimer: 0, draftChain: null, recovered: null, notice: null,
  uncheckedRev: -1, reloadPending: false, orphan: null,
  // keptCopies: write failures that left a `<stem>.unsaved-<stamp>` copy beside the file;
  // failedAt: when the last write failed. A copy stops the timed retries (see `saveFailed`).
  keptCopies: 0, failedAt: 0,
  saveTimer: 0, goneTimer: 0, retry: 0, savedAt: null, savedAtMs: null, saving: null, switching: null,
  lastState: '', lastSave: '', lastBanner: '',
  // Wave 2 (H7). applying: a text from outside (the disk, a merge) is going into the editor,
  // and the change it makes is not the user's. conflict: the disk moved on under a dirty page
  // and the two could not be merged, `{theirs, hash, count, base}`; merged: the last clean merge,
  // `{ours, theirs, text, at}`, what Undo merge and Show changes work from; mergeNote: the timer
  // of the banner that says a merge happened. bindParent: moves the blank-click listener to the
  // element the column is in now (M12).
  applying: false, conflict: null, merged: null, mergeNote: 0, bindParent: null,
  cleanups: [],
});

/**
 * Mount the file at `path` into `el` and answer the handle (docs/KERNEL.md `ose:editor`).
 * The handle comes back at once; `handle.ready` is the open in flight.
 *
 * `opts.line` (1-based, a line of the file as the search overlay counts them) puts the caret in
 * the block that holds that line once the editor is up (C7); `opts.selection` is a `{from,to}`
 * a router remembered; `opts.query` seeds the find bar.
 *
 * Wave 2 (M12, M24): when an instance of `path` is parked (`handle.park()`, a tab gone to the
 * background), that instance is put back into `el` instead — the same buffer, undo history and
 * mode, its caret and scroll — and the same handle is answered.
 */
export function markdownPage(el, path, opts = {}) {
  const again = findParked(P.normalize(String(path ?? '')));
  if (again) { again.reattach(el, opts); return again.handle; }
  return buildPage(el, path, opts);
}

function buildPage(el, path, opts) {
  /** @type {null | ReturnType<typeof blankPage>} */
  let page = null;
  let openToken = 0;
  let opening = Promise.resolve();
  let closed = false;
  /** The leave in flight: a second `canLeave` awaits the same save. */
  let leaving = null;
  // Parking (M12): the column is out of the document, in `el`, which is then a holder of the
  // instance's own. `parkScroll` and `parkFocus` are how it was left.
  let parked = false;
  let parkScroll = 0;
  let parkFocus = false;

  const listeners = new Map();
  const inst = {
    get el() { return el; },
    api: null,
    handle: null,
    get parked() { return parked; },
    usedAt: Date.now(),
    /** Parked, clean, and nothing standing between the buffer and the disk: may be let go. */
    evictable: () => parked && !closed && (!page || (!page.dirty && !page.problem && !page.deleted && !page.saving && !page.hasDraft)),
    reattach: (host, o) => reattach(host, o),
    rewriteLinks: (target, pairs, o) => rewriteLinks(target, pairs, o),
    path: () => (page ? page.path : null),
    isDirty: () => !!(page && page.dirty),
    titleEl: () => (page ? page.titleEl : null),
    onFsChange: (payload) => onFsChange(payload),
    applySpellcheck: () => { if (page) applySpellcheck(page); },
    save: (o) => saveNow(o),
    stay: () => stay(),
    leaveWindow: () => leaveWindow(),
    writeDraft: () => (page && page.dirty ? writeDraft(page) : Promise.resolve()),
    covers: (from) => !!(page && covers(page.path, from)),
    /**
     * The page holds `target`: its path, or where a rename or a move in flight is taking it
     * (the kernel may rewrite the moved files' links before `afterPathChange` re-points them).
     */
    holds: (target) => !!(page && (page.path === target
      || (page.moving && page.moving.to && covers(page.path, page.moving.from)
        && mapPath(page.path, page.moving.from, page.moving.to) === target))),
    beforePathChange: (change) => beforePathChange(change),
    afterPathChange: (change) => afterPathChange(change),
  };

  const isActive = () => activeInstance() === inst;
  /** The shell's status bar belongs to one page at a time: the focused one (K1c). */
  const setStatus = (field, value) => { if (isActive()) status.set(field, value); };

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[editor:${event}]`, e); }
    }
  }

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => { listeners.get(event)?.delete(fn); };
  }

  // -------------------------------------------------------------------------
  // open and close

  async function open(nextPath, options = {}) {
    if (closed) return;
    if (options.line && page && page.path === nextPath && (page.crepe || page.source) && page.el && page.el.parentNode === el) {
      scrollToLine(options.line, options.col);
      openFindWith(page, options.query);
      return;
    }
    const token = ++openToken;
    // A page that cannot be saved is not replaced: it stays, with its banner (C1).
    if (!await closePage({ keepAlive: true })) return;
    if (token !== openToken) return;

    const p = blankPage();
    p.path = nextPath;
    page = p;
    // A parked instance reopening itself (a reload from disk in the background) does not take
    // the status bar from the page on screen.
    if (!parked) take();

    let file;
    try {
      file = await pageFiles.readFile(nextPath);
      if (!file || typeof file.text !== 'string') throw Object.assign(new Error('the host answered no text'), { code: 'io' });
    } catch (e) {
      if (token !== openToken) return;
      page = null;
      el.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `cannot open ${nextPath}: ${errText(e)}`;
      el.append(empty);
      log(`open failed ${nextPath}: ${errCode(e)} ${errText(e)}`, 'warn');
      setStatus('doc', null);
      setStatus('save', null);
      setStatus('mode', null);
      return;
    }
    if (token !== openToken) return;
    const text = file.text;

    // A file that is not markdown is never parsed as one (batch 12): it opens in source mode,
    // with no title strip, and what is written back is exactly what CodeMirror holds.
    p.plain = !P.isMarkdown(nextPath);
    p.baseline = text;
    p.baselineHash = file.hash ?? null;
    p.mtime = Number(file.mtime) || 0;

    // A draft this machine kept of the page (C4, §6.6): a crash, a forced quit, a save that
    // failed. Applied when it was written over the text on disk now; offered when not.
    let bodyText = text;
    let recoveredMode = null;
    const draft = await readDraft(nextPath);
    if (token !== openToken) return;
    if (draft) {
      if (draft.text === text) {
        void draftOp(p, () => pageFiles.drafts.drop(nextPath).catch(() => {}));
      } else {
        // Applied only when it was written over the text on disk now, and the file has not been
        // written since: a file that went back to that text later (a git checkout, a sync client
        // restoring it) is not the text the draft was typed over, so the draft is only offered.
        const at = Number(draft.at) || 0;
        const since = p.mtime > 0 && at > 0 && p.mtime > at;
        const applied = !since && (draft.baselineHash ?? null) === p.baselineHash;
        p.hasDraft = true;
        p.recovered = {
          at: Number(draft.at) || Date.now(), text: draft.text, applied,
          baselineHash: draft.baselineHash ?? null, exact: draft.exact !== false,
          mode: draft.mode === 'source' ? 'source' : 'rich',
        };
        if (Number(draft.rev) > revClock) revClock = Number(draft.rev);
        if (applied) {
          bodyText = draft.text;
          recoveredMode = !p.plain && p.recovered.exact && p.recovered.mode === 'rich' ? 'block' : 'source';
        }
        log(`draft found ${nextPath}: ${applied ? 'applied' : 'offered, the file changed since'}`, 'warn');
        // An offered draft shares its slot with every draft this page will write, and the next
        // one would replace it. It goes to Versions first; until it is there, the slot is not
        // touched (`keepRecovered`).
        if (!applied) {
          await keepRecovered(p);
          if (token !== openToken) return;
        }
        const info = { path: nextPath, at: p.recovered.at, applied };
        bus.emit('doc:recovered', info);
        emit('recovered', info);
      }
    }

    p.doc = p.plain ? plainDoc(bodyText) : parseDoc(bodyText);
    p.title = p.doc.title;
    publishTitle(p);
    p.mode = recoveredMode || (p.plain || (await wasInSource(nextPath)) ? 'source' : 'block');
    p.forced = p.plain ? 'plain' : null;
    if (token !== openToken) return;

    buildDom(p, el);
    updateMeta(p, true);

    if (!await mountBody(p, bodyText, token)) return;
    // C10: what the parser could not hold is not in the rich view, and the next save would
    // delete it from the file. Such a page opens as text instead, and says why.
    if (p.crepe) {
      const check = checkOpened(p.crepe, p.doc.body);
      if (!check.ok) {
        await forceSource(p, bodyText, 'lossy-open', check.reason);
        if (p !== page) return;
      }
    }
    if (bodyText !== text) {
      // The recovered buffer is the user's and it is not on disk: dirty, but not saved behind
      // their back before they have seen the banner. Leaving saves it; so does Ctrl+S; so does
      // the first edit. A blur alone does not (onEditorBlur), or clicking Compare would write
      // the draft before the user compared it.
      p.rev = ++revClock;
      if (p.recovered && p.recovered.applied) {
        p.recovered.rev = p.rev;
        // A draft that was not what a save would write (the guard's best effort): leaving
        // keeps it as a draft and never writes it until the user has looked (`unchecked`).
        if (!p.recovered.exact) p.uncheckedRev = p.rev;
      }
      setDirty(p, true);
    }

    publishState(p);
    publishMode(p);

    // The jump waits for the layout: node views have to be laid out before a block has a height
    // to scroll to, and the router puts a remembered scroll back one frame after the mount — the
    // jump must come after that, not be undone by it. `selection` is the router handing back
    // where the caret was when the page was last left (N44); a line wins over it.
    if (options.line || options.selection || options.query) {
      afterLayout(() => {
        if (p !== page) return;
        if (options.line) scrollToLine(options.line, options.col);
        else if (options.selection) restoreSelection(p, options.selection);
        openFindWith(p, options.query);
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
      if (errCode(e) !== 'unknown_command') log(`draft read failed ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
      return null;
    }
  }

  /**
   * Put the body in: Crepe in block mode, CodeMirror over the whole file in source mode. `text`
   * is the whole file. Answers false when the open was superseded while the editor was building.
   */
  async function mountBody(p, text, token) {
    p.ready = false;
    if (p.mode === 'source') {
      p.bodyEl.classList.add('ed-source');
      p.el.classList.add('ed-source-on');
      // The title line is inside the text now; a strip that could also edit it would be a second
      // source of truth for the same bytes. It stays as a label until the mode goes back.
      if (p.titleEl) p.titleEl.contentEditable = 'false';
      // A file the language pack knows by its name is a file of code, and opens as the small
      // editor for one: the grammar, the token colours and the comforts of a program, exactly
      // the set a standalone `codeEditor` gets (`ide()` in source.js). A markdown page keeps its
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
        readOnly: p.frozen,
        onChange: () => markDirty(p),
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
      const onBlur = () => onEditorBlur(p);
      dom.addEventListener('blur', onBlur);
      p.cleanups.push(() => dom.removeEventListener('blur', onBlur));
      p.ready = true;
    } else {
      p.crepe = await makeCrepe({
        root: p.bodyEl,
        markdown: p.doc.body,
        resolveImage: (src) => resolveImage(p, src),
        uploadImage: (file) => uploadImage(p, file),
        attachFile: (file) => attachFile(p, file),
        pagePath: () => p.path,
        onChange: () => { if (p.ready) markDirty(p); },
        // The two keys at the top edge of the body (L10, L19); source.js holds the keymap.
        onLeaveTop: () => focusTitleEnd(p),
        onSelectAll: () => selectAllWithTitle(p),
        on: (crepeApi) => {
          crepeApi.blur(() => onEditorBlur(p));
        },
      });
      if (token !== undefined && token !== openToken) { await p.crepe.destroy().catch(() => {}); return false; }
      wireDrops(p);
      // The third argument is what a replacement calls: an edit like any other (M5).
      p.find = createFind(p.el, () => (p.crepe ? editorView(p.crepe) : null), () => markDirty(p));
      // Page view: the rules where each A4 sheet ends (sheets.js). Idle unless the layout is `pages`.
      p.cleanups.push(attachSheets(p.el, () => p.bodyEl.querySelector('.ProseMirror')));
      // Anything the editor does to the document while it is settling (the trailing plugin adds
      // an empty paragraph, node views mount) must not count as a user edit. Two frames is the
      // normal path; the timer is the fallback, because a hidden window fires no frames at all.
      const ready = () => { p.ready = true; };
      requestAnimationFrame(() => requestAnimationFrame(ready));
      setTimeout(ready, 80);
      if (p.frozen) { try { p.crepe.setReadonly(true); } catch { /* not ready */ } }
    }
    wireEditorEvents(p);
    applySpellcheck(p);
    updateMeta(p, true);
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
    const p = page;
    if (!p) { if (!keepAlive) release(); return true; }
    clearTimeout(p.saveTimer);
    // Frozen before anything else, clean or dirty (H1): a key typed while the old editor is
    // torn down would land in a page that is already gone. Dirty is looked at after the freeze.
    freeze(p);
    const refuse = () => {
      if (p === page) { unfreeze(p); void writeDraft(p); focusBanner(p); }
      return false;
    };
    if (p.dirty && !p.trashed) {
      if (unchecked(p)) {
        if (!await leaveAsDraft(p)) return refuse();
      } else {
        let ok = false;
        try { ok = await saveDoc(p, { explicit: true, leaving: true, teardown: true }); } catch (e) { console.error('[editor] close', e); }
        if (!ok || p.dirty) return refuse();
      }
    }
    if (p !== page) return true;
    page = null;
    clearTimeout(p.saveTimer);
    clearTimeout(p.draftTimer);
    clearTimeout(p.goneTimer);
    await unmountBody(p);
    if (p.el && p.el.parentNode) p.el.remove();
    const gone = p.path;
    p.el = p.host = p.titleEl = p.metaEl = p.bodyEl = p.bannerEl = null;
    publishTitle(null);
    setStatus('doc', null);
    setStatus('save', null);
    setStatus('mode', null);
    if (keepAlive) return true;
    release();
    emit('closed', { path: gone });
    return true;
  }

  /**
   * The document shape of a file that is not markdown (`.txt`, `.csv`, `.py`, a log). Every
   * field is empty but `body`, so nothing above the body is drawn and `compose` never rewrites
   * a byte: source mode hands the file back exactly as it holds it.
   */
  function plainDoc(text) {
    return {
      eol: '\n', eols: null, lines: null, bom: false, endsWithNewline: /\n$/.test(String(text ?? '')),
      frontmatterRaw: '', frontmatter: null, preTitle: '', titleLine: null, title: '', gap: '',
      body: String(text ?? ''), plain: true,
    };
  }

  // -------------------------------------------------------------------------
  // rich and source (H14)

  /** Ctrl+E: the other mode. */
  function toggleSource() {
    const p = page;
    if (!p || (!p.crepe && !p.source)) return Promise.resolve(false);
    return setMode(p.source ? 'rich' : 'source');
  }

  /**
   * Show the page in `want` ('rich' or 'source'). The buffer, not the file, crosses over, and
   * nothing is written: the dirty flag and the baseline are untouched.
   *
   * Rich → Source never refuses (H14). A clean page shows the disk text itself; a dirty one
   * the text a save would write, or when the guard says that text is not safe, its best effort
   * — the page stays dirty and the user checks it there. Source → Rich parses the text and asks
   * the open check; when the rich view cannot hold all of it, the page stays in source and the
   * banner says why. The undo history of the editor being left does not survive.
   *
   * `o.text` puts that text in instead of the buffer's (a recovered draft); `o.forced` is the
   * reason the mode was not the user's choice, and a forced mode is never remembered.
   */
  async function setMode(want, o = {}) {
    const p = page;
    if (!p || (!p.crepe && !p.source)) return false;
    if (p.plain && want !== 'source') {
      toast(`${P.basename(p.path)} is not markdown: source is its only mode`, 'info');
      return false;
    }
    const now = p.source ? 'source' : 'rich';
    if (want === now && typeof o.text !== 'string') return true;
    if (p.switching) { await p.switching; return setMode(want, o); }
    let done;
    p.switching = new Promise((r) => { done = r; });
    try {
      return await switchTo(p, want, o);
    } finally {
      p.switching = null;
      done();
    }
  }

  async function switchTo(p, want, o) {
    const host = p.el ? p.el.parentNode : null;
    if (!host) return false;
    // H1: nothing typed may land between the compose and the teardown.
    const wasFrozen = p.frozen;
    freeze(p);
    let text;
    let exact = true;
    if (typeof o.text === 'string') text = o.text;
    else if (p.source) text = p.source.getText();
    else if (!p.dirty) text = p.baseline;
    else {
      const r = composeChecked(p);
      text = r.text ?? bestEffort(p);
      exact = r.status !== 'unsafe';
      if (r.status === 'unsafe') log(`guard unsafe ${p.path}: ${r.reason}`, 'warn');
    }
    const scroller = scrollerOf(host);
    const top = scroller ? scroller.scrollTop : 0;

    // Between the teardown and the new mount the buffer lives only in `text`: it goes to a draft
    // first, so a mount that throws cannot take it with it. Text handed in (`o.text`, a recovered
    // draft) is not the buffer and is already kept: its caller writes the draft over its own hash.
    if (p.dirty && typeof o.text !== 'string') await writeDraftText(p, text, exact && !unchecked(p));
    if (p !== page) return false;

    let refused = null;
    try {
      await remount(p, want === 'source' ? 'source' : 'block', text);
      if (p !== page) return false;
      if (p.crepe) {
        const check = checkOpened(p.crepe, p.doc.body);
        if (!check.ok) {
          refused = check.reason;
          await remount(p, 'source', text);
          if (p !== page) return false;
        }
      }
    } catch (e) {
      if (p !== page) return false;
      console.error('[editor] mode switch', e);
      log(`mode switch failed ${p.path}: ${errText(e)}`, 'error');
      refused = `the editor could not be built: ${errText(e)}`;
      if (!await mountFallback(p, text)) {
        if (!wasFrozen) unfreeze(p);
        publishState(p);
        return false;
      }
    }
    if (scroller) scroller.scrollTop = top;
    if (!wasFrozen) unfreeze(p);

    if (refused) {
      p.notice = `Staying in source: the rich view cannot show part of this page (${refused}).`;
      log(`source to rich refused ${p.path}: ${refused}`, 'warn');
      publishState(p);
      publishMode(p);
      return false;
    }
    p.forced = o.forced || (p.plain ? 'plain' : null);
    if (!p.forced) {
      p.notice = null;
      void rememberSource(p.path, p.mode === 'source');
    }
    publishState(p);
    publishMode(p);
    if (!o.quiet) {
      if (p.source) p.source.focus(); else focusBody();
    }
    return true;
  }

  /**
   * A mount that threw: the text again in source mode, which parses nothing and cannot fail on
   * it. When even that throws, the text stays on the page (`orphan`), where the draft, Copy
   * text and Save as still find it. True when the source view is up.
   */
  async function mountFallback(p, text) {
    try {
      await remount(p, 'source', text);
      if (p === page && p.source) { p.orphan = null; return true; }
    } catch (e) {
      console.error('[editor] source fallback', e);
    }
    if (p !== page) return false;
    p.orphan = text;
    p.notice = 'The editor could not be built. Copy your text, or save it as a new file.';
    return false;
  }

  /** Unmount the body and mount `text` in `mode`; the column is rebuilt, the flags are kept. */
  async function remount(p, mode, text) {
    const host = p.el ? p.el.parentNode : el;
    await unmountBody(p);
    if (p !== page) return false;
    p.orphan = null;
    p.mode = mode;
    p.doc = p.plain ? plainDoc(text) : parseDoc(text);
    p.title = p.doc.title;
    publishTitle(p);
    p.titleSelected = false;
    buildDom(p, host);
    return mountBody(p, text);
  }

  /**
   * Open the page as text, whatever it was: `lossy-open` at open (C10) and `unsafe` after a
   * guard refusal (§7.1). The buffer keeps its dirty flag; the mode is not remembered.
   */
  async function forceSource(p, text, forced, reason) {
    const wasFrozen = p.frozen;
    freeze(p);
    await remount(p, 'source', text);
    if (p !== page) return;
    if (!wasFrozen) unfreeze(p);
    p.forced = forced;
    p.notice = forced === 'lossy-open'
      ? `Opened as text: the rich view cannot show part of this page (${reason}).`
      : 'The rich view could not write this page exactly. It is open as text: check it and save.';
    log(`opened as text ${p.path} (${forced}): ${reason}`, 'warn');
    publishState(p);
    publishMode(p);
  }

  /** The words the status bar and the handle use for the mode. */
  const publicMode = (p) => (p && p.mode === 'source' ? 'source' : 'rich');

  /** The mode, to the bus, the handle, the status bar and the switch in the meta line. */
  function publishMode(p) {
    if (!p) return;
    const mode = publicMode(p);
    const info = { path: p.path, mode, forced: p.forced || null };
    bus.emit('doc:mode', info);
    emit('mode', info);
    paintMode(p);
  }

  function paintMode(p) {
    if (!p) return;
    const mode = publicMode(p);
    if (p.plain) setStatus('mode', { text: 'Text' });
    else setStatus('mode', { text: mode === 'source' ? 'Source' : 'Rich', onClick: () => { void toggleSource(); } });
    if (p.modeEl) {
      for (const b of p.modeEl.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }
  }

  /**
   * Put the caret in the block holding file line `line` (1-based) and bring it into view. A
   * line above the body — frontmatter, the title — scrolls to the top, with the caret in the
   * title when the line is the title's. True when there was a page to scroll.
   */
  function scrollToLine(line, col) {
    const p = page;
    const n = Math.floor(Number(line) || 0);
    if (!p || !p.el || n < 1) return false;
    // Source mode counts the same lines the search overlay counts: the file's own.
    if (p.source) { p.source.goToLine(n, col); return true; }
    if (!p.crepe) return false;
    const view = editorView(p.crepe);
    if (!view) return false;
    const start = bodyStartLine(p.doc);
    if (n < start) {
      const scroller = scrollerOf(p.el);
      if (scroller) scroller.scrollTop = 0;
      if (n === titleLineNo(p.doc)) focusTitle(p);
      return true;
    }
    const pos = posForBodyLine(p.crepe, view, p.doc.body, n - start + 1, col);
    caretAt(view, pos, { block: 'start', always: true, focus: true });
    return true;
  }

  /**
   * The find bar, seeded with the term a search hit was found by (N36). Silent when there is no
   * term; loud in the console when there is one and no bar to put it in.
   */
  function openFindWith(p, query) {
    if (!query) return;
    if (p && p.find && typeof p.find.open === 'function') { p.find.open({ query }); return; }
    console.warn('[editor] no find bar to seed with', query);
  }

  /**
   * Put a `{from, to}` the router remembered back on the document (N44). `caretAt` does the
   * dispatch itself, and `always` makes it scroll even when the position is already on screen.
   */
  function restoreSelection(p, sel) {
    const view = p && p.crepe ? editorView(p.crepe) : null;
    if (!view || !sel) return;
    const size = view.state.doc.content.size;
    const from = Math.max(0, Math.min(Math.floor(Number(sel.from) || 0), size));
    caretAt(view, from, { block: 'center', always: true, focus: true });
  }

  /** Where the caret is, for the router to hand back at the next open (N44, P7). */
  function currentSelection() {
    const view = page && page.crepe ? editorView(page.crepe) : null;
    return view ? { from: view.state.selection.from, to: view.state.selection.to } : null;
  }

  /** The top of the page, caret at the start of the title (when the file has one). */
  function focusTitle(p) {
    const scroller = scrollerOf(p.el);
    if (scroller) scroller.scrollTop = 0;
    if (!p.titleEl) return;
    p.titleEl.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(p.titleEl);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }

  /**
   * Flush now. `explicit` is a user gesture (Ctrl+S, leaving the page): it asks the
   * changed-on-disk question. `closing` means the window is about to go, so the question cannot
   * be awaited: it is shown and the save answers false. Answers true only when the disk holds
   * the buffer afterwards (§6.2).
   */
  async function saveNow(o = {}) {
    if (!page) return true;
    clearTimeout(page.saveTimer);
    return saveDoc(page, o);
  }

  // -------------------------------------------------------------------------
  // leaving (C1, C5)

  /**
   * May the page be left? A clean page freezes and says yes; a dirty one is saved first, and
   * a conflict question may be awaited here. When the save does not land the page stays
   * editable, the banner says why and takes the focus, and the answer is no. Re-entrant: a
   * second call while one is in flight awaits the same answer. `stay()` undoes the freeze of a
   * yes the caller did not use.
   */
  function canLeave() {
    if (leaving) return leaving;
    const p = page;
    if (!p) return Promise.resolve(true);
    leaving = (async () => {
      try {
        freeze(p);
        if (!p.dirty || p.trashed) return true;
        if (unchecked(p) && await leaveAsDraft(p)) return true;
        let ok = false;
        if (!unchecked(p)) {
          try { ok = await saveNow({ explicit: true, leaving: true, teardown: true }); } catch (e) { console.error('[editor] leave', e); }
        }
        if (ok && !p.dirty) return true;
        if (p === page) { unfreeze(p); void writeDraft(p); focusBanner(p); }
        return false;
      } finally {
        leaving = null;
      }
    })();
    return leaving;
  }

  /**
   * The window is going (closed, reloaded, switched to another vault). The same as `canLeave`,
   * except that a question cannot be awaited into a window on its way out: it is shown, and
   * the answer is no. A yes stays frozen until the kernel says the window stays after all.
   */
  async function leaveWindow() {
    const p = page;
    if (!p) return true;
    freeze(p);
    if (!p.dirty || p.trashed) return true;
    if (unchecked(p) && await leaveAsDraft(p)) return true;
    let ok = false;
    if (!unchecked(p)) {
      try { ok = await saveNow({ explicit: true, closing: true }); } catch (e) { console.error('[editor] leave window', e); }
    }
    if (ok && !p.dirty) return true;
    if (p === page) { unfreeze(p); void writeDraft(p); focusBanner(p); }
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
    await writeDraft(p);
    await (p.draftChain || Promise.resolve());
    if (p.draft === 'written') log(`left as a draft ${p.path}: not checked yet`, 'warn');
    return p.draft === 'written';
  }

  /**
   * The leave did not happen after all (`stay`, `window:stay`). A page that took "Reload from
   * disk" while it could not be rebuilt is rebuilt now, from the disk.
   */
  function stay() {
    const p = page;
    if (!p) return;
    unfreeze(p);
    if (p.reloadPending) { p.reloadPending = false; void reopenInPlace(p); }
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
    // In source mode the title strip stays a label: the text below is where the title is edited.
    if (p.titleEl && p.titleEl.tagName === 'H1') p.titleEl.contentEditable = on && !p.source ? 'plaintext-only' : 'false';
    for (const v of (p.el ? p.el.querySelectorAll('.ed-prop-val.editable') : [])) v.contentEditable = on ? 'plaintext-only' : 'false';
    if (p.el) p.el.classList.toggle('ed-frozen', !on);
  }

  // -------------------------------------------------------------------------
  // path changes (C6): the kernel's file operations ask the page first

  /**
   * Before a rename, move, trash or copy of `change.from` (a file, or a folder above the page).
   * The page is flushed with the view frozen; a flush that does not land refuses the change,
   * and nothing on disk is touched. A copy only flushes. Afterwards, saves wait for
   * `afterPathChange` (`moving`), so nothing is written to a name that is going away.
   */
  async function beforePathChange(change) {
    const p = page;
    if (!p || !change || !covers(p.path, change.from)) return { ok: true };
    const refuse = () => {
      if (p === page) { void writeDraft(p); focusBanner(p); }
      return { ok: false, reason: `${P.basename(p.path)} has unsaved changes that could not be saved` };
    };
    // Text nobody has checked yet is not written for a path change (see `unchecked`). A copy
    // takes the file as it is on disk and a rename carries the draft along (the host re-keys
    // it); a trash would throw the buffer away with the page, so it waits for a save.
    if (unchecked(p)) {
      if (change.kind === 'trash') {
        if (p === page) focusBanner(p);
        return { ok: false, reason: `${P.basename(p.path)} has changes to check and save first` };
      }
      if (!await leaveAsDraft(p)) return refuse();
      if (change.kind === 'copy') return { ok: true };
    }
    const flush = () => saveNow({ explicit: true, leaving: true, pathChange: true });
    if (change.kind === 'copy') {
      if (!p.dirty) return { ok: true };
      let ok = false;
      try { ok = await flush(); } catch { ok = false; }
      if (!(ok && !p.dirty)) return refuse();
      // "Reload from disk" was the answer: the copy takes the disk, and so does the page.
      if (p.reloadPending) { p.reloadPending = false; void reopenInPlace(p); }
      return { ok: true };
    }
    freeze(p);
    if (p.dirty && !unchecked(p)) {
      let ok = false;
      try { ok = await flush(); } catch { ok = false; }
      if (!ok || p.dirty) { unfreeze(p); return refuse(); }
    }
    let done;
    p.movingDone = new Promise((r) => { done = r; });
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
   * router was already re-pointed by the kernel). A trash leaves the page clean for the caller.
   */
  async function afterPathChange(change) {
    const p = page;
    if (!p || !p.moving || !change || p.moving.from !== change.from) return;
    const m = p.moving;
    p.moving = null;
    const settle = () => { try { m.done(); } catch { /* nothing waits */ } p.movingDone = null; };
    // "Reload from disk" was chosen in `beforePathChange`: the buffer on screen is not the
    // user's any more. Once the path is settled the page is rebuilt from the disk, where it is.
    const reload = () => {
      if (!p.reloadPending) return;
      p.reloadPending = false;
      if (p === page && !p.dirty) void reopenInPlace(p);
    };
    if (!change.ok) { unfreeze(p); settle(); publishState(p); reload(); return; }
    if (change.kind === 'trash') {
      p.reloadPending = false;
      p.trashed = true;
      clearTimeout(p.saveTimer);
      setDirty(p, false);
      void dropDraft(p);
      settle();
      publishState(p);
      // A parked page of a trashed file has no tab to come back to: it goes now, not when the
      // cap reaches it.
      if (parked) void letGo();
      return;
    }
    if (change.to && (change.kind === 'rename' || change.kind === 'move')) {
      const from = p.path;
      const to = mapPath(p.path, change.from, change.to);
      const kindChanged = P.isMarkdown(from) !== P.isMarkdown(to);
      p.path = to;
      void renameRemembered(from, to);
      publishTitle(p);
      updateMeta(p);
      unfreeze(p);
      settle();
      publishState(p);
      // A page that stopped (or started) being markdown is shown by a different editor. It was
      // saved in `beforePathChange`, so a remount loses nothing.
      // A parked one is simply let go: the next open builds the right editor.
      if (kindChanged && !p.dirty) {
        p.reloadPending = false;
        if (parked) void letGo();
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

  // -------------------------------------------------------------------------
  // DOM

  function buildDom(p, host) {
    host.innerHTML = '';
    const col = document.createElement('div');
    col.className = 'page-col ed';
    p.el = col;
    p.host = col;

    // The banner's place is the top of the column, drawn by `renderBanner` when there is
    // something to say (§6.5).
    const banner = document.createElement('div');
    banner.className = 'ed-banner';
    banner.hidden = true;
    p.bannerEl = banner;
    p.lastBanner = '';
    col.append(banner);

    if (p.doc.frontmatterRaw) col.append(propertiesStrip(p));

    // A file that is not markdown has no title of any kind: the meta line names it.
    p.titleEl = null;
    if (p.plain) {
      // nothing above the body
    } else if (p.doc.titleLine !== null) {
      col.append(makeTitleEl(p, p.doc.title));
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'page-title untitled';
      wrap.textContent = P.stem(p.path);
      const add = document.createElement('button');
      add.className = 'ed-add-title';
      add.type = 'button';
      add.textContent = 'add title';
      add.title = 'Insert a level-1 heading at the top of the file';
      add.addEventListener('click', () => addTitle(p));
      wrap.append(add);
      col.append(wrap);
    }

    const meta = document.createElement('div');
    meta.className = 'page-meta';
    const metaText = document.createElement('span');
    metaText.className = 'ed-meta-text';
    meta.append(metaText);
    p.metaEl = meta;
    p.metaText = metaText;
    p.modeEl = null;
    // H14: which view this is, on screen. Two buttons, one pressed; Tab reaches them and they
    // run the same commands the palette lists (`page.view-rich`, `page.view-source`).
    if (!p.plain) {
      const sw = document.createElement('span');
      sw.className = 'ed-mode';
      sw.setAttribute('role', 'group');
      sw.setAttribute('aria-label', 'View');
      for (const [mode, label, title] of [
        ['rich', 'Rich', 'Show rich view'],
        ['source', 'Source', 'Show source (raw markdown text)'],
      ]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ed-mode-btn';
        b.dataset.mode = mode;
        b.textContent = label;
        b.title = title;
        b.setAttribute('aria-pressed', String(publicMode(p) === mode));
        b.addEventListener('click', () => { void setMode(mode); });
        sw.append(b);
      }
      meta.append(sw);
      p.modeEl = sw;
    }
    col.append(meta);

    const body = document.createElement('div');
    body.className = 'ed-body';
    p.bodyEl = body;
    col.append(body);

    host.append(col);
    if (p.frozen) col.classList.add('ed-frozen');
    // Which page the commands act on: the one the caret is in. With one page mounted — the
    // stock shell — this never changes anything.
    col.addEventListener('focusin', take);
    // The merge note (H7) goes on Esc as well as by itself. Nothing else is taken from the key.
    col.addEventListener('keydown', (e) => { if (e.key === 'Escape' && p.mergeNote) clearMergeNote(p); }, true);
    renderBanner(p);
  }

  /** The editable H1. `plaintext-only` keeps pasted formatting out of a file's title line. */
  function makeTitleEl(p, text) {
    const h1 = document.createElement('h1');
    h1.className = 'page-title';
    h1.contentEditable = p.frozen ? 'false' : 'plaintext-only';
    h1.spellcheck = false;
    h1.dataset.placeholder = 'Untitled';
    h1.textContent = text;
    h1.addEventListener('input', () => {
      p.title = h1.textContent.replace(/\s+/g, ' ').trim();
      publishTitle(p);
      markDirty(p);
    });
    h1.addEventListener('keydown', onTitleKey);
    // Enter and Tab leave the title through focusBody, so blur is the one place a finished
    // title is handled: save it, then let it name the file if the file is still `Untitled`.
    h1.addEventListener('blur', () => { void onTitleDone(p); });
    p.titleEl = h1;
    return h1;
  }

  async function onTitleDone(p) {
    const toBody = p.titleToBody;
    p.titleToBody = false;
    if (p.dirty) await saveNow();
    // The rename is in place now (no remount), so the caret the user asked for is still there;
    // it is put back only if the freeze around the flush took it away.
    if (await renameUntitledFromTitle(p) && toBody && p === page && !(p.el && p.el.contains(document.activeElement))) focusBody();
  }

  /**
   * The YAML block above the title. Every row is shown; a row whose value sits on one plain
   * `key: value` line is editable in place (C6). The edit rewrites that line only, inside the
   * raw block that composeDoc writes back verbatim, so unknown keys, comments and multi-line
   * values are never reformatted — the block is still never parsed as YAML.
   */
  function propertiesStrip(p) {
    const rows = p.doc.frontmatter || [];
    const box = document.createElement('div');
    box.className = 'ed-props';

    const head = document.createElement('button');
    head.className = 'ed-props-head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');
    // The shell's chevron, so the fold glyph is the sidebar's (same grid, same weight).
    head.innerHTML = `${icon('chevron')}<span>properties</span><span class="ed-props-count">${rows.length}</span>`;

    const list = document.createElement('div');
    list.className = 'ed-props-list';
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'ed-prop';
      const k = document.createElement('span');
      k.className = 'ed-prop-key';
      k.textContent = r.key;
      const v = document.createElement('span');
      v.className = 'ed-prop-val text-select';
      v.textContent = r.value;
      if (r.key && frontmatterEditable(p.doc.frontmatterRaw, r.key)) wirePropEdit(p, v, r.key);
      row.append(k, v);
      list.append(row);
    }
    head.addEventListener('click', () => {
      const open_ = box.classList.toggle('closed');
      head.setAttribute('aria-expanded', String(!open_));
    });
    box.append(head, list);
    return box;
  }

  /** One editable value: plain text, one line; Enter or Esc leaves, blur saves. */
  function wirePropEdit(p, v, key) {
    v.contentEditable = p.frozen ? 'false' : 'plaintext-only';
    v.spellcheck = false;
    v.classList.add('editable');
    v.dataset.placeholder = 'empty';
    v.title = 'Click to edit';
    v.addEventListener('input', () => {
      if (p !== page || p.frozen) return;
      // After a save `p.doc` is re-parsed from what was written, so the raw block here is always
      // the current one; a line that stopped being locatable leaves the file untouched.
      const raw = setFrontmatterValue(p.doc.frontmatterRaw, key, v.textContent);
      if (raw === null || raw === p.doc.frontmatterRaw) return;
      p.doc.frontmatterRaw = raw;
      markDirty(p);
    });
    v.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); v.blur(); }
    });
    v.addEventListener('blur', () => {
      v.textContent = v.textContent.replace(/[\r\n]+/g, ' ').trim();
      if (p.dirty) void saveNow();
    });
  }

  function onTitleKey(e) {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (page) page.titleToBody = true;
      focusBody();
    }
  }

  /**
   * L11: the caret lands at the **start of the first body block**, not wherever it happened to
   * be last. Leaving the title is a move to the top of the body, and nothing else.
   */
  function focusBody() {
    const p = page;
    if (!p) return;
    if (p.source) { p.source.focus(); return; }
    const view = p.crepe ? editorView(p.crepe) : null;
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView());
    view.focus();
  }

  /**
   * L10: the way back. Backspace or ArrowUp at the very start of the body puts the caret at the
   * **end** of the title. False when there is no title to go to.
   */
  function focusTitleEnd(p) {
    if (!p || !p.titleEl || p.titleEl.contentEditable === 'false') return false;
    p.titleEl.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(p.titleEl);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /**
   * L19: Ctrl+A once selects the block, twice the body (P3, blocks.js), a third time the title
   * as well — so the copy that follows is the whole note. The title is not part of the
   * ProseMirror document, so the selection cannot literally reach it: it is marked instead, and
   * the copy handler in `wireEditorEvents` writes the title line in front of the body.
   */
  function selectAllWithTitle(p) {
    if (!p || !p.titleEl || p.titleSelected) return false;
    p.titleSelected = true;
    p.titleEl.classList.add('ed-all-selected');
    return true;
  }

  function clearTitleSelection(p) {
    if (!p || !p.titleSelected) return;
    p.titleSelected = false;
    if (p.titleEl) p.titleEl.classList.remove('ed-all-selected');
  }

  /** The note without its frontmatter: the title line, the gap, the body, as a save would write. */
  function wholeNote(p) {
    const r = checkedBody(p.crepe, p.doc.body);
    const body = r.text ?? (p.crepe ? p.crepe.getMarkdown() : '');
    return composeDoc({ ...p.doc, frontmatterRaw: '', preTitle: '' }, { title: p.title, body });
  }

  /** Give a file with no H1 one. A user action, never automatic. */
  function addTitle(p) {
    if (p.frozen) return;
    const doc = p.doc;
    doc.titleLine = '# ';
    doc.title = '';
    doc.gap = doc.body.trim() ? '\n\n' : '\n';
    p.title = P.stem(p.path);
    // Rebuild the header only; the editor keeps its document and its undo history.
    const h1 = makeTitleEl(p, p.title);
    p.el.querySelector('.page-title').replaceWith(h1);
    markDirty(p);
    h1.focus();
    const range = document.createRange();
    range.selectNodeContents(h1);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }

  /**
   * Spellcheck is a setting, not a guess (L12/E43). `settings.spellcheck` (P8, default true)
   * decides; the language is the app's own.
   */
  function applySpellcheck(p) {
    if (!p || !p.el) return;
    const on_ = spellcheckOn();
    const lang = navigator.language || 'en';
    p.el.setAttribute('lang', lang);
    const view = p.crepe ? editorView(p.crepe) : null;
    for (const dom of [view && view.dom, p.source && p.source.view.contentDOM]) {
      if (!dom) continue;
      dom.setAttribute('spellcheck', String(on_));
      dom.setAttribute('lang', lang);
    }
  }

  // -------------------------------------------------------------------------
  // events inside the page

  function wireEditorEvents(p) {
    const host = p.host;
    // M5: there is no "touched" gate any more. A change the editor makes on its own while it
    // settles is kept out by `p.ready`; after that, a change is a change, and whether it is
    // worth a write is decided by comparing the composed text with the baseline.
    //
    // L19: the widened selection is a mode of exactly one gesture. Anything but the chords that
    // read it (Ctrl+A again, Ctrl+C, Ctrl+X) puts the page back to an ordinary selection.
    const MODIFIERS = ['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'];
    const keeps = (e) => MODIFIERS.includes(e.key)
      || ((e.ctrlKey || e.metaKey) && ['a', 'c', 'x', 'insert'].includes(String(e.key).toLowerCase()));
    const clearAll = (e) => { if (e.type !== 'keydown' || !keeps(e)) clearTitleSelection(p); };
    const onCopy = (e) => {
      if (!p.titleSelected || !e.clipboardData || !p.crepe) return;
      let text;
      try { text = wholeNote(p); } catch (err) { console.error('[editor] copy whole note', err); return; }
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.setData('text/plain', text);
    };
    host.addEventListener('keydown', clearAll, true);
    host.addEventListener('pointerdown', clearAll, true);
    host.addEventListener('copy', onCopy, true);
    p.cleanups.push(() => {
      host.removeEventListener('keydown', clearAll, true);
      host.removeEventListener('pointerdown', clearAll, true);
      host.removeEventListener('copy', onCopy, true);
    });

    host.addEventListener('pointerdown', onLinkPointerDown, true);
    host.addEventListener('click', onLinkClick, true);
    p.cleanups.push(() => host.removeEventListener('pointerdown', onLinkPointerDown, true));
    p.cleanups.push(() => host.removeEventListener('click', onLinkClick, true));

    // Notion behaviour: a click in the empty space below the last block puts the caret at the
    // end of the page instead of leaving the editor unfocused.
    //
    // The element around the column is the router's, and a parked page comes back into another
    // one (M12): the listener on it is bound where the column is now, and moved with it
    // (`p.bindParent`), never left on an element that shows a different page.
    let scroller = null;
    const onBlankClick = (e) => {
      if (e.button !== 0 || parked) return;
      if (e.target !== host && e.target !== scroller && e.target !== p.bodyEl) return;
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return;
      e.preventDefault();
      const end = view.state.doc.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)));
      view.focus();
    };
    const unbindParent = () => { if (scroller) scroller.removeEventListener('mousedown', onBlankClick); scroller = null; };
    p.bindParent = () => {
      unbindParent();
      scroller = host.parentElement;
      if (scroller) scroller.addEventListener('mousedown', onBlankClick);
    };
    host.addEventListener('mousedown', onBlankClick);
    p.bindParent();
    p.cleanups.push(() => { host.removeEventListener('mousedown', onBlankClick); unbindParent(); p.bindParent = null; });
  }

  /** The body lost the focus: a save now, and a draft when that save did not land (C4). */
  function onEditorBlur(p) {
    if (p !== page || !p.dirty) return;
    // A recovered draft nobody has edited yet waits for a deliberate save (see open).
    if (p.recovered && p.recovered.applied && p.recovered.rev === p.rev) return;
    void saveNow().then((ok) => { if (!ok && p === page && p.dirty) void writeDraft(p); });
  }

  /**
   * Ctrl/Cmd+click follows a link. It has to be caught on pointerdown: ProseMirror treats
   * Ctrl+mousedown as "select this node", re-renders the paragraph, and by the time the click
   * event arrives its target is the paragraph and the anchor is gone.
   */
  function onLinkPointerDown(e) {
    if (!page || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
    const a = anchorAt(e);
    if (!a || inTooltip(a)) return;
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    void followLink(href);
  }

  /**
   * The link tooltip's own open action. Crepe renders it as `<a target="_blank">`, which would
   * take the whole app with it, so it is always intercepted. A plain click in the text is left
   * alone: it must still place the caret.
   */
  function onLinkClick(e) {
    if (!page) return;
    const a = anchorAt(e);
    if (!a) return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); return; }
    if (!inTooltip(a)) return;
    const href = (a.textContent || a.getAttribute('href') || '').trim();
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    void followLink(href);
  }

  async function followLink(href) {
    if (!page) return;
    // linkstate.js (P7) owns where a href goes: anchors, missing pages, text files into source
    // mode, the platform for everything else. The editor only says which page it was written in.
    return followHref(href, page.path);
  }

  // -------------------------------------------------------------------------
  // images

  function resolveImage(p, src) {
    const s = String(src || '');
    if (!s || P.isExternal(s) || s.startsWith('blob:')) return s;
    const target = P.resolveHref(p.path, s);
    return target ? bridge.assetUrl(target) : s;
  }

  /**
   * A pasted or dropped file lands in `<page folder>/attachments/<yyyy-mm-dd>-<slug>.<ext>`,
   * numbered when taken, so the folder stays portable. Resolves to the vault path of the copy.
   */
  async function attachFile(p, file) {
    const image = /^image\//.test(file.type || '');
    const ext = (/\.([a-z0-9]{1,8})$/i.exec(file.name || '') || [])[1]
      || (image ? (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg') : 'bin');
    const base = `${P.today()}-${P.slugify(P.stem(file.name || ''), image ? 'image' : 'file')}`;
    // Where attachments go is a setting (S35, P8); the default answers the page's own folder.
    // `''` is the vault root: a path with no folder in front of it (QA F23).
    const folder = attachmentFolder(p.path);
    const named = (name) => (folder ? `${folder}/${name}` : name);
    const nth = (n) => named(n < 2 ? `${base}.${ext.toLowerCase()}` : `${base}-${n}.${ext.toLowerCase()}`);
    const data = await readAsBase64(file);
    // The name is taken with an exclusive create (contract §4.5: never an overwrite), and the
    // bytes then go into the empty file that create made. A file that appeared under the name
    // meanwhile (a sync client, a second window) answers `exists`, and the next number is tried.
    let target = null;
    for (let n = 1; n < 1000 && target === null; n++) {
      try {
        const r = await pageFiles.createNew(nth(n), '');
        target = String((r && r.path) || nth(n));
      } catch (e) {
        if (errCode(e) === 'exists') continue;
        if (errCode(e) !== 'unknown_command') throw e;
        // A kernel with no exclusive create: the old probe, which is the best it can do.
        let k = n;
        while (await bridge.exists(nth(k))) k++;
        target = nth(k);
      }
    }
    if (target === null) throw Object.assign(new Error(`no free name for ${base}.${ext}`), { code: 'exists' });
    await bridge.writeBinary(target, data);
    return target;
  }

  /** Milkdown's uploader (crepe.js onUpload): the attachment as a markdown src relative to the page. */
  async function uploadImage(p, file) {
    return P.relativeHref(p.path, await attachFile(p, file));
  }

  /**
   * The drops the body's own handler (drop.js) never sees. On the title or the meta line the
   * browser would put the payload's text into the title, or the shell's window guard would
   * refuse the drop; both are the page, so the links go at the top of the body (position 0).
   * Inside a node view that keeps its events, the drop is taken here at the pointer, and
   * drop.js puts the blocks after the node. A frozen page takes nothing anywhere.
   */
  function wireDrops(p) {
    const host = p.host;
    const above = (t) => t instanceof Element && !!(t.closest('.page-title') || t.closest('.page-meta'));
    const held = (t) => t instanceof Element && !!t.closest('.ProseMirror [contenteditable="false"]');
    const o = { pagePath: () => p.path, attach: (file) => attachFile(p, file) };
    const onOver = (e) => {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
      const ours = types.includes(DRAG_TYPE) || types.includes('Files');
      if (!p.frozen && !(ours && (above(e.target) || held(e.target)))) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = p.frozen ? 'none' : types.includes(DRAG_TYPE) ? 'move' : 'copy';
    };
    const onDrop = (e) => {
      if (p.frozen) { e.preventDefault(); return; }
      const top = above(e.target);
      if (!top && !held(e.target)) return;
      const payload = payloadOf(e.dataTransfer);
      if (!payload) return;
      e.preventDefault();
      e.stopPropagation();
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return;
      const at = top ? null : view.posAtCoords({ left: e.clientX, top: e.clientY });
      void dropInto(view, payload, at ? at.pos : 0, o);
    };
    host.addEventListener('dragover', onOver, true);
    host.addEventListener('drop', onDrop, true);
    p.cleanups.push(() => { host.removeEventListener('dragover', onOver, true); host.removeEventListener('drop', onDrop, true); });
  }

  // -------------------------------------------------------------------------
  // the save state (H8, §6.4)

  /**
   * The note's own title (its H1, or the file's stem), on `store 'pageTitle'` and the handle's
   * `title` event. Wave 2 (M13, W8): the window, the tab and the address bar name the file by its
   * real name and no longer read this; it stays for whoever wants the H1. `null` when no page is
   * open. Only the active page publishes the store key.
   */
  function publishTitle(p) {
    if (!p || !p.path) { if (isActive()) store.set('pageTitle', null); return; }
    const title = String(p.title || '').trim() || P.stem(p.path);
    if (isActive()) store.set('pageTitle', { path: p.path, title });
    emit('title', { path: p.path, title });
  }

  function statusOf(p) {
    if (!p) return 'clean';
    if (p.deleted) return 'deleted';
    if (p.problem) return p.problem.status;
    if (p.saving) return 'saving';
    return p.dirty ? 'dirty' : 'clean';
  }

  /** @returns {import('./page.js').DocState} */
  function stateOf(p) {
    const st = statusOf(p);
    let reason = null;
    let message = null;
    if (st === 'deleted') { reason = 'gone'; message = `${P.basename(p.path)} was deleted or moved on disk`; }
    else if (p.problem) { reason = p.problem.reason || null; message = p.problem.message || null; }
    return {
      path: p.path, status: st, dirty: !!p.dirty, reason, message, draft: p.draft,
      mode: publicMode(p), savedAt: p.savedAtMs,
    };
  }

  /**
   * Say the state everywhere it is shown: the bus (`doc:state`, for every page, not only the
   * focused one), the handle, the status bar's `save` field, the banner and the meta line.
   */
  function publishState(p) {
    if (!p || !p.path || p !== page) return;
    const s = stateOf(p);
    const key = JSON.stringify(s);
    if (key !== p.lastState) {
      p.lastState = key;
      bus.emit('doc:state', s);
      emit('state', s);
    }
    paintSave(p, s);
    renderBanner(p);
  }

  function paintSave(p, s = stateOf(p)) {
    if (!isActive()) return;
    const show = () => { void commands.run('page.show-problem'); };
    let value = null;
    switch (s.status) {
      case 'clean': value = p.savedAt ? 'saved ' + p.savedAt : null; break;
      case 'dirty': value = 'unsaved'; break;
      case 'saving': value = 'saving…'; break;
      case 'not-saved': value = { text: 'Not saved', kind: 'err', onClick: show }; break;
      case 'conflict': value = { text: 'Not saved · changed on disk', kind: 'err', onClick: show }; break;
      case 'deleted': value = { text: 'Deleted on disk', kind: p.dirty ? 'err' : 'warn', onClick: show }; break;
      default: value = null;
    }
    const key = value && typeof value === 'object' ? `${value.text}|${value.kind}` : String(value);
    if (key === p.lastSave) return;
    p.lastSave = key;
    status.set('save', value);
  }

  /** What the banner says, or null when there is nothing to say (§6.5). */
  function bannerSpec(p) {
    const st = statusOf(p);
    const name = P.basename(p.path);
    if (st === 'not-saved') {
      if (p.problem.reason === 'unsafe') {
        return {
          kind: 'err', alert: true,
          text: 'The rich view could not write this page exactly. It is open as text: check it and save.',
          buttons: [['Save', 'page.save'], ['Save as…', 'page.save-as'], ['Copy text', 'page.copy-markdown'], ['Discard changes', 'page.discard-changes']],
        };
      }
      const kept = p.draft === 'written' ? 'Your text is kept on this machine.' : 'Copy your text somewhere safe before closing.';
      return {
        kind: 'err', alert: true,
        text: `Not saved: ${String(p.problem.message || 'the file could not be written').replace(/[.\s]+$/, '')}. ${kept}`,
        buttons: [['Try again', 'page.save'], ['Save as…', 'page.save-as'], ['Copy text', 'page.copy-markdown'], ['Discard changes', 'page.discard-changes']],
      };
    }
    if (st === 'conflict') {
      // H7: only what could not be merged gets here. The buffer is untouched until the user
      // picks one of these; each button is also a command, so the palette reaches them.
      const c = p.conflict || {};
      const n = Number(c.count) || 0;
      if (typeof c.theirs !== 'string') {
        return {
          kind: 'err', alert: true,
          text: `Changed on disk while you were editing: ${name} is no longer text this editor can show.`,
          buttons: [['Keep mine', 'page.merge-keep-mine'], ['Discard changes', 'page.discard-changes']],
        };
      }
      return {
        kind: 'err', alert: true,
        text: n
          ? `Changed on disk while you were editing: ${n} part${n === 1 ? ' overlaps' : 's overlap'}.`
          : 'Changed on disk while you were editing.',
        buttons: [['Resolve…', 'page.merge-resolve'], ['Keep mine', 'page.merge-keep-mine'], ['Take theirs', 'page.merge-take-theirs']],
      };
    }
    if (st === 'deleted') {
      return {
        kind: p.dirty ? 'err' : 'warn', alert: !!p.dirty,
        text: `${name} was deleted or moved on disk.`,
        buttons: [['Save again here', 'page.save'], ['Save as…', 'page.save-as'],
          p.dirty ? ['Discard changes', 'page.discard-changes'] : ['Close', 'page.close']],
      };
    }
    if (p.recovered) {
      const when = whenLabel(p.recovered.at);
      return p.recovered.applied
        ? {
          kind: 'warn', alert: false,
          text: `Unsaved changes from ${when} were recovered.`,
          buttons: [['Compare', 'page.recovered-compare'], ['Discard recovered', 'page.discard-changes']],
        }
        : {
          kind: 'warn', alert: false,
          text: `Unsaved changes from ${when} could not be applied: the file changed since.`,
          buttons: [['Compare', 'page.recovered-compare'], ['Restore mine', 'page.recovered-restore'], ['Discard', 'page.discard-changes']],
        };
    }
    if (p.mergeNote && p.merged) {
      return {
        kind: 'warn', alert: false,
        text: 'Merged changes made on disk by another program.',
        buttons: [['Show changes', 'page.merge-show'], ...(canUndoMerge(p) ? [['Undo merge', 'page.merge-undo']] : [])],
      };
    }
    if (p.notice) return { kind: 'warn', alert: false, text: p.notice, buttons: [] };
    return null;
  }

  /** Draw the banner when what it says changed; the buttons run the commands they name. */
  function renderBanner(p) {
    const box = p && p.bannerEl;
    if (!box) return;
    const spec = bannerSpec(p);
    const key = spec ? JSON.stringify([spec.kind, spec.alert, spec.text, spec.buttons]) : '';
    if (key === p.lastBanner) return;
    p.lastBanner = key;
    const had = box.contains(document.activeElement);
    box.textContent = '';
    box.hidden = !spec;
    box.className = 'ed-banner' + (spec ? ` ed-banner-${spec.kind}` : '');
    if (!spec) { box.removeAttribute('role'); return; }
    box.setAttribute('role', spec.alert ? 'alert' : 'status');
    const text = document.createElement('span');
    text.className = 'ed-banner-text';
    text.textContent = spec.text;
    box.append(text);
    if (spec.buttons.length) {
      const acts = document.createElement('span');
      acts.className = 'ed-banner-acts';
      for (const [label, id] of spec.buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.textContent = label;
        b.dataset.command = id;
        b.addEventListener('click', () => { take(); void commands.run(id); });
        acts.append(b);
      }
      box.append(acts);
    }
    if (had) focusBanner(p);
  }

  /** `page.show-problem`: the banner into view and its first button focused. */
  function focusBanner(p) {
    if (!p || !p.bannerEl || p.bannerEl.hidden) return false;
    const first = p.bannerEl.querySelector('button');
    try { p.bannerEl.scrollIntoView({ block: 'nearest' }); } catch { /* not laid out */ }
    if (first) first.focus({ preventScroll: true });
    return true;
  }

  /** The dirty flag, and the two events that have always said it. */
  function setDirty(p, dirty) {
    if (p.dirty === dirty) return;
    p.dirty = dirty;
    // Every page says it, on screen or parked (M12): the event carries its path, and a tab in
    // the background shows the dot of its own page.
    bus.emit('doc:dirty', { path: p.path, dirty });
    emit('dirty', { path: p.path, dirty });
    updateMeta(p);
  }

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
    if (p !== page || !p.ready || p.applying) return;
    p.rev = ++revClock;
    setDirty(p, true);
    clearTimeout(p.wordTimer);
    p.wordTimer = setTimeout(() => { if (p === page) updateMeta(p, true); }, SAVE_DEBOUNCE);
    if (autosaveHeld(p) || (p.problem && p.problem.status === 'not-saved')) {
      scheduleDraft(p);
      // A write that left a copy beside the file is not retried on a timer (`saveFailed`); an
      // edit tries once more, no sooner than the backoff allows, and only a few times.
      if (p.problem && p.problem.copy && !p.saveTimer && p.keptCopies < KEPT_COPIES_MAX) {
        const wait = Math.max(SAVE_DEBOUNCE, p.retry * 1000 - (Date.now() - p.failedAt));
        p.saveTimer = setTimeout(() => { p.saveTimer = 0; void saveDoc(p); }, wait);
      }
    } else {
      clearTimeout(p.saveTimer);
      p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
    }
    publishState(p);
  }

  /** Autosave never runs on a deleted page, a conflict or a page the rich view could not write. */
  const autosaveHeld = (p) => p.deleted || (p.problem && (p.problem.status === 'conflict' || p.problem.reason === 'unsafe'));

  /**
   * The file exactly as a save would write it, with the guard's verdict (C8, §7.1). In source
   * mode the text in CodeMirror *is* the file — frontmatter, title and body — and it is handed
   * back untouched, with the file's own line endings (M3).
   * @returns {{status:'ok'|'fellBack'|'unsafe', text:string|null, reason?:string}}
   */
  function composeChecked(p) {
    if (p.source) return { status: 'ok', text: p.source.getText() };
    // No editor could be built (`mountFallback`): the text that was to go in is all there is.
    // Nothing saves it over the file (`saveDoc` needs an editor); Save as and Copy text may.
    if (!p.crepe) {
      return typeof p.orphan === 'string'
        ? { status: 'ok', text: p.orphan }
        : { status: 'unsafe', text: null, reason: 'the page has no editor' };
    }
    const r = checkedBody(p.crepe, p.doc.body);
    if (r.status === 'unsafe') {
      let text = null;
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
    if (!p.crepe && typeof p.orphan === 'string') return p.orphan;
    let body = null;
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
  async function saveDoc(p, o = {}) {
    if (!p) return true;
    if (!p.crepe && !p.source) return !p.dirty;
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
      await Promise.race([p.movingDone, new Promise((r) => setTimeout(r, 10000))]);
      if (p.moving) return false;
      return saveDoc(p, o);
    }
    const deliberate = o.explicit || o.closing;
    // "Save again here" on a deleted page is a deliberate save, even of a clean buffer.
    const recreate = p.deleted && o.explicit && !o.leaving && !o.closing;
    if (!p.dirty && !recreate) return true;
    if (p.readOnly) return false;
    // H7: the disk and the buffer overlap. Ctrl+S (a save the user asked for, not a leave, a
    // close or a path change) opens the resolve view; everything else goes to the host as
    // usual, where the stale hash keeps it from writing over the disk's text.
    if (p.conflict && o.explicit && !o.leaving && !o.closing && !o.pathChange && !o.noResolve) return resolveMerge(p);
    // A recovered draft nobody has edited yet waits for a deliberate save (see open): not a
    // blur, not a debounce, not the window being hidden before the user has compared it.
    if (!deliberate && ((p.recovered && p.recovered.applied && p.recovered.rev === p.rev) || unchecked(p))) return false;
    if (!deliberate && autosaveHeld(p)) { scheduleDraft(p); return false; }
    if (p.deleted && !recreate) { void writeDraft(p); return false; }

    const rev = p.rev;
    const r = composeChecked(p);
    if (r.status === 'unsafe') { await refuseUnsafe(p, r); return false; }
    if (r.status === 'fellBack') {
      log(`guard fellBack ${p.path}: ${r.reason}`, 'warn');
      emit('guard', { status: r.status, reason: r.reason });
    }
    const text = r.text;
    // M5: a buffer that composes back to the baseline is not dirty, whatever changed in it.
    if (text === p.baseline && !recreate) { settleClean(p, rev); return true; }

    let outcome = false;
    p.saving = (async () => {
      outcome = await writeOut(p, text, rev, { expectedHash: p.deleted ? null : p.baselineHash });
    })();
    publishState(p);
    try {
      await p.saving;
    } catch (e) {
      saveFailed(p, e);
      outcome = false;
    } finally {
      p.saving = null;
      publishState(p);
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
      if (!disk.exists && opts.expectedHash !== null) { markDeleted(p); return false; }
      // No question here any more: the disk's change is merged into the buffer, and only when
      // both touched the same lines does the page hold a conflict and say so (H7, §5.3).
      const m = await mergeExternal(p, { text: disk.text, hash: disk.hash });
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
    if (p.forced === 'unsafe') { p.forced = null; p.notice = null; publishMode(p); }
    else if (!p.forced) p.notice = null;
    if (p.recovered && p.recovered.applied) p.recovered = null;
    // The next reconcile compares against what was written, and in source mode the title strip
    // (a label over text the user just edited) follows it.
    p.doc = p.plain ? plainDoc(text) : parseDoc(text);
    p.title = p.doc.titleLine !== null ? p.doc.title : p.title;
    publishTitle(p);
    if (p.source && p.titleEl && p.titleEl.textContent !== p.title) p.titleEl.textContent = p.title;
    p.savedAt = P.hhmm();
    p.savedAtMs = Date.now();
    if (Number(res.mtime)) p.mtime = Number(res.mtime);
    log(`save ok ${p.path}${res.unchanged ? ' (unchanged)' : ''}`, 'info');
    bus.emit('doc:saved', { path: p.path });
    emit('saved', { path: p.path, text });
    if (p.rev === rev) {
      settleClean(p, rev);
    } else if (p === page) {
      // Typed during the write: still dirty, and the debounce runs again.
      clearTimeout(p.saveTimer);
      p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
      publishState(p);
    }
  }

  /** Clean: the disk holds the buffer. The draft goes, and so does any problem. */
  function settleClean(p, rev) {
    const conflict = p.conflict;
    if (!p.deleted) { p.problem = null; p.conflict = null; }
    p.retry = 0;
    setDirty(p, false);
    void dropDraft(p, rev);
    publishState(p);
    updateMeta(p);
    // The buffer went back to the text it was opened from while the disk moved on: nothing of
    // the user's is left to keep, so the page shows the disk, in place (H7).
    if (conflict && !p.deleted && p === page) {
      if (typeof conflict.theirs === 'string') void reloadClean(p, conflict.theirs, conflict.hash);
      else void reopenInPlace(p);
    }
  }

  /** A write threw. The buffer stays dirty and on this machine; a later try may still land. */
  function saveFailed(p, e) {
    const code = errCode(e);
    log(`save failed ${p.path}: ${code} ${errText(e)}`, 'error');
    // `[write_failed] …; your text is in <where>`: the host could not put the file in place and
    // set the new text aside in a visible copy beside it (vault.rs `keep_unsaved`).
    const copy = code === 'write_failed' && /;\s*your text is in\s/.test(errText(e));
    p.problem = {
      status: 'not-saved',
      reason: code === 'stale_vault' ? 'stale-vault' : 'write-failed',
      message: code === 'stale_vault' ? 'the vault changed since this page was opened' : errText(e),
      copy,
    };
    p.failedAt = Date.now();
    if (copy) p.keptCopies++;
    void writeDraft(p);
    publishState(p);
    // A write the host refused is tried again, further apart each time (2, 4, 8 … 30 s). A page
    // of another vault is not: it would land in the wrong place, which is what the epoch stops.
    // Nor is a write that left a copy beside the file: every try would leave one more in the
    // user's folder. That one is tried again on the next edit (`markDirty`) or by a deliberate
    // save, which the banner offers.
    if (code !== 'stale_vault' && p === page) {
      p.retry = Math.min(RETRY_MAX, p.retry ? p.retry * 2 : 2);
      clearTimeout(p.saveTimer);
      p.saveTimer = 0;
      if (!copy) p.saveTimer = setTimeout(() => { void saveDoc(p); }, p.retry * 1000);
    }
  }

  /**
   * The guard found no text that reads back as the page (§7.1): nothing is written. The best
   * effort goes to a draft, and the page opens as text over it, dirty, for the user to check
   * and save — saving then writes exactly what CodeMirror holds.
   */
  async function refuseUnsafe(p, r) {
    log(`guard unsafe ${p.path}: ${r.reason}`, 'error');
    emit('guard', { status: 'unsafe', reason: r.reason });
    const text = typeof r.text === 'string' ? r.text : bestEffort(p);
    p.problem = { status: 'not-saved', reason: 'unsafe', message: 'the rich view could not write this page exactly' };
    await writeDraftText(p, text, false);
    if (p !== page) return;
    await forceSource(p, text, 'unsafe', r.reason);
    // Until the user edits it or saves it deliberately, this text is not written by a leave.
    if (p === page) p.uncheckedRev = p.rev;
  }

  // -------------------------------------------------------------------------
  // changes made on disk (H7, §5.3)
  //
  // The page was based on `p.baseline` (hash `p.baselineHash`); the disk holds another text.
  // A clean page takes it in place, as one transaction, so the undo history survives and the
  // caret stays where the text allows. A dirty page merges it line by line: the buffer's
  // changes and the disk's, both made against the baseline, laid over each other (merge.js).
  // Only where both touched the same lines does the page hold a conflict; the buffer is then
  // left exactly as it is, autosave stops, leaving is refused, and the banner offers the
  // resolve view. There is no blind "Changed on disk" question any more.

  /**
   * The disk holds `disk.text` (`null` when it is not text this editor can read) under
   * `disk.hash`. Answers what came of it: `'same'` (nothing new), `'reloaded'` (a clean page
   * took the disk), `'merged'` (the disk's change is in the buffer, which is dirty over the
   * disk's hash now, or clean when the two agree) or `'conflict'`.
   * @returns {Promise<'same'|'reloaded'|'merged'|'conflict'>}
   */
  async function mergeExternal(p, disk) {
    if (p !== page || p.trashed) return 'same';
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
    if (p !== page || p.trashed) return 'same';
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
    try { r0 = composeChecked(p); } catch (e) { r0 = { status: 'unsafe', text: null, reason: errText(e) }; }
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
    const wasUnchecked = unchecked(p);
    if (merged !== ours) await applyText(p, merged);
    if (p !== page) return 'merged';
    p.baseline = disk.text;
    p.baselineHash = hash;
    p.conflict = null;
    if (p.problem && p.problem.status === 'conflict') p.problem = null;
    log(`merged changes made on disk ${p.path}`, 'info');
    if (merged === disk.text) {
      // Both sides made the same change: nothing of the user's is left unwritten.
      p.merged = null;
      settleClean(p, p.rev);
      return 'merged';
    }
    p.rev = ++revClock;
    if (wasUnchecked) p.uncheckedRev = p.rev;
    setDirty(p, true);
    if (merged !== ours) {
      p.merged = { ours, theirs: disk.text, text: merged, at: Date.now(), rev: p.rev };
      showMergeNote(p);
    }
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
    publishState(p);
    return 'merged';
  }

  /** A clean page takes the disk's text in place (`applyText`); it is the baseline now. */
  async function reloadClean(p, text, hash) {
    await applyText(p, text);
    if (p !== page) return;
    p.baseline = text;
    p.baselineHash = hash ?? p.baselineHash;
    p.conflict = null;
    if (p.problem && p.problem.status === 'conflict') p.problem = null;
    clearTimeout(p.saveTimer);
    setDirty(p, false);
    publishState(p);
    updateMeta(p, true);
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
    if (p.source) {
      p.applying = true;
      try { p.source.replaceText(text); } finally { p.applying = false; }
      p.doc = p.plain ? plainDoc(text) : parseDoc(text);
      if (p.doc.titleLine !== null) p.title = p.doc.title;
      if (p.titleEl && p.titleEl.textContent !== p.title) p.titleEl.textContent = p.title;
      publishTitle(p);
      updateMeta(p, true);
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
      if (!check.ok) await forceSource(p, text, 'lossy-open', check.reason);
      updateMeta(p, true);
      return !!p.crepe;
    }
    if (!p.crepe && !p.source) { p.orphan = text; return false; }
    const wasFrozen = p.frozen;
    freeze(p);
    try {
      await remount(p, p.mode === 'source' ? 'source' : 'block', text);
      if (p === page && p.crepe) {
        const check = checkOpened(p.crepe, p.doc.body);
        if (!check.ok) await forceSource(p, text, 'lossy-open', check.reason);
      }
    } catch (e) {
      console.error('[editor] apply', e);
      if (p === page) await mountFallback(p, text);
    }
    if (p === page && !wasFrozen) unfreeze(p);
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
      const nodes = [];
      for (let i = start; i < endB; i++) nodes.push(body.child(i));
      // Outside the undo history: Ctrl+Z must never revert a change made on disk and autosave
      // the old text over it. The user's earlier steps map through this one.
      const tr = closeHistory(nodes.length ? state.tr.replaceWith(from, to, nodes) : state.tr.delete(from, to))
        .setMeta('addToHistory', false);
      p.applying = true;
      try { view.dispatch(tr); } finally {
        // The document watcher reports on a microtask (crepe.js `watchDoc`); this one is queued
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
    publishTitle(p);
    if (frontChanged && p.el) {
      const old = p.el.querySelector('.ed-props');
      if (old) old.replaceWith(propertiesStrip(p));
    }
    return true;
  }

  /**
   * The disk and the buffer overlap: the buffer is left as it is, autosave stops, leaving is
   * refused, a draft keeps the text, and the banner offers the resolve view. `info` is
   * `{theirs, hash, count, base}`: the disk's text (null when it is not text), its hash, how many
   * regions overlap (0 when unknown) and the text both were edited from.
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
    emit('conflict', { path: p.path, count: info.count });
    void writeDraft(p);
    publishState(p);
  }

  /** The disk as it is now, `{text, hash}`, or null when it cannot be read (a gone file is looked for). */
  async function readDisk(p) {
    try {
      const f = await pageFiles.readFile(p.path);
      return { text: typeof f.text === 'string' ? f.text : null, hash: f.hash ?? null };
    } catch (e) {
      if (errCode(e) === 'not_found') { goneCheck(p); return null; }
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
    if (!p || p !== page || !p.conflict) return false;
    // The disk may have moved again since the banner went up: merge that first.
    const disk = await readDisk(p);
    if (p !== page || !p.conflict) return false;
    if (disk && disk.hash !== null && disk.hash !== p.conflict.hash) {
      const m = await mergeExternal(p, disk);
      if (m !== 'conflict') return saveDoc(p, { explicit: true, noResolve: true });
    }
    const c = p.conflict;
    if (!c) return false;
    let r0;
    try { r0 = composeChecked(p); } catch (e) { r0 = { status: 'unsafe', text: null, reason: errText(e) }; }
    const exact = r0.status !== 'unsafe' && typeof r0.text === 'string';
    const ours = exact ? r0.text : bestEffort(p);
    if (typeof c.theirs !== 'string') {
      const ok = await confirm({
        title: 'Changed on disk',
        body: `${p.path} was replaced by something this editor cannot show as text. Keep your version and overwrite it? The file on disk is kept in Versions….`,
        ok: 'Keep mine',
      });
      return ok && p === page ? keepMine(p) : false;
    }
    const actions = [
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
      note: c.count
        ? `${c.count} part${c.count === 1 ? '' : 's'} changed on both sides. Keep both puts the lines on disk after yours where they overlap.`
        : 'Keep both puts the lines on disk after yours where they differ.',
      actions,
    });
    if (p !== page || p.conflict !== c) return false;
    if (choice === 'both') return keepBothIn(p, ours, c);
    if (choice === 'mine') return keepMine(p);
    if (choice === 'theirs') return takeTheirs(p);
    return false;
  }

  /** Keep both: every overlap becomes the buffer's lines, then the disk's; dirty, over the disk's hash. */
  async function keepBothIn(p, ours, c) {
    const text = keepBoth(typeof c.base === 'string' ? c.base : '', ours, c.theirs);
    await applyText(p, text);
    if (p !== page) return false;
    p.baseline = c.theirs;
    p.baselineHash = c.hash;
    p.conflict = null;
    p.problem = null;
    p.merged = null;
    p.rev = ++revClock;
    setDirty(p, true);
    log(`kept both versions ${p.path}`, 'info');
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
    publishState(p);
    return false;
  }

  /**
   * Keep mine: the buffer over the disk, against the hash of the text the conflict showed, so a
   * write that lands meanwhile is merged again rather than lost. The host keeps the disk's text
   * as a `conflict` version.
   */
  async function keepMine(p) {
    if (!p || p !== page) return false;
    const c = p.conflict;
    if (!c) return saveNow({ explicit: true });
    let r0;
    try { r0 = composeChecked(p); } catch (e) { r0 = { status: 'unsafe', text: null, reason: errText(e) }; }
    if (r0.status === 'unsafe' || typeof r0.text !== 'string') {
      toast('Not saved: the rich view could not write this page exactly. Switch to Source, check it, then keep yours.', 'err', 0);
      return false;
    }
    const rev = p.rev;
    let res;
    try {
      res = await pageFiles.save(p.path, r0.text, { expectedHash: c.hash, version: 'conflict' });
    } catch (e) {
      saveFailed(p, e);
      return false;
    }
    if (p !== page) return false;
    if (res && res.status === 'saved') { saved(p, r0.text, res, rev); return !p.dirty; }
    if (res && res.status === 'conflict') {
      const d = res.disk || { exists: false, text: null, hash: null };
      if (!d.exists) { p.conflict = null; p.problem = null; markDeleted(p); return false; }
      const m = await mergeExternal(p, { text: d.text, hash: d.hash });
      return m === 'conflict' ? false : saveDoc(p, { explicit: true, noResolve: true });
    }
    saveFailed(p, Object.assign(new Error('the host gave no answer to the save'), { code: 'unknown_command' }));
    return false;
  }

  /** Take theirs: the buffer goes to Versions (reason `reload`), and the page shows the disk. */
  async function takeTheirs(p) {
    if (!p || p !== page) return false;
    const disk = await readDisk(p);
    if (!disk || typeof disk.text !== 'string' || p !== page) {
      if (disk) toast(`${p.path} is not text this editor can show; keep yours, or discard your changes`, 'warn');
      return false;
    }
    let d = null;
    try { d = draftText(p); } catch { d = null; }
    if (d && typeof d.text === 'string') await keepBuffer(p, d.text);
    if (p !== page) return false;
    p.conflict = null;
    p.problem = null;
    p.recovered = null;
    p.merged = null;
    clearTimeout(p.saveTimer);
    await reloadClean(p, disk.text, disk.hash);
    await dropDraft(p);
    log(`took the version on disk ${p.path}`, 'info');
    return true;
  }

  /** The banner that says a merge happened: up for `MERGE_NOTE_MS`, or until Esc. */
  function showMergeNote(p) {
    clearTimeout(p.mergeNote);
    p.mergeNote = setTimeout(() => { p.mergeNote = 0; if (p === page) publishState(p); }, MERGE_NOTE_MS);
  }

  function clearMergeNote(p) {
    if (!p || !p.mergeNote) return;
    clearTimeout(p.mergeNote);
    p.mergeNote = 0;
    publishState(p);
  }

  /** Undo merge is one step: offered while nothing was typed after the merge. */
  const canUndoMerge = (p) => !!(p && p.merged && p.merged.rev === p.rev);

  /**
   * `page.merge-undo`: the buffer goes back to what it held before the merge. The disk's text
   * is kept as a version first, because the next save writes the buffer over it.
   */
  async function undoMerge(p) {
    if (!canUndoMerge(p) || p !== page) return false;
    const m = p.merged;
    clearMergeNote(p);
    try {
      await pageFiles.keepVersion(p.path, m.theirs, { force: true, reason: 'conflict' });
    } catch (e) {
      log(`version not kept ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
    }
    if (p !== page) return false;
    await applyText(p, m.ours);
    if (p !== page) return false;
    p.merged = null;
    p.rev = ++revClock;
    setDirty(p, true);
    log(`merge undone ${p.path}`, 'info');
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
    publishState(p);
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
    if (typeof text !== 'string') return;
    try {
      await pageFiles.keepVersion(p.path, text, { force: true, reason: 'reload' });
    } catch (e) {
      log(`version not kept ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
    }
  }

  /** The buffer, kept as a version before the page lets it go (reason `reload`). Never throws. */
  async function keepBuffer(p, text) {
    if (typeof text !== 'string' || text === p.baseline) return;
    try {
      await pageFiles.keepVersion(p.path, text, { force: true, reason: 'reload' });
    } catch (e) {
      log(`version not kept ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn');
    }
  }

  // -------------------------------------------------------------------------
  // drafts (C4, M1)

  /** The text a draft of the page holds, and whether it is what a save would write. */
  function draftText(p) {
    // Text the user has not checked yet stays marked as such, whichever editor holds it.
    const exact = !unchecked(p);
    if (p.source) return { text: p.source.getText(), exact };
    if (!p.crepe) return { text: typeof p.orphan === 'string' ? p.orphan : null, exact: false };
    const r = composeChecked(p);
    if (r.status !== 'unsafe' && typeof r.text === 'string') return { text: r.text, exact };
    return { text: typeof r.text === 'string' ? r.text : bestEffort(p), exact: false };
  }

  /** A draft soon: `DRAFT_DELAY` after this edit, and at most every `DRAFT_EVERY` while typing. */
  function scheduleDraft(p) {
    if (p.draftTimer) return;
    const wait = Math.max(DRAFT_DELAY, DRAFT_EVERY - (Date.now() - p.draftAt));
    p.draftTimer = setTimeout(() => { p.draftTimer = 0; if (p === page && p.dirty) void writeDraft(p); }, wait);
  }

  /** Write the draft of a dirty buffer now. Never throws; the state says how it went. */
  async function writeDraft(p) {
    if (!p || !p.path || !p.dirty || p.trashed) return;
    if (!p.crepe && !p.source && typeof p.orphan !== 'string') return;
    clearTimeout(p.draftTimer);
    p.draftTimer = 0;
    let d;
    try { d = draftText(p); } catch (e) { d = { text: null }; console.error('[editor] draft text', e); }
    if (typeof d.text !== 'string') { p.draft = 'failed'; publishState(p); return; }
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
    const draft = { text, baselineHash: p.baselineHash ?? null, mode: publicMode(p), exact: !!exact, rev: p.rev };
    // Set before the write, so a drop issued meanwhile is not skipped for a draft that is on
    // its way (the chain puts that drop after this write). Cleared only by a confirmed drop.
    p.hasDraft = true;
    return draftOp(p, async () => {
      const path = p.path;
      if (!await keepRecovered(p)) {
        p.draft = 'failed';
        log(`draft not written ${path}: the recovered draft in its place is not in Versions`, 'warn');
        publishState(p);
        return;
      }
      try {
        await pageFiles.drafts.write(path, { path, ...draft });
        p.draftAt = Date.now();
        p.draft = 'written';
      } catch (e) {
        p.draft = 'failed';
        log(`draft failed ${path}: ${errCode(e)} ${errText(e)}`, 'warn');
      }
      publishState(p);
    });
  }

  /**
   * Drop the page's draft: after a save that left it clean (`rev`, so a newer draft written
   * meanwhile stays), after Discard and after Reload from disk (no `rev`: always). Queued behind
   * any draft write already issued.
   */
  function dropDraft(p, rev) {
    clearTimeout(p.draftTimer);
    p.draftTimer = 0;
    return draftOp(p, async () => {
      if (!p.hasDraft) return;
      if (!await keepRecovered(p)) return;
      try {
        const r = await pageFiles.drafts.drop(p.path, rev === undefined ? undefined : { ifRev: rev });
        // A newer draft than this save stays, and so does the flag that says there is one.
        if (r && r.dropped === false && rev !== undefined) return;
        p.hasDraft = false;
        p.draft = null;
      } catch (e) {
        if (errCode(e) !== 'unknown_command') { log(`draft not dropped ${p.path}: ${errCode(e)} ${errText(e)}`, 'warn'); return; }
        p.hasDraft = false;
        p.draft = null;
      }
      publishState(p);
    });
  }

  // -------------------------------------------------------------------------
  // the meta line

  /**
   * S32: the count comes from the ProseMirror document, and only when `recount` says so:
   * markDirty repaints the line immediately with the number it already has and schedules the
   * recount on the same debounce as the save.
   */
  function updateMeta(p, recount = false) {
    if (!p.metaText) return;
    if (recount) {
      const text = pageText(p);
      p.words = countWords(text);
      p.chars = text.length;
    }
    const n = (v) => v.toLocaleString('en');
    const bits = [];
    // A file with no title of its own says its name; a page's folder is in the breadcrumb.
    if (p.plain) bits.push(P.basename(p.path));
    bits.push(`${n(p.words)} word${p.words === 1 ? '' : 's'}`);
    bits.push(`${n(p.chars)} character${p.chars === 1 ? '' : 's'}`);
    const when = modifiedLabel(p.mtime);
    if (when) bits.push(when);
    const linked = backlinkCount(p.path);
    if (linked) bits.push(`${linked} linked`);
    if (p.deleted) bits.push('(deleted)');
    if (p.dirty) bits.push('unsaved');
    else if (p.savedAt) bits.push('saved ' + p.savedAt);
    p.metaText.textContent = bits.join('  ·  ');
    setStatus('doc', `${n(p.words)} word${p.words === 1 ? '' : 's'}`);
  }

  /**
   * The text the counts are taken from: the title and the body, never the frontmatter. From the
   * ProseMirror document itself (never a serialisation) in block mode, from the buffer in source
   * mode, from the file before either is mounted.
   */
  function pageText(p) {
    try {
      if (p.source) return p.source.viewText();
      const view = p.crepe ? editorView(p.crepe) : null;
      if (view) {
        const doc = view.state.doc;
        return `${p.title || ''} ${doc.textBetween(0, doc.content.size, '\n', ' ')}`;
      }
    } catch (e) { console.error('[editor] word count', e); }
    return `${p.title || ''} ${p.doc ? p.doc.body : ''}`;
  }

  // -------------------------------------------------------------------------
  // external changes (C7, H9)

  /**
   * Something touched the open file from outside (the watcher). The whole batch is read, and
   * the last change about this page wins; a rename onto the page's path is a modify. Renames
   * and trashes of our own making are ignored while they are in flight (`moving`); after
   * them the page already has its new path and the echo reads back the same hash.
   */
  function onFsChange(payload) {
    const p = page;
    if (!p || !payload || p.trashed || !p.path) return;
    let hit = null;
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
    if (p !== page || p.trashed) return;
    if (p.saving) { try { await p.saving; } catch { /* reported */ } }
    const before = p.baselineHash;
    let file;
    try {
      file = await pageFiles.readFile(p.path);
    } catch (e) {
      if (errCode(e) === 'not_found') goneCheck(p);
      return;
    }
    if (p !== page || p.trashed) return;
    // A save landed while the read was out: the answer is about the old baseline. Ask again.
    if (p.saving || p.baselineHash !== before) { if (depth < 3) void checkDisk(p, depth + 1); return; }
    if (p.deleted) { p.deleted = false; publishState(p); updateMeta(p); }
    if (!file || typeof file.text !== 'string') return;
    if ((file.hash != null && file.hash === p.baselineHash) || file.text === p.baseline) {
      if (file.hash != null) p.baselineHash = file.hash;
      return;
    }
    // The overlap the banner already shows: nothing new to merge.
    if (p.conflict && file.hash != null && file.hash === p.conflict.hash) return;
    if (Number(file.mtime)) p.mtime = Number(file.mtime);
    // H7: a clean page takes the disk in place; a dirty one merges it (`mergeExternal`).
    await mergeExternal(p, { text: file.text, hash: file.hash ?? null });
  }

  /**
   * The file is not where the page says. A sync client replacing it, or a folder blinking, is
   * not a deletion: look again in a moment, and only then say so (C7).
   */
  function goneCheck(p) {
    if (p.goneTimer || p.trashed) return;
    p.goneTimer = setTimeout(async () => {
      p.goneTimer = 0;
      if (p !== page || p.trashed) return;
      let there = true;
      try { there = !!(await bridge.exists(p.path)); } catch { there = true; }
      if (p !== page) return;
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
    if (p.dirty) void writeDraft(p);
    updateMeta(p);
    publishState(p);
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
    void renameRemembered(from, to);
    publishTitle(p);
    updateMeta(p);
    publishState(p);
    if (!parked) toast(`moved on disk: ${from} → ${to}`);
    if (typeof ose.route.repoint === 'function') { repointRoute([{ from, to }]); return; }
    // A kernel with no re-point: the old way, a remount at the new path, which saves first. A
    // parked page is not on screen to remount: it follows the path and waits for its tab.
    if (!parked) void navigate({ type: 'page', path: to }, { replace: true });
  }

  /**
   * Reopen the page from disk in the same host, keeping the scroll position and the caret (E39).
   * The undo history does not survive: the document the editor is rebuilt from is a different
   * one. The page must be clean: a dirty one is not replaced.
   */
  async function reopenInPlace(p) {
    if (p !== page || !p.el) return;
    const scroller = scrollerOf(el);
    const top = scroller ? scroller.scrollTop : 0;
    const sel = currentSelection();
    const line = p.source ? p.source.view.state.doc.lineAt(p.source.view.state.selection.main.head).number : 0;
    await run(p.path, sel ? { selection: sel } : {});
    if (scroller) scroller.scrollTop = top;
    if (line && page && page.source) page.source.goToLine(line);
  }

  // -------------------------------------------------------------------------
  // what the commands do to this page

  /** The heading picker (C2). The title row scrolls to the top; a body heading takes the caret. */
  async function outlinePage() {
    const p = page;
    if (!p || !p.crepe) return;
    const view = editorView(p.crepe);
    if (!view) return;
    await pickHeading({
      view,
      title: p.doc.titleLine !== null ? p.title : null,
      onTitle: () => { if (p === page) focusTitle(p); },
    });
  }

  /**
   * Insert a link to another page at the caret. The palette has just closed, so the editor is
   * focused first: the link goes where the caret was left.
   */
  async function linkPage() {
    const p = page;
    if (!p || !p.crepe) return;
    const view = editorView(p.crepe);
    if (!view) return;
    view.focus();
    await insertPageLink(view);
  }

  /**
   * A new page is `Untitled.md` until it has a title (C12): once the H1 is edited and left, the
   * file takes the title as its name, through the one rename there is (`ose.fileops`, H13). The
   * page keeps its own extension; only files still named `Untitled*` are renamed this way. One
   * name per file (M13): this runs only when the vault setting `titleSync` asks for it.
   */
  async function renameUntitledFromTitle(p) {
    if (!titleSyncOn()) return false;
    if (p !== page || p.deleted || p.trashed || !p.doc || p.doc.titleLine === null) return false;
    if (!UNTITLED.test(P.stem(p.path))) return false;
    const title = cleanStem(p.title);
    if (!title || UNTITLED.test(title)) return false;
    const ext = P.extname(p.path);
    const name = ext ? `${title}.${ext}` : title;
    if (name === P.basename(p.path)) return false;
    const ops = fileops();
    if (!ops || typeof ops.rename !== 'function') return false;
    try {
      const r = await ops.rename(p.path, name);
      reportLinks(r && r.links);
      return true;
    } catch (e) {
      // The title stays as typed either way; only the file name is at stake.
      if (errCode(e) === 'exists') toast(`${name} already exists; the file keeps its name`, 'warn');
      else if (errCode(e) !== 'not_saved') toast(`could not rename the file: ${errText(e)}`, 'err');
      return false;
    }
  }

  /** The file text as a save would write it, on the clipboard (C14). */
  async function copyMarkdown() {
    const p = page;
    if (!p) return;
    let r;
    try { r = composeChecked(p); } catch (e) { r = { status: 'unsafe', text: null, reason: errText(e) }; }
    const text = typeof r.text === 'string' ? r.text : bestEffort(p);
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
    const p = page;
    if (!p) return false;
    const base = P.basename(p.path);
    const dot = base.lastIndexOf('.');
    const start = p.path.length - base.length;
    const answer = await prompt({
      title: 'Save as', value: p.path, ok: 'Save',
      body: 'A path in the vault. The file there must not exist yet; the old one is left as it is.',
      select: [start, start + (dot > 0 ? dot : base.length)],
    });
    if (!answer || p !== page) return false;
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
    try { r = composeChecked(p); } catch (e) { r = { status: 'unsafe', text: null, reason: errText(e) }; }
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
    if (p !== page) return false;
    const from = p.path;
    const dest = String((res && res.path) || to);
    await dropDraft(p);
    p.path = dest;
    p.deleted = false;
    p.problem = null;
    p.recovered = null;
    p.baseline = text;
    p.baselineHash = (res && res.hash) ?? null;
    p.savedAt = P.hhmm();
    p.savedAtMs = Date.now();
    if (p.source && !p.forced) void rememberSource(dest, true);
    log(`save ok ${dest} (save as, from ${from})`, 'info');
    if (typeof ose.route.repoint === 'function') repointRoute([{ from, to: dest }]);
    publishTitle(p);
    if (p.rev === rev) settleClean(p, rev); else publishState(p);
    toast(`saved as ${dest}`);
    if (!parked && (typeof ose.route.repoint !== 'function' || P.isMarkdown(from) !== P.isMarkdown(dest))) {
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
    const p = page;
    if (!p) return false;
    if (!p.dirty) {
      if (p.recovered) {
        // The offered draft went to Versions at open; when that failed, it is tried once more,
        // and the question says plainly whether the text survives the discard.
        const kept = await keepRecovered(p);
        if (p !== page || !p.recovered) return true;
        const ok = await confirm({
          title: 'Discard recovered changes?',
          body: kept
            ? 'The page stays as the file on disk. The recovered text is kept in Versions….'
            : 'The page stays as the file on disk. The recovered text could not be kept in Versions and will be lost.',
          ok: 'Discard', danger: true,
        });
        if (!ok || p !== page || !p.recovered) return false;
        // The slot may hold the draft only while it is not in Versions: a failed keep leaves
        // it, and the user said to let it go, so it goes without the check.
        if (!kept) p.recovered.kept = true;
        await dropDraft(p);
        p.recovered = null;
        publishState(p);
        toast('recovered changes discarded');
      }
      return true;
    }
    const ok = await confirm({
      title: 'Discard unsaved changes?',
      body: p.deleted
        ? 'The file is gone from disk; the text on screen goes too.'
        : 'The page goes back to the file on disk. What you discard is kept in Versions….',
      ok: 'Discard', danger: true,
    });
    if (!ok || p !== page) return false;
    if (!p.deleted) {
      let d = null;
      try { d = draftText(p); } catch { d = null; }
      if (d && typeof d.text === 'string') await keepBuffer(p, d.text);
    }
    await dropDraft(p);
    clearTimeout(p.saveTimer);
    p.problem = null;
    p.conflict = null;
    p.merged = null;
    p.recovered = null;
    setDirty(p, false);
    log(`discarded changes ${p.path}`, 'info');
    if (p.deleted || p !== page) { publishState(p); return true; }
    await reopenInPlace(p);
    return true;
  }

  /** `page.recovered-compare`: the disk against the recovered draft, side by side. */
  async function recoveredCompare() {
    const p = page;
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
    const p = page;
    const r = p && p.recovered;
    if (!r || r.applied) return false;
    const mode = !p.plain && r.exact && r.mode === 'rich' ? 'rich' : 'source';
    r.applied = true;
    const ok = await setMode(mode, { text: r.text, quiet: true });
    if (p !== page) return false;
    if (!ok && !p.source) { r.applied = false; publishState(p); return false; }
    p.rev = ++revClock;
    setDirty(p, true);
    // The draft was typed over an older text than the disk holds, and that text is gone: there
    // is nothing to merge against. The page holds it as an overlap with the disk, and the
    // resolve view (Keep both, Keep mine, Take theirs) decides.
    holdConflict(p, { theirs: p.baseline, hash: p.baselineHash, count: 0, base: null });
    return true;
  }

  function focusPage() {
    const p = page;
    if (!p) return;
    if (p.source) { p.source.focus(); return; }
    if (p.crepe) { const view = editorView(p.crepe); if (view) { view.focus(); return; } }
    if (p.titleEl) p.titleEl.focus();
  }

  // -------------------------------------------------------------------------
  // the api the extension modules and the commands act through

  const api = {
    hasPage: () => !!page,
    getPage: () => page,
    getView: () => (page && page.crepe ? editorView(page.crepe) : null),
    getCrepe: () => (page ? page.crepe : null),
    getPath: () => (page ? page.path : null),
    getDoc: () => (page ? page.doc : null),
    focusTitle: () => { if (page) focusTitle(page); },
    focusBody: () => focusBody(),
    markDirty: () => { if (page) markDirty(page); },
    // A module that changed the document through a transaction the user asked for. There is
    // no "touched" gate any more (M5): it is the same as markDirty, kept for the modules.
    touch: () => { if (page) markDirty(page); },
    saveNow: (o) => saveNow(o),
    // The router saves this when a page is left and hands it back at the next open (N44, P7);
    // backlinks.js asks for a repaint when its count changes (N6).
    getSelection: () => currentSelection(),
    updateMeta: () => { if (page) updateMeta(page); },
    reopenInPlace: () => (page ? reopenInPlace(page) : Promise.resolve()),
    attachFile: (file) => (page ? attachFile(page, file) : Promise.reject(new Error('no page'))),
    // The find bar of the open page, whichever kind it is.
    openFind: (o) => { if (page && page.find) page.find.open(o || {}); },
    // Batch 12 (P5) and H14: the two views.
    isSource: () => !!(page && page.source),
    isMarkdown: () => !!(page && !page.plain),
    toggleSource: () => toggleSource(),
    setMode: (mode) => setMode(mode),
    // K1c: what the page-level commands do, so they can live at module level and act on
    // whichever page has the focus.
    hasCrepe: () => !!(page && page.crepe),
    isReadOnly: () => !!(page && (page.readOnly || page.frozen)),
    folder: () => (page ? P.dirname(page.path) : null),
    copyMarkdown: () => copyMarkdown(),
    link: () => linkPage(),
    outline: () => outlinePage(),
    find: (o) => { if (page && page.find) page.find.open(o || {}); },
    reveal: () => { if (page) void bridge.reveal(page.path); },
    // Wave 1 (H8, C4, C7): the save state and what the banner's buttons do.
    status: () => statusOf(page),
    isDirty: () => !!(page && page.dirty),
    hasRecovered: () => !!(page && page.recovered),
    recoveredApplied: () => !!(page && page.recovered && page.recovered.applied),
    saveAs: () => saveAs(),
    discardChanges: () => discardChanges(),
    showProblem: () => focusBanner(page),
    recoveredCompare: () => recoveredCompare(),
    recoveredRestore: () => recoveredRestore(),
    // Wave 2 (H7): an overlap with the disk, and a merge that happened.
    hasConflict: () => !!(page && page.conflict),
    conflictIsText: () => !!(page && page.conflict && typeof page.conflict.theirs === 'string'),
    hasMerge: () => !!(page && page.merged),
    canUndoMerge: () => canUndoMerge(page),
    mergeResolve: () => resolveMerge(page),
    mergeKeepMine: () => keepMine(page),
    mergeTakeTheirs: () => takeTheirs(page),
    mergeUndo: () => undoMerge(page),
    mergeShow: () => showMerge(page),
  };
  inst.api = api;

  // -------------------------------------------------------------------------
  // the instance itself

  /** Say everything the status bar and the window title want, as the active page. */
  function repaint() {
    if (!page) return;
    publishTitle(page);
    page.lastSave = '';
    paintSave(page);
    paintMode(page);
    updateMeta(page);
  }
  inst.repaint = repaint;

  /** Become the page the commands and the status bar belong to. */
  function take() {
    if (activeInstance() === inst) return;
    setActive(inst);
    repaint();
  }

  /** Hand the bar and the commands to whatever else is on screen, if anything is. */
  function release() {
    if (activeInstance() !== inst) return;
    let next = null;
    for (const other of instances) { if (other !== inst && !other.parked) { next = other; break; } }
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
    if (closed || parked) return true;
    const scroller = scrollerOf(el);
    parkScroll = scroller ? scroller.scrollTop : 0;
    parkFocus = !!(document.activeElement && el.contains(document.activeElement));
    const holder = document.createElement('div');
    holder.className = 'ed-parked';
    while (el.firstChild) holder.append(el.firstChild);
    el = holder;
    parked = true;
    inst.usedAt = Date.now();
    const p = page;
    if (p && p.bindParent) p.bindParent();
    if (activeInstance() === inst) {
      status.set('doc', null);
      status.set('save', null);
      status.set('mode', null);
      store.set('pageTitle', null);
    }
    release();
    if (p && p.dirty && !p.saving) {
      clearTimeout(p.saveTimer);
      p.saveTimer = 0;
      void saveDoc(p).then((ok) => { if (!ok && p === page && p.dirty) void writeDraft(p); });
    }
    // The cap is a memory budget: the least recently used clean pages past it are let go.
    for (const other of overCap()) { if (other !== inst) void other.handle.close(); }
    return true;
  }

  /**
   * Back on screen, in `host`: the same column, buffer, undo history and mode. The scroll it
   * was left at comes back, and the focus when it had it; a `line` or a `query` the router
   * hands over wins over the old scroll, as it does at an open.
   */
  function reattach(host, o = {}) {
    if (closed || !parked) return;
    const holder = el;
    host.innerHTML = '';
    while (holder.firstChild) host.append(holder.firstChild);
    el = host;
    parked = false;
    inst.usedAt = Date.now();
    const p = page;
    if (p && p.bindParent) p.bindParent();
    take();
    if (p) {
      p.lastBanner = '';
      publishState(p);
      if (p.source) { try { p.source.view.requestMeasure(); } catch { /* not laid out yet */ } }
    }
    const scroll = parkScroll;
    const focus = parkFocus;
    afterLayout(() => {
      if (parked || closed || p !== page) return;
      if (p && o.line) { scrollToLine(o.line, o.col); openFindWith(p, o.query); return; }
      if (focus) focusPage();
      const scroller = scrollerOf(el);
      if (scroller) scroller.scrollTop = scroll;
      if (p) openFindWith(p, o.query);
    });
  }

  /** Destroy this instance, saving first. False when its text could not be saved. */
  function letGo() {
    return handle.close();
  }

  // -------------------------------------------------------------------------
  // links into an open page (H5, §4.8)

  /**
   * The kernel moved files (`pairs`, `[{from, to}]`) and asks this page, which holds `target`,
   * to rewrite its links instead of the file on disk being written behind it. Source mode
   * applies `ose.links.planRewrite` as one CodeMirror change; the rich view rewrites the link
   * marks and images whose target moved, in one ProseMirror transaction. Either is an edit of
   * its own in the undo history: the page is dirty, and autosave writes it through the guard
   * as always. `o.settled`: this file's own hrefs were already rewritten for the move, so only
   * links into the moved files are looked at (the kernel's second pass).
   * @returns {Promise<{handled: boolean, changed?: number, failed?: string}>}
   */
  async function rewriteLinks(target, pairs, o = {}) {
    const p = page;
    if (!p || closed || p.trashed) return { handled: false };
    const list = (Array.isArray(pairs) ? pairs : [])
      .map((x) => ({ from: P.normalize(String((x && x.from) || '')), to: P.normalize(String((x && x.to) || '')) }))
      .filter((x) => x.from && x.to && x.from !== x.to);
    // A file that is not markdown holds no markdown links; the disk path leaves it alone too.
    if (!list.length || p.plain) return { handled: true, changed: 0 };
    try {
      if (p.source) {
        for (let round = 0; round < 2; round++) {
          const text = p.source.getText();
          const splices = await planRewrite(text, target, list, o);
          if (splices === null) return { handled: false };
          if (p !== page || !p.source) return { handled: false };
          // The buffer moved while the plan was being made: plan again over what is there now.
          if (p.source.getText() !== text) continue;
          if (!splices.length) return { handled: true, changed: 0 };
          let out = text;
          for (const sp of [...splices].sort((a, b) => b.from - a.from)) out = out.slice(0, sp.from) + sp.insert + out.slice(sp.to);
          p.source.replaceText(out, { edit: true });
          log(`links rewritten in the open page ${target}: ${splices.length}`, 'info');
          return { handled: true, changed: splices.length };
        }
        return { handled: true, changed: 0, failed: `${target} kept changing while its links were rewritten` };
      }
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return { handled: false };
      const changed = rewriteRich(view, target, list, o);
      if (changed) log(`links rewritten in the open page ${target}: ${changed}`, 'info');
      return { handled: true, changed };
    } catch (e) {
      log(`links not rewritten in the open page ${target}: ${errText(e)}`, 'warn');
      return { handled: true, changed: 0, failed: errText(e) };
    }
  }

  /**
   * The rich half of `rewriteLinks`, the same decisions the kernel's disk path makes
   * (links.js `rewriteInboundMany`): a href is resolved against where the page was written
   * (its old path when the page itself moved), and rewritten relative to where it is now when
   * its target moved, or when the page moved and the href would otherwise stop resolving. A
   * vault-root href (`/…`) is left as the disk path leaves it. Answers how many links
   * changed; nothing is dispatched when none did.
   */
  function rewriteRich(view, target, list, o) {
    const toFor = new Map(list.map((x) => [x.from, x.to]));
    const fromFor = o && o.settled ? new Map() : new Map(list.map((x) => [x.to, x.from]));
    const was = fromFor.get(target) || target;
    const moved = was !== target;
    const nextHref = (href) => {
      const raw = String(href ?? '').trim();
      if (!raw || P.isExternal(raw)) return null;
      const at = raw.search(/[#?]/);
      const base = at < 0 ? raw : raw.slice(0, at);
      const tail = at < 0 ? '' : raw.slice(at);
      if (!base) return null;
      const t = P.resolveHref(was, base);
      if (t === null) return null;
      if (!moved && base.startsWith('/')) return null;
      const to = toFor.get(t);
      if (!to && !moved) return null;
      if (!to && base.startsWith('/')) return null;
      const n = P.relativeHref(target, to || t) + tail;
      return n === raw ? null : n;
    };
    const { state } = view;
    const tr = state.tr;
    let changed = 0;
    let lastMark = null;
    let lastEnd = -1;
    state.doc.descendants((node, pos) => {
      if (node.isText) {
        for (const m of node.marks) {
          if (m.type.name !== 'link') continue;
          const n = nextHref(m.attrs.href);
          if (n === null) continue;
          const end = pos + node.nodeSize;
          tr.removeMark(pos, end, m);
          tr.addMark(pos, end, m.type.create({ ...m.attrs, href: n }));
          // One link over several text nodes (a bold word inside it) is counted once.
          if (!(lastMark && lastMark.eq(m) && lastEnd === pos)) changed++;
          lastMark = m;
          lastEnd = end;
        }
        return false;
      }
      const name = node.type.name;
      if ((name === 'image' || name === 'image-block') && typeof node.attrs.src === 'string') {
        const n = nextHref(node.attrs.src);
        if (n !== null) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: n }); changed++; }
      }
      return true;
    });
    if (changed) view.dispatch(closeHistory(tr));
    return changed;
  }

  /**
   * One open at a time, in order: a second call waits for the first rather than racing it.
   * The queue itself never holds a rejection — an open that throws is reported and the next
   * one still runs — but the caller's promise keeps it, so a router can say what failed.
   */
  function run(nextPath, options) {
    const next = opening.catch(() => {}).then(() => open(nextPath, options));
    opening = next.catch((e) => { console.error('[editor] open', e); });
    return next;
  }

  const handle = {
    get el() { return el; },
    get path() { return page ? page.path : null; },
    get dirty() { return !!(page && page.dirty); },
    /** 'rich' | 'source': the public words; the internal 'block' stays internal. */
    get mode() { return publicMode(page); },
    get state() { return page ? stateOf(page) : null; },
    get readOnly() { return !!(page && page.readOnly); },
    get ready() { return opening; },
    open: (nextPath, options = {}) => run(nextPath, options),
    /** May the page be left? A dirty page saves first; false keeps it, with its banner (§6.2). */
    canLeave: (reason) => canLeave(reason),
    /** A yes from `canLeave` froze the page; the leave did not happen after all. */
    stay: () => stay(),
    /** `canLeave`, then the teardown. False: the page is kept and nothing was torn down. */
    close: async () => {
      if (closed) return true;
      try { await opening; } catch { /* the open already said so */ }
      if (!await canLeave('close')) return false;
      if (closed) return true;
      if (!await closePage()) return false;
      closed = true;
      instances.delete(inst);
      releaseCommands();
      return true;
    },
    /**
     * The tab went to the background (M12): the column leaves the document and the editor stays
     * alive, to be put back by the next `markdownPage` of this path. Always true.
     */
    park: () => park(),
    get parked() { return parked; },
    /** True only when the disk holds the buffer afterwards. */
    save: (o) => saveNow(o),
    focus: () => focusPage(),
    find: (query) => { if (page && page.find) page.find.open(query ? { query } : {}); },
    goToLine: (line, col) => scrollToLine(line, col),
    selection: () => currentSelection(),
    on,
  };
  inst.handle = handle;

  instances.add(inst);
  take();
  acquireCommands();
  wireGlobals();
  void run(path, opts);
  return handle;
}

/**
 * @typedef {object} DocState
 * @property {string} path
 * @property {'clean'|'dirty'|'saving'|'not-saved'|'conflict'|'deleted'} status
 * @property {boolean} dirty
 * @property {null|'write-failed'|'unsafe'|'stale-vault'|'overlap'|'gone'|'read-only'} reason
 *   `overlap` (wave 2, H7): the disk changed lines the buffer changed too; nothing was merged
 * @property {string|null} message   one sentence, for the tab tooltip and the banner
 * @property {null|'written'|'failed'} draft
 * @property {'rich'|'source'} mode
 * @property {number|null} savedAt
 */

// ---------------------------------------------------------------------------
// module level: the things one document has one of

const anchorAt = (e) => (e.target instanceof Element ? e.target.closest('a[href], a.link-display') : null);
const inTooltip = (a) => !!a.closest('.milkdown-link-preview, .milkdown-link-edit');

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(fr.error || new Error('read failed'));
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.readAsDataURL(file);
});

/**
 * A file name's stem from free text (a title): no path separators, no characters Windows
 * refuses, no control characters, no trailing dot or space. The extension is the caller's.
 */
const cleanStem = (text) => String(text ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .replace(/[\\/:*?"<>|]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[. ]+$/, '');

/** `modified today` / `modified yesterday` / `modified 9 Sep 2026`. Empty for a file with no mtime. */
function modifiedLabel(mtime) {
  const ms = Number(mtime) || 0;
  if (!ms) return '';
  const d = new Date(ms);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = day(new Date());
  if (day(d) === today) return 'modified today';
  if (day(d) === today - 86_400_000) return 'modified yesterday';
  return 'modified ' + d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** `14:02` today, `9 Sep 14:02` another day: when a draft was written. */
function whenLabel(at) {
  const d = new Date(Number(at) || Date.now());
  const time = P.hhmm(d);
  const same = new Date().toDateString() === d.toDateString();
  return same ? time : `${d.toLocaleDateString('en', { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * What a rename did to the links that pointed at the old name (C13): a count, and one toast
 * per page whose rewrite failed — a count that silently leaves a broken link out is worse
 * than no count (QA F21).
 */
function reportLinks(r) {
  if (!r) return;
  const links = Number(r.links) || 0;
  const files = Number(r.files) || 0;
  if (links > 0) toast(`renamed · ${links} link${links === 1 ? '' : 's'} in ${files} page${files === 1 ? '' : 's'} updated`);
  for (const f of r.failed || []) toast('could not update links in ' + (f && f.path ? f.path : f), 'err');
  if (r.error) toast('renamed, but the links to it could not be updated: ' + r.error, 'warn');
}

/**
 * Two frames, or 80ms, whichever comes first — and exactly once. A hidden window fires no
 * animation frames at all, so a bare `requestAnimationFrame` chain would never run.
 */
function afterLayout(fn) {
  let done = false;
  const once = () => { if (done) return; done = true; fn(); };
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, 80);
}

// ---------------------------------------------------------------------------
// the listeners one document has one of

let globalsWired = false;

function wireGlobals() {
  if (globalsWired) return;
  globalsWired = true;
  // link.js turns a picked page into an href relative to the page being edited.
  bindPagePath(() => (activeInstance() ? activeInstance().path() : null));
  // The bridge facade already re-emits 'fs' onto the bus; listening to both would reload twice.
  bus.on('fs', (payload) => { for (const i of [...instances]) i.onFsChange(payload); });
  // Spellcheck is a setting now (L12/E43): a page already open follows a change to it.
  bus.on('settings', () => { for (const i of [...instances]) i.applySpellcheck(); });
  // C5: the one leave gate. Closing the window, reloading it and switching vaults all await
  // this, and a false keeps the window (docs/KERNEL.md `ose.window.onLeave`). The pages that
  // said yes stay frozen until the kernel says the window stays after all.
  onWindowLeave(() => leaveAll());
  bus.on('window:stay', () => { for (const i of [...instances]) i.stay(); });
  // No save can finish in `beforeunload`; a draft can be started, and the browser is asked to
  // keep the page. The leave gate above is the path that saves.
  window.addEventListener('beforeunload', (e) => {
    let any = false;
    for (const i of [...instances]) if (i.isDirty()) { any = true; void i.writeDraft(); }
    if (any) { e.preventDefault(); e.returnValue = ''; }
  });
  // A window that is hidden may be the last thing that happens to it (logout, a killed process).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    for (const i of [...instances]) if (i.isDirty()) { void i.writeDraft(); void i.save(); }
  });
}

/** Every page lets the window go, or the window stays. False if any page says no. */
async function leaveAll() {
  let ok = true;
  for (const i of [...instances]) {
    let answer = true;
    try { answer = await i.leaveWindow(); } catch (e) { console.error('[editor] leave', e); answer = false; }
    if (answer === false) ok = false;
  }
  return ok;
}

/**
 * Save every mounted page. False if any page answered false (§6.2).
 * @param {{explicit?: boolean, closing?: boolean}} [opts]
 */
export async function saveAll(opts) {
  let ok = true;
  for (const i of [...instances]) {
    let answer = true;
    try { answer = await i.save(opts); } catch (e) { console.error('[editor] save all', e); answer = false; }
    if (answer === false) ok = false;
  }
  return ok;
}

/**
 * Before a rename, move, trash or copy of `from` (a file, or a folder: every page under it),
 * each mounted page at or under it is flushed (§6.3). One refusal refuses the whole change,
 * and the pages that had already agreed are told it did not happen.
 * @param {{kind: 'rename'|'move'|'trash'|'copy', from: string, to: string|null}} change
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function beforePathChange(change) {
  if (!change || !change.from) return { ok: true };
  const agreed = [];
  for (const i of [...instances]) {
    if (!i.covers(change.from)) continue;
    let r;
    try { r = await i.beforePathChange(change); } catch (e) { r = { ok: false, reason: errText(e) }; }
    if (!r || r.ok === false) {
      for (const a of agreed) { try { await a.afterPathChange({ ...change, ok: false }); } catch { /* told */ } }
      return { ok: false, reason: (r && r.reason) || 'a page has unsaved changes that could not be saved' };
    }
    agreed.push(i);
  }
  return { ok: true };
}

/**
 * After the host call, whether it succeeded (`ok`) or not: the pages that were asked follow
 * the new path, stay as they were, or let go of a trashed file (§6.3).
 * @param {{kind: string, from: string, to: string|null, ok: boolean}} change
 */
export async function afterPathChange(change) {
  if (!change || !change.from) return;
  for (const i of [...instances]) {
    try { await i.afterPathChange(change); } catch (e) { console.error('[editor] afterPathChange', e); }
  }
}

/**
 * `PageHost.release(path)` (M12): the parked instance of `path` is saved and destroyed, as a
 * background tab showing it is closed. True when there is none, or it went; false when its text
 * could not be saved, and then it stays, with its banner, for the tab to show again.
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function releasePage(path) {
  const inst = findParked(P.normalize(String(path ?? '')));
  if (!inst) return true;
  try { return (await inst.handle.close()) !== false; } catch (e) {
    console.error('[editor] release', e);
    return false;
  }
}

/**
 * The paths of the parked instances, most recently used first (M12).
 * @returns {string[]}
 */
export function parkedPaths() { return parkedList(); }

/**
 * `PageHost.rewriteLinksIn(path, pairs)` (H5, §4.8): the links of an open page — on screen or
 * parked — into files that moved are rewritten in the editor, as an edit of the page, instead of
 * the file being written on disk behind it. `{handled: false}` when no page holds `path`: the
 * kernel then rewrites the file on disk as before. `opts.settled`: the kernel's second pass,
 * where the file's own hrefs were already rewritten for the move.
 * @param {string} path
 * @param {Array<{from: string, to: string}>} pairs
 * @param {{settled?: boolean}} [opts]
 * @returns {Promise<{handled: boolean, changed?: number, failed?: string}>}
 */
export async function rewriteLinksIn(path, pairs, opts = {}) {
  const target = P.normalize(String(path ?? ''));
  if (!target) return { handled: false };
  for (const i of [...instances]) {
    if (!i.holds(target)) continue;
    try { return await i.rewriteLinks(target, pairs, opts || {}); } catch (e) {
      return { handled: true, changed: 0, failed: errText(e) };
    }
  }
  return { handled: false };
}

// ---------------------------------------------------------------------------
// the commands
//
// Registered when the first page mounts and removed when the last one closes, plus one
// reference `holdPageCommands()` holds for the shell, so `page.new` is there with no page open.

let cmdRefs = 0;
let dropCommands = null;

const hasPage = () => !!(activeInstance() && activeInstance().api.hasPage());
const pageStatus = () => (activeInstance() ? activeInstance().api.status() : 'clean');

/**
 * What the extension modules (extensions.js) get of the open page. Accessors, never the object
 * itself, because the page is replaced on every open and the *instance* is replaced when the
 * focus moves. They go through this and do not import page.js, so the graph stays a tree.
 */
const editorApi = {};
for (const name of [
  'hasPage', 'getPage', 'getView', 'getCrepe', 'getPath', 'getDoc', 'focusTitle', 'focusBody',
  'markDirty', 'touch', 'saveNow', 'getSelection', 'updateMeta', 'reopenInPlace', 'attachFile',
  'openFind', 'isSource', 'isMarkdown', 'toggleSource', 'setMode', 'hasCrepe', 'isReadOnly', 'folder',
  'copyMarkdown', 'link', 'outline', 'find', 'reveal', 'status', 'isDirty', 'hasRecovered',
  'recoveredApplied', 'saveAs', 'discardChanges', 'showProblem', 'recoveredCompare', 'recoveredRestore',
  'hasConflict', 'conflictIsText', 'hasMerge', 'canUndoMerge', 'mergeResolve', 'mergeKeepMine',
  'mergeTakeTheirs', 'mergeUndo', 'mergeShow',
]) {
  editorApi[name] = (...args) => {
    const a = activeApi();
    if (!a) {
      if (name === 'saveNow') return Promise.resolve(true);
      return ['hasPage', 'isSource', 'isMarkdown', 'hasCrepe', 'isDirty', 'hasRecovered', 'recoveredApplied',
        'hasConflict', 'conflictIsText', 'hasMerge', 'canUndoMerge'].includes(name)
        ? false : undefined;
    }
    return a[name](...args);
  };
}

export function acquireCommands() {
  if (cmdRefs++ > 0) return releaseCommands;
  dropCommands = collectCommands(() => registerCommands());
  return releaseCommands;
}

export function releaseCommands() {
  if (cmdRefs === 0) return;
  if (--cmdRefs > 0) return;
  if (dropCommands) dropCommands();
  dropCommands = null;
}

function registerCommands() {
  registerExtensionCommands(editorApi);
  commands.register({
    id: 'page.new', title: 'New page', group: 'page', shortcut: 'Ctrl+N',
    run: () => newPage(),
  });
  // C5: the promise is the answer. Ctrl+S, the banner's Try again and the leave gate all wait
  // on it, and it is true only when the disk holds the page.
  commands.register({
    id: 'page.save', title: 'Save page', group: 'page', shortcut: 'Ctrl+S',
    when: hasPage, run: () => editorApi.saveNow({ explicit: true }),
  });
  commands.register({
    id: 'page.save-as', title: 'Save as…', group: 'page',
    when: hasPage, run: () => editorApi.saveAs(),
  });
  commands.register({
    id: 'page.discard-changes', title: 'Discard unsaved changes', group: 'page',
    when: () => hasPage() && (editorApi.isDirty() || editorApi.hasRecovered()),
    run: () => editorApi.discardChanges(),
  });
  commands.register({
    id: 'page.show-problem', title: 'Show why the page is not saved', group: 'page',
    when: () => hasPage() && ['not-saved', 'conflict', 'deleted'].includes(pageStatus()),
    run: () => editorApi.showProblem(),
  });
  commands.register({
    id: 'page.recovered-compare', title: 'Compare recovered changes', group: 'page',
    when: () => hasPage() && editorApi.hasRecovered(),
    run: () => editorApi.recoveredCompare(),
  });
  commands.register({
    id: 'page.recovered-restore', title: 'Restore recovered changes', group: 'page',
    when: () => hasPage() && editorApi.hasRecovered() && !editorApi.recoveredApplied(),
    run: () => editorApi.recoveredRestore(),
  });
  // H7: a change made on disk. The banner's buttons run these, and so does the palette.
  commands.register({
    id: 'page.merge-resolve', title: 'Resolve changes made on disk', group: 'page',
    when: () => hasPage() && editorApi.hasConflict() && editorApi.conflictIsText(),
    run: () => editorApi.mergeResolve(),
  });
  commands.register({
    id: 'page.merge-keep-mine', title: 'Keep my version (overwrite the file on disk)', group: 'page',
    when: () => hasPage() && editorApi.hasConflict(),
    run: () => editorApi.mergeKeepMine(),
  });
  commands.register({
    id: 'page.merge-take-theirs', title: 'Take the version on disk', group: 'page',
    when: () => hasPage() && editorApi.hasConflict() && editorApi.conflictIsText(),
    run: () => editorApi.mergeTakeTheirs(),
  });
  commands.register({
    id: 'page.merge-undo', title: 'Undo merge', group: 'page',
    when: () => hasPage() && editorApi.canUndoMerge(),
    run: () => editorApi.mergeUndo(),
  });
  commands.register({
    id: 'page.merge-show', title: 'Show changes merged from disk', group: 'page',
    when: () => hasPage() && editorApi.hasMerge(),
    run: () => editorApi.mergeShow(),
  });
  commands.register({
    id: 'page.reveal', title: 'Reveal in Explorer', group: 'page',
    when: hasPage, run: () => editorApi.reveal(),
  });
  commands.register({
    id: 'page.link', title: 'Link a page', group: 'page',
    when: hasPage, run: () => void editorApi.link(),
  });
  commands.register({
    id: 'page.copy-markdown', title: 'Copy as markdown', group: 'page',
    when: hasPage, run: () => editorApi.copyMarkdown(),
  });
  commands.register({
    id: 'page.export-pdf', title: 'Export to PDF', group: 'page',
    when: hasPage, run: () => void exportPdf(),
  });
  commands.register({
    id: 'page.print', title: 'Print', group: 'page',
    when: hasPage, run: () => void printPage(),
  });
  // The chords are the kernel's (keys.js): Ctrl+F for find, the outline's is its choice.
  commands.register({
    id: 'page.find', title: 'Find in page', group: 'page',
    when: hasPage, run: () => editorApi.find(),
  });
  // The heading picker reads the ProseMirror document, so it is the block editor's alone.
  commands.register({
    id: 'page.outline', title: 'Go to heading', group: 'page',
    when: () => !!(activeInstance() && activeInstance().api.hasCrepe()), run: () => void editorApi.outline(),
  });
}

/**
 * `page.new` (Ctrl+N, M28): `Untitled.md` in the folder the user is in
 * (`ose.focus.defaultNewFolder()`: the focused folder, else the folder on screen or the open
 * page's, else the vault root), created through the one create there is (`ose.fileops`, never
 * an overwrite). The title is selected. With `titleSync` on, the name typed there becomes the
 * file's name when the title is left (C12, M13); otherwise the file keeps its name.
 */
async function newPage() {
  const ops = fileops();
  if (!ops || typeof ops.create !== 'function') { toast('could not create the page: this kernel has no file operations', 'err'); return false; }
  let folder = '';
  try { folder = defaultNewFolder() || ''; } catch { folder = ''; }
  let path;
  try {
    ({ path } = await ops.create(folder, 'Untitled.md', { text: '# Untitled\n', unique: true }));
  } catch (e) {
    toast('could not create the page: ' + errText(e), 'err');
    return false;
  }
  const went = await navigate({ type: 'page', path });
  if (went === false) return false;
  // The router mounts asynchronously; select the title once it is there. L21: not forever —
  // a page that never mounts (refused, failed) stops the search after two seconds.
  let tries = 0;
  const selectNewTitle = () => {
    const inst = activeInst();
    const titleEl = inst && inst.path() === path ? inst.titleEl() : null;
    if (!titleEl) { if (++tries < 50) setTimeout(selectNewTitle, 40); return; }
    titleEl.focus();
    const r = document.createRange();
    r.selectNodeContents(titleEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  };
  setTimeout(selectNewTitle, 40);
  return true;
}

// ---------------------------------------------------------------------------
// paper
//
// Two commands, both the host's: `Export to PDF` (Ctrl+Shift+P) writes the file through
// WebView2's own PrintToPdf after a native save dialog, and `Print` opens the system print
// dialog, which is also how "Microsoft Print to PDF" is reached.
//
// Neither touches the theme. The sheet is black on white from either theme because print.css
// says so under `@media print`, and the swap that used to happen here is what left the app in
// light mode: `window.print()` does not return in WebView2, so the restore never ran. Nothing
// in the editor calls `window.print()` any more except the browser dev server's fallback, where
// it is a real Chromium dialog and does return.

/** `Export to PDF`: the save dialog, then the file, then a line saying where it went. */
async function exportPdf() {
  if (!hasPage()) return;
  const path = editorApi.getPath();
  const inst = activeInst();
  const titled = inst && inst.titleEl() ? inst.titleEl().textContent.trim() : '';
  const name = titled || P.stem(path || '') || 'page';
  let r;
  // WebView2 copies the document title into the PDF's `/Title`, and ours is the window's
  // ("Family · lifeos"): the vault's name is nobody's business but his. The page's own title
  // stands in it for the length of the export.
  const windowTitle = document.title;
  document.title = name;
  try {
    r = await ose.print.toPdf(null, { name, folder: editorApi.folder() || '' });
  } catch (e) {
    toast('could not export: ' + (e.message || e), 'err');
    return;
  } finally {
    document.title = windowTitle;
  }
  if (!r) { toast('Export to PDF needs the app', 'warn'); return; }
  if (r.browser) { toast('Export to PDF needs the app; in the browser, use Print', 'warn'); return; }
  if (r.cancelled) return;
  toast('saved ' + P.basename(String(r.path || '')));
}

/** `Print`: the system print dialog. In the browser there is none, so the page's own is used. */
async function printPage() {
  if (!hasPage()) return;
  let r;
  try {
    r = await ose.print.dialog();
  } catch (e) {
    toast('could not print: ' + (e.message || e), 'err');
    return;
  }
  if (!r) { toast('printing needs the app', 'warn'); return; }
  // The dev server's bridge cannot show a native dialog and says so; in a real browser
  // `window.print()` is a Chromium dialog that returns, which is what makes the dev loop work.
  if (r.browser) window.print();
}

/** The page the commands act on, for whoever needs to ask (the compatibility layer). */
export function activePage() { return activeInstance() ? activeInstance().handle : null; }
