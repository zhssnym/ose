// Live's paste and file drop (M11): what comes in from outside becomes markdown in the file.
//
// Three kinds of paste, in this order:
//
//   - HTML with text in it (a web page, a mail, a Word document): through DOMPurify, then
//     turndown with the GFM rules (tables, strikethrough, task lists), written in the vault's
//     own conventions: `#` headings, `-` bullets with one space, `_` emphasis, `**` strong,
//     fenced code, and a plain newline for a line break (a note's single newline is a line
//     break, M6). An image the HTML carries inline as a `data:` URL is stored as an attachment
//     and linked, never written into the file as base64; a web image keeps its address and is
//     not downloaded (L6).
//   - Files (a screenshot, a file copied in Explorer or Finder), and a clipboard whose HTML is
//     only an image: each is stored with `ctx.saveAttachment` and linked, `![](href)` for an
//     image and `[name](href)` for anything else, all in one transaction. A file the page
//     refuses (`null`: an outside-vault page, a failed write) inserts nothing; the page says why.
//   - Plain text: CodeMirror's own paste, untouched.
//
// Ctrl+Shift+V (`format.paste-plain`) always pastes plain: the chord is noticed on keydown and
// the paste event that follows it is left to CodeMirror.
//
// A drop of files on the text does the same as a paste of files, at the drop point. Positions
// taken before an attachment is written are mapped through whatever the user typed meanwhile.

import { EditorView, ViewPlugin } from '@codemirror/view';
import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';
import { copyText, toast } from '../../host.js';

/** The turndown options (contract §3.2), one place. */
export const TURNDOWN_OPTIONS = /** @type {const} */ ({
  headingStyle: 'atx',
  bulletListMarker: '-',
  emDelimiter: '_',
  strongDelimiter: '**',
  codeBlockStyle: 'fenced',
  fence: '```',
  hr: '---',
  // A `<br>` is a plain newline: the vault reads one as a line break.
  br: '',
});

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'button', 'select', 'textarea', 'meta', 'link', 'title'],
};

/** @type {TurndownService | null} */
let service = null;

/** One turndown, built on first use, with the vault's list rule over turndown's. */
function turndown() {
  if (service) return service;
  const td = new TurndownService(TURNDOWN_OPTIONS);
  td.use(gfm);
  // turndown writes `-   item` (the marker padded to four columns); the vault writes `- item`,
  // and a continuation line is indented by the marker's own width.
  td.addRule('oseListItem', {
    filter: 'li',
    replacement(content, node, options) {
      const parent = node.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent && parent.nodeName === 'OL') {
        const start = Number((/** @type {Element} */ (parent)).getAttribute('start')) || 1;
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const pad = ' '.repeat(prefix.length);
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n(?=.)/g, `\n${pad}`)
        // A task's box is written with its space, and the item's own text often starts with one.
        .replace(/^(\[[ xX]\]) {2,}/, '$1 ');
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '');
    },
  });
  // Word and the web put the whole fragment in comments and empty spans; a comment is nothing.
  td.remove(['script', 'style']);
  service = td;
  return td;
}

/**
 * HTML to sanitised DOM: DOMPurify's html profile, with no script, style, frame or form.
 * @param {string} html
 * @returns {HTMLElement}
 */
export function cleanHtml(html) {
  return /** @type {HTMLElement} */ (DOMPurify.sanitize(String(html ?? ''), { ...PURIFY, RETURN_DOM: true }));
}

/**
 * Sanitised DOM (or HTML) to markdown in the vault's conventions. Pure: no attachment is
 * written here, a `data:` image is dropped to its alt text (use `markdownFromHtml` for those).
 *
 * @param {string | HTMLElement} input
 * @returns {string}
 */
