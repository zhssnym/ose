// A page for a file nobody edits: a PDF, an image, or any other file that is not text.
//
// `shell/page.js` branches on the extension and hands the first two here; a file whose first
// bytes are not text (the host's sniff) gets `binaryPage`, a box that says what it is and
// offers the ways out, because every file in the vault opens in the app (H17). The shape is
// `markdownPage`'s, because the core's page host contract is one shape (docs/CORE.md
// `ose.setPageHost`): a handle with `ready`, `close()`, `goToLine()` and `selection()`. The
// last two answer "no" honestly — there is no line and no caret in a picture — and the router
// falls back to scrolling the column, which is the right thing.
//
// Nothing here reads the file's bytes, beyond the first few of a PDF to see that it is one.
// The web view draws it itself from the vault's URL (`ose.files.assetUrl`, which the host's
// `vault` protocol answers from the vault, src-tauri/src/protocol.rs): an `<img src>` for a
// picture, and for a PDF an `<iframe>` whose document is the web view's own PDF viewer. That is
// why the page's CSP allows the vault origin in `frame-src` as well as `img-src`, and why the
// protocol answers `application/pdf` for `.pdf`. No library, no bytes through the bridge, no
// temp file.
//
// The frame is the one thing in the app the app cannot see into: it is another document, in
// another process, on another origin. Two rules follow, and both are here rather than in a
// comment somewhere (QA-5 findings 5 and 13):
//
//   - The keyboard never walks into it. `tabindex="-1"` keeps it out of the tab sequence and
//     nothing ever focuses it, so a keyboard-only user cannot end up inside a document where
//     none of the app's chords work. A mouse user still can, on purpose, by clicking it; the
//     header then says so and offers the way back.
//   - A PDF that will not draw is our sentence, not the web view's modal. The first bytes are
//     checked before the frame is pointed at anything, so the viewer is never asked to draw a
//     file that is not a PDF.

import { ose } from '../core/core.ts';
import { icon, toast, esc } from '../ui/index.ts';
import { baseName, extOf, isOutside, outsideLabel } from './paths.ts';
import { typeLabel, sizeLabel, dateLabel } from './folder-model.ts';

/** The extensions this file claims. `page.js` asks; nothing else needs to know. */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);
export const isImageFile = (p) => IMAGE_EXTS.has(extOf(p));
export const isPdfFile = (p) => extOf(p) === 'pdf';
export const isMediaFile = (p) => isPdfFile(p) || isImageFile(p);

/**
 * The handle both pages here answer: the page host's one shape (`markdownPage`'s), with `media`
 * set so the page seam can tell it from an editor's, and `path` a function rather than a getter.
 */
export interface MediaPage {
  path: () => string;
  kind: string;
  media: true;
  readonly ready: Promise<void>;
  focus: () => void;
  canLeave: (reason?: string) => Promise<boolean>;
  stay(): void;
  release(): void;
  close(): Promise<boolean>;
  goToLine: (line?: number, col?: number) => boolean;
  selection: () => null;
}

/**
 * The core's "page not found" box, re-lettered for a file the user cannot write by typing
 * (QA-5 finding 4). `mediaMissingPage` below fills a `.miss` box with it, so the page keeps
 * the core's own shape and place in the column and has no button — a `.pdf` that is not
 * there is not a page to create, and a stub would be a markdown file wearing a media
 * extension.
 */
export function mediaMiss(box: Element | null, path: string): boolean {
  if (!box) return false;
  // `.miss-title` and `.miss-path` are the core's own, so the box keeps its shape and its
  // place; the third line is ours and quiet, because a missing attachment is a fact to state,
  // not an error to shout (`.miss-why` is the red the core keeps for a bridge fault).
  box.innerHTML = `
        <div class="miss-title">${isOutside(path) ? 'that file is not there' : 'that file is not in the vault'}</div>
        <div class="miss-path mono">${esc(outsideLabel(path))}</div>
        <div class="media-gone mono">nothing here can create a ${esc(extOf(path))} · put the file back, or fix the link that pointed at it</div>`;
  return true;
}

/**
 * A media route whose file is not there. The page host claims every media path
 * (`claims(path)`, docs/SHELL.md "The page seam"), so the router hands this one over instead
 * of drawing its own "page not found" with a **Create it** that has no business near a `.pdf`;
 * this draws the core's own `.miss` box, re-lettered by `mediaMiss`, in the core's own
 * place in the column. It answers the same handle as a real media page.
 *
 * `el` is the router's `.page-host`, `path` a vault path that does not exist.
 */
