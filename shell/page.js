// The page seam: who draws a page, and which pages the app offers.
//
// The core's router never imports `ose:editor` — the editor is a bundle of its own and the
// core must not know it exists (docs/CORE.md). The shell joins them here, and this file is
// the whole of the page host the router and `ose.fileops` talk to (docs/SHELL.md "The page
// seam"): open, leave, park, close, release, the two halves of a rename, a move or a trash of
// the page on screen, and link rewrites into pages that are open. Everything else the editor
// does (its commands, its chords, its dialogs, its autosave) it does for itself.
//
// Every file in the vault opens (H17). What draws it is decided here and nowhere else: a PDF
// or an image goes to `media.js`; anything else is asked of the host (`stat` with `sniff`),
// and text goes to the editor — markdown with its Rich/Source switch, the rest as plain
// Source — while bytes that are not text get `binaryPage`, a box with the ways out.
//
// A tab that goes to the background does not tear its page down (M12, M24): the router asks
// for `close({ park: true })` and the editor keeps that file's one live instance, buffer and
// undo, until the tab comes back or the file is released.
//
// The editor is imported, not loaded by a static `import`: a bundle that fails to evaluate on
// some web view must cost the pages, not the whole window (M38). Without it the router shows a
// page as plain text, the tree and every view still work, and a toast says why.

import { ose } from 'ose:core';
import { toast } from 'ose:ui';
import { allPages } from './sidebar.js';
import { clean } from './paths.js';
import { isMediaFile, mediaMissingPage, binaryPage } from './media.js';

let editorLoad = null;
let editor = null;
let page = null;
// Set by `beforePathChange` when the media page on screen let go of its file for the host call;
// `afterPathChange` mounts it again, at the new path or the old one.
let released = null;

const under = (p, folder) => p === folder || p.startsWith(folder + '/');
const mapped = (p, from, to) => (p === from ? to : to + p.slice(from.length));
// Media handles only (`media.js`), whose `path` is a function; an editor handle's is a getter.
const pathOf = (h) => clean(h.path());

/**
 * Start loading `ose:editor`, once, and answer the module (or null when it failed). `boot.js`
 * calls this first thing, so the biggest bundle in the window downloads while the core boots.
 */
export function loadEditor() {
  if (!editorLoad) {
    editorLoad = import('ose:editor').then(
      (m) => { editor = m; return m; },
      (e) => { console.error('[shell] editor', e); return { failed: e }; },
    );
  }
  return editorLoad;
}

/**
 * Whether the bytes of `path` are text, asked of the host: the first 8 KB hold no NUL and are
 * UTF-8 (docs/HOST.md `stat` with `sniff`). A host that does not sniff, a file that is not
 * there, a stat that fails: all answer true, and the editor or the router says the rest.
 */
async function isText(path) {
  try {
    const st = await ose.files.stat(path, { sniff: true });
    if (st && st.exists !== false && st.kind !== 'dir' && st.text === false) return false;
  } catch { /* the editor's turn */ }
  return true;
}

