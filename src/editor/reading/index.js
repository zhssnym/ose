// The Reading view (docs/LIVE.md, "Reading"): the buffer drawn read-only, in place of the editor.
//
// It is a view and not a mode (contract X3): the editor stays mounted underneath and the page
// comes back to it. Nothing here can change a byte: there is no editing affordance, a task box
// is disabled, and the text is only ever read.
//
// The markdown is marked's, with `breaks: true` (a single newline is a line break, the way the
// editor reads it, M6), the pandoc maths of ../math.js, and a wikilink extension of its own.
// What marked writes goes through DOMPurify: no script, no event handler, no frame, no form.
// The frontmatter is not markdown and is drawn as a properties block. Images go through the
// page's `resolveAsset`, and fenced code is coloured by ../highlight.js, like every other code
// surface of the app.
//
// Every top-level block carries `data-line`, the 1-based file line it starts on, so the page
// can carry the reader's place across (`topLine`, `goToLine`) both ways.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { describe, highlightInto, loadLanguage } from '../highlight.js';
import { markedMath, renderMath } from '../math.js';
import * as P from '../paths.js';
// The grammar Live parses with, so the two views agree on what a wikilink, an embed, a
// frontmatter block and a fence name are. Pure modules: nothing here mounts a view.
import { frontmatterRange, wikiParts } from '../live/syntax.js';
import { readEmbed } from '../live/widgets/image.js';
import { fenceLanguage } from '../live/widgets/code.js';
import '../render.css';
import './reading.css';

/**
 * @typedef {object} ReadingOptions
 * @property {HTMLElement} host
 * @property {string} text
 * @property {string} path
 * @property {(src: string) => string | null} resolveAsset
 * @property {(target: string) => { path: string | null, exists: boolean }} [resolveWikilink]
 * @property {(href: string, o: { newTab: boolean }) => void} onOpenLink
 *
 * @typedef {object} ReadingView
 * @property {HTMLElement} el
 * @property {(text: string) => void} setText
 * @property {(line: number) => boolean} goToLine
 * @property {() => number} topLine
 * @property {() => void} destroy
 */

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'button', 'textarea', 'select', 'meta', 'link', 'base'],
  FORBID_ATTR: ['style', 'srcset', 'formaction'],
  ALLOW_DATA_ATTR: true,
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------------------
// the text

/**
 * The text as the lexer should see it: no byte-order mark, and `\n` for every line break, so a
 * line number here is the line number CodeMirror and the file agree on.
 * @param {string} text
 */
