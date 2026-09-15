// A page for a file nobody edits: a PDF, or an image.
//
// `shell/page.js` branches on the extension and hands these two here. The shape is
// `markdownPage`'s, because the kernel's page host contract is one shape (docs/KERNEL.md
// `ose.setPageHost`): a handle with `ready`, `close()`, `goToLine()` and `selection()`. The
// last two answer "no" honestly — there is no line and no caret in a picture — and the router
// falls back to scrolling the column, which is the right thing.
//
// Nothing here reads the file's bytes. The web view does that itself over the vault origin
// (`ose.files.assetUrl`): an `<img src>` for a picture, and for a PDF an `<iframe>` whose
// document is the web view's own PDF viewer — Chromium's in WebView2, WKWebView's on macOS.
// That is why the host's CSP names the vault origin in `frame-src` as well as `img-src`
// (src-tauri/src/rice.rs) and why the vault protocol answers `application/pdf` for `.pdf`
// (src-tauri/src/protocol.rs). No library, no bytes through the bridge, no temp file.

import { ose } from 'ose:kernel';
import { icon, toast } from 'ose:ui';
import { baseName, extOf } from './paths.js';

/** The extensions this file claims. `page.js` asks; nothing else needs to know. */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']);
export const isImageFile = (p) => IMAGE_EXTS.has(extOf(p));
export const isPdfFile = (p) => extOf(p) === 'pdf';
export const isMediaFile = (p) => isPdfFile(p) || isImageFile(p);

// docs/MODULES.md rule 3, and the same trick the stock modules use: the stylesheet is a <link>
// this file adds, resolved against itself, so no line in the rice ever spells an origin. The
// shell lives as long as the window, so it is added once and left.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = new URL('./media.css', import.meta.url).href;
  document.head.appendChild(sheet);
}

/** `412 KB`, `1.2 MB` — the status bar's voice, not a table's. */
function sizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Mount a media page into `el`.
 *
 * @param {HTMLElement} el   the router's `.page-host`
 * @param {string} path      a vault path, already known to exist
 * @returns a page-host handle: { path, ready, close, goToLine, selection }
 */