/** The page host (docs/SHELL.md "The page seam"). Every method but `open` is optional to the router. */
const host = {
  // A picture, a PDF or any file whose bytes are not text gets `binaryPage`, the card with the
  // ways out; everything else `markdownPage`, which reattaches a parked instance of the
  // same file when there is one. All three answer the same handle, so the calls below do not
  // know which they are holding.
  async open(el, path, opts) {
    released = null;
    if (isMediaFile(path)) {
      // The router hands a claimed path over even when it is not there (`claims` below), so
      // the stat is ours: a missing file gets our box, never the core's "Create it".
      let there = true;
      try { there = !!(await ose.files.exists(path)); } catch { there = true; }
      page = there ? binaryPage(el, path) : mediaMissingPage(el, path);
      return page.ready;
    }
    if (!(await isText(path))) {
      page = binaryPage(el, path);
      return page.ready;
    }
    // No editor: draw nothing, and the router shows the file as text.
    if (!editor) { page = null; return undefined; }
    page = editor.markdownPage(el, path, opts);
    return page.ready;
  },

  /** Whether the page on screen lets itself be left; a dirty page saves first (C1). */
  async canLeave(reason) {
    if (!page) return true;
    return (await page.canLeave(reason)) !== false;
  },

  /** A `true` from `canLeave` froze the page; the navigation did not happen after all. */
  stay() {
    if (page) page.stay();
  },

  /**
   * Take the page off the screen. With `park` (its tab went to the background, or another tab
   * still shows the file) an editor page is detached and kept alive, buffer and undo intact,
   * and this always answers true; a media page has nothing to keep and simply closes.
   * Otherwise it is torn down, and false means it refused and is still mounted, untouched.
   */
  async close(opts = {}) {
    if (!page) return true;
    const closing = page;
    if (opts && opts.park && !closing.media) {
      try { await closing.park(); } catch (e) { console.error('[shell] park', e); }
      if (page === closing) page = null;
      released = null;
      return true;
    }
    const answer = await closing.close();
    if (answer === false) return false;
    if (page === closing) page = null;
    released = null;
    return true;
  },

  /**
   * A parked page of `path` is saved and destroyed: its last tab closed while it was in the
   * background. False: it could not be saved, and it stays parked (the close is refused).
   */
  async release(path) {
    if (!editor) return true;
    return (await editor.releasePage(clean(path))) !== false;
  },

  /**
   * Links in a file that is open (on screen or parked) are rewritten as an edit of its buffer,
   * undoable, and saved by its autosave (H5). Undefined when the editor cannot: the core
   * then rewrites the file on disk as before.
   */
  async rewriteLinksIn(path, pairs) {
    if (!editor) return undefined;
    return editor.rewriteLinksIn(clean(path), pairs);
  },

  /**
   * The pages, on screen or parked, whose text could not be saved. The leave gate names them in
   * its refusal and reopens one that no tab shows.
   */
  problems() {
    return editor ? editor.problemPages() : [];
  },

  scrollToLine: (line, col) => !!page && page.goToLine(line, col),
  selection: () => (page ? page.selection() : null),

  /**
   * Before a rename, a move, a trash or a copy of `from` (C6). The editor answers for every
   * page it has mounted at or under `from`: it saves, and refuses when the text cannot be
   * written. A media page has nothing to save; it only lets go of the file for the host call.
   */
  async beforePathChange(change) {
    if (page && page.media && change.kind !== 'copy' && under(pathOf(page), clean(change.from))) {
      page.release();
      released = page;
    }
    if (editor) {
      const answer = await editor.beforePathChange(change);
      if (answer && answer.ok === false) {
        await remountReleased(false, change);
        return answer;
      }
    }
    return { ok: true };
  },

  /** After it, whether the host call succeeded or not. The router has been re-pointed already. */
  async afterPathChange(change) {
    if (editor) await editor.afterPathChange(change);
    await remountReleased(!!change.ok, change);
  },

  // Every media path is ours to draw, there or not: the router skips its own "page not found"
  // for these and calls `open` anyway (docs/CORE.md `setPageHost`).
  claims: (path) => isMediaFile(path),

  // `headingLine` is the editor's (setext headings, fenced code), and `ose:editor` does not
  // export it yet (work/inbox/K1c/002). Until it does, the core's own ATX fallback in
  // pagehost.js resolves a `#fragment`, which is every heading the vault actually has.
};

/**
 * A media page that let go of its file for a path change is mounted again: at its new path
 * after a rename or a move, at the old one when the change failed. A trashed one is left for
 * the caller, which navigates away.
 */
async function remountReleased(ok, change) {
  const h = released;
  released = null;
  if (!h || h !== page) return;
  if (ok && change.kind === 'trash') return;
  const from = clean(change.from);
  const at = pathOf(h);
  const path = ok && change.to ? mapped(at, from, clean(change.to)) : at;
  try {
    await ose.route.navigate({ type: 'page', path }, { replace: true, force: true });
  } catch (e) { console.warn('[shell] media remount', e); }
}

/**
 * Hand the page host and the page list to the core. Waits for the editor bundle; when it did
 * not load, the page host still goes in (media pages, and the router's plain-text fallback for
 * the rest) and one sticky toast says so.
 */
export async function initPageHost() {
  const ed = await loadEditor();
  if (ed && ed.failed) {
    const why = String((ed.failed && ed.failed.message) || ed.failed);
    try { await ose.log(`editor failed to load: ${why}`, 'error'); } catch { /* the log is best effort */ }
    toast(`The editor could not be loaded (${why}). Pages open as plain text, read-only.`, 'err', 0);
  } else if (editor) {
    // One reference held for the life of the window, so `page.new` is in the palette and on
    // Ctrl+N with no page open — the home is where a new page most often starts.
    try { editor.holdPageCommands(); } catch (e) { console.error('[shell] page commands', e); }
  }

  ose.setPageHost(host);

  // The other half: what quick open, the page picker and the editor's `[[` menu all list. The
  // sidebar knows the tree and the focused folder; the core does not.
  ose.setPageList(() => allPages());
}