export function htmlToMarkdown(input) {
  const body = typeof input === 'string' ? cleanHtml(input) : input;
  for (const img of [...body.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (/^(?:data|blob):/i.test(src)) img.replaceWith(img.ownerDocument.createTextNode(img.getAttribute('alt') || ''));
  }
  return turndown().turndown(body).replace(/^\n+|\n+$/g, '');
}

/**
 * A `data:` URL as a File, for an image the clipboard carried inline. Null for anything that is
 * not an image, or not a data URL.
 *
 * @param {string} url
 * @param {number} n
 * @returns {File | null}
 */
export function fileFromDataUrl(url, n = 1) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/i.exec(String(url || ''));
  if (!m) return null;
  const type = (m[1] || '').toLowerCase();
  if (!type.startsWith('image/')) return null;
  let bytes;
  try {
    bytes = m[3]
      ? Uint8Array.from(atob((m[4] || '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(m[4] || ''));
  } catch {
    return null;
  }
  const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^a-z0-9]/g, '');
  return new File([bytes], `pasted-image-${n}.${ext || 'png'}`, { type });
}

/** Square brackets and backslashes in a link's text, escaped. */
const linkText = (s) => String(s).replace(/([[\]\\])/g, '\\$1');

/** An href that holds a space or a parenthesis goes in angle brackets, as CommonMark reads it. */
const linkDest = (href) => (/[\s()]/.test(href) && !/[<>]/.test(href) ? `<${href}>` : href);

/**
 * The markdown for one stored file.
 * @param {File} file
 * @param {string} href
 */
export function linkFor(file, href) {
  return /^image\//.test(file.type || '')
    ? `![](${linkDest(href)})`
    : `[${linkText(file.name || 'file')}](${linkDest(href)})`;
}

/**
 * Store every file and answer the markdown that links them, one per line. A file the page
 * refuses (null) or that throws is left out.
 *
 * @param {File[]} files
 * @param {import('../registry.js').PasteContext} ctx
 * @returns {Promise<string>}
 */
export async function storeFiles(files, ctx) {
  const out = [];
  for (const file of files) {
    let path = null;
    try { path = await ctx.saveAttachment(file); } catch (e) { console.warn('[live] attachment', e); path = null; }
    if (path) out.push(linkFor(file, ctx.linkTo(path)));
  }
  return out.join('\n');
}

/**
 * HTML to markdown, with every inline `data:` image stored as an attachment first and linked
 * where it stood. An image the page refuses keeps only its alt text.
 *
 * @param {string} html
 * @param {import('../registry.js').PasteContext} ctx
 * @returns {Promise<string>}
 */
export async function markdownFromHtml(html, ctx) {
  const body = cleanHtml(html);
  let n = 0;
  for (const img of [...body.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (!/^data:/i.test(src)) continue;
    const file = fileFromDataUrl(src, ++n);
    let path = null;
    if (file) {
      try { path = await ctx.saveAttachment(file); } catch (e) { console.warn('[live] attachment', e); path = null; }
    }
    if (path) img.setAttribute('src', ctx.linkTo(path));
    else img.replaceWith(body.ownerDocument.createTextNode(img.getAttribute('alt') || ''));
  }
  return htmlToMarkdown(body);
}

/** The files a DataTransfer holds. */
function filesOf(data) {
  if (!data) return [];
  const list = [];
  if (data.files && data.files.length) {
    for (const f of data.files) list.push(f);
  } else if (data.items) {
    for (const item of data.items) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) list.push(f);
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// the extension

/** A place in the document that an insertion is waiting for, kept mapped through edits. */
class Pending {
  /** @param {number} from @param {number} to */
  constructor(from, to) {
    this.from = from;
    this.to = to;
    this.done = false;
    /** @type {string | null} the markdown, once known, while the view cannot take it (read-only) */
    this.text = null;
    /** The view went away while the attachment was being written. */
    this.orphan = false;
  }
}

/**
 * The links of attachments that were written but could not go into the page, because the view
 * went away first (a mode switch, a close). The file is in the vault either way; the link goes
 * on the clipboard and the page says so, so nothing is left linked from nowhere without a word.
 * @param {string} text
 */
function orphaned(text) {
  void copyText(text).then(
    (ok) => toast(ok
      ? 'The attachment was saved, but the page changed before its link went in. The link is on the clipboard.'
      : `The attachment was saved, but the page changed before its link went in: ${text}`, 'warn', 9000),
    () => toast(`The attachment was saved, but the page changed before its link went in: ${text}`, 'warn', 9000),
  );
}

/**
 * What the paste extension holds for one view: the insertions waiting for an attachment (or
 * for the view to be editable again), and the plain-paste chord. One plugin for every view, so
 * `pendingPastes` can find it.
 */
const tracker = ViewPlugin.fromClass(class {
  /** @param {EditorView} view */
  constructor(view) {
    this.view = view;
    /** @type {Set<Pending>} */
    this.pending = new Set();
    /** @type {Set<Promise<unknown>>} */
    this.work = new Set();
    this.plain = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.plainTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.flushTimer = null;
  }

  /** @param {import('@codemirror/view').ViewUpdate} u */
  update(u) {
    if (!this.pending.size) return;
    if (u.docChanged) {
      for (const p of this.pending) {
        p.from = u.changes.mapPos(p.from, -1);
        p.to = Math.max(p.from, u.changes.mapPos(p.to, 1));
      }
    }
    // The view is editable again (a freeze ended): what arrived meanwhile goes in now. Not
    // from inside an update, where a dispatch is refused.
    if (!u.state.readOnly && !this.flushTimer && [...this.pending].some((p) => p.text !== null)) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        for (const p of [...this.pending]) if (p.text !== null) land(this.view, p, p.text);
      }, 0);
    }
  }

  destroy() {
    for (const p of this.pending) {
      if (p.text !== null) { p.done = true; orphaned(p.text); } else p.orphan = true;
    }
    this.pending.clear();
    if (this.plainTimer) clearTimeout(this.plainTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }
});

/**
 * Put `text` where `p` has been mapped to, as one user paste, and let go of `p`. A read-only
 * view (frozen for a save, a mode switch or a leave) keeps `p` and its text until it is
 * editable again: a programmatic dispatch would get past the read-only facet, and land in a
 * buffer whose text has already been taken.
 * @param {EditorView} view
 * @param {Pending} p
 * @param {string} text
 */
function land(view, p, text) {
  if (p.done) return;
  const t = view.plugin(tracker);
  if (!text) {
    p.done = true;
    if (t) t.pending.delete(p);
    return;
  }
  if (!t || p.orphan) { p.done = true; orphaned(text); return; }
  if (view.state.readOnly) { p.text = text; return; }
  t.pending.delete(p);
  p.done = true;
  const len = view.state.doc.length;
  const from = Math.min(p.from, len);
  const to = Math.min(Math.max(p.to, from), len);
  try {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.paste',
      scrollIntoView: true,
    });
  } catch (e) {
    console.warn('[live] paste', e);                      // the view went away meanwhile
    orphaned(text);
  }
}

