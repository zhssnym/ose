// A page for a file nobody edits: a PDF, or an image.
//
// `shell/page.js` branches on the extension and hands these two here. The shape is
// `markdownPage`'s, because the kernel's page host contract is one shape (docs/KERNEL.md
// `ose.setPageHost`): a handle with `ready`, `close()`, `goToLine()` and `selection()`. The
// last two answer "no" honestly — there is no line and no caret in a picture — and the router
// falls back to scrolling the column, which is the right thing.
//
// Nothing here reads the file's bytes, beyond the first few of a PDF to see that it is one.
// The web view draws it itself over the vault origin (`ose.files.assetUrl`): an `<img src>`
// for a picture, and for a PDF an `<iframe>` whose document is the web view's own PDF viewer —
// Chromium's in WebView2, WKWebView's on macOS. That is why the host's CSP names the vault
// origin in `frame-src` as well as `img-src` (src-tauri/src/rice.rs) and why the vault
// protocol answers `application/pdf` for `.pdf` (src-tauri/src/protocol.rs). No library, no
// bytes through the bridge, no temp file.
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

import { ose } from 'ose:kernel';
import { icon, toast, esc } from 'ose:ui';
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
 * The kernel's "page not found" box, re-lettered for a file the user cannot write by typing
 * (QA-5 finding 4). `page.js` calls this on the box the router drew, so it keeps the kernel's
 * own `.miss` shape and place in the column and loses only the button — a `.pdf` that is not
 * there is not a page to create, and the stub `Create it` writes is a markdown file wearing a
 * media extension.
 */
export function mediaMiss(box, path) {
  if (!box) return false;
  addStyles();
  // `.miss-title` and `.miss-path` are the kernel's own, so the box keeps its shape and its
  // place; the third line is ours and quiet, because a missing attachment is a fact to state,
  // not an error to shout (`.miss-why` is the red the kernel keeps for a bridge fault).
  box.innerHTML = `
        <div class="miss-title">that file is not in the vault</div>
        <div class="miss-path mono">${esc(path)}</div>
        <div class="media-gone mono">nothing here can create a ${esc(extOf(path))} · put the file back, or fix the link that pointed at it</div>`;
  return true;
}

/**
 * Is what the vault origin serves for this path actually a PDF?
 *
 * An `<iframe>` fires no `error` for a payload it cannot parse — it loads the web view's own
 * viewer, which then draws its own modal in its own language and colours over our page (QA-5
 * finding 13). So the bytes are asked for first, one chunk, and the reader is cancelled the
 * moment it answers: `%PDF-` must be in the first kilobyte, which is where the format says it
 * is and where every viewer looks for it.
 *
 * `connect-src` already names the vault origin in the host's CSP, and in the browser dev the
 * vault is the dev server's own origin, so this costs one request and no permission anywhere.
 * On anything unexpected it answers `true`: the frame is still the better guess than our own
 * error line, and a viewer that disagrees will say so.
 */
async function looksLikePdf(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    if (!r.ok && r.status !== 206) return false;
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (type && !type.startsWith('application/pdf')) return false;
    if (!r.body || !r.body.getReader) return true;
    const reader = r.body.getReader();
    const first = await reader.read();
    try { await reader.cancel(); } catch { /* the body is already done */ }
    const bytes = first && first.value ? first.value.subarray(0, 1024) : null;
    if (!bytes || !bytes.length) return false;
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return text.includes('%PDF-');
  } catch (e) {
    console.warn('[media] could not read the head of', url, e);
    return true;
  }
}

