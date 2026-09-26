// Live's images: `![alt|width](src)` and `![[file.png|width]]`, drawn off the caret line.
//
// Two registrations over the same node type, because CodeMirror takes block decorations
// only from a state field:
//
//   `image`        (inline)  an image with text around it on its line: the markup is replaced
//                            by the picture, where it stands;
//   `image-block`  (block)   an image alone on its line: the whole line is replaced by the
//                            picture, full width, which is how a figure reads.
//
// The alt slot is read the way the rich view reads it (`readAlt` in ../../image.js): `alt|420`
// is alt text and a width. The URL is the page's to give (`ctx.resolveAsset`): the vault
// protocol for a vault path, the address itself for the web, and null for what cannot be
// shown, which draws the small "missing image" box with the src in it. A load error draws the
// same box.
//
// Nothing here edits. A click puts the caret at the start of the markup, which reveals it; that
// is the widget's whole behaviour. The core parses an embed, `![[file.png|300]]`, as an `Image`
// node too (syntax.js); it is drawn only when its target has an image extension, so that
// `![[a note]]` stays what the core makes of it.

import { Decoration, WidgetType } from '@codemirror/view';
import { readAlt } from '../../image.js';

/** The extensions `![[…]]` is an image for. Anything else is a note embed, not ours. */
export const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/** `![[target#heading|extra]]`: the target, and what follows the bar (a width or alt text). */
const EMBED = /^!\[\[([^[\]\n|#]+?)(?:#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]$/;

/**
 * What an embed says, `![[file.png|300]]` or `![[file.png|alt text]]`: its src, alt text and
 * width. Null when it is not an image (no target, or not an image extension): a note embed. The
 * Reading view reads an embed through this too, so the two views draw the same embeds.
 *
 * @param {string} text  the whole embed, `![[` to `]]`
 * @returns {{ src: string, alt: string, width: string } | null}
 */
export function readEmbed(text) {
  const m = EMBED.exec(text);
  if (!m || !IMAGE_EXT.test((m[1] || '').trim())) return null;
  const extra = (m[2] || '').trim();
  const sized = /^(\d{1,5})(?:x\d{1,5})?$/.exec(extra);
  return { src: (m[1] || '').trim(), alt: sized ? '' : extra, width: sized ? (sized[1] || '') : '' };
}

/**
 * What an image node says: its src, alt text and width. Null for a reference image
 * (`![alt][ref]`), which has no src of its own here and stays raw.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {import('@lezer/common').SyntaxNodeRef} node
 * @returns {{ src: string, alt: string, width: string } | null}
 */
export function readImage(state, node) {
  const text = state.doc.sliceString(node.from, node.to);
  if (text.startsWith('![[')) return readEmbed(text);
  const url = node.node.getChild('URL');
  if (!url) return null;
  const marks = node.node.getChildren('LinkMark');
  const open = marks[0];
  const close = marks[1];
  if (!open || !close) return null;
  const { alt, width } = readAlt(state.doc.sliceString(open.to, close.from));
  let src = state.doc.sliceString(url.from, url.to).trim();
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
  return { src, alt: String(alt || ''), width: String(width || '') };
}

/** True when the node is the only thing on its line, leading and trailing spaces aside. */
function aloneOnLine(state, node) {
  const line = state.doc.lineAt(node.from);
  if (line.number !== state.doc.lineAt(node.to).number) return false;
  return line.text.trim() === state.doc.sliceString(node.from, node.to).trim();
}

/** The box a missing image draws: it says so, and names what it looked for. */
function missingBox(src) {
  const box = document.createElement('span');
  box.className = 'cm-live-image-missing';
  const label = document.createElement('span');
  label.className = 'cm-live-image-missing-label';
  label.textContent = 'Missing image';
  const name = document.createElement('code');
  name.textContent = src;
  box.append(label, name);
  box.title = `Missing image: ${src}`;
  return box;
}

export class ImageWidget extends WidgetType {
  /**
   * @param {string} src     as written in the file
   * @param {string | null} url  what the web view loads; null = missing
   * @param {string} alt
   * @param {string} width   digits, or ''
   * @param {boolean} block
   */
  constructor(src, url, alt, width, block) {
    super();
    this.src = src;
    this.url = url;
    this.alt = alt;
    this.width = width;
    this.block = block;
  }

  /** @param {ImageWidget} other */
  eq(other) {
    return other.src === this.src && other.url === this.url && other.alt === this.alt
      && other.width === this.width && other.block === this.block;
  }

  /** @param {import('@codemirror/view').EditorView} view */
  toDOM(view) {
    /** @type {HTMLElement} */
    const wrap = document.createElement(this.block ? 'div' : 'span');
    wrap.className = this.block ? 'cm-live-image cm-live-image-block' : 'cm-live-image';
    if (!this.url) {
      wrap.append(missingBox(this.src));
    } else {
      const img = document.createElement('img');
      img.src = this.url;
      img.alt = this.alt;
      img.draggable = false;
      if (this.alt) img.title = this.alt;
      if (this.width) img.width = Number(this.width);
      img.addEventListener('error', () => {
        img.replaceWith(missingBox(this.src));
        view.requestMeasure();
      });
      img.addEventListener('load', () => view.requestMeasure());
      wrap.append(img);
    }
    // The one gesture: the caret goes to the start of the markup, which shows it raw. The
    // position is asked of the view at the time of the click, so the widget never has to be
    // redrawn because something above it moved.
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const at = markupStart(view, wrap);
      if (at === null) return;
      view.dispatch({ selection: { anchor: at }, userEvent: 'select.live.image' });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent() { return true; }
}

/** Where the markup a widget stands for begins: the first non-space of its range. */
function markupStart(view, dom) {
  let at;
  try { at = view.posAtDOM(dom); } catch { return null; }
  const line = view.state.doc.lineAt(at);
  const lead = /^\s*/.exec(line.text.slice(at - line.from));
  return at + (lead ? lead[0].length : 0);
}

/** @param {import('../registry.js').WidgetContext} ctx */
function widgetFor(ctx, node, block) {
  const info = readImage(ctx.state, node);
  if (!info || !info.src) return null;
  let url = null;
  try { url = ctx.resolveAsset(info.src); } catch { url = null; }
  return new ImageWidget(info.src, url || null, info.alt, info.width, block);
}

/** @type {import('../registry.js').LiveWidget} */
export const image = {
  id: 'image',
  kind: 'inline',
  nodes: ['Image'],
  decorate(ctx, node, out) {
    if (aloneOnLine(ctx.state, node)) return;
    const widget = widgetFor(ctx, node, false);
    if (widget) out.add(node.from, node.to, Decoration.replace({ widget }));
  },
};

/** @type {import('../registry.js').LiveWidget} */
export const imageBlock = {
  id: 'image-block',
  kind: 'block',
  nodes: ['Image'],
  decorate(ctx, node, out) {
    if (!aloneOnLine(ctx.state, node)) return;
    const widget = widgetFor(ctx, node, true);
    if (!widget) return;
    const line = ctx.state.doc.lineAt(node.from);
    out.add(line.from, line.to, Decoration.replace({ widget, block: true }));
  },
};