export function normalise(text) {
  return String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * The frontmatter at the very start of `text`: its lines, and how many lines it takes with its
 * fences. Null when the file does not open with a `---` line closed by `---` or `...`.
 * @param {string} text  normalised
 * @returns {{ body: string, lines: number } | null}
 */
export function frontmatter(text) {
  const range = frontmatterRange(text);                  // Live's own rule (live/syntax.js)
  if (!range) return null;
  const open = text.indexOf('\n') + 1;
  const body = text.slice(open, Math.max(open, range.closeFrom - 1));
  const lines = (text.slice(0, range.to).match(/\n/g) || []).length + 1;
  return { body, lines };
}

/**
 * The end of the wikilink whose `[[` is at `start` in `src`, or -1: Live's rule (live/syntax.js
 * `wikiEnd`) read over a string. The inside may not hold a line break, another `[[`, or a `]`
 * alone, and may not be empty.
 * @param {string} src
 * @param {number} start
 */
export function wikiEnd(src, start) {
  if (src[start] !== '[' || src[start + 1] !== '[') return -1;
  for (let i = start + 2; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') return -1;
    if (c === '[' && src[i + 1] === '[') return -1;
    if (c === ']') {
      if (src[i + 1] !== ']' || i === start + 2) return -1;
      return i + 2;
    }
  }
  return -1;
}

/**
 * The properties a frontmatter body states, top-level keys only: a nested or list line belongs
 * to the key above it. Drawn as text, never parsed as YAML: the reader sees what the file says.
 * @param {string} body
 * @returns {Array<[string, string]>}
 */
export function properties(body) {
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const line of body.split('\n')) {
    const m = /^([^\s#:][^:]*):(?:[ \t]+(.*))?$/.exec(line);
    if (m) { out.push([(m[1] || '').trim(), (m[2] || '').trim()]); continue; }
    const last = out[out.length - 1];
    if (last && line.trim()) last[1] = last[1] ? `${last[1]} ${line.trim()}` : line.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// marked

/**
 * One marked instance per view, with a wikilink extension that knows the page it is in.
 * @param {ReadingOptions} o
 */
function makeMarked(o) {
  const md = new Marked({ gfm: true, breaks: true, pedantic: false });
  md.use(markedMath);

  /** Where a wikilink target goes: an href relative to this page, and whether it exists. */
  const resolve = (target) => {
    let found = null;
    try { found = o.resolveWikilink ? o.resolveWikilink(target) : null; } catch { found = null; }
    if (found && found.path) {
      let href = found.path;
      try { href = P.relativeHref(o.path, found.path); } catch { href = found.path; }
      return { href, exists: found.exists !== false };
    }
    const file = /\.[a-z0-9]{1,8}$/i.test(target) ? target : `${target}.md`;
    // Without a resolver nothing is known, and nothing is drawn as missing.
    return { href: encodeURI(file), exists: o.resolveWikilink ? !!(found && found.exists) : true };
  };

  md.use({
    extensions: [{
      name: 'oseWikilink',
      level: 'inline',
      start(src) {
        const i = src.indexOf('[[');
        if (i < 0) return undefined;
        return i > 0 && src[i - 1] === '!' ? i - 1 : i;
      },
      tokenizer(src) {
        const embed = src[0] === '!';
        const end = wikiEnd(src, embed ? 1 : 0);
        if (end < 0) return undefined;
        const raw = src.slice(0, end);
        const { target, heading, alias, ref } = wikiParts(raw);
        return { type: 'oseWikilink', raw, embed, target, heading, alias, ref };
      },
      renderer(token) {
        const { target, heading, alias, ref, embed } = token;
        const picture = embed ? readEmbed(token.raw) : null;
        if (picture) {
          const { href } = resolve(picture.src);
          return `<img src="${escapeHtml(href)}" alt="${escapeHtml(picture.alt)}"${picture.width ? ` width="${picture.width}"` : ''}>`;
        }
        // The alias, else the target and heading; a link whose text would be empty (`[[ ]]`,
        // `[[a|]]`) shows what is written, as Live does on the caret.
        const named = heading && !target ? heading : target + (heading ? ` › ${heading}` : '');
        const shown = alias.trim() ? alias : (named || ref.trim() || token.raw);
        const place = target ? resolve(target) : { href: '', exists: true };
        const href = place.href + (heading ? `#${encodeURIComponent(heading)}` : '');
        const cls = `md-link ose-wikilink${place.exists ? '' : ' is-missing'}${embed ? ' ose-embed' : ''}`;
        return `<a class="${cls}" href="${escapeHtml(href)}">${escapeHtml(shown)}</a>`;
      },
    }],
  });
  return md;
}

// ---------------------------------------------------------------------------
// drawing

/**
 * The HTML of each top-level block of `src`, with the file line it starts on.
 * @param {Marked} md
 * @param {string} src  normalised, frontmatter taken off
 * @param {number} firstLine  the file line `src` starts on
 * @returns {Array<{ line: number, html: string }>}
 */
export function blocks(md, src, firstLine) {
  const tokens = md.lexer(src);
  const out = [];
  let pos = 0;
  let line = firstLine;
  for (const token of tokens) {
    const raw = String(token.raw || '');
    const at = raw ? src.indexOf(raw, pos) : -1;
    if (at >= 0) {
      for (let i = pos; i < at; i++) if (src.charCodeAt(i) === 10) line++;
      pos = at;
    }
    const start = line;
    if (token.type === 'space') {
      // N blank lines are N minus 1 lines of space the writer left (space.js, render.js).
      const extra = (raw.match(/\n/g) || []).length - 2;
      // Each is given the line it stands for: the blank lines past the first one.
      const firstBlank = raw.startsWith('\n') ? start + 1 : start;
      for (let i = 0; i < extra; i++) out.push({ line: firstBlank + 1 + i, html: '<p class="md-space"></p>' });
    } else {
      /** @type {any} */
      const list = [token];                               // marked.parser wants the lexer's `links` on the array
      list.links = /** @type {any} */ (tokens).links;
      let html = '';
      try { html = md.parser(list); } catch (e) { console.warn('[reading] block', e); html = `<p>${escapeHtml(raw)}</p>`; }
      out.push({ line: start, html });
    }
    if (at >= 0) {
      for (let i = pos; i < pos + raw.length; i++) if (src.charCodeAt(i) === 10) line++;
      pos += raw.length;
    }
  }
  return out;
}

/** Colour one fenced block once its grammar has arrived; a missing grammar leaves it plain. */
function colour(el) {
  const named = [...el.classList].find((c) => c.startsWith('language-'));
  // Through Live's fence names: ```py is Python, ```text is plain (live/widgets/code.js).
  const name = named ? fenceLanguage(named.slice('language-'.length)) : '';
  const desc = name ? describe(name, null) : null;
  if (!desc) return;
  const code = el.textContent || '';
  void loadLanguage(desc).then((support) => {
    if (support && el.isConnected !== false && el.textContent === code) highlightInto(el, code, support);
  }, () => {});
}

/** The box a missing image draws in its place. */
function missingBox(src, doc) {
  const box = doc.createElement('span');
  box.className = 'ose-reading-missing';
  const label = doc.createElement('span');
  label.className = 'ose-reading-missing-label';
  label.textContent = 'Missing image';
  const name = doc.createElement('code');
  name.textContent = src;
  box.append(label, name);
  return box;
}

/**
 * @param {HTMLElement} box
 * @param {ReadingOptions} o
 */
function finish(box, o) {
  // The maths placeholders marked wrote become MathML after the sanitiser (math.js `paintMath`,
  // done here so a display formula keeps the `data-line` its placeholder carried).
  for (const el of [...box.querySelectorAll('[data-math]')]) {
    const out = renderMath(el.textContent || '', { display: el.classList.contains('ose-math-display') });
    const line = el.getAttribute('data-line');
    if (line) out.setAttribute('data-line', line);
    el.replaceWith(out);
  }
  for (const img of [...box.querySelectorAll('img')]) {
    const src = (img.getAttribute('src') || '').trim();
    // `![alt|420](src)`: alt text and a width, as the editor reads the slot (../image.js).
    const sized = /^([\s\S]*)\|(\d{1,5})$/.exec(img.getAttribute('alt') || '');
    if (sized) { img.setAttribute('alt', sized[1] || ''); img.setAttribute('width', sized[2] || ''); }
    let url = null;
    try { url = src ? o.resolveAsset(src) : null; } catch { url = null; }
    if (!url) { img.replaceWith(missingBox(src, box.ownerDocument)); continue; }
    img.setAttribute('src', url);
    img.loading = 'lazy';
    // Alone in its paragraph, an image is a figure; beside text, a word of the sentence.
    const p = img.parentElement;
    if (p && p.tagName === 'P' && p.children.length === 1 && !(p.textContent || '').trim()) img.classList.add('ose-reading-figure');
    img.addEventListener('error', () => img.replaceWith(missingBox(src, box.ownerDocument)), { once: true });
  }
  for (const input of box.querySelectorAll('input')) {
    input.setAttribute('disabled', '');
    input.tabIndex = -1;
  }
  for (const a of box.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (P.isExternal(href)) a.classList.add('md-external');
  }
  for (const el of box.querySelectorAll('pre > code')) colour(el);
  // The first H1 is the page's title, drawn as the Rich view's title strip and Live's first H1
  // are (base.css `.page-title`, live.css `.cm-live-title`).
  const title = [...box.children].find((c) => c.tagName === 'H1');
  if (title) title.classList.add('ose-reading-title');
}

/**
 * Draw `text` into `box`.
 * @param {HTMLElement} box
 * @param {Marked} md
 * @param {string} text
 * @param {ReadingOptions} o
 */
function draw(box, md, text, o) {
  const doc = box.ownerDocument;
  box.textContent = '';
  const src = normalise(text);
  const fm = frontmatter(src);
  if (fm) {
    const props = doc.createElement('div');
    props.className = 'ose-reading-props';
    props.dataset.line = '1';
    const head = doc.createElement('div');
    head.className = 'ose-reading-props-head';
    head.textContent = 'Properties';
    const dl = doc.createElement('dl');
    for (const [k, v] of properties(fm.body)) {
      const dt = doc.createElement('dt');
      dt.textContent = k;
      const dd = doc.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    props.append(head, dl);
    box.append(props);
  }
  const body = fm ? src.split('\n').slice(fm.lines).join('\n') : src;
  const first = fm ? fm.lines + 1 : 1;
  let parts;
  try {
    parts = blocks(md, body, first);
  } catch (e) {
    console.error('[reading] render', e);
    const pre = doc.createElement('pre');
    pre.textContent = body;
    pre.dataset.line = String(first);
    box.append(pre);
    return;
  }
  for (const { line, html } of parts) {
    const frag = /** @type {DocumentFragment} */ (DOMPurify.sanitize(html, { ...PURIFY, RETURN_DOM_FRAGMENT: true }));
    for (const node of [...frag.childNodes]) {
      if (node.nodeType === 1) {
        /** @type {HTMLElement} */ (node).dataset.line = String(line);
        box.append(node);
      } else if (node.nodeType === 3 && (node.textContent || '').trim()) {
        const p = doc.createElement('p');
        p.dataset.line = String(line);
        p.append(node);
        box.append(p);
      }
    }
  }
  finish(box, o);
}

/** The element that scrolls `el`: the nearest ancestor that can, else the document's. */
function scroller(el) {
  for (let n = el; n; n = n.parentElement) {
    const style = n.ownerDocument.defaultView ? n.ownerDocument.defaultView.getComputedStyle(n) : null;
    if (style && /(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight) return n;
  }
  return /** @type {HTMLElement} */ (el.ownerDocument.scrollingElement || el.ownerDocument.documentElement);
}

/**
 * The Reading view of §4.4.
 * @param {ReadingOptions} o
 * @returns {ReadingView}
 */
export function createReadingView(o) {
  const doc = o.host.ownerDocument;
  const el = doc.createElement('div');
  el.className = 'md-render ose-reading';
  el.tabIndex = 0;
  el.setAttribute('role', 'document');
  el.setAttribute('aria-label', 'Reading view');
  el.setAttribute('aria-readonly', 'true');
  const md = makeMarked(o);
  draw(el, md, o.text, o);
  o.host.append(el);

  /** Every link is the page's to follow; the web view never navigates. */
  const onClick = (e) => {
    const a = e.target instanceof Element ? e.target.closest('a') : null;
    if (!a || !el.contains(a)) return;
    e.preventDefault();
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    o.onOpenLink(href, { newTab: !!(e.ctrlKey || e.metaKey) || e.button === 1 });
  };
  const onAux = (e) => { if (e.button === 1) onClick(e); };
  el.addEventListener('click', onClick);
  el.addEventListener('auxclick', onAux);

  const blocksOf = () => /** @type {HTMLElement[]} */ ([...el.children].filter((c) => c instanceof HTMLElement && c.dataset.line));

  return {
    el,
    setText(text) {
      const s = scroller(el);
      const top = s.scrollTop;
      draw(el, md, text, o);
      s.scrollTop = top;
    },
    goToLine(line) {
      const list = blocksOf();
      if (!list.length) return false;
      let target = list[0];
      for (const b of list) {
        if (Number(b.dataset.line) <= line) target = b; else break;
      }
      if (!target) return false;
      const s = scroller(el);
      const delta = target.getBoundingClientRect().top - s.getBoundingClientRect().top;
      s.scrollTop += delta;
      return true;
    },
    topLine() {
      const list = blocksOf();
      if (!list.length) return 1;
      const s = scroller(el);
      const top = s === doc.scrollingElement || s === doc.documentElement ? 0 : s.getBoundingClientRect().top;
      for (const b of list) {
        if (b.getBoundingClientRect().bottom > top + 1) return Number(b.dataset.line) || 1;
      }
      return Number(list[list.length - 1]?.dataset.line) || 1;
    },
    destroy() {
      el.removeEventListener('click', onClick);
      el.removeEventListener('auxclick', onAux);
      el.remove();
    },
  };
}
