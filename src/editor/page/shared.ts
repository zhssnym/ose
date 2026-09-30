// Part of the markdown page (../page.ts). What every part of the page shares: the constants, the
// small helpers and the types.

import { toast } from '../deps.ts';
import { activeInstance } from '../instances.ts';
import * as serializer from '../crepe.ts';
import { createSourceView } from '../source.ts';
import { parseDoc } from '../doc.ts';
import * as P from '../paths.ts';

export const { makeCrepe, editorView } = serializer;

export const SAVE_DEBOUNCE = 600;
/** A draft follows an edit this long after it, and while typing at most every DRAFT_EVERY. */
export const DRAFT_DELAY = 1000;
export const DRAFT_EVERY = 5000;
/** A file that vanished is looked for again after this long before the page says it is gone (C7). */
export const GONE_RECHECK = 1000;
/** The longest wait between two tries of a save the host refused, in seconds. */
export const RETRY_MAX = 30;
/**
 * A write whose rename kept failing leaves the text in a visible `<stem>.unsaved-<stamp>` file
 * beside the note, one per try. After this many, only a deliberate save tries again.
 */
export const KEPT_COPIES_MAX = 3;
/** A file still carrying the name `newPage` gave it: the first real title renames it (C12). */
export const UNTITLED = /^Untitled( \d+)?$/i;

/**
 * The edit counter. It is one clock for every page and every open, started at the time the
 * bundle loaded, so a later edit always has a higher number than any draft an earlier session
 * or an earlier open left behind: `drafts.drop(path, {ifRev})` then never keeps a stale one.
 */
let revClock = Date.now();

/** What a body command says while the Reading view is up. */
export const READING_REFUSAL = 'Leave the Reading view to edit · Esc';

/**
 * The next edit's revision: after every one before it, and never behind the wall clock. Two
 * windows each have a clock of their own, and the draft of a file outside the vault is shared
 * by every window that has it open; on the wall clock their revisions compare.
 */
export const nextRev = () => { revClock = Math.max(revClock + 1, Date.now()); return revClock; };
/** A revision written elsewhere (a draft's): the clock never runs behind one it has seen. */
export const seenRev = (rev: number) => { if (rev > revClock) revClock = rev; };

/** A change made on disk and merged into a dirty page is announced for this long (H7). */
export const MERGE_NOTE_MS = 8000;

// Every live page, on screen or parked, and the one the commands act on (the focused one, or
// the last mounted) are instances.ts's register.
export const activeInst = () => activeInstance();
export const activeApi = () => (activeInstance() ? activeInstance().api : null);

/** `path` is `from`, or a page inside the folder `from`. */
export const covers = (path, from) => !!path && !!from && (path === from || path.startsWith(from + '/'));
/** `path` under `from` moved to `to`. */
export const mapPath = (path, from, to) => (path === from ? to : to + path.slice(from.length));
export const errText = (e) => String((e && e.message) || e || 'unknown error').replace(/\n[\s\S]*/, '');
export const errCode = (e) => (e && e.code) || 'io';

// The three modes (X1): the public words, and the internal ones `p.mode` holds. 'block' is
// Crepe; the word predates Live and stays internal.
export const INTERNAL = { rich: 'block', live: 'live', source: 'source' };
export const PUBLIC = { block: 'rich', live: 'live', source: 'source' };
export const MODE_LABEL = { rich: 'Rich', live: 'Live', source: 'Source' };
export const MODE_CHOICES = [{ value: 'rich', label: 'Rich' }, { value: 'live', label: 'Live' }, { value: 'source', label: 'Source' }];
/** A file's encoding is UTF-8 unless the host said otherwise (X10). */
export const isUtf8 = (enc) => !enc || /^utf-?8$/i.test(String(enc));
export const ATTACH_OUTSIDE = 'Attachments need a file inside the vault';
/** The page has an editor mounted, whichever of the three. */
export const hasEditor = (p) => !!(p && (p.crepe || p.source || p.live));

/** The mode a recovered draft reopens in (L5): its own, unless it is not exactly a save's text. */
export function recoveredModeOf(p, r) {
  if (p.plain || !r.exact) return 'source';
  return r.mode === 'live' ? 'live' : r.mode === 'rich' ? 'block' : 'source';
}

// ---------------------------------------------------------------------------
// the serializer's two checks (docs/CORE.md `ose:editor`, "Writing")
//
// `readMarkdownChecked` and `openCheck` are crepe.ts's, and neither throws; the try blocks here
// only make sure that a bug in them can never read as a clean write or a clean open.

