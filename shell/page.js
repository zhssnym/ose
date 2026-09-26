// The page seam: who draws a page, and which pages the app offers.
//
// The kernel's router never imports `ose:editor` — the editor is a bundle of its own and the
// kernel must not know it exists (docs/KERNEL.md). The shell joins them here, and this file is
// the whole of the page host the router and `ose.fileops` talk to (docs/SHELL.md "The page
// seam"): open, leave, close, and the two halves of a rename, a move or a trash of the page on
// screen. Everything else the editor does (its commands, its chords, its dialogs, its
// autosave) it does for itself.
//
// The editor is imported, not loaded by a static `import`: a bundle that fails to evaluate on
// some web view must cost the pages, not the whole window (M38). Without it the router shows a
// page as plain text, the tree and every view still work, and a toast says why.

import { ose } from 'ose:kernel';
import { toast } from 'ose:ui';
import { allPages } from './sidebar.js';
import { clean } from './paths.js';
import { isMediaFile, mediaPage, mediaMissingPage } from './media.js';

let editorLoad = null;
let editor = null;
let page = null;
// Set by `beforePathChange` when the media page on screen let go of its file for the host call;
// `afterPathChange` mounts it again, at the new path or the old one.
let released = null;

const under = (p, folder) => p === folder || p.startsWith(folder + '/');
const mapped = (p, from, to) => (p === from ? to : to + p.slice(from.length));
const pathOf = (h) => (h && typeof h.path === 'function' ? clean(h.path()) : '');

/**
 * Start loading `ose:editor`, once, and answer the module (or null when it failed). `boot.js`
 * calls this first thing, so the biggest bundle in the window downloads while the kernel boots.
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

/** The page host (docs/SHELL.md "The page seam"). Every method but `open` is optional to the router. */
const host = {
  // The branch is the extension and nothing else: a PDF and an image are drawn by `media.js`,
  // everything else — markdown, and the text files the editor shows as source — by
  // `markdownPage`. Both answer the same handle, so the calls below do not know which they
  // are holding.
  async open(el, path, opts) {
    released = null;
    if (isMediaFile(path)) {
      // The router hands a claimed path over even when it is not there (`claims` below), so
      // the stat is ours: a missing file gets our box, never the kernel's "Create it".
      let there = true;
      try { there = !!(await ose.files.exists(path)); } catch { there = true; }
      page = there ? mediaPage(el, path) : mediaMissingPage(el, path);
      return page.ready;
    }
    // No editor: draw nothing, and the router shows the file as text.
    if (!editor || typeof editor.markdownPage !== 'function') { page = null; return undefined; }
    page = editor.markdownPage(el, path, opts);
    return page.ready;
  },

  /** Whether the page on screen lets itself be left; a dirty page saves first (C1). */
  async canLeave(reason) {
    if (!page || typeof page.canLeave !== 'function') return true;
    return (await page.canLeave(reason)) !== false;
  },

  /** A `true` from `canLeave` froze the page; the navigation did not happen after all. */
  stay() {
    if (page && typeof page.stay === 'function') page.stay();
  },

  /** Tear the page down. False: it refused, and it is still mounted with nothing torn down. */
  async close() {
    if (!page) return true;
    const closing = page;
    const answer = await closing.close();
    if (answer === false) return false;
    if (page === closing) page = null;
    released = null;
    return true;
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
      if (typeof page.release === 'function') page.release();
      released = page;
    }
    if (editor && typeof editor.beforePathChange === 'function') {
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
    if (editor && typeof editor.afterPathChange === 'function') await editor.afterPathChange(change);
    await remountReleased(!!change.ok, change);
  },

  // Every media path is ours to draw, there or not: the router skips its own "page not found"
  // for these and calls `open` anyway (docs/KERNEL.md `setPageHost`).
  claims: (path) => isMediaFile(path),

  // `headingLine` is the editor's (setext headings, fenced code), and `ose:editor` does not
  // export it yet (work/inbox/K1c/002). Until it does, the kernel's own ATX fallback in
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
 * Hand the page host and the page list to the kernel. Waits for the editor bundle; when it did
 * not load, the page host still goes in (media pages, and the router's plain-text fallback for
 * the rest) and one sticky toast says so.
 */
export async function initPageHost() {
  const ed = await loadEditor();
  if (ed && ed.failed) {
    const why = String((ed.failed && ed.failed.message) || ed.failed);
    try { await ose.log(`editor failed to load: ${why}`, 'error'); } catch { /* the log is best effort */ }
    toast(`The editor could not be loaded (${why}). Pages open as plain text, read-only.`, 'err', 0);
  } else if (editor && typeof editor.holdPageCommands === 'function') {
    // One reference held for the life of the window, so `page.new` is in the palette and on
    // Ctrl+N with no page open — the home is where a new page most often starts.
    try { editor.holdPageCommands(); } catch (e) { console.error('[shell] page commands', e); }
  }

  ose.setPageHost(host);

  // The other half: what quick open, the page picker and the editor's `[[` menu all list. The
  // sidebar knows the tree and the focused folder; the kernel does not.
  ose.setPageList(() => allPages());
}

/**
 * The page on screen, for a shell file that needs to ask. Null on a view or the home. It is a
 * `markdownPage` handle or a `mediaPage` one: `page.media` says which.
 */
export const currentPage = () => page;
