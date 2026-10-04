// The vault's own words in a view: the intro and the review of a month or a year. Drawn with
// the editor's `render` (src/editor/lib.ts, loaded by dynamic import, as the Journal does) when
// it is there, else as plain paragraphs. A text that is only `_gap: …_` lines is always plain,
// so the known hole reads as one.

import { esc } from '../../ui/index.ts';
import { isGapLine } from './plans.ts';

/** Prose, as the file has it: paragraphs, `_..._` as emphasis, gap lines flagged. */
export function prose(text: string): string {
  return String(text ?? '').split(/\n{2,}/).map((p) => {
    const line = p.trim().replace(/\s*\n\s*/g, ' ');
    const body = esc(line).replace(/_([^_]+)_/g, '<em>$1</em>');
    return `<p${isGapLine(line) ? ' class="mo-gap"' : ''}>${body}</p>`;
  }).join('');
}

type Render = (markdown: string, opts?: any) => HTMLElement | null;
let renderMd: Render | null = null;
let loading: Promise<void> | null = null;

/** Load the editor's renderer once; a failure leaves the plain paragraphs. */
function loadRenderer(): Promise<void> {
  if (!loading) loading = import('../../editor/lib.ts').then((m) => { renderMd = m.render; }).catch(() => { /* the plain renderer */ });
  return loading;
}

/**
 * Fill `el` with `text`: plain paragraphs first, the rendered markdown once the renderer is
 * loaded (when `el` still holds this text).
 * @param basePath the file the text is from, for its relative links
 */
export function proseInto(el: HTMLElement, text: string, basePath: string): void {
  el.innerHTML = prose(text);
  const plain = String(text ?? '').split(/\r?\n/).every((l) => !l.trim() || isGapLine(l));
  el.dataset.prose = plain ? '' : text;
  if (plain) return;
  const draw = () => {
    if (!renderMd || el.dataset.prose !== text) return;
    try {
      const node = renderMd(text, { basePath });
      if (node) { el.textContent = ''; el.appendChild(node); }
    } catch { /* the plain paragraphs stay */ }
  };
  if (renderMd) draw(); else void loadRenderer().then(draw);
}