export function checkedBody(crepe, original): { status: 'ok' | 'fellBack' | 'unsafe'; text: string | null; reason?: string; } {
  try {
    return serializer.readMarkdownChecked(crepe, original);
  } catch (e) {
    return { status: 'unsafe', text: null, reason: `serialising failed: ${errText(e)}` };
  }
}

export function checkOpened(crepe, body): { ok: true; } | { ok: false; reason: string; } {
  try { return serializer.openCheck(crepe, body) || { ok: false, reason: 'the check gave no answer' }; } catch (e) {
    return { ok: false, reason: `the check failed: ${errText(e)}` };
  }
}

// ---------------------------------------------------------------------------
// the instance

/** The document shape of a file that is not markdown (`plainDoc`). */
export type PlainDoc = {eol: string, eols: null, lines: null, bom: boolean, endsWithNewline: boolean,
  frontmatterRaw: string, frontmatter: null, preTitle: string, titleLine: null, title: string,
  gap: string, body: string, plain: true};
export type PageDoc = ReturnType<typeof parseDoc> | PlainDoc;
export type Timer = ReturnType<typeof setTimeout> | number;
/** The find bar: `createFind`'s over Crepe, or the same four methods over CodeMirror's panel. */
export type FindBar = {open: (o?: {query?: string | null, replace?: boolean}) => void,
  close: (o?: {toEditor?: boolean}) => void, isOpen: () => boolean, destroy: () => void};
export type Reading = {view: import('../reading/index.ts').ReadingView, el: HTMLElement, from: string,
  editorTop: number, startLine: number | null};
export type Problem = {status: string, reason: string, message: string, copy?: boolean};
export type Recovered = {at: number, text: string, applied: boolean, baselineHash: string | null,
  exact: boolean, mode: string, rev?: number, kept?: boolean};
export type Conflict = {theirs: string | null, hash: string | null, count: number, base: string | null,
  encoding?: string, lossy?: boolean};
export type Merged = {ours: string, theirs: string, text: string, at: number, rev: number};
export type Moving = {kind: string, from: string, to: string | null, done: (v?: unknown) => void};
/** One open page (see the comments in `blankPage`). */
export interface PageState {
  path: string;
  doc: PageDoc | null;
  title: string;
  baseline: string;
  baselineHash: string | null;
  el: HTMLElement | null;
  host: HTMLElement | null;
  titleEl: HTMLElement | null;
  metaEl: HTMLElement | null;
  metaText: HTMLElement | null;
  modeEl: HTMLElement | null;
  bannerEl: HTMLElement | null;
  bodyEl: HTMLElement | null;
  crepe: Awaited<ReturnType<typeof makeCrepe>> | null;
  find: FindBar | null;
  mode: string;
  plain: boolean;
  forced: string | null;
  source: ReturnType<typeof createSourceView> | null;
  words: number;
  chars: number;
  mtime: number;
  wordTimer: Timer;
  live: import('../live/view.ts').LiveView | null;
  lastEdit: string;
  reading: Reading | null;
  outside: boolean;
  encoding: string;
  lossy: boolean;
  forcedEncoding: string | null;
  liveFailed: string | null;
  wikiPages: string[] | null;
  titleSelected: boolean;
  dirty: boolean;
  ready: boolean;
  rev: number;
  frozen: boolean;
  problem: Problem | null;
  deleted: boolean;
  trashed: boolean;
  moving: Moving | null;
  movingDone: Promise<unknown> | null;
  asking: boolean;
  titleToBody: boolean;
  readOnly: boolean;
  draft: 'written' | 'failed' | null;
  hasDraft: boolean;
  draftAt: number;
  draftStamp: number | null;
  draftTimer: Timer;
  draftChain: Promise<unknown> | null;
  recovered: Recovered | null;
  notice: string | null;
  uncheckedRev: number;
  reloadPending: boolean;
  orphan: string | null;
  keptCopies: number;
  failedAt: number;
  saveTimer: Timer;
  goneTimer: Timer;
  retry: number;
  savedAt: string | null;
  savedAtMs: number | null;
  saving: Promise<void> | null;
  switching: Promise<unknown> | null;
  lastState: string;
  lastSave: string;
  lastBanner: string;
  applying: boolean;
  conflict: Conflict | null;
  merged: Merged | null;
  mergeNote: Timer;
  bindParent: (() => void) | null;
  cleanups: Array<() => void>;
}

