// The one thing the router needs that the kernel does not own: whoever draws a markdown page.
//
// docs/KERNEL.md: nothing in the kernel knows a view or a file of the shell. The router is
// kernel (history, the window title, the mount cycle, the stack); the block
// editor is `ose:editor`, a separate bundle. So the router never imports it: the shell hands
// the kernel a page host once, and the router calls through it. With no host registered the
// router still works and falls back to showing the file as text, which is exactly what it did
// before the editor bundle existed.
//
//   setPageHost({ open, close, scrollToLine, selection?, headingLine? })
//
//   open(el, path, { line, col, query, selection })  -> Promise, draws the page into `el`
//   close()                        -> Promise, the page's last save; may reject, never hangs
//   scrollToLine(line, col)        -> boolean, true when it jumped inside the mounted page
//   selection()                    -> { from, to } | null, the caret to restore on back
//   headingLine(text, heading)     -> 1-based line of that heading, or 0
//
// Only one host at a time; the call answers a function that removes it again.

import { headingSlug } from './href.js';

let host = null;

export function setPageHost(next) {
  host = next || null;
  const mine = host;
  return () => { if (host === mine) host = null; };
}

export function pageHost() { return host; }
export function hasPageHost() { return !!host; }

/**
 * The other half of the same idea: which markdown pages quick open and the page picker should
 * offer. The list belongs to whatever draws the tree — the sidebar narrows it to the focused
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
      const m = /^#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(lines[i]);
      if (m && headingSlug(m[1]) === want) return i + 1;
    }
    return 0;
  }
  return host.headingLine(text, heading);
}