export function mediaPage(el, path) {
  addStyles();

  let closed = false;
  const kind = isPdfFile(path) ? 'pdf' : 'image';
  const name = baseName(path);

  const root = document.createElement('div');
  root.className = 'media-page';
  root.dataset.kind = kind;

  // ---- the header: the name, then the actions, on one 32px line (docs/DESIGN.md).
  const head = document.createElement('div');
  head.className = 'media-head';
  const title = document.createElement('span');
  title.className = 'media-name grow mono';
  title.textContent = name;
  title.title = path;
  head.appendChild(title);

  /** The fit / actual toggle, images only. Fitted is the state a page opens in. */
  let fitted = true;
  let zoomBtn = null;
  if (kind === 'image') {
    zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'btn sm';
    zoomBtn.addEventListener('click', () => setFit(!fitted));
    head.appendChild(zoomBtn);
  }

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn sm';
  openBtn.innerHTML = `${icon('reveal')}<span>open externally</span>`;
  // N10: a host that refuses (an executable, a path outside the vault) says so out loud.
  openBtn.addEventListener('click', () => {
    ose.files.open(path).catch((err) => toast(err.message || String(err), 'err'));
  });
  head.appendChild(openBtn);
  root.appendChild(head);

  // ---- the body: one frame, or one picture.
  const body = document.createElement('div');
  body.className = 'media-body';
  root.appendChild(body);

  let frame = null;
  let img = null;
  let zoomWrap = null;
  const src = ose.files.assetUrl(path);

  if (kind === 'pdf') {
    frame = document.createElement('iframe');
    frame.className = 'media-frame';
    frame.title = name;
    // No `sandbox`: the built-in viewer is the web view's own document, and a sandbox without
    // `allow-scripts` stops it drawing at all. The CSP is what bounds this frame, and it lets
    // the vault origin and nothing else in.
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = src;
    body.appendChild(frame);
  } else {
    zoomWrap = document.createElement('button');
    zoomWrap.type = 'button';
    zoomWrap.className = 'media-zoom';
    zoomWrap.addEventListener('click', () => setFit(!fitted));
    img = document.createElement('img');
    img.className = 'media-img';
    img.alt = name;
    img.decoding = 'async';
    img.src = src;
    zoomWrap.appendChild(img);
    body.appendChild(zoomWrap);
  }

  const missing = document.createElement('div');
  missing.className = 'media-miss empty mono';
  missing.hidden = true;
  body.appendChild(missing);

  /**
   * Fit caps the picture to the column; actual size draws it at its own pixels and lets the
   * body scroll. An image smaller than the column looks the same either way, so the toggle
   * stays and simply does nothing visible — one rule, no special case.
   */
  function setFit(next) {
    fitted = !!next;
    root.dataset.fit = fitted ? 'fit' : 'actual';
    if (!zoomBtn) return;
    zoomBtn.textContent = fitted ? 'actual size' : 'fit';
    zoomBtn.title = fitted ? 'draw the image at its own size' : 'cap the image to the column';
    if (zoomWrap) zoomWrap.title = zoomBtn.title;
  }
  setFit(true);

  // ---- the status bar: the path, and one line about the file. The editor's fields are its
  // own and are already cleared by the close that preceded this mount.
  function status(field, text) { try { ose.status.set(field, text); } catch { /* no bar */ } }

  const ready = (async () => {
    let size = 0;
    try { size = (await ose.files.stat(path)).size || 0; } catch { size = 0; }
    if (closed) return;
    status('path', path);
    const tail = sizeText(size);
    if (kind === 'pdf') {
      status('doc', tail ? `pdf · ${tail}` : 'pdf');
    } else {
      const say = () => {
        if (closed) return;
        const dims = img && img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : '';
        status('doc', [dims, tail].filter(Boolean).join(' · ') || 'image');
      };
      if (img && img.complete) say(); else if (img) img.addEventListener('load', say, { once: true });
      status('doc', tail ? `image · ${tail}` : 'image');
    }
  })();

  // A file that will not draw says so where the page is, not only in a console: a moved file,
  // a web view with its PDF viewer switched off, an image with a broken byte.
  const failed = (what) => {
    if (closed) return;
    missing.hidden = false;
    missing.textContent = `${name} could not be shown here · try open externally`;
    if (what) what.classList.add('media-dead');
  };
  if (img) img.addEventListener('error', () => failed(zoomWrap), { once: true });

  // The router's `.page-host` is `min-height: 100%`, which is tall enough but not a *definite*
  // height, so a percentage height inside it would collapse. One class while the page is
  // mounted, taken away on close, and the frame can fill the column (media.css).
  el.classList.add('media-host');
  el.appendChild(root);
  // Focusable but not in the tab order: the two header buttons are the tab stops, and this is
  // what the arrow keys scroll, exactly as a markdown page leaves the column.
  root.tabIndex = -1;

  return {
    path: () => path,
    kind,
    get ready() { return ready; },
    focus: () => root.focus({ preventScroll: true }),
    async close() {
      if (closed) return;
      closed = true;
      // Drop the frame before the node goes: a PDF viewer left attached keeps the file open
      // on Windows, and the next rename of it would fail.
      if (frame) { frame.removeAttribute('src'); frame.remove(); frame = null; }
      if (img) { img.removeAttribute('src'); img.remove(); img = null; }
      root.remove();
      el.classList.remove('media-host');
      status('path', null);
      status('doc', null);
    },
    // No lines, no caret: the page host contract says a host may answer "not me", and the
    // router then scrolls the column instead of jumping inside the page.
    goToLine: () => false,
    selection: () => null,
  };
}
