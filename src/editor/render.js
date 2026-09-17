// `render(markdown, opts)` (docs/KERNEL.md `ose:editor`): markdown as read-only DOM.
//
// A view, a tile or a plugin that wants to *show* a note rather than edit it should not have
// to boot Milkdown: this is marked with GFM on, through DOMPurify, into one detached element.
// Nothing here is editable, no plugin runs, no command is registered and no file is read.
//
// The two things the caller cannot do for itself are the two the editor knows: a link in a
// vault file is relative to the file it is written in, and an image in a vault file is a path
// the web view cannot load without the vault protocol (`ose.files.assetUrl`).

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { bridge } from './host.js';
import * as P from './paths.js';
import './render.css';

// A note is prose, not a web page: no raw HTML blocks are honoured (DOMPurify would keep the
// harmless ones, but a note that draws its own layout stops being a note), and a single
// newline is a newline, exactly as the block editor treats it.
const OPTIONS = { gfm: true, breaks: false, pedantic: false };

/**
 * @param {string} markdown
 * @param {object} [opts]  { basePath, onLink(path, heading) }
 * @returns {HTMLElement}  a `<div class="md-render">`, not attached to anything
 */
export function render(markdown, opts = {}) {
  const basePath = String(opts.basePath || '');
  const box = document.createElement('div');
  box.className = 'md-render';

  let html = '';
  try {
    html = marked.parse(String(markdown ?? ''), OPTIONS);
  } catch (e) {
    console.error('[editor] render', e);
    box.textContent = String(markdown ?? '');
    return box;
  }
  box.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });

  for (const a of box.querySelectorAll('a[href]')) resolveLink(a, basePath);
  for (const img of box.querySelectorAll('img[src]')) resolveImage(img, basePath);
  // A task list is a picture of the file's state, not a control: it is shown and not offered.
  for (const input of box.querySelectorAll('input')) { input.disabled = true; input.tabIndex = -1; }

  if (typeof opts.onLink === 'function') wireLinks(box, opts.onLink);
  return box;
}

/**
 * A vault link keeps its text and loses its href: `data-path` (and `data-heading`) says where
 * it goes, and whoever mounted the element decides what that means. An external link keeps its
 * href and opens outside, which is the only safe thing a web view can do with one.
 */
function resolveLink(a, basePath) {
  const href = (a.getAttribute('href') || '').trim();
  if (!href) return;
  if (P.isExternal(href)) {
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.classList.add('md-external');
    return;
  }
  if (href.startsWith('#')) { a.dataset.heading = href.slice(1); a.classList.add('md-anchor'); a.removeAttribute('href'); return; }
  const target = P.linkTarget(basePath, href);
  if (!target || !target.path) return;
  a.dataset.path = target.path;
  if (target.heading) a.dataset.heading = target.heading;
  a.classList.add('md-link');
  a.removeAttribute('href');
  a.setAttribute('role', 'link');
  a.tabIndex = 0;
}

function resolveImage(img, basePath) {
  const src = (img.getAttribute('src') || '').trim();
  if (!src || P.isExternal(src) || src.startsWith('data:') || src.startsWith('blob:')) return;
  const target = P.resolveHref(basePath, src);
  if (target) img.setAttribute('src', bridge.assetUrl(target));
  img.loading = 'lazy';
}

/** Mouse and keyboard, because a link that only answers the mouse is not a link here (D2). */
function wireLinks(box, onLink) {
  const follow = (a) => onLink(a.dataset.path || null, a.dataset.heading || null);
  box.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('.md-link, .md-anchor') : null;
    if (!a) return;
    e.preventDefault();
    follow(a);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const a = e.target instanceof Element ? e.target.closest('.md-link, .md-anchor') : null;
    if (!a) return;
    e.preventDefault();
    follow(a);
  });
}