/** A place to land in, held in `view`'s tracker. @param {EditorView} view @param {number} from @param {number} to */
function hold(view, from, to) {
  const p = new Pending(from, to);
  const t = view.plugin(tracker);
  if (t) t.pending.add(p);
  return p;
}

/**
 * Wait on `markdown` (an attachment being written) and land it at `p`.
 * @param {EditorView} view
 * @param {Pending} p
 * @param {Promise<string>} markdown
 * @param {() => string} [fallback]  what goes in when the conversion fails
 */
function landLater(view, p, markdown, fallback) {
  const t = view.plugin(tracker);
  const job = markdown.then(
    (md) => land(view, p, md || (fallback ? fallback() : '')),
    (err) => { console.warn('[live] paste', err); land(view, p, ''); },
  );
  if (t) {
    t.work.add(job);
    void job.finally(() => t.work.delete(job));
  }
}

/**
 * Resolves when every paste and drop `view` has in the air has been written and answered
 * (landed, or held while the view is read-only). A mode switch waits on this before it
 * freezes the view and takes its text, so a pasted image's link is in the text it takes.
 * @param {EditorView} view
 * @returns {Promise<void>}
 */
export async function pendingPastes(view) {
  const t = view && view.plugin(tracker);
  while (t && t.work.size) await Promise.allSettled([...t.work]);
}

/**
 * @param {import('../registry.js').PasteContext} ctx
 * @returns {import('@codemirror/state').Extension}
 */
export function paste(ctx) {
  /** @param {ClipboardEvent} e @param {EditorView} view */
  function onPaste(e, view) {
    const t = view.plugin(tracker);
    const plain = !!(t && t.plain);
    if (t) {
      t.plain = false;
      if (t.plainTimer) { clearTimeout(t.plainTimer); t.plainTimer = null; }
    }
    if (plain || view.state.readOnly) return false;
    const data = e.clipboardData;
    if (!data) return false;
    const html = data.getData('text/html');
    const files = filesOf(data);
    const body = html ? cleanHtml(html) : null;
    const hasText = !!(body && (body.textContent || '').trim());
    const sel = view.state.selection.main;

    if (html && (hasText || !files.length)) {
      const inline = body ? [...body.querySelectorAll('img')].some((i) => /^data:/i.test(i.getAttribute('src') || '')) : false;
      if (!inline) {
        const md = body ? htmlToMarkdown(body) : '';
        if (!md) return false;                            // nothing turndown could say: plain text
        e.preventDefault();
        land(view, hold(view, sel.from, sel.to), md);
        return true;
      }
      e.preventDefault();
      const p = hold(view, sel.from, sel.to);
      const plainText = data.getData('text/plain');
      landLater(view, p, markdownFromHtml(html, ctx), () => plainText);
      return true;
    }
    if (files.length) {
      e.preventDefault();
      const p = hold(view, sel.from, sel.to);
      landLater(view, p, storeFiles(files, ctx));
      return true;
    }
    return false;
  }

  /** @param {DragEvent} e @param {EditorView} view */
  function onDrop(e, view) {
    const files = filesOf(e.dataTransfer);
    if (!files.length) return false;
    e.preventDefault();
    if (view.state.readOnly) return true;
    const at = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    const p = hold(view, at, at);
    landLater(view, p, storeFiles(files, ctx));
    return true;
  }

  /** @param {KeyboardEvent} e @param {EditorView} view */
  function onKeydown(e, view) {
    const t = view.plugin(tracker);
    if (!t) return false;
    const chord = (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'KeyV' || e.key === 'V' || e.key === 'v');
    if (!chord) return false;
    // The browser's own plain paste follows this keydown; the flag lets it through untouched.
    t.plain = true;
    if (t.plainTimer) clearTimeout(t.plainTimer);
    t.plainTimer = setTimeout(() => { t.plain = false; t.plainTimer = null; }, 1000);
    return false;
  }

  return [
    tracker,
    EditorView.domEventHandlers({ paste: onPaste, drop: onDrop, keydown: onKeydown }),
  ];
}
