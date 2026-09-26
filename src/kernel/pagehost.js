// The two things the router needs that the kernel does not own: whoever draws a file, and
// whoever draws a folder.
//
// docs/KERNEL.md: nothing in the kernel knows a view or a file of the shell. The router is
// kernel (tabs and their history, the window title, the mount cycle); the editor is
// `ose:editor`, a separate bundle, and the folder view is the shell's. So the router imports
// neither: the shell hands the kernel a page host and a folder host once, and the router calls
// through them. With no page host the router still shows a file as text; with no folder host a
// folder route says so in a box.
//
//   setPageHost({ open, canLeave?, stay?, close?, release?, rewriteLinksIn?, scrollToLine?,
//                 selection?, headingLine?, beforePathChange?, afterPathChange?, claims?,
//                 problems? })
//
//   open(el, path, { line, col, query, selection })  -> Promise, draws the file into `el`;
//                                     reuses a parked instance of `path` when there is one
//   canLeave('navigate')           -> Promise<boolean>; false keeps the page (its banner says
//                                     why) and the router changes nothing (C1). True leaves
//                                     the page frozen until `close` or `stay`
//   stay()                         -> undo the freeze a true `canLeave` left
//   close({ park }?)               -> Promise<boolean>; false: still mounted, nothing torn down.
//                                     `park: true` (another tab is brought forward, or another
//                                     tab shows the same file): detach and keep the instance
//                                     alive, buffer and undo included; always true
//   release(path)                  -> Promise<boolean>; a parked instance of `path` is saved
//                                     and destroyed. False: it could not be saved, and the tab
//                                     that holds it is not closed
//   rewriteLinksIn(path, pairs)    -> Promise<{ handled, changed, failed? }>; `path` is open
//                                     (on screen or parked): its links into `pairs` are
//                                     rewritten in the buffer as one undoable edit and nothing
//                                     is written to disk here (links.js, H5)
//   scrollToLine(line, col)        -> boolean, true when it jumped inside the mounted page
//   selection()                    -> { from, to } | null, the caret to restore on back
//   headingLine(text, heading)     -> 1-based line of that heading, or 0
//   beforePathChange({kind, from, to}) -> Promise<{ok, reason?}>; ok:false and the file
//                                     operation touches nothing (./fileops.js, C6)
//   afterPathChange({kind, from, to, ok}) -> Promise, whether the host call succeeded or not
//   claims(path)                   -> boolean, true when the host draws a missing path itself
//   problems()                     -> string[], the paths of the pages that hold unsaved work
//                                     they could not write, on screen or parked: the leave gate
//                                     names them, and brings one no tab shows back into a tab
//
// `kind` is 'rename' | 'move' | 'trash' | 'copy'; `to` is null for a trash. Every method but
// `open` is optional, and a missing one means "yes" or "nothing to do".
//
//   setFolderHost({ open(el, path, { select, scrollTop }) -> Promise<FolderHandle> })
//   FolderHandle = { unmount(), refresh(), selection() -> string | null }
//
// The router treats a folder handle as it treats a view's: `unmount` is awaited on the way out,
// `refresh` runs on a watcher change (debounced) and on `settings`, and `selection()` is
// remembered per tab and handed back as `select` when the folder is shown again.
//
// Only one of each at a time; each call answers a function that removes it again.

import { headingSlug } from './href.js';

let host = null;

export function setPageHost(next) {
  host = next || null;
  const mine = host;
  return () => { if (host === mine) host = null; };
}

export function pageHost() { return host; }
export function hasPageHost() { return !!host; }

let folders = null;

/** `ose.setFolderHost(host)`: whoever draws a folder route (H15). Answers the unregister. */
export function setFolderHost(next) {
  folders = next && typeof next.open === 'function' ? next : null;
  const mine = folders;
  return () => { if (folders === mine) folders = null; };
}

export function folderHost() { return folders; }

/**
 * The third seam: which markdown pages the page picker and the editor's `[[` menu offer. The list belongs to whatever draws the tree — the sidebar narrows it to the focused
 * folder — and the kernel must not import a sidebar. With nothing registered the picker falls
 * back to walking the vault itself, so it works wherever there is no tree.
 */
let pages = null;
export function setPageList(fn) {
  pages = typeof fn === 'function' ? fn : null;
  const mine = pages;
  return () => { if (pages === mine) pages = null; };
}
export function pageList() { return pages; }

/**
 * The 1-based line of a `# heading` in `text`. The page host's own version wins (the editor
 * knows about setext headings and fenced code); this is the fallback so a `#fragment` link
 * still lands with no editor mounted.
 */
export function headingLineIn(text, heading) {
  if (!host || typeof host.headingLine !== 'function') {
    const want = headingSlug(heading);
    if (!want) return 0;
    const lines = String(text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(lines[i] || '');
      if (m && headingSlug(m[1] || '') === want) return i + 1;
    }
    return 0;
  }
  return host.headingLine(text, heading);
}
