// The page seam: who draws a markdown page, and which pages the app offers.
//
// The kernel's router never imports `ose:editor` — the editor is a bundle of its own and the
// kernel must not know it exists (docs/KERNEL.md). The shell joins them here, in one call, and
// that is the whole of the editor's place in the shell: everything else the editor does
// (its commands, its chords, its dialogs, its autosave) it does for itself.

import { ose } from 'ose:kernel';
import { markdownPage, holdPageCommands } from 'ose:editor';
import { allPages } from './sidebar.js';
import { isMediaFile, mediaMiss, mediaPage } from './media.js';

let page = null;

export function initPageHost() {
  // One reference held for the life of the window, so `page.new` is in the palette and on
  // Ctrl+N with no page open — the start surface is where a new page most often starts.
  holdPageCommands();

  ose.setPageHost({
    // The branch is the extension and nothing else (docs/SHELL.md "The page seam"): a PDF and
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

  initMediaMiss();
}

/* --------------------------------------------------- a media path that is not in the vault */

/**
 * The kernel stats a page route before it asks anyone to draw it, and when the file is not
 * there it draws "page not found" with a **Create it** button that writes `# <name>\n` over
 * the path (router.js). That is right for markdown and wrong for a `.pdf` or a `.png`: it puts
 * a markdown file behind a media extension, and the web view is then asked to draw it
 * (QA-5 finding 4). The kernel must not learn extensions — docs/KERNEL.md, and the router is
 * right to stay generic — so the shell takes that one box back for the paths it claims.
 *
 * Two halves, because the box is drawn after the shell is told about the route:
 *
 *  - a capture-phase guard on the button. It needs no timing at all: a press on `Create it`
 *    while a media route is on screen never reaches the kernel's own handler, so nothing is
 *    ever written, whatever else may have gone wrong above.
 *  - a watch that re-letters the box, so the button is not offered in the first place. The
 *    `exists` call goes onto the bridge before the router's own `stat` does, so the answer is
 *    in hand by the time the box lands; a `MutationObserver` armed for that one route swaps it
 *    the moment it appears, and disarms on the next route, on success, or after four seconds.
 *
 * Both reach for the kernel's `.miss` box by the one attribute the router gives its button.
 * That is a coupling, and it is the reason `work/reports/P.md` asks for a page-host hook
 * (`claims(path)`) so the router can skip its own miss for a path the shell will draw.
 */
const CREATE = '[data-act="create"]';
let watcher = null;

function stopWatch() { if (watcher) { watcher.disconnect(); watcher = null; } }

function missBoxFor(el) { return el ? el.closest('.miss') : null; }
function findCreateBox() { return missBoxFor(document.querySelector(`.miss ${CREATE}`)); }

function relabel(box, path) {
  if (!box || box.dataset.oseMedia === '1') return false;
  box.dataset.oseMedia = '1';
  return mediaMiss(box, path);
}

/** The route on screen, when it is a media page. Null otherwise. */
function mediaRoute() {
  let r = null;
  try { r = ose.route.current(); } catch { return null; }
  return r && r.type === 'page' && isMediaFile(r.path) ? r : null;
}

function initMediaMiss() {
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest(CREATE) : null;
    if (!btn) return;
    const r = mediaRoute();
    if (!r) return;
    // Capture phase on the document: stopping here means the event never reaches the button,
    // so the kernel's own listener — the one that writes the stub — does not run.
    e.preventDefault();
    e.stopPropagation();
    relabel(missBoxFor(btn), r.path);
  }, true);

  ose.route.on((route) => {
    stopWatch();
    if (!route || route.type !== 'page' || !isMediaFile(route.path)) return;
    const path = route.path;
    ose.files.exists(path).then((there) => {
      const now = mediaRoute();
      if (there || !now || now.path !== path) return;
      if (relabel(findCreateBox(), path)) return;
      watcher = new MutationObserver(() => {
        if (mediaRoute() && relabel(findCreateBox(), path)) stopWatch();
      });
      watcher.observe(document.body, { childList: true, subtree: true });
      setTimeout(stopWatch, 4000);
    }).catch(() => { /* the bridge will have said so already */ });
  });
}

/**
 * The page on screen, for a shell file that needs to ask. Null on a view or the start surface.
 * It is a `markdownPage` handle or a `mediaPage` one: ask `page.kind` before reaching for a
 * method only one of them has.
 */
export const currentPage = () => page;