/**
 * Mount a media page into `el`.
 *
 * @param {HTMLElement} el   the router's `.page-host`
 * @param {string} path      a vault path, already known to exist
 * @returns a page-host handle: { path, kind, ready, focus, close, goToLine, selection }
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

  /**
   * The way out of the viewer, and the only control here that comes and goes: it is shown
   * exactly while the frame holds the keyboard, because that is the one moment the app's own
   * chords do not work and the user needs to be told what does (QA-5 finding 5).
   */
  let leaveBtn = null;
  if (kind === 'pdf') {
    leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.className = 'btn sm media-leave';
    leaveBtn.hidden = true;
    leaveBtn.textContent = 'leave the viewer';
    leaveBtn.title = 'the PDF viewer has the keyboard; Shift+Tab does this too';
    leaveBtn.addEventListener('click', () => leaveFrame());
    head.appendChild(leaveBtn);
  }

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
  // A click on the header — the name, the gap, anywhere that is not one of the buttons — is
  // also a way back out of the frame, because it is the nearest thing to "click off it".
  head.addEventListener('mousedown', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    leaveFrame();
  });
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
    // Out of the tab sequence: the keyboard must never land in a document where none of the
    // app's chords reach (QA-5 finding 5). `src` is set below, once the bytes have answered.
    frame.tabIndex = -1;
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

  // ---- the frame and the keyboard ------------------------------------------------------
  //
  // While the frame has focus the window is blurred and every chord the app binds is the
  // viewer's, not ours. We cannot see into it and we must not steal focus back mid-scroll, so
  // the page does the two things it can: it says so, and it offers one press and one click
  // that end it.

  /** Focus back on the page itself, which is where the app's keys work again. */
  function leaveFrame() {
    if (closed) return;
    root.focus({ preventScroll: true });
    setFrameFocus(false);
  }

  function setFrameFocus(inFrame) {
    if (closed) return;
    root.dataset.frame = inFrame ? 'in' : 'out';
    if (leaveBtn) leaveBtn.hidden = !inFrame;
  }
  setFrameFocus(false);

  // The window blurs when the frame takes the keyboard, and `document.activeElement` is the
  // iframe element itself — the one thing about the frame this document can still see.
  const onWindowBlur = () => {
    if (closed || !frame) return;
    if (document.activeElement === frame) setFrameFocus(true);
  };
  // Anything focused back in our own document means the frame let go.
  const onFocusIn = () => { if (!closed && document.activeElement !== frame) setFrameFocus(false); };
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('focusin', onFocusIn);

  // Esc inside the page (on a header button, or on the page itself) lands focus back on the
  // column, the same "one step out" Esc means everywhere else. It cannot reach the frame —
  // nothing can — which is what the `leave the viewer` button and Shift+Tab are for.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.activeElement === root) return;
    e.preventDefault();
    root.focus({ preventScroll: true });
  });

  // ---- the status bar: the path, and one line about the file. The editor's fields are its
  // own and are already cleared by the close that preceded this mount.
  function status(field, text) { try { ose.status.set(field, text); } catch { /* no bar */ } }

  let docTail = '';
  const ready = (async () => {
    let size = 0;
    try { size = (await ose.files.stat(path)).size || 0; } catch { size = 0; }
    if (closed) return;
    status('path', path);
    const tail = sizeText(size);
    docTail = tail;
    if (kind === 'pdf') {
      status('doc', tail ? `pdf · ${tail}` : 'pdf');
      // The bytes decide whether the viewer is asked at all. Until they answer the frame has
      // no `src`, so the web view never gets the chance to draw its own error over the page.
      const ok = await looksLikePdf(src);
      if (closed || !frame) return;
      if (ok) frame.src = src;
      else failed(frame, 'is not a PDF');
    } else {
      // The placeholder first, then the pixels: the other way round, an image the browser had
      // already decoded had its dimensions written and immediately overwritten (QA-5 finding 8).
      status('doc', tail ? `image · ${tail}` : 'image');
      const say = () => {
        if (closed) return;
        const dims = img && img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : '';
        status('doc', [dims, tail].filter(Boolean).join(' · ') || 'image');
      };
      if (img && img.complete && img.naturalWidth) say();
      else if (img) img.addEventListener('load', say, { once: true });
    }
  })();

  // A file that will not draw says so where the page is, in the page's own voice and the
  // page's own colours: a moved file, an image with a broken byte, a `.pdf` that is not one.
  function failed(what, why) {
    if (closed) return;
    missing.hidden = false;
    missing.textContent = `${name} could not be drawn here · try open externally`;
    if (what) what.classList.add('media-dead');
    if (leaveBtn) leaveBtn.hidden = true;
    const said = [kind, docTail, why].filter(Boolean).join(' · ');
    status('doc', said ? `${said} · could not be drawn` : 'could not be drawn');
  }
  if (img) img.addEventListener('error', () => failed(zoomWrap, null), { once: true });

  // The router's `.page-host` is `min-height: 100%`, which is tall enough but not a *definite*
  // height, so a percentage height inside it would collapse. One class while the page is
  // mounted, taken away on close, and the frame can fill the column (media.css).
  el.classList.add('media-host');
  el.appendChild(root);
  // Focusable but not in the tab order: the header buttons are the tab stops, and this is what
  // the arrow keys scroll, exactly as a markdown page leaves the column. The router's
  // `settleFocus` lands here, never in the frame.
  root.tabIndex = -1;

  return {
    path: () => path,
    kind,
    get ready() { return ready; },
    focus: () => root.focus({ preventScroll: true }),
    async close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('focusin', onFocusIn);
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