export const blankPage = (): PageState => ({
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
  // Wave 3. live: the Live view (X2), when `mode` is 'live'. lastEdit: the page's last mode that
  // is not Source, where Ctrl+E goes back to. reading: the Reading view over the editor (X3),
  // `{view, el, from}`, or null. outside: the path is `abs:` (X7). encoding: the host's label
  // for the file's encoding (X10); lossy: its bytes do not decode exactly, so the page is
  // read-only; forcedEncoding: the one `page.reopen-encoding` chose, used for every read of the
  // file. liveFailed: why Live could not be built at the last mount (it fell back to Source).
  // wikiPages: the vault's markdown pages, for `[[wikilink]]` resolution in Live.
  live: null, lastEdit: 'rich', reading: null, outside: false,
  encoding: 'UTF-8', lossy: false, forcedEncoding: null, liveFailed: null, wikiPages: null,
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
  // stored for this path; draftStamp: the host's `at` on the draft this page last wrote or
  // recovered; recovered: the draft found at open, `{at, text, applied, kept, …}`.
  // draftChain: the draft writes and drops of this page, one after the other, so a drop issued
  // after a write runs after it. uncheckedRev: the edit at which text the user has not checked
  // yet went on screen (a guard refusal, an inexact draft); while `rev` is still that, the page
  // is let go as a draft, never written. reloadPending: "Reload from disk" was chosen while
  // the page could not be rebuilt at once; the next `stay` or path change rebuilds it.
  draft: null, hasDraft: false, draftAt: 0, draftStamp: null, draftTimer: 0, draftChain: null, recovered: null, notice: null,
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
  cleanups: [] as any[],
});

/** One live editor, on screen or parked, as instances.ts keeps it. */
export interface PageInstance {
  readonly el: HTMLElement;
  api: any;
  handle: any;
  readonly parked: boolean;
  usedAt: number;
  repaint?: () => void;
  [key: string]: any;
}

export interface DocState {
  path: string;
  status: 'clean'|'dirty'|'saving'|'not-saved'|'conflict'|'deleted';
  dirty: boolean;
  /**
   * `overlap` (wave 2, H7): the disk changed lines the buffer changed too; nothing was merged.
   *   `unencodable` (wave 3, X10): the text holds a character the file's encoding cannot hold
   */
  reason: null|'write-failed'|'unsafe'|'stale-vault'|'overlap'|'gone'|'read-only'|'unencodable';
  /** one sentence, for the tab tooltip and the banner */
  message: string|null;
  draft: null|'written'|'failed';
  mode: 'rich'|'live'|'source';
  savedAt: number|null;
}

// ---------------------------------------------------------------------------
// module level: the things one document has one of

export const anchorAt = (e) => (e.target instanceof Element ? e.target.closest('a[href], a.link-display') : null);
export const inTooltip = (a) => !!a.closest('.milkdown-link-preview, .milkdown-link-edit');

export const readAsBase64 = (file) => new Promise<any>((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(fr.error || new Error('read failed'));
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.readAsDataURL(file);
});

/**
 * The words of a markdown file as the Rich view shows them, for the counts: no frontmatter, the
 * title and the body, with the markup taken out (heading marks, list and task markers, quote
 * marks, fences, emphasis, link targets, table rules, tags) and one line break between blocks,
 * as ProseMirror's `textBetween` joins them. Close to Rich's own count, never a serialisation.
 */
export function shownText(text: string) {
  const d = parseDoc(text);
  const body = String(d.body || '')
    .replace(/^[ \t]*(```|~~~).*$/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^([ \t]*>)+[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, '')
    .replace(/(\*\*|__|~~)(?=\S)|(?<=\S)(\*\*|__|~~)/g, '')
    .replace(/(^|[^\p{L}\p{N}\\])[*_`]+(?=\S)|(?<=\S)[*_`]+(?=$|[^\p{L}\p{N}])/gmu, '$1')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, (row) => row.trim().slice(1, -1).split('|').map((c) => c.trim()).join('\n'))
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>$])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return `${d.title || ''} ${body}`;
}

/**
 * A file name's stem from free text (a title): no path separators, no characters Windows
 * refuses, no control characters, no trailing dot or space. The extension is the caller's.
 */
export const cleanStem = (text) => String(text ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .replace(/[\\/:*?"<>|]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[. ]+$/, '');

/** `modified today` / `modified yesterday` / `modified 9 Sep 2026`. Empty for a file with no mtime. */
export function modifiedLabel(mtime) {
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
export function whenLabel(at) {
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
export function reportLinks(r) {
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
export function afterLayout(fn) {
  let done = false;
  const once = () => { if (done) return; done = true; fn(); };
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, 80);
}
