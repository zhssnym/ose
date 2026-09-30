// Inline markdown to sanitised HTML, for the widgets that draw text themselves (a table's
// cells, `ctx.inlineHtml`).
//
// A cell has to read the way the rest of Live reads (contract §3.2, "the same inline rules"),
// so this is not the module-level `marked` (its `use` is global, render.js keeps off it too):
// it is an instance of its own with the pandoc maths of ../math.js, and a wikilink extension
// that draws `[[target|alias]]` the way inline.ts does, alias shown, a missing target dotted.
// An image goes through the page's `resolveAsset`, as widgets/image.js does, and what cannot
// be resolved is the same "Missing image" box. A load error is caught by the view (view.ts),
// which swaps in that box too.
//
// The HTML is sanitised before the maths is painted (its html profile would take `<math>`
// apart), then the MathML Temml writes goes in as the elements it is.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { markedMath, paintMath } from '../math.ts';
import { wikiParts } from './syntax.ts';

/** The extensions `![[…]]` is a picture for. */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

const escapeHtml = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/**
 * The "Missing image" box of widgets/image.js, as markup.
 */
export const missingImageHtml = (src: string) => `<span class="cm-live-image-missing" title="${escapeHtml(`Missing image: ${src}`)}">`
  + `<span class="cm-live-image-missing-label">Missing image</span><code>${escapeHtml(src)}</code></span>`;

/**
 * The same box as an element, for a load error after the fact.
 */
export function missingImageBox(src: string) {
  const t = document.createElement('template');
  t.innerHTML = missingImageHtml(src);
  return (t.content.firstElementChild as HTMLElement);
}

/**
 * `alt|420`: alt text and a width, as the rich view writes them.
 */
function altAndWidth(raw: string) {
  const m = /^([\s\S]*)\|(\d{1,5})$/.exec(String(raw ?? ''));
  return m ? { alt: m[1] || '', width: m[2] || '' } : { alt: String(raw ?? ''), width: '' };
}

export interface CellEnv {
  resolveAsset: (src: string) => string | null;
  resolveWikilink?: ((target: string) => { path: string | null, exists: boolean }) | null;
}

/**
 * The `inlineHtml` of one Live view.
 */
export function makeInlineHtml(env: CellEnv): (md: string) => string {
  const md = new Marked({ gfm: true, breaks: true, pedantic: false });
  md.use(markedMath);
  md.use({
    extensions: [{
      name: 'liveWikilink',
      level: 'inline',
      start(src: string) {
        const i = src.indexOf('[[');
        if (i < 0) return undefined;
        return i > 0 && src[i - 1] === '!' ? i - 1 : i;
      },
      tokenizer(src: string) {
        const m = /^!?\[\[[^[\]\n]+\]\]/.exec(src);
        if (!m) return undefined;
        return { type: 'liveWikilink', raw: m[0] };
      },
      renderer(token: { raw: string; }) {
        const parts = wikiParts(token.raw);
        if (token.raw.startsWith('!') && IMAGE_EXT.test(parts.target)) {
          const sized = /^(\d{1,5})(?:x\d{1,5})?$/.exec(parts.alias.trim());
          return `<img data-live-src="${escapeHtml(parts.target)}" alt="${escapeHtml(sized ? '' : parts.alias)}"`
            + `${sized ? ` width="${sized[1]}"` : ''}>`;
        }
        let missing = false;
        if (parts.target && env.resolveWikilink) {
          try { missing = !env.resolveWikilink(parts.target).exists; } catch { missing = false; }
        }
        return `<span class="cm-live-link cm-live-wiki${missing ? ' cm-live-missing' : ''}">${escapeHtml(parts.shown)}</span>`;
      },
    }],
    renderer: {
      image(token: { href: string; title?: string | null; text: string; }) {
        const { alt, width } = altAndWidth(token.text);
        const src = String(token.href || '').replace(/^<|>$/g, '');
        return `<img data-live-src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"`
          + `${width ? ` width="${width}"` : ''}${token.title ? ` title="${escapeHtml(token.title)}"` : ''}>`;
      },
    },
  });

  return (text) => {
    // A table cell's `\|` is a pipe of the cell's text (GFM), `[[page\|alias]]` included.
    const src = String(text ?? '').replace(/\\\|/g, '|');
    try {
      const html = (md.parseInline(src, { async: false }) as string);
      const clean = DOMPurify.sanitize(html, {
        FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input'], FORBID_ATTR: ['style'],
      });
      const box = document.createElement('template');
      box.innerHTML = clean;
      for (const img of box.content.querySelectorAll('img[data-live-src]')) {
        const want = img.getAttribute('data-live-src') || '';
        let url: string | null = null;
        try { url = want ? env.resolveAsset(want) : null; } catch { url = null; }
        if (!url) { img.replaceWith(missingImageBox(want)); continue; }
        img.setAttribute('src', url);
        img.setAttribute('draggable', 'false');
      }
      // paintMath wants an element; a template's content is a fragment.
      const holder = document.createElement('div');
      holder.append(box.content);
      paintMath(holder);
      return holder.innerHTML;
    } catch {
      return escapeHtml(src);
    }
  };
}
