// `render(markdown, opts)` (docs/KERNEL.md `ose:editor`): markdown as read-only DOM.
//
// A view, a tile or a plugin that wants to *show* a note rather than edit it should not have
// to boot Milkdown: this is marked with GFM on, through DOMPurify, into one detached element.
// Nothing here is editable, no plugin runs, no command is registered and no file is read.
//
// The three things the caller cannot do for itself are the three the editor knows: a link in a
// vault file is relative to the file it is written in, an image in a vault file is a path the
// web view cannot load without the vault protocol (`ose.files.assetUrl`), and a fenced code
// block is coloured by the same grammars and the same `--code-*` tokens a code block in the
// editor is, so a drill's statement and the file the answer is typed into look like one app.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { bridge } from './host.js';
import { describe, highlightInto, loadLanguage } from './highlight.js';
import { markedMath, paintMath } from './math.js';
import * as P from './paths.js';
import './render.css';

// A note is prose, not a web page: no raw HTML blocks are honoured (DOMPurify would keep the
// harmless ones, but a note that draws its own layout stops being a note), and a single
// newline is a newline, exactly as the block editor treats it.
const OPTIONS = { gfm: true, breaks: false, pedantic: false };

// An instance of marked of our own, never the module-level one: `use` is global on that one and
// a note is not the only thing in this bundle that parses markdown. The maths extension is the
// same pandoc rule the block editor reads (math.js), so a `$` means the same thing on both.
const md = new Marked(OPTIONS);
md.use(markedMath);
// A run of blank lines is space the writer put there: N blank lines between two blocks are N
// minus 1 empty paragraphs (space.js, and the block editor reads the same file the same way).
// marked hands the whole run over as one `space` token and writes nothing for it; here each
// line of space past the separator becomes the empty paragraph it is, so a note read through
// `render()` has the shape it has in the editor and on paper.
md.use({
  renderer: {
    space(token) {
      const lines = (String(token.raw || '').match(/\n/g) || []).length - 2;
      return lines > 0 ? '<p class="md-space"></p>'.repeat(lines) : '';
    },
  },
});

/**
 * @param {string} markdown
 * @param {object} [opts]  { basePath, onLink(path, heading), codeLanguage }
 * @returns {HTMLElement}  a `<div class="md-render">`, not attached to anything
 */
export function render(markdown, opts = {}) {
  const basePath = String(opts.basePath || '');
  const box = document.createElement('div');
  box.className = 'md-render';

  let html = '';
  try {
    html = md.parse(String(markdown ?? ''), OPTIONS);
  } catch (e) {
    console.error('[editor] render', e);
    box.textContent = String(markdown ?? '');
    return box;
  }
  box.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  // After the sanitiser, never before: its html profile does not know MathML and would take a
  // `<math>` element apart. What marked wrote is a placeholder holding the TeX as text.
  paintMath(box);

  for (const a of box.querySelectorAll('a[href]')) resolveLink(a, basePath);
  for (const img of box.querySelectorAll('img[src]')) resolveImage(img, basePath);
  // A task list is a picture of the file's state, not a control: it is shown and not offered.
  for (const input of box.querySelectorAll('input')) { input.disabled = true; input.tabIndex = -1; }
  colourCode(box, opts.codeLanguage);

  if (typeof opts.onLink === 'function') wireLinks(box, opts.onLink);
  return box;
}

/**
 * Colour every fenced block, in place, once its grammar has arrived.
 *
 * `render` is synchronous and stays synchronous: the element it answers is complete and
 * readable before any grammar is asked for, and every block that gets one is repainted where
 * it already stands. A caller that measures the box, mounts it, or throws it away in the same
 * turn is unaffected either way.
 *
 * `fallback` is `codeLanguage`: the language a fence that names none is assumed to be. A fence
 * that names one always wins, a block with neither stays plain text, and a name the pack does
 * not have stays plain text as well. That is the whole rule.
 */
function colourCode(box, fallback) {
  const assumed = String(fallback || '').trim();
  for (const el of box.querySelectorAll('pre > code')) {
    const named = [...el.classList].find((c) => c.startsWith('language-'));
    const name = named ? named.slice('language-'.length) : assumed;
    const desc = describe(name, null);
    if (!desc) continue;
    const code = el.textContent;
    const paint = (support) => {
      // The caller owns this DOM and may have replaced the text while the chunk was in the
      // air. Repaint what was read, or nothing.
      if (support && el.textContent === code) highlightInto(el, code, support);
    };
    loadLanguage(desc).then(paint, () => {});
  }
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