export function mediaMissingPage(el: HTMLElement, path: string): MediaPage {
  const col = document.createElement('div');
  col.className = 'page-col';
  const box = document.createElement('div');
  box.className = 'miss';
  col.appendChild(box);
  mediaMiss(box, path);
  el.appendChild(col);
  return {
    path: () => path,
    kind: 'missing',
    media: true,
    ready: Promise.resolve(),
    focus: () => {},
    canLeave: async () => true,
    stay() {},
    release() {},
    async close() {
      col.remove();
      return true;
    },
    goToLine: () => false,
    selection: () => null,
  };
}

/**
 * A file that is not text: a picture, a PDF, a spreadsheet, an archive. It still opens in the
 * app (H17), as a box that says what it is (name, type, size, when it changed) and the ways out:
 * the platform's own app for it, and its folder in the platform's file manager. Nothing reads
 * its bytes.
 *
 * `el` is the router's `.page-host`, `path` a vault path that exists and is not text. Answers
 * a page-host handle: { path, kind, ready, focus, close, goToLine, selection }.
 */
export function binaryPage(el: HTMLElement, path: string): MediaPage {
  let closed = false;
  const name = baseName(path);
  const col = document.createElement('div');
  col.className = 'page-col binary-page';
  col.tabIndex = -1;
  col.innerHTML = `
    <div class="binary-box">
      <div class="binary-head">
        <span class="binary-icon">${icon('file')}</span>
        <span class="binary-name mono" title="${esc(outsideLabel(path))}">${esc(name)}</span>
      </div>
      <dl class="binary-facts">
        <dt>Type</dt><dd class="binary-type">${esc(typeLabel({ name, kind: 'file', ext: extOf(path) }))}</dd>
        <dt>Size</dt><dd class="binary-size mono">…</dd>
        <dt>Modified</dt><dd class="binary-date">…</dd>
      </dl>
      <p class="binary-why">Ose shows text files. This one opens in its own app.</p>
      <div class="binary-actions"></div>
    </div>`;
  // Drawn just above.
  const actions = col.querySelector('.binary-actions') as HTMLElement;
  const button = (label: string, iconName: string, run: () => unknown, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (primary ? ' primary' : '');
    b.innerHTML = `${icon(iconName)}<span>${esc(label)}</span>`;
    b.addEventListener('click', () => {
      try {
        const out = run() as Promise<unknown> | null | undefined;
        if (out && typeof out.catch === 'function') out.catch((err) => toast(err.message || String(err), 'err', 0));
      } catch (err) { toast(String((err && typeof err === 'object' && 'message' in err && err.message) || err), 'err', 0); }
    });
    actions.appendChild(b);
    return b;
  };
  const first = button('Open with default app', 'reveal', () => ose.files.open(path), true);
  // A file outside the vault (X7): the copy into it is the way in.
  if (isOutside(path)) button('Copy into the vault…', 'copy', () => ose.commands.run('file.copy-into-vault', path));
  button('Open containing folder', 'folder', () => ose.files.reveal(path));

  el.appendChild(col);

  const ready = (async () => {
    let st: Awaited<ReturnType<typeof ose.files.stat>> | null = null;
    try { st = await ose.files.stat(path); } catch { st = null; }
    if (closed) return;
    const size = col.querySelector('.binary-size');
    const date = col.querySelector('.binary-date');
    if (size) size.textContent = st ? sizeLabel(st.size || 0, 'file') || '0 bytes' : 'unknown';
    if (date) date.textContent = st && st.mtime ? dateLabel(st.mtime) : 'unknown';
    try { ose.status.set('doc', typeLabel({ name, kind: 'file', ext: extOf(path) })); } catch { /* no bar */ }
  })();

  return {
    path: () => path,
    kind: 'binary',
    media: true,
    get ready() { return ready; },
    // The first way out takes the keyboard, so Enter on arrival opens it where it belongs.
    focus: () => first.focus({ preventScroll: true }),
    canLeave: async () => true,
    stay() {},
    release() {},
    async close() {
      if (closed) return true;
      closed = true;
      col.remove();
      try { ose.status.set('doc', null); } catch { /* no bar */ }
      return true;
    },
    goToLine: () => false,
    selection: () => null,
  };
}
