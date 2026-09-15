// The page seam: who draws a markdown page, and which pages the app offers.
//
// The kernel's router never imports `ose:editor` — the editor is a bundle of its own and the
// kernel must not know it exists (docs/KERNEL.md). The rice joins them here, in one call, and
// that is the whole of the editor's place in the stock rice: everything else the editor does
// (its commands, its chords, its dialogs, its autosave) it does for itself.

import { ose } from 'ose:kernel';
import { markdownPage, holdPageCommands } from 'ose:editor';
import { allPages } from './sidebar.js';
import { isMediaFile, mediaPage } from './media.js';

let page = null;

export function initPageHost() {
  // One reference held for the life of the window, so `page.new` is in the palette and on
  // Ctrl+N with no page open — the start surface is where a new page most often starts.
  holdPageCommands();

  ose.setPageHost({
    // The branch is the extension and nothing else (docs/RICE.md "The page seam"): a PDF and
    // an image are drawn by `media.js`, everything else — markdown, and the source-mode text
    // files the editor claims — by `markdownPage`. Both answer the same handle, so the three
    // calls below do not know which they are holding.
    open(el, path, opts) {
      page = isMediaFile(path) ? mediaPage(el, path) : markdownPage(el, path, opts);
      return page.ready;
    },
    close() {
      if (!page) return null;
      const closing = page;
      page = null;
      return closing.close();
    },
    scrollToLine: (line, col) => !!page && page.goToLine(line, col),
    selection: () => (page ? page.selection() : null),
    // `headingLine` is the editor's (setext headings, fenced code), and `ose:editor` does not
    // export it yet (work/inbox/K1c/002). Until it does, the kernel's own ATX fallback in
    // pagehost.js resolves a `#fragment`, which is every heading the vault actually has.
  });

  // The other half: what quick open, the page picker and the editor's `[[` menu all list. The
  // sidebar knows the tree and the focused folder; the kernel does not.
  ose.setPageList(() => allPages());
}

/**
 * The page on screen, for a rice file that needs to ask. Null on a view or the start surface.
 * It is a `markdownPage` handle or a `mediaPage` one: ask `page.kind` before reaching for a
 * method only one of them has.
 */
export const currentPage = () => page;
